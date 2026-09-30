import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AgentRuntime, ApprovalLedger, RunControlError, denyAll, type AgentCheckpointState, type AgentReply, type Approver } from "@august/agent";
import { randomUUID } from "node:crypto";
import {
  DecisionCascade,
  FallbackProvider,
  HeuristicEngine,
  LayaEngine,
  fitCalibrationTable,
  parseCalibrationTable,
  type CalibrationTable,
  LlmChoiceEngine,
  LlmQueryExpander,
  UsageRequiredProvider,
  layaHttpTransport,
  NativeLayaTransport,
  nativeLayaIdentity,
  type DecisionEngine,
  type LlmProvider,
} from "@august/brain";
import { CapabilityRegistry } from "@august/capabilities";
import { BudgetAdmissionError, DurableRuntimeStore, type BudgetSnapshot, type DurableRun, type RunBudgetRequest, type RunState, AnchorLog, AuditAnchorer, AuditKey, EventJournal, makeSessionKey, verifyAudit, type AuditAnchor, type AuditReport, type SessionKey } from "@august/core";
import { RegistryClient, installNpm, resolveNpm, verifyInstalled, type InstallPlan } from "@august/discovery";
import { EGRESS_BRIDGE_JS, EgressProxy, McpHost, detectSandbox, parseEgress, sandboxHome, sandboxSpec, type NetworkAccess, type SandboxKind } from "@august/mcp";
import { LocalEmbeddingClient, MemoryExecutor, MemoryStore, memoryManifest } from "@august/memory";
import { maxSensitivity } from "@august/policy";
import { DistillationEngine, PatternStore, type Route } from "@august/ladder";
import { LearningStore,VerifierSet, calibrationSamples, engineOf, evaluateActivation, recordOwnerFeedback, type ActivationReport } from "@august/learning";
import { PolicyEngine } from "@august/policy";
import { BuiltinExecutor, builtinManifest, clockManifest } from "./builtins.ts";
import { ConfigError, loadConfig, resolveLlmPricing, writeConfig, type AugustConfig, type McpServerConfig } from "./config.ts";
import { JsonlDecisionLog } from "./decision-log.ts";
import { MetaExecutor, metaManifest, type ArtifactService } from "./meta.ts";
import { targetsFor, type TargetRoots } from "./targets.ts";
import { builtinVerifiers } from "./verifiers.ts";
import { assertKeyDirectoryOutside, deriveKey, loadMasterKey } from "./masterkey.ts";
import { openSecretStore, resolveSecret, type SecretStore } from "./secrets.ts";
import { SecretBroker, type DeliveryContext, type EgressMode } from "./broker.ts";
import { AuditPublisher, type AuditExternalStatus } from "./audit-context.ts";
import { createLlm, quoteForModelAttempt } from "./providers.ts";
export { createLlm } from "./providers.ts";

export interface AppDeps {
  env: Record<string, string | undefined>;
  approver?: Approver;
  /** Shared ledger for approvals answered by channels. Default: a new one. */
  approvals?: ApprovalLedger;
  /** Replace the network LLM, for tests. */
  llm?: LlmProvider;
  fetch?: typeof fetch;
  secrets?: SecretStore;
  /** Where installs are saved. Without it, installed servers last until exit. */
  configPath?: string;
  /** Override sandbox detection, for tests. */
  sandboxKind?: SandboxKind;
  home?: string;
}

export interface AuditHandle {
  enabled: boolean;
  reason?: string;
  keyId?: string;
  /** Base64 SPKI of the public key, for verifying exported anchors elsewhere. */
  publicKey?: string;
  anchorLogPath?: string;
  anchor(): AuditAnchor | undefined;
  anchors(): AuditAnchor[];
  verify(): AuditReport;
  externalStatus(): AuditExternalStatus;
  publish(): Promise<AuditExternalStatus>;
  stop(): void;
}

export interface StartReport {
  started: Array<{ id: string; isolation: string }>;
  failed: Array<{ id: string; error: string; /** Server stderr, for the owner only. */ diagnostics?: string }>;
}

export interface HandleOptions { idempotencyKey?: string; budget?: RunBudgetRequest }
export interface DurableAgentReply extends AgentReply { runId: string; replayed: boolean; feedbackId?: string }
export interface RunListOptions { session?: SessionKey; states?: RunState[]; limit?: number }

export interface App {
  config: AugustConfig;
  agent: AgentRuntime;
  journal: EventJournal;
  cascade: DecisionCascade;
  registry: CapabilityRegistry;
  policy: PolicyEngine;
  mcp: McpHost;
  meta: MetaExecutor;
  runs: DurableRuntimeStore;
  /** Every approval the agent asks for lives here; channels resolve it by id and nonce. */
  approvals: ApprovalLedger;
  secrets: SecretStore;
  sandbox: SandboxKind;
  /** Decisions, executions and the evidence about their outcomes. Examples are derived from it by one rule. */
  learning: LearningStore;
  /** Patterns learned from verified repeated work, and their place on the ladder. */
  distill: DistillationEngine;
  /** What the owner asked August to remember, with where each entry came from. */
  memory: MemoryStore;
  /** Signed anchors that make a rewrite of the journal detectable. */
  audit: AuditHandle;
  /** Admission circuit status, not a guarantee that the remote model is currently healthy. */
  providerHealth(): ReturnType<FallbackProvider["health"]>;
  budgetSnapshot(): BudgetSnapshot;
  /** The owner's verdict on a run they saw: an independent outcome. Only their own session's runs can be judged. */
  feedback(session: SessionKey, feedbackId: string, verdict: "success" | "failure", note?: string): void;
  /** Refits Laya's segmented calibration from verified outcomes and applies it now. */
  recalibrate(): { samples: number; segments: number; table: CalibrationTable };
  /** Whether verified outcomes support letting Laya decide alone. */
  activationReport(): ActivationReport;
  /** Handle one message and save the decision statistics. */
  handle(session: SessionKey, text: string, approver?: Approver, options?: HandleOptions): Promise<DurableAgentReply>;
  getRun(id: string): DurableRun | undefined;
  listRuns(options?: RunListOptions): DurableRun[];
  pauseRun(id: string): Promise<DurableRun>;
  cancelRun(id: string): Promise<DurableRun>;
  resumeRun(id: string, approver?: Approver): Promise<DurableAgentReply>;
  retryRun(id: string, options?: HandleOptions, approver?: Approver): Promise<DurableAgentReply>;
  resolveRun(id: string, resolution: "abandon" | "confirm_not_executed"): DurableRun;
  /** Start the MCP servers from the config. One failing server never stops the others. */
  startServers(): Promise<StartReport>;
  close(): void;
}

function readStats(path: string): Record<string, number> {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

/**
 * Routes each approval to the person of that session, so each channel asks
 * its own person. Sessions run one message at a time (lane queue), so one
 * entry per session is enough even when sessions run in parallel.
 */
class SessionApprover implements Approver {
  readonly bySession = new Map<string, Approver>();
  constructor(private readonly fallback: Approver) {}
  approve(request: Parameters<Approver["approve"]>[0]): Promise<boolean> {
    return (this.bySession.get(request.session) ?? this.fallback).approve(request);
  }
}

export function createApp(config: AugustConfig, deps: AppDeps): App {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.root, { recursive: true });
  const home = deps.home ?? process.env.HOME ?? dirname(config.root);

  // Keys live outside the data folder, so a copy or backup of the data does not carry them.
  const keyDir = deps.env.AUGUST_KEY_DIR ?? join(deps.home ?? dirname(dirname(config.dataDir)), ".config", "august");
  // File tools must never be able to read the master key, even through a symlink.
  try { assertKeyDirectoryOutside(keyDir, [config.root, resolve(dirname(config.dataDir))]); }
  catch (error) { throw new ConfigError((error as Error).message); }
  const secrets = deps.secrets ?? openSecretStore(dirname(config.dataDir), { env: deps.env, keyDir });
  const pricing = resolveLlmPricing(config);
  const provider = deps.llm ?? createLlm(config, { ...deps, circuits: { load: () => runs.providerCircuits(), save: states => runs.saveProviderCircuits(states) } }, secrets);
  const llm = new UsageRequiredProvider(provider);
  // Claim before opening the other writable stores or reconstructing runtime state.
  const runs = new DurableRuntimeStore(join(config.dataDir, "runtime.db"), { exclusiveOwner: true,budgetPolicy:config.budgets });
  try {

  // Native/sidecar Laya is explicit; until then a heuristic stands in.
  // Either way the cascade starts in shadow mode and earns its way out.
  let primary: DecisionEngine = new HeuristicEngine();
  const engineId = config.laya?.onnx ? nativeLayaIdentity(config.laya.onnx) : config.laya?.engine ?? "laya";
  const calibrationPath = join(config.dataDir, "calibration.json");
  const loadCalibration = (): CalibrationTable | undefined => {
    try { return existsSync(calibrationPath) ? parseCalibrationTable(JSON.parse(readFileSync(calibrationPath, "utf8"))) : undefined; }
    // A damaged table is refused whole: Laya then runs uncalibrated, which only sends more decisions to the LLM.
    catch { return undefined; }
  };
  let laya: LayaEngine | undefined;
  const nativeLaya = config.laya?.onnx ? new NativeLayaTransport(config.laya.onnx) : undefined;
  if (config.laya) primary = laya = new LayaEngine(nativeLaya?.predict ?? layaHttpTransport(config.laya.url!, { fetch: deps.fetch }), { temperature: config.laya.temperature, calibration: loadCalibration(), engine: engineId });
  const cascade = new DecisionCascade({
    primary,
    fallback: new LlmChoiceEngine(llm),
    threshold: config.laya?.threshold,
    shadow: config.laya?.shadow ?? true,
    log: new JsonlDecisionLog(join(config.dataDir, "decisions.jsonl")),
  });
  const statsPath = join(config.dataDir, "cascade.json");
  cascade.restore(readStats(statsPath));

  const registry = new CapabilityRegistry();
  registry.install(builtinManifest, "verified");
  registry.install(clockManifest, "verified");
  registry.install(memoryManifest, "verified");
  registry.install(metaManifest, "verified");

  const sandbox = deps.sandboxKind ?? detectSandbox();
  const registryClient = new RegistryClient(config.registryUrl, deps.fetch);
  const configured = [...config.mcp];
  const broker = new SecretBroker(secrets, deps.env);
  // Everything that must never appear in a checkpoint: August's own keys by name, and each capability's own secrets.
  const ownSecretNames = new Set([config.llm.apiKeyEnv, config.llm.backup?.apiKeyEnv, config.channels.telegram?.tokenSecret, config.auditExternal?.tokenEnv,config.memory?.embedding?.apiKeyEnv].filter((name): name is string => Boolean(name)));
  const capabilitySecrets = new Map<string, { trust: DeliveryContext["trust"]; names: Set<string> }>();
  const registerCheckpointSecrets = (entry: McpServerConfig) => {
    const names = [...(entry.envFrom ?? []), ...Object.values(entry.headersFrom ?? {})];
    capabilitySecrets.set(entry.id, { trust: entry.trust ?? "community", names: new Set(names) });
  };
  const secretValues = (): string[] => [
    ...[...ownSecretNames].map((name) => resolveSecret(name, secrets, deps.env)),
    ...[...capabilitySecrets].flatMap(([capability, c]) => broker.redactionValues({ capability, trust: c.trust, artifactVerified: true, sandboxed: true, egress: "none" }, [...c.names])),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  configured.forEach(registerCheckpointSecrets);
  const proxies: EgressProxy[] = [];
  const egressSession = makeSessionKey({ workspace: config.workspace, channel: "system", user: "egress" });

  let mcp!: McpHost;
  const capabilityDir = (id: string) => join(config.dataDir, "capabilities", id);
  const npmRegistry = config.npmRegistryUrl ?? "https://registry.npmjs.org";
  const artifacts: ArtifactService = {
    resolve: (ref) => resolveNpm(ref, { fetch: deps.fetch, registryUrl: npmRegistry }),
    install: (evidence, id) => installNpm(evidence, capabilityDir(id), { bun: process.execPath, registryUrl: config.npmRegistryUrl, cacheDir: join(config.dataDir, "capabilities", ".package-cache"), nodeAvailable: Boolean(Bun.which("node")) }),
  };

  /** The sandbox and network posture of a server. A community server is always sandboxed and gets no network unless it lists hosts. */
  const postureOf = (entry: McpServerConfig) => {
    const trust = entry.trust ?? "community";
    const community = trust === "community";
    // Only the owner, naming this server, can switch its sandbox off; a global "off" or "auto" never weakens a community server.
    const mode = entry.sandbox === "off" ? "off" : community ? "required" : entry.sandbox ?? config.sandbox;
    const network: "none" | "open" | "allowlist" = entry.egress?.length ? "allowlist" : (entry.network ?? !community) ? "open" : "none";
    return { trust, community, mode, network } as const;
  };
  const deliveryFor = (entry: McpServerConfig, sandboxed: boolean, egress: EgressMode): DeliveryContext => ({ capability: entry.id, trust: entry.trust ?? "community", artifactVerified: Boolean(entry.artifact), sandboxed, egress });

  const startServer = async (entry: McpServerConfig): Promise<string> => {
    const { trust, mode, network } = postureOf(entry);
    const policy = { sensitivity: entry.sensitivity, targetArgs: entry.targetArgs };
    if (entry.url) {
      // Our own process holds the credential and sends it to exactly this https host: nothing local can read it.
      const ctx: DeliveryContext = { capability: entry.id, trust, artifactVerified: true, sandboxed: true, egress: "allowlist" };
      const headers: Record<string, string> = {};
      const names = Object.values(entry.headersFrom ?? {});
      const values = broker.deliver(ctx, names);
      for (const [header, name] of Object.entries(entry.headersFrom ?? {})) headers[header] = values[name]!;
      await mcp.add({ id: entry.id, url: entry.url, headers }, trust, policy);
      return "remote";
    }
    const readOnlyPaths: string[] = [];
    let base = { id: entry.id, command: entry.command!, args: entry.args, env: { ...entry.env } };
    if (entry.artifact) {
      // What runs is exactly what was approved: the installed tree is hashed again and must equal the pin.
      const dir = capabilityDir(entry.id);
      if (!verifyInstalled(entry.artifact, dir)) throw new Error(`"${entry.id}" changed on disk since it was installed and will not start; reinstall it`);
      const runtime = entry.artifact.entry.runtime === "node" ? Bun.which("node") : process.execPath;
      if (!runtime) throw new Error(`"${entry.id}" needs node, which is not installed`);
      base = { id: entry.id, command: runtime, args: [join(dir, entry.artifact.entry.file), ...(entry.args ?? [])], env: { ...entry.env } };
      // The package and the runtime that runs it stay readable even when they live under the hidden home.
      readOnlyPaths.push(dir, runtime);
    }
    let access: NetworkAccess = network === "open" ? "open" : "none";
    if (network === "allowlist") {
      const rules = parseEgress(entry.egress!);
      const onDecision = (decision: unknown) => journal.append({ kind: "egress.decision", session: egressSession, data: decision });
      if (sandbox === "bwrap") {
        const socket = join(config.dataDir, "sandbox", `${entry.id}.egress.sock`);
        const bridgeScript = join(config.dataDir, "sandbox", `${entry.id}.bridge.js`);
        mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
        writeFileSync(bridgeScript, EGRESS_BRIDGE_JS, { mode: 0o600 });
        const proxy = await EgressProxy.listenUnix(socket, { capability: entry.id, rules, onDecision });
        proxies.push(proxy);
        access = { kind: "unix", socket, runtime: process.execPath, bridgeScript };
      } else if (sandbox === "sandbox-exec") {
        const proxy = await EgressProxy.listenTcp({ capability: entry.id, rules, onDecision });
        proxies.push(proxy);
        access = { kind: "tcp", port: (proxy.address as { port: number }).port, token: proxy.token! };
      } else {
        throw new Error(`"${entry.id}" lists egress hosts, but no sandbox here can enforce them`);
      }
    }
    const options = { mode, network: access, home: sandboxHome(config.dataDir, entry.id), realHome: home, kind: sandbox, readOnlyPaths } as const;
    // First decide what the server may be handed, from the sandbox it will really get; only then read any secret.
    const posture = sandboxSpec(base, options);
    const names = entry.envFrom ?? [];
    const env = { ...base.env, ...broker.deliver(deliveryFor(entry, posture.isolation !== "none", posture.egress), names) };
    const wrapped = sandboxSpec({ ...base, env }, options);
    await mcp.add(wrapped.spec, trust, policy);
    return wrapped.isolation;
  };

  const memoryFilesDir=config.memory?.filesDir??join(config.dataDir,"memory");
  try{assertKeyDirectoryOutside(memoryFilesDir,[config.root]);}catch{runs.close();throw new ConfigError("Owner-editable memory files must live outside capability-writable workspace roots");}
  const embedding=config.memory?.embedding;
  const embeddingKey=embedding?.apiKeyEnv?resolveSecret(embedding.apiKeyEnv,secrets,deps.env):undefined;
  if(embedding?.apiKeyEnv&&!embeddingKey){runs.close();throw new ConfigError("Local embedding credential is unavailable; configure its secret reference");}
  let memory:MemoryStore;
  try {memory=new MemoryStore(join(config.dataDir, "memory.db"), { filesDir:memoryFilesDir,...(embedding?{embeddings:{client:new LocalEmbeddingClient({...embedding,apiKey:embeddingKey}),queryPrefix:embedding.queryPrefix,documentPrefix:embedding.documentPrefix}}:{}),containsSecret: (text) => secretValues().some((value) => value.length >= 6 && text.includes(value)) });}
  catch(error){runs.close();throw error;}
  const meta = new MetaExecutor({
    registry,
    registryClient,
    skillsDir: config.skillsDir,
    fetch: deps.fetch,
    takenIds: () => new Set([...configured.map((s) => s.id), ...registry.list().map((c) => c.manifest.id)]),
    fallback: new MemoryExecutor(memory, new BuiltinExecutor(config.root)),
    artifacts,
    containment: () => (sandbox === "none" ? { ok: false, reason: "no working sandbox was found (on Linux install bubblewrap)" } : { ok: true }),
    addServer: async (entry: McpServerConfig, plan: InstallPlan) => {
      configured.push(entry); registerCheckpointSecrets(entry);
      if (deps.configPath) {
        const current = loadConfig(deps.configPath);
        writeConfig(deps.configPath, { ...current, mcp: [...current.mcp, entry] });
      }
      const missing = [...plan.missing, ...broker.missing(deliveryFor(entry, true, "none"), [...(entry.envFrom ?? []), ...Object.values(entry.headersFrom ?? {})])];
      if (missing.length) {
        return `Saved "${entry.id}", but it needs ${missing.join(", ")} first. The person can run: ${missing.map((n) => `august secret set --for ${entry.id} ${n}`).join("; ")}. Then restart August.`;
      }
      const isolation = await startServer(entry);
      const tools = registry.get(entry.id)?.manifest.tools.map((t) => t.name) ?? [];
      return `Installed "${entry.id}" (${isolation === "none" ? "not sandboxed" : `sandbox: ${isolation}`}). New tools: ${tools.join(", ") || "none"}.`;
    },
  });
  meta.reloadSkills();
  mcp = new McpHost(registry, { fallback: meta });

  const journal = new EventJournal(join(config.dataDir, "journal.db"));
  // The journal's own hash chain can be recomputed by anyone who can edit the file. Signed anchors, kept beside the
  // key and outside the data folder, cannot: they are what a rewrite of history fails to match.
  let audit: AuditHandle;
  try {
    const master = loadMasterKey({ env: deps.env, keyDir, create: true });
    if (!master) throw new Error("no master key is available");
    const key = new AuditKey(deriveKey(master.key, "audit-ed25519"));
    const log = new AnchorLog(join(keyDir, "audit", "anchors.jsonl"));
    if (!verifyAudit(journal, log.list(), key.publicKeyBytes(), key.id).ok) throw new Error("journal or retained anchors do not verify; no new anchors were signed");
    const anchorer = new AuditAnchorer(journal, { log, key, automatic: !config.auditExternal });
    const publisher = new AuditPublisher(config, { env: deps.env, home, secrets }, journal, log, key, () => anchorer.anchor());
    audit = {
      enabled: true, keyId: key.id, publicKey: key.publicKeyBytes().toString("base64"), anchorLogPath: log.path,
      anchor: () => { if (config.auditExternal) throw new Error("external custody requires await audit.publish() before signing"); return anchorer.anchor(); }, anchors: () => log.list(),
      verify: () => verifyAudit(journal, log.list(), key.publicKeyBytes(), key.id),
      externalStatus: () => publisher.status(), publish: () => publisher.publish(), stop: () => publisher.stop(),
    };
  } catch (error) {
    const reason = (error as Error).message;
    const status = (): AuditExternalStatus => ({ state: config.auditExternal ? "unavailable" : "not-configured", anchoredThrough: 0, localThrough: journal.head()?.seq ?? 0 });
    audit = { enabled: false, reason, anchor: () => undefined, anchors: () => [], verify: () => ({ ok: false, chainBrokenAt: journal.verify(), anchors: 0, anchoredThrough: 0, unanchored: journal.head()?.seq ?? 0, problems: [`audit anchoring is off: ${reason}`] }), externalStatus: status, publish: async () => status(), stop: () => {} };
  }
  const verifierSet = new VerifierSet(builtinVerifiers({ root: config.root, skillsDir: config.skillsDir, registry }));
  const learning = new LearningStore(join(config.dataDir, "learning.db"), { verifiers: verifierSet.ids() });
  const patternStore = new PatternStore(join(config.dataDir, "patterns.db"));
  const distill = new DistillationEngine({ store: patternStore });
  const policy = new PolicyEngine();
  const registryHost = new URL(config.registryUrl).host;
  // Searching the public registry is routine; a standing mandate covers it (never from a tainted context).
  policy.mandates.grant({
    id: "registry-search",
    description: "search the MCP registry",
    effects: ["network"],
    tools: ["august.find_tools"],
    destinations: [registryHost],
    expiresAt: Number.MAX_SAFE_INTEGER,
  });

  const approver = new SessionApprover(deps.approver ?? denyAll);
  const approvals = deps.approvals ?? new ApprovalLedger();
  // A model-driven write may never touch the agent's own data, configuration, secrets or skills.
  const targetRoots: TargetRoots = { workspace: config.root, protectedPaths: [dirname(config.dataDir), config.dataDir, config.skillsDir, ...(deps.configPath ? [deps.configPath] : [])] };
  const expander = new LlmQueryExpander(llm);
  const agent = new AgentRuntime({
    registry,
    executor: mcp,
    decision: cascade,
    llm,
    policy,
    journal,
    approver,
    approvals,
    targetsOf: (tool, args) => targetsFor(targetRoots, tool, args),
    expandQuery: (t, controls) => expander.expand(t, controls),
    destinationOf: (tool) => (tool === "august.find_tools" ? registryHost : undefined),
  });

  const saveStats = () => {
    try {
      writeFileSync(statsPath, JSON.stringify(cascade.stats()), { mode: 0o600 });
    } catch {
      // statistics are best-effort
    }
  };

  const redactCheckpoint = (text: string) => secretValues().reduce((value, secret) => value.replaceAll(secret, "[redacted secret]"), text);

  type Active = { controller: AbortController; desired?: "paused" | "cancelled"; done: Promise<void>; finish: () => void };
  const active = new Map<string, Active>();
  const priorFor = (run: DurableRun): string[] => { const prior = runs.stateView(run.session); const i = prior.lastIndexOf(`User: ${run.request}`); if (i >= 0) prior.splice(i, 1); return prior; };
  /** With the owner's opt-in, keeps a short record of the run: the request, the tools used, how it ended. Never the tools' output. */
  const rememberRun = (run: DurableRun, reply: AgentReply): void => {
    if (!config.memory?.episodic) return;
    const tools = [...new Set(reply.trace?.executions.map((e) => e.tool) ?? [])];
    const outcome = reply.stopReason ? `stopped (${reply.stopReason})` : reply.error ? "failed" : "done";
    memory.remember({
      scope: run.session, class: "episodic", text: `Asked: ${run.request.slice(0, 400)} | tools: ${tools.join(", ") || "none"} | ${outcome}`,
      origin: { kind: "builtin", source: "run", locator: run.id }, sourceRun: run.id, trust: reply.tainted ? "untrusted" : "trusted", sensitivity: "personal",
      ttlMs: (config.memory.episodicDays ?? 90) * 86_400_000,
    });
  };
  /** Records what a run decided and did, then lets the host check what it can. A failure here never changes what the person gets. */
  const learnFrom = async (run: DurableRun, reply: AgentReply, seg: { startedAt: number; llmCalls: number; usageBefore: DurableRun["usage"]; route: Route }): Promise<string | undefined> => {
    if (!reply.trace || reply.trace.decisions.length === 0) return;
    try {
      const after = runs.getRun(run.id)!.usage; const id = learning.nextSegmentId(run.id);
      const stage = seg.route.plan && reply.compiled?.completed ? seg.route.stage : "llm";
      learning.recordRun({ runId: id, session: run.session, startedAt: seg.startedAt, finishedAt: Date.now(), stage, trace: reply.trace, usage: { llmCalls: seg.llmCalls, totalTokens: after.totalTokens - seg.usageBefore.totalTokens, costMicros: after.costMicros - seg.usageBefore.costMicros } });
      const checks = await verifierSet.verify(reply.trace.executions);
      for (const { decisionIndex, evidence } of checks) learning.addEvidence(id, decisionIndex, evidence);
      // The ladder learns from the same independent evidence: a run counts as verified only when every call was
      // confirmed by a host check and none was contradicted. The model's own "done" is never evidence.
      distill.observe({ runId: id, request: run.request, reply, route: seg.route });
      rememberRun(run, reply);
      const confirmed = new Set(checks.filter((c) => c.evidence.verdict === "success").map((c) => c.decisionIndex));
      if (checks.some((c) => c.evidence.verdict === "failure")) distill.settle(id, "failed");
      else if (reply.trace.executions.length > 0 && reply.trace.executions.every((e) => confirmed.has(e.decisionIndex))) distill.settle(id, "verified");
      return id;
    } catch (error) {
      journal.append({ kind: "learning.error", session: run.session, data: { name: (error as Error).name } });
    }
  };
  const execute = async (run: DurableRun, perMessage?: Approver, priorMessages?: string[], priorProvenance: { sources: string[]; sensitivity: "public" | "personal" | "secret" } = { sources: [], sensitivity: "public" }): Promise<DurableAgentReply> => {
    if (run.state === "recovering" && (!run.checkpoint?.safeToResume || run.checkpoint.phase === "tool_started")) throw new Error("run needs owner resolution before resume");
    const controller = new AbortController(); let finish!: () => void;
    const entry: Active = { controller, done: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish() };
    active.set(run.id, entry); if (perMessage) approver.bySession.set(run.session, perMessage);
    const segmentStart = Date.now(); const usageBefore = run.usage; let llmCalls = 0, receivedAttempt: string | undefined;
    let usageStop: "token-budget" | "cost-budget" | undefined = run.usage.totalTokens >= run.budget.maxTokens ? "token-budget" : run.usage.costMicros > 0 && run.usage.costMicros >= run.budget.maxCostMicros ? "cost-budget" : undefined;
    try {
      run = runs.transition(run.id, "running");
      const checkpoint = run.checkpoint as (AgentCheckpointState & typeof run.checkpoint) | undefined;
      if (checkpoint && (!checkpoint.taint || !checkpoint.loop || checkpoint.steps === undefined || checkpoint.externalEffects === undefined)) throw new Error("run checkpoint is missing safety state");
      // Only a fresh run may start from a learned pattern; a resumed one continues exactly where its checkpoint says.
      const route: Route = checkpoint ? { stage: "llm" } : distill.route(run.request, registry.enabledTools());
      // Notes the owner's own words put in memory go in front of the model. Anything written under untrusted influence does not: it is reachable only through memory.recall, where it taints the run.
      const notes = checkpoint || config.memory?.recall === false ? [] : await memory.recallHybrid({ scope: run.session, query: run.request, classes: ["semantic", "procedural", "working"], trustedOnly: true, limit: 4,signal:controller.signal });
      const noted = notes.map(({ entry }) => `Memory (${entry.class}, kept by the owner): ${entry.text}`);
      const sensitivity = notes.reduce<"public" | "personal" | "secret">((max, { entry }) => maxSensitivity(max, entry.sensitivity), priorProvenance.sensitivity);
      let reply = await agent.handle(run.session, run.request, {
        plan: route.plan, planReply: route.verbatim ? "verbatim" : "summarize", guidance: route.guidance,
        priorMessages: [...noted, ...(priorMessages ?? [])], priorTaint: { tainted: priorProvenance.sources.length > 0, sources: priorProvenance.sources, ...(sensitivity === "public" ? {} : { sensitivity }) }, checkpoint, signal: controller.signal, deadlineAt: run.createdAt + run.budget.maxWallMs,
        maxSteps: run.budget.maxSteps, maxExternalEffects: run.budget.maxExternalEffects, redactCheckpoint,
        onAttempt: event => {
          if (event.type === "started") {
            try{runs.beginModelAttempt(run.id, event, quoteForModelAttempt(config, event.provider, Boolean(deps.llm)));}
            catch(error){if(error instanceof BudgetAdmissionError)throw new RunControlError(error.reason);throw error;}
          }
          else {
            const attempt = runs.getModelAttempt(event.id);
            if (!attempt || attempt.runId !== run.id) throw new Error("model receipt belongs to another run");
            if (event.type === "receipt") { usageStop = runs.reportModelAttempt(event.id, event.usage).exhausted; receivedAttempt = event.id; }
            else runs.finishModelAttempt(event.id, event.outcome, event.reason);
          }
        },
        onUsage: async () => { if (!receivedAttempt) throw new Error("model usage has no durable attempt"); receivedAttempt = undefined; llmCalls += 1; },
        remainingTokens: (tool) => {
          const current=runs.getRun(run.id)!,s=runs.budgetSnapshot(),t=tool?s.tools[tool]:undefined;
          return Math.max(1,Math.min(current.budget.maxTokens-current.usage.totalTokens,s.daily.remainingTokens??Number.MAX_SAFE_INTEGER,t?.remainingTokens??Number.MAX_SAFE_INTEGER));
        },
        completionLimit: (provider, _model, tool) => {
          const quote=quoteForModelAttempt(config,provider,Boolean(deps.llm));
          const current=runs.getRun(run.id)!,s=runs.budgetSnapshot(),t=tool?s.tools[tool]:undefined;
          const available=[{reason:"cost-budget" as const,micros:Math.max(0,current.budget.maxCostMicros-current.usage.costMicros)},
            ...(s.daily.remainingCostMicros===undefined?[]:[{reason:"daily-budget" as const,micros:s.daily.remainingCostMicros}]),
            ...(t?.remainingCostMicros===undefined?[]:[{reason:"tool-budget" as const,micros:t.remainingCostMicros}])].sort((a,b)=>a.micros-b.micros)[0]!;
          if(quote.outputMicrosPerMillion===0)return Number.MAX_SAFE_INTEGER;
          const limit=Number(BigInt(available.micros)*1_000_000n/BigInt(quote.outputMicrosPerMillion));
          if(limit<1)throw new RunControlError(available.reason);
          return Math.min(Number.MAX_SAFE_INTEGER,limit);
        },
        usageExhaustion: () => usageStop,
        modelBudgetExhaustion: (tool) => {
          if (runs.modelAccounting(run.id).unknownCalls) return "billing-unknown";
          const current = runs.getRun(run.id)!;
          const s=runs.budgetSnapshot(),t=tool?s.tools[tool]:undefined;
          const primaryPaid=pricing.inputMicrosPerMillion>0||pricing.outputMicrosPerMillion>0;
          const backupPaid=config.llm.backup?.pricing?config.llm.backup.pricing.inputMicrosPerMillion>0||config.llm.backup.pricing.outputMicrosPerMillion>0:true;
          const paid=primaryPaid&&backupPaid; // Exact per-provider admission still occurs before its network request.
          if(s.daily.remainingTokens===0||paid&&s.daily.remainingCostMicros!==undefined&&(s.daily.remainingCostMicros===0||s.daily.unpricedCalls>0))return "daily-budget";
          if(t?.remainingCalls===0||t?.remainingTokens===0||paid&&t?.remainingCostMicros!==undefined&&(t.remainingCostMicros===0||t.unpricedCalls>0))return "tool-budget";
          return (pricing.inputMicrosPerMillion > 0 || pricing.outputMicrosPerMillion > 0) && current.usage.costMicros >= current.budget.maxCostMicros ? "cost-budget" : undefined;
        },
        toolBudgetExhaustion:(tool)=>{const s=runs.budgetSnapshot(),t=s.tools[tool];return t?.remainingCalls===0?"tool-budget":undefined;},
        beforeTool:(tool,argsHash)=>{const id=randomUUID();try{runs.beginToolAttempt(run.id,id,tool,argsHash);}catch(error){if(error instanceof BudgetAdmissionError)throw new RunControlError(error.reason);throw error;}return id;},
        afterTool:(id,disposition)=>runs.finishToolAttempt(id,disposition),
        onEvent: (event) => {
          if (event.type !== "checkpoint") return;
          runs.checkpoint(run.id, event);
          const current = runs.getRun(run.id)!;
          if (event.phase === "waiting_approval" && current.state === "running") runs.transition(run.id, "waiting_approval");
          else if (event.phase === "tool_started") { if (current.state === "waiting_approval") runs.transition(run.id, "running"); if (runs.getRun(run.id)!.state === "running") runs.transition(run.id, "waiting_external"); }
          else if (event.phase === "tool_finished" && current.state === "waiting_external") runs.transition(run.id, "running");
          else if (event.phase === "before_decision" && current.state === "waiting_approval") runs.transition(run.id, "running");
        },
      });
      const current = runs.getRun(run.id)!;
      if (entry.desired) reply = { ...reply, reply: `Stopped: ${entry.desired}.`, stopReason: "cancelled" };
      if (reply.stopReason) {
        const billingPause = reply.stopReason === "billing-unknown" && current.checkpoint?.safeToResume && current.checkpoint.phase !== "tool_started";
        const target = entry.desired ?? (reply.stopReason === "cancelled" ? "cancelled" : reply.stopReason === "provider-unavailable" ? "waiting_external" : billingPause ? "paused" : "failed");
        run = current.state === target ? current : runs.finishRun(run.id, target, reply.reply, { error: reply.stopReason, steps: reply.steps });
      } else if (reply.error) {
        run = runs.finishRun(run.id, "failed", reply.reply, { error: reply.error, steps: reply.steps });
      } else {
        run = runs.finishRun(run.id, "completed", reply.reply, { steps: reply.steps });
      }
      runs.clearSettledStop(run.id);
      const feedbackId = await learnFrom(run, reply, { startedAt: segmentStart, llmCalls, usageBefore, route });
      return { ...reply, runId: run.id, replayed: false, ...(run.state === "completed" && feedbackId ? { feedbackId } : {}) };
    } catch (error) {
      const current = runs.getRun(run.id);
      if (current && !["completed", "failed", "cancelled"].includes(current.state)) {
        const uncertain = current.checkpoint?.phase === "tool_started";
        if (entry.desired && (entry.desired === "cancelled" || !uncertain)) {
          runs.finishRun(run.id, entry.desired, uncertain ? "Cancelled further work. A started external effect may be uncertain." : `Stopped: ${entry.desired}.`, { error: (error as Error).message });
          runs.clearSettledStop(run.id);
        } else runs.transition(run.id, uncertain ? "recovering" : "failed", { error: (error as Error).message });
      }
      throw error;
    } finally { approver.bySession.delete(run.session); active.delete(run.id); entry.finish(); saveStats(); }
  };
  const stop = async (id: string, desired: "paused" | "cancelled"): Promise<DurableRun> => {
    const effective = runs.requestStop(id, desired);
    const entry = active.get(id);
    if (!entry) {
      const run = runs.getRun(id)!;
      const result = run.state === effective ? run : runs.transition(id, effective);
      runs.clearSettledStop(id); return result;
    }
    entry.desired = effective; entry.controller.abort(); await entry.done; return runs.getRun(id)!;
  };

  return {
    config,
    agent,
    journal,
    cascade,
    registry,
    policy,
    mcp,
    meta,
    runs,
    approvals,
    secrets,
    sandbox,
    async handle(session, text, perMessage, options = {}) {
      const started = runs.startRun({ session, request: text, ...options });
      if (started.replayed) { if (started.run.reply === undefined) throw new Error("completed run has no reply"); return { reply: started.run.reply, steps: started.run.steps, tainted: (started.run.checkpoint?.taint as { tainted?: boolean } | undefined)?.tainted === true, runId: started.run.id, replayed: true, feedbackId: learning.latestSegmentId(started.run.id) }; }
      const prior = runs.stateView(session); const priorProvenance = runs.provenance(session); runs.appendMessage(session, "user", text);
      return execute(started.run, perMessage, prior, priorProvenance);
    },
    getRun: (id) => runs.getRun(id),
    listRuns: (options = {}) => runs.listRuns(options.session, options.limit, options.states),
    pauseRun: (id) => stop(id, "paused"),
    cancelRun: (id) => stop(id, "cancelled"),
    resumeRun: async (id, perMessage) => {
      const run = runs.getRun(id), providerWait = run?.error === "provider-unavailable" && run.checkpoint?.providerRetryAt !== undefined;
      if (run?.checkpoint?.safeToResume === false || run?.checkpoint?.phase === "tool_started") throw new Error("run needs owner resolution before resume; resolve safety/billing first");
      if (!run || !(["paused", "recovering"].includes(run.state) || (run.state === "waiting_external" && providerWait)) || runs.modelAccounting(id).unresolvedCalls || (providerWait && Date.now() < run.checkpoint!.providerRetryAt!)) throw new Error("run is not resumable; resolve safety/billing first, or wait for provider cooldown");
      return execute(run, perMessage, priorFor(run), runs.provenance(run.session));
    },
    retryRun: async (id, options = {}, perMessage) => { const run = runs.retryRun(id, options).run; return execute(run, perMessage, priorFor(run), runs.provenance(run.session)); },
    resolveRun: (id, resolution) => runs.resolveRun(id, resolution),
    learning,
    feedback(session, segment, verdict, note) {
      // Only the person whose run it was can judge it: the session recorded with the run must be theirs.
      if (!segment || learning.sessionOf(segment) !== session) throw new Error("no such run for this session");
      recordOwnerFeedback(learning, segment, verdict, note);
      distill.settle(segment, verdict === "success" ? "verified" : "failed");
    },
    distill,
    memory,
    audit,
    providerHealth: () => provider instanceof FallbackProvider ? provider.health() : [],
    budgetSnapshot: () => runs.budgetSnapshot(),
    recalibrate() {
      const samples = calibrationSamples(learning.examples().examples, engineId);
      const table = fitCalibrationTable(samples, { engine: engineId });
      writeFileSync(calibrationPath, JSON.stringify(table, null, 2), { mode: 0o600 });
      laya?.setCalibration(table);
      return { samples: samples.length, segments: Object.keys(table.fits).length, table };
    },
    activationReport: () => evaluateActivation(learning.examples().examples.filter(example => engineOf(example) === engineId)),
    async startServers() {
      const report: StartReport = { started: [], failed: [] };
      for (const entry of config.mcp) {
        try {
          report.started.push({ id: entry.id, isolation: await startServer(entry) });
        } catch (error) {
          report.failed.push({ id: entry.id, error: (error as Error).message, ...((error as { diagnostics?: string }).diagnostics ? { diagnostics: (error as { diagnostics: string }).diagnostics } : {}) });
        }
      }
      return report;
    },
    close() {
      // Vouch for everything up to the last event before the journal is closed.
      if (!config.auditExternal) { try { audit.anchor(); } catch { /* the journal is still intact; the next run anchors it */ } }
      audit.stop();
      mcp.closeAll();
      if (nativeLaya) void nativeLaya.close();
      for (const proxy of proxies) void proxy.close();
      learning.close();
      patternStore.close();
      memory.close();
      saveStats();
      runs.close();
    },
  };
  } catch (error) { runs.close(); throw error; }
}
