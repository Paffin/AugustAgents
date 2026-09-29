import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalRequest, Approver } from "@august/agent";
import { makeSessionKey } from "@august/core";
import { startGateway, type RunningGateway } from "@august/gateway";
import { createApp, type App, type AppDeps } from "./bootstrap.ts";
import { ConfigError, defaultConfig, defaultConfigPath, loadConfig, writeConfig } from "./config.ts";

export interface CliIo {
  print(line: string): void;
  /** Prompt the person. null means the input has ended. */
  ask(prompt: string): Promise<string | null>;
  env: Record<string, string | undefined>;
  home: string;
  fetch?: typeof fetch;
  /** Replace the network LLM, for tests. */
  llm?: AppDeps["llm"];
}

export interface CliResult {
  code: number;
  gateway?: RunningGateway;
}

const HELP = `august: a local agent that decides with Laya and acts with your tools

  august init [--force]   create ~/.august/config.json and your August folder
  august chat             talk to the agent in this terminal
  august serve            start the local HTTP gateway (loopback only)
`;

function clip(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 80 ? `${s.slice(0, 80)}...` : s;
}

export function terminalApprover(io: Pick<CliIo, "print" | "ask">): Approver {
  return {
    async approve(request: ApprovalRequest): Promise<boolean> {
      io.print(`\n? ${request.tool} wants to run: ${request.verdict.reason}`);
      for (const [k, v] of Object.entries(request.args)) io.print(`    ${k}: ${clip(v)}`);
      const answer = await io.ask("  Allow once? [y/N] ");
      return answer?.trim().toLowerCase() === "y";
    },
  };
}

export async function main(argv: readonly string[], io: CliIo): Promise<CliResult> {
  const [command, ...flags] = argv;
  const configPath = defaultConfigPath(io.home);
  try {
    switch (command) {
      case "init":
        return init(configPath, flags.includes("--force"), io);
      case "chat":
        return await chat(configPath, io);
      case "serve":
        return await serve(configPath, io);
      default:
        io.print(HELP);
        return { code: command === undefined || command === "help" || command === "--help" ? 0 : 1 };
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      io.print(`Error: ${error.message}`);
      return { code: 1 };
    }
    throw error;
  }
}

function init(configPath: string, force: boolean, io: CliIo): CliResult {
  if (existsSync(configPath) && !force) {
    io.print(`Config already exists at ${configPath}. Use --force to replace it (this creates a new gateway token).`);
    return { code: 1 };
  }
  const config = defaultConfig(io.home);
  writeConfig(configPath, config);
  mkdirSync(config.root, { recursive: true });
  const welcome = join(config.root, "welcome.md");
  if (!existsSync(welcome)) writeFileSync(welcome, "# Welcome\n\nPut notes here. The agent can read files in this folder and nowhere else.\n");
  io.print(`Created ${configPath}`);
  io.print(`Your folder: ${config.root}`);
  io.print(`Next: export ${config.llm.apiKeyEnv}=<your key>, then run "august chat".`);
  return { code: 0 };
}

async function chat(configPath: string, io: CliIo): Promise<CliResult> {
  const config = loadConfig(configPath);
  const app = createApp(config, { env: io.env, fetch: io.fetch, llm: io.llm, approver: terminalApprover(io) });
  const { agent } = app;
  await reportServers(app, io);
  const session = makeSessionKey({ workspace: config.workspace, channel: "cli", user: "local" });
  io.print('Ready. Type "exit" to quit.');
  for (;;) {
    const line = await io.ask("you> ");
    if (line === null || line.trim() === "exit") break;
    if (line.trim() === "") continue;
    try {
      const { reply } = await agent.handle(session, line);
      io.print(reply);
    } catch {
      io.print("Something went wrong.");
    }
  }
  app.mcp.closeAll();
  return { code: 0 };
}

async function reportServers(app: App, io: CliIo): Promise<void> {
  const { started, failed } = await app.startServers();
  if (started.length) io.print(`Tools from: ${started.join(", ")}`);
  for (const f of failed) io.print(`Could not start "${f.id}": ${f.error}`);
}

async function serve(configPath: string, io: CliIo): Promise<CliResult> {
  const config = loadConfig(configPath);
  // No one is at a terminal to approve here, so controlled actions are refused.
  const app = createApp(config, { env: io.env, fetch: io.fetch, llm: io.llm });
  const { agent } = app;
  await reportServers(app, io);
  const inner = startGateway({
    hostname: "127.0.0.1",
    port: config.gateway.port,
    token: config.gateway.token,
    workspace: config.workspace,
    onMessage: async ({ session, text }) => ({ reply: (await agent.handle(session, text)).reply }),
  });
  const gateway: RunningGateway = {
    port: inner.port,
    stop: () => {
      inner.stop();
      app.mcp.closeAll();
    },
  };
  io.print(`Gateway on http://127.0.0.1:${gateway.port} (token is in ${configPath})`);
  return { code: 0, gateway };
}
