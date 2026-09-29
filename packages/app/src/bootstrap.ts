import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentRuntime, denyAll, type AgentCheckpointState, type AgentReply, type Approver } from "@august/agent";
import {
  DecisionCascade,
  HeuristicEngine,
  LayaEngine,
  LlmChoiceEngine,
  LlmQueryExpander,
  MeteredProvider,
  OpenAiCompatibleProvider,
  RunMeter,
  withUsageMeter,
  layaHttpTransport,
  type DecisionEngine,
  type LlmProvider,
} from "@august/brain";
import { CapabilityRegistry } from "@august/capabilities";
import { DurableRuntimeStore, RunUsageLedger, UnsupportedBudgetError, type LedgerEntry, type RunUsageTotals, type DurableRun, type RunBudgetRequest, type RunState, EventJournal, type SessionKey } from "@august/core";
import { RegistryClient, type InstallPlan } from "@august/discovery";
import { McpHost, detectSandbox, sandboxHome, sandboxSpec, type SandboxKind } from "@august/mcp";
import { PolicyEngine } from "@august/policy";
import { BuiltinExecutor, builtinManifest, clockManifest } from "./builtins.ts";
import { ConfigError, loadConfig, writeConfig, type AugustConfig, type McpServerConfig } from "./config.ts";
import { JsonlDecisionLog } from "./decision-log.ts";
import { MetaExecutor, metaManifest } from "./meta.ts";
import { openSecretStore, resolveSecret, type SecretStore } from "./secrets.ts";

export interface AppDeps {
  env: Record<string, string | undefined>;
  approver?: Approver;
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

export interface StartReport {
  started: Array<{ id: string; isolation: string }>;
  failed: Array<{ id: string; error: string }>;
}

export interface HandleOptions { idempotencyKey?: string; budget?: RunBudgetRequest }
export interface DurableAgentReply extends AgentReply { runId: string; replayed: boolean }
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
  secrets: SecretStore;
  sandbox: SandboxKind;
  /** Handle one message and save the decision statistics. */
  handle(session: SessionKey, text: string, approver?: Approver, options?: HandleOptions): Promise<DurableAgentReply>;
  getRun(id: string): DurableRun | undefined;
  /** What the provider reported for this run, per call and in total. */
  runUsage(id: string): { totals: RunUsageTotals; entries: LedgerEntry[] };
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

function isLocal(baseUrl: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname);
}

export function createLlm(config: AugustConfig, deps: Pick<AppDeps, "env" | "fetch">, secrets?: SecretStore): LlmProvider {
  const keyName = config.llm.apiKeyEnv;
  const apiKey = keyName ? resolveSecret(keyName, secrets, deps.env) : undefined;
  if (keyName && !apiKey && !isLocal(config.llm.baseUrl)) {
    throw new ConfigError(`no API key: run "august secret set ${keyName}" (or export ${keyName})`);
  }
  return new OpenAiCompatibleProvider({ baseUrl: config.llm.baseUrl, model: config.llm.model, apiKey, fetch: deps.fetch, pricing: config.llm.pricing });
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

  const secrets = deps.secrets ?? openSecretStore(dirname(config.dataDir));
  const llm = new MeteredProvider(deps.llm ?? createLlm(config, deps, secrets));

  // Laya decides when a sidecar is configured; until then a heuristic stands in.
  // Either way the cascade starts in shadow mode and earns its way out.
  let primary: DecisionEngine = new HeuristicEngine();
  if (config.laya) primary = new LayaEngine(layaHttpTransport(config.laya.url, { fetch: deps.fetch }), { temperature: config.laya.temperature });
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
  registry.install(metaManifest, "verified");

  const sandbox = deps.sandboxKind ?? detectSandbox();
  const registryClient = new RegistryClient(config.registryUrl, deps.fetch);
  const configured = [...config.mcp];
  const checkpointSecretNames = new Set([config.llm.apiKeyEnv, config.channels.telegram?.tokenSecret].filter((name): name is string => Boolean(name)));
  const registerCheckpointSecrets = (entry: McpServerConfig) => { for (const name of [...(entry.envFrom ?? []), ...Object.values(entry.headersFrom ?? {})]) checkpointSecretNames.add(name); };
  configured.forEach(registerCheckpointSecrets);

  let mcp!: McpHost;
  const startServer = async (entry: McpServerConfig): Promise<string> => {
    const trust = entry.trust ?? "community";
    if (entry.url) {
      const headers: Record<string, string> = {};
      for (const [header, name] of Object.entries(entry.headersFrom ?? {})) {
        const value = resolveSecret(name, secrets, deps.env);
        if (value === undefined) throw new Error(`secret ${name} is not set (august secret set ${name})`);
        headers[header] = value;
      }
      await mcp.add({ id: entry.id, url: entry.url, headers }, trust);
      return "remote";
    }
    const env: Record<string, string> = { ...entry.env };
    for (const name of entry.envFrom ?? []) {
      const value = resolveSecret(name, secrets, deps.env);
      if (value === undefined) throw new Error(`${name} is not set (august secret set ${name})`);
      env[name] = value;
    }
    const wrapped = sandboxSpec(
      { id: entry.id, command: entry.command!, args: entry.args, env },
      {
        mode: entry.sandbox ?? config.sandbox,
        network: entry.network ?? true,
        home: sandboxHome(config.dataDir, entry.id),
        realHome: home,
        kind: sandbox,
      },
    );
    await mcp.add(wrapped.spec, trust);
    return wrapped.isolation;
  };

  const meta = new MetaExecutor({
    registry,
    registryClient,
    skillsDir: config.skillsDir,
    fetch: deps.fetch,
    takenIds: () => new Set([...configured.map((s) => s.id), ...registry.list().map((c) => c.manifest.id)]),
    fallback: new BuiltinExecutor(config.root),
    addServer: async (entry: McpServerConfig, plan: InstallPlan) => {
      configured.push(entry); registerCheckpointSecrets(entry);
      if (deps.configPath) {
        const current = loadConfig(deps.configPath);
        writeConfig(deps.configPath, { ...current, mcp: [...current.mcp, entry] });
      }
      const missing = [...plan.missing, ...plan.secrets.map((s) => s.name).filter((n) => resolveSecret(n, secrets, deps.env) === undefined)];
      if (missing.length) {
        return `Saved "${entry.id}", but it needs ${missing.join(", ")} first. The person can run: ${missing.map((n) => `august secret set ${n}`).join("; ")}. Then restart August.`;
      }
      const isolation = await startServer(entry);
      const tools = registry.get(entry.id)?.manifest.tools.map((t) => t.name) ?? [];
      return `Installed "${entry.id}" (${isolation === "none" ? "not sandboxed" : `sandbox: ${isolation}`}). New tools: ${tools.join(", ") || "none"}.`;
    },
  });
  meta.reloadSkills();
  mcp = new McpHost(registry, { fallback: meta });

  const journal = new EventJournal(join(config.dataDir, "journal.db"));
  const runs = new DurableRuntimeStore(join(config.dataDir, "runtime.db"));
  const usage = new RunUsageLedger(join(config.dataDir, "usage.db"));
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
  const expander = new LlmQueryExpander(llm);
  const agent = new AgentRuntime({
    registry,
    executor: mcp,
    decision: cascade,
    llm,
    policy,
    journal,
    approver,
    expandQuery: (t) => expander.expand(t),
    destinationOf: (tool) => (tool === "august.find_tools" ? registryHost : undefined),
  });

  const saveStats = () => {
    try {
      writeFileSync(statsPath, JSON.stringify(cascade.stats()), { mode: 0o600 });
    } catch {
      // statistics are best-effort
    }
  };

  const redactCheckpoint = (text: string) => [...checkpointSecretNames].reduce((value, name) => { const secret = resolveSecret(name, secrets, deps.env); return secret ? value.replaceAll(secret, "[redacted secret]") : value; }, text);

  const withDefaultBudget = (budget: RunBudgetRequest = {}): RunBudgetRequest => {
    const merged = { ...config.runBudget, ...budget };
    if (merged.maxCostMicros !== undefined && !config.llm.pricing) throw new UnsupportedBudgetError("monetary", "needs llm.pricing");
    return merged;
  };
  type Active = { controller: AbortController; desired?: "paused" | "cancelled"; done: Promise<void>; finish: () => void };
  const active = new Map<string, Active>();
  const priorFor = (run: DurableRun): string[] => { const prior = runs.stateView(run.session); const i = prior.lastIndexOf(`User: ${run.request}`); if (i >= 0) prior.splice(i, 1); return prior; };
  const execute = async (run: DurableRun, perMessage?: Approver, priorMessages?: string[], priorTaintSources: string[] = []): Promise<DurableAgentReply> => {
    if (run.state === "recovering" && (!run.checkpoint?.safeToResume || run.checkpoint.phase === "tool_started")) throw new Error("run needs owner resolution before resume");
    const controller = new AbortController(); let finish!: () => void;
    const entry: Active = { controller, done: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish() };
    active.set(run.id, entry); if (perMessage) approver.bySession.set(run.session, perMessage);
    try {
      run = runs.transition(run.id, "running");
      const checkpoint = run.checkpoint as (AgentCheckpointState & typeof run.checkpoint) | undefined;
      if (checkpoint && (!checkpoint.taint || !checkpoint.loop || checkpoint.steps === undefined || checkpoint.externalEffects === undefined)) throw new Error("run checkpoint is missing safety state");
      const meter = new RunMeter({ limits: { maxTokens: run.budget.maxTokens, maxCostMicros: run.budget.maxCostMicros }, totals: usage.totals(run.id), persist: (u) => usage.append(run.id, u), persistUnreported: (provider) => usage.appendUnreported(run.id, provider) });
      let reply = await withUsageMeter(meter, () => agent.handle(run.session, run.request, {
        priorMessages, priorTaint: { tainted: priorTaintSources.length > 0, sources: priorTaintSources }, checkpoint, signal: controller.signal, deadlineAt: run.createdAt + run.budget.maxWallMs,
        maxSteps: run.budget.maxSteps, maxExternalEffects: run.budget.maxExternalEffects, redactCheckpoint,
        onEvent: (event) => {
          if (event.type !== "checkpoint") return;
          runs.checkpoint(run.id, event);
          const current = runs.getRun(run.id)!;
          if (event.phase === "waiting_approval" && current.state === "running") runs.transition(run.id, "waiting_approval");
          else if (event.phase === "tool_started") { if (current.state === "waiting_approval") runs.transition(run.id, "running"); if (runs.getRun(run.id)!.state === "running") runs.transition(run.id, "waiting_external"); }
          else if (event.phase === "tool_finished" && current.state === "waiting_external") runs.transition(run.id, "running");
          else if (event.phase === "before_decision" && current.state === "waiting_approval") runs.transition(run.id, "running");
        },
      }));
      const current = runs.getRun(run.id)!;
      if (entry.desired) reply = { ...reply, reply: `Stopped: ${entry.desired}.`, stopReason: "cancelled" };
      if (reply.stopReason) {
        const target = entry.desired ?? (reply.stopReason === "cancelled" ? "cancelled" : "failed");
        run = current.state === target ? current : runs.finishRun(run.id, target, reply.reply, { error: reply.stopReason, steps: reply.steps });
      } else if (reply.error) {
        run = runs.finishRun(run.id, "failed", reply.reply, { error: reply.error, steps: reply.steps });
      } else {
        run = runs.finishRun(run.id, "completed", reply.reply, { steps: reply.steps });
      }
      return { ...reply, runId: run.id, replayed: false };
    } catch (error) {
      const current = runs.getRun(run.id); if (current && !["completed", "failed", "cancelled"].includes(current.state)) runs.transition(run.id, current.checkpoint?.phase === "tool_started" && !current.checkpoint.safeToResume ? "recovering" : "failed", { error: (error as Error).message });
      throw error;
    } finally { approver.bySession.delete(run.session); active.delete(run.id); entry.finish(); saveStats(); }
  };
  const stop = async (id: string, desired: "paused" | "cancelled"): Promise<DurableRun> => {
    const entry = active.get(id); if (!entry) { const run = runs.getRun(id); if (!run) throw new Error(`unknown run ${id}`); return runs.transition(id, desired); }
    entry.desired = desired; entry.controller.abort(); await entry.done; return runs.getRun(id)!;
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
    secrets,
    sandbox,
    async handle(session, text, perMessage, options = {}) {
      const started = runs.startRun({ session, request: text, budget: withDefaultBudget(options.budget), ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });
      if (started.replayed) { if (started.run.reply === undefined) throw new Error("completed run has no reply"); return { reply: started.run.reply, steps: started.run.steps, tainted: (started.run.checkpoint?.taint as { tainted?: boolean } | undefined)?.tainted === true, runId: started.run.id, replayed: true }; }
      const prior = runs.stateView(session); const priorTaintSources = runs.taintSources(session); runs.appendMessage(session, "user", text);
      return execute(started.run, perMessage, prior, priorTaintSources);
    },
    getRun: (id) => runs.getRun(id),
    runUsage: (id) => ({ totals: usage.totals(id), entries: usage.entries(id) }),
    listRuns: (options = {}) => runs.listRuns(options.session, options.limit, options.states),
    pauseRun: (id) => stop(id, "paused"),
    cancelRun: (id) => stop(id, "cancelled"),
    resumeRun: async (id, perMessage) => { const run = runs.getRun(id); if (!run || !["paused", "recovering"].includes(run.state)) throw new Error("run is not resumable"); return execute(run, perMessage, priorFor(run), runs.taintSources(run.session)); },
    retryRun: async (id, options = {}, perMessage) => { const run = runs.retryRun(id, { ...options, budget: options.budget ? withDefaultBudget(options.budget) : undefined }).run; return execute(run, perMessage, priorFor(run), runs.taintSources(run.session)); },
    resolveRun: (id, resolution) => runs.resolveRun(id, resolution),
    async startServers() {
      const report: StartReport = { started: [], failed: [] };
      for (const entry of config.mcp) {
        try {
          report.started.push({ id: entry.id, isolation: await startServer(entry) });
        } catch (error) {
          report.failed.push({ id: entry.id, error: (error as Error).message });
        }
      }
      return report;
    },
    close() {
      mcp.closeAll();
      runs.close();
      usage.close();
      saveStats();
    },
  };
}
