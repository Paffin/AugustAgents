import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentRuntime, denyAll, type AgentReply, type Approver } from "@august/agent";
import {
  DecisionCascade,
  HeuristicEngine,
  LayaEngine,
  LlmChoiceEngine,
  LlmQueryExpander,
  OpenAiCompatibleProvider,
  layaHttpTransport,
  type DecisionEngine,
  type LlmProvider,
} from "@august/brain";
import { CapabilityRegistry } from "@august/capabilities";
import { EventJournal, type SessionKey } from "@august/core";
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

export interface App {
  config: AugustConfig;
  agent: AgentRuntime;
  journal: EventJournal;
  cascade: DecisionCascade;
  registry: CapabilityRegistry;
  policy: PolicyEngine;
  mcp: McpHost;
  meta: MetaExecutor;
  secrets: SecretStore;
  sandbox: SandboxKind;
  /** Handle one message and save the decision statistics. */
  handle(session: SessionKey, text: string, approver?: Approver): Promise<AgentReply>;
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
  return new OpenAiCompatibleProvider({ baseUrl: config.llm.baseUrl, model: config.llm.model, apiKey, fetch: deps.fetch });
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
  const llm = deps.llm ?? createLlm(config, deps, secrets);

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
      configured.push(entry);
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

  return {
    config,
    agent,
    journal,
    cascade,
    registry,
    policy,
    mcp,
    meta,
    secrets,
    sandbox,
    async handle(session, text, perMessage) {
      if (perMessage) approver.bySession.set(session, perMessage);
      try {
        return await agent.handle(session, text);
      } finally {
        approver.bySession.delete(session);
        saveStats();
      }
    },
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
      saveStats();
    },
  };
}
