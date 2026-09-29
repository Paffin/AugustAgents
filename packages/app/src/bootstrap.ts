import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntime, denyAll, type Approver } from "@august/agent";
import {
  DecisionCascade,
  HeuristicEngine,
  LlmChoiceEngine,
  OpenAiCompatibleProvider,
  type LlmProvider,
} from "@august/brain";
import { CapabilityRegistry } from "@august/capabilities";
import { EventJournal } from "@august/core";
import { McpHost } from "@august/mcp";
import { PolicyEngine } from "@august/policy";
import { BuiltinExecutor, builtinManifest, clockManifest } from "./builtins.ts";
import { ConfigError, type AugustConfig } from "./config.ts";
import { JsonlDecisionLog } from "./decision-log.ts";

export interface AppDeps {
  env: Record<string, string | undefined>;
  approver?: Approver;
  /** Replace the network LLM, for tests. */
  llm?: LlmProvider;
  fetch?: typeof fetch;
}

export interface App {
  agent: AgentRuntime;
  journal: EventJournal;
  cascade: DecisionCascade;
  registry: CapabilityRegistry;
  policy: PolicyEngine;
  mcp: McpHost;
  /** Start the MCP servers from the config. One failing server never stops the others. */
  startServers(): Promise<{ started: string[]; failed: Array<{ id: string; error: string }> }>;
}

function isLocal(baseUrl: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname);
}

export function createLlm(config: AugustConfig, deps: Pick<AppDeps, "env" | "fetch">): LlmProvider {
  const keyName = config.llm.apiKeyEnv;
  const apiKey = keyName ? deps.env[keyName] : undefined;
  if (keyName && !apiKey && !isLocal(config.llm.baseUrl)) {
    throw new ConfigError(`set ${keyName} in your environment (the key is never stored in the config file)`);
  }
  return new OpenAiCompatibleProvider({ baseUrl: config.llm.baseUrl, model: config.llm.model, apiKey, fetch: deps.fetch });
}

/**
 * Wires everything together. Laya is not connected yet, so the cascade runs in
 * shadow mode: the LLM decides, the heuristic engine is measured against it, and
 * every untainted decision is saved as training data.
 */
export function createApp(config: AugustConfig, deps: AppDeps): App {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.root, { recursive: true });

  const llm = deps.llm ?? createLlm(config, deps);
  const cascade = new DecisionCascade({
    primary: new HeuristicEngine(),
    fallback: new LlmChoiceEngine(llm),
    shadow: true,
    log: new JsonlDecisionLog(join(config.dataDir, "decisions.jsonl")),
  });

  const registry = new CapabilityRegistry();
  registry.install(builtinManifest, "verified");
  registry.install(clockManifest, "verified");

  const mcp = new McpHost(registry, { fallback: new BuiltinExecutor(config.root) });
  const journal = new EventJournal(join(config.dataDir, "journal.db"));
  const policy = new PolicyEngine();
  const agent = new AgentRuntime({
    registry,
    executor: mcp,
    decision: cascade,
    llm,
    policy,
    journal,
    approver: deps.approver ?? denyAll,
  });
  const startServers = async () => {
    const started: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const server of config.mcp) {
      try {
        const env: Record<string, string> = { ...server.env };
        for (const name of server.envFrom ?? []) {
          const value = deps.env[name];
          if (value === undefined) throw new Error(`${name} is not set`);
          env[name] = value;
        }
        await mcp.add({ id: server.id, command: server.command, args: server.args, env }, server.trust ?? "community");
        started.push(server.id);
      } catch (error) {
        failed.push({ id: server.id, error: (error as Error).message });
      }
    }
    return { started, failed };
  };
  return { agent, journal, cascade, registry, policy, mcp, startServers };
}
