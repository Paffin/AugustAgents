import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalRequest, Approver } from "@august/agent";
import { DecisionCascade, HeuristicEngine } from "@august/brain";
import { PendingApprovals, TelegramChannel, WEB_HTML, WEB_JS } from "@august/channels";
import { LaneQueue, makeSessionKey } from "@august/core";
import { startGateway, type RunningGateway } from "@august/gateway";
import { detectSandbox, type SandboxKind } from "@august/mcp";
import { createApp, type App, type AppDeps } from "./bootstrap.ts";
import { ConfigError, EGRESS_ENTRY, defaultConfig, defaultConfigPath, loadConfig, parseConfig, writeConfig, type AugustConfig, type LlmPricing } from "./config.ts";
import { SECRET_NAME, openSecretStore, resolveSecret, scopedSecretName, type SecretStore } from "./secrets.ts";

export interface CliIo {
  print(line: string): void;
  /** Prompt the person. null means the input has ended. */
  ask(prompt: string): Promise<string | null>;
  env: Record<string, string | undefined>;
  home: string;
  fetch?: typeof fetch;
  /** Replace the network LLM, for tests. */
  llm?: AppDeps["llm"];
  secrets?: SecretStore;
  sandboxKind?: SandboxKind;
}

export interface CliResult {
  code: number;
  gateway?: RunningGateway;
  stop?: () => void;
}

const HELP = `august: a local agent that decides with Laya and acts with your tools

  august setup                 guided setup: model, key, channel (3 questions)
  august init [--force]        write a default config without questions
  august chat                  talk to the agent in this terminal
  august serve                 web chat + API on 127.0.0.1, Telegram if configured
  august doctor                check that everything is in place

  august secret set NAME       store a secret (API keys, tokens)
  august secret set --for TOOL NAME   a secret only that installed tool can receive
  august secret list | rm NAME
  august mcp list | rm ID | allow ID HOST... | deny ID      configured MCP servers
  august skills                installed skills
  august laya status | activate [--force]
  august calibrate             fit Laya's confidence on verified outcomes (per question, language, option count)
  august learn status | report | export FILE | feedback RUN good|bad [note]   verified outcomes and training data
  august patterns [list] | show ID | approve ID | disable ID | enable ID | forget ID   repeated work August has learned to do without asking the model
`;

function clip(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 80 ? `${s.slice(0, 80)}...` : s;
}

export function terminalApprover(io: Pick<CliIo, "print" | "ask">): Approver {
  return {
    channel: "terminal",
    async approve(request: ApprovalRequest): Promise<boolean> {
      io.print(`\n? ${request.tool} wants to run: ${request.verdict.reason} (request ${request.ticket.id})`);
      if (request.details) io.print(`  ${request.details}`);
      for (const [k, v] of Object.entries(request.args)) io.print(`    ${k}: ${clip(v)}`);
      const answer = await io.ask("  Allow once? [y/N] ");
      return answer?.trim().toLowerCase() === "y";
    },
  };
}

function storeFor(io: CliIo): SecretStore {
  return io.secrets ?? openSecretStore(join(io.home, ".august"));
}

function appDeps(io: CliIo, configPath: string, approver?: Approver): AppDeps {
  return { env: io.env, fetch: io.fetch, llm: io.llm, approver, secrets: storeFor(io), configPath, sandboxKind: io.sandboxKind, home: io.home };
}

export async function main(argv: readonly string[], io: CliIo): Promise<CliResult> {
  const [command, ...rest] = argv;
  const configPath = defaultConfigPath(io.home);
  try {
    switch (command) {
      case "init":
        return init(configPath, rest.includes("--force"), io);
      case "setup":
        return await setup(configPath, io);
      case "chat":
        return await chat(configPath, io);
      case "serve":
        return await serve(configPath, io);
      case "doctor":
        return await doctor(configPath, io);
      case "secret":
        return await secret(rest, io);
      case "mcp":
        return mcp(configPath, rest, io);
      case "skills":
        return skills(configPath, io);
      case "laya":
        return laya(configPath, rest, io);
      case "calibrate":
        return calibrate(configPath, io);
      case "learn":
        return learn(configPath, rest, io);
      case "patterns":
        return patterns(configPath, rest, io);
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

function writeWelcome(config: AugustConfig): void {
  mkdirSync(config.root, { recursive: true });
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const welcome = join(config.root, "welcome.md");
  if (!existsSync(welcome)) writeFileSync(welcome, "# Welcome\n\nPut notes here. The agent can read files in this folder and nowhere else.\n");
}

function init(configPath: string, force: boolean, io: CliIo): CliResult {
  if (existsSync(configPath) && !force) {
    io.print(`Config already exists at ${configPath}. Use --force to replace it (this creates a new gateway token).`);
    return { code: 1 };
  }
  const config = defaultConfig(io.home);
  writeConfig(configPath, config);
  writeWelcome(config);
  io.print(`Created ${configPath}`);
  io.print(`Your folder: ${config.root}`);
  io.print(`Next: august secret set ${config.llm.apiKeyEnv}, then run "august chat".`);
  return { code: 0 };
}

interface Provider {
  label: string;
  baseUrl: string;
  keyName?: string;
  model: string;
  pricing: LlmPricing;
}

export const PROVIDERS: Provider[] = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyName: "OPENAI_API_KEY", model: "gpt-4o-mini", pricing: { inputMicrosPerMillion: 150_000, outputMicrosPerMillion: 600_000, source: "https://developers.openai.com/api/docs/models/gpt-4o-mini", asOf: "2026-09-29" } },
  { label: "OpenRouter (many models, one key)", baseUrl: "https://openrouter.ai/api/v1", keyName: "OPENROUTER_API_KEY", model: "qwen/qwen3-32b", pricing: { inputMicrosPerMillion: 80_000, outputMicrosPerMillion: 280_000, source: "https://openrouter.ai/qwen/qwen3-32b/", asOf: "2026-09-29" } },
  { label: "Ollama on this computer (no key, fully local)", baseUrl: "http://localhost:11434/v1", model: "qwen3", pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, source: "local API price", asOf: "2026-09-29" } },
];

async function choose(io: CliIo, question: string, options: string[]): Promise<number | null> {
  io.print(question);
  options.forEach((o, i) => io.print(`  ${i + 1}) ${o}`));
  for (let tries = 0; tries < 3; tries++) {
    const a = await io.ask("> ");
    if (a === null) return null;
    const n = Number(a.trim() || "1");
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    io.print(`Type a number from 1 to ${options.length}.`);
  }
  return null;
}

/**
 * The three touches after install: which model, its key, which channel.
 * Everything else has a safe default.
 */
async function setup(configPath: string, io: CliIo): Promise<CliResult> {
  const store = storeFor(io);
  const base = existsSync(configPath) ? loadConfig(configPath) : defaultConfig(io.home);

  const p = await choose(io, "1/3 Which model should write and plan?", [...PROVIDERS.map((x) => x.label), "Another OpenAI-compatible endpoint"]);
  if (p === null) return { code: 1 };
  let provider: Provider;
  if (p < PROVIDERS.length) {
    provider = PROVIDERS[p]!;
  } else {
    const url = (await io.ask("Base URL (https://.../v1): "))?.trim();
    if (!url) return { code: 1 };
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); let pricing: LlmPricing = { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, source: "local API price", asOf: new Date().toISOString().slice(0, 10) };
    if (!local) { const rates = (await io.ask("Input/output microdollars per million tokens (e.g. 100000/400000): "))?.trim().split(/[\s,/]+/).map(Number); if (!rates || rates.length !== 2 || rates.some((n) => !Number.isSafeInteger(n) || n <= 0)) { io.print("Remote pricing needs two positive integer rates."); return { code: 1 }; } pricing = { inputMicrosPerMillion: rates[0]!, outputMicrosPerMillion: rates[1]!, source: url, asOf: new Date().toISOString().slice(0, 10) }; }
    provider = { label: "custom", baseUrl: url, keyName: local ? undefined : "LLM_API_KEY", model: "", pricing };
  }
  const model = (await io.ask(`Model [${provider.model || "required"}]: `))?.trim() || provider.model;
  if (!model) return { code: 1 };

  if (provider.keyName) {
    const existing = resolveSecret(provider.keyName, store, io.env);
    const key = (await io.ask(`2/3 ${provider.keyName}${existing ? " [press Enter to keep the saved one]" : ""}: `))?.trim();
    if (key) store.set(provider.keyName, key);
    else if (!existing) {
      io.print("A key is needed for this provider.");
      return { code: 1 };
    }
  } else {
    io.print("2/3 No key needed for a local model.");
  }

  const c = await choose(io, "3/3 Where will you talk to August?", ["Terminal and browser on this computer", "Also Telegram"]);
  if (c === null) return { code: 1 };
  let channels = base.channels;
  if (c === 1) {
    const token = (await io.ask("Telegram bot token (from @BotFather): "))?.trim();
    const user = Number((await io.ask("Your Telegram user id (ask @userinfobot): "))?.trim());
    if (!token || !Number.isInteger(user) || user <= 0) {
      io.print("Telegram needs a bot token and your numeric user id.");
      return { code: 1 };
    }
    store.set("TELEGRAM_BOT_TOKEN", token);
    channels = { ...channels, telegram: { tokenSecret: "TELEGRAM_BOT_TOKEN", allowedUsers: [user] } };
  }

  const config = parseConfig({ ...base, llm: { baseUrl: provider.baseUrl, model, apiKeyEnv: provider.keyName, pricing: provider.pricing }, channels });
  writeConfig(configPath, config);
  writeWelcome(config);
  io.print("");
  io.print(`Done. Secrets are in your ${store.kind === "file" ? "private secrets file" : store.kind}.`);
  io.print('Start with "august chat", or "august serve" for the browser' + (c === 1 ? " and Telegram." : "."));
  return { code: 0 };
}

async function reportServers(app: App, io: CliIo): Promise<void> {
  const { started, failed } = await app.startServers();
  if (started.length) io.print(`Tools from: ${started.map((s) => (s.isolation === "none" ? `${s.id} (not sandboxed)` : s.id)).join(", ")}`);
  for (const f of failed) io.print(`Could not start "${f.id}": ${f.error}`);
}

async function chat(configPath: string, io: CliIo): Promise<CliResult> {
  const config = loadConfig(configPath);
  const app = createApp(config, appDeps(io, configPath, terminalApprover(io)));
  await reportServers(app, io);
  const session = makeSessionKey({ workspace: config.workspace, channel: "cli", user: "local" });
  io.print('Ready. Type "exit" to quit. After an answer, /good or /bad [why] tells August whether it was right.');
  let lastRun: string | undefined;
  for (;;) {
    const line = await io.ask("you> ");
    if (line === null || line.trim() === "exit") break;
    if (line.trim() === "") continue;
    const verdict = /^\/(good|bad)(?:\s+(.*))?$/.exec(line.trim());
    if (verdict) {
      try {
        if (!lastRun) throw new Error("nothing to judge yet");
        app.feedback(session, lastRun, verdict[1] === "good" ? "success" : "failure", verdict[2]);
        io.print("Noted. Thank you.");
      } catch (error) {
        io.print(/already gave/.test((error as Error).message) ? "You already told me about that answer." : "There is no answer to judge yet.");
      }
      continue;
    }
    try {
      const { reply, runId } = await app.handle(session, line);
      lastRun = runId;
      io.print(reply);
    } catch {
      io.print("Something went wrong.");
    }
  }
  app.close();
  return { code: 0 };
}

async function serve(configPath: string, io: CliIo): Promise<CliResult> {
  const config = loadConfig(configPath);
  const app = createApp(config, appDeps(io, configPath));
  await reportServers(app, io);
  const approvals = new PendingApprovals(app.approvals);
  const queue = new LaneQueue();

  let inner: RunningGateway;
  try {
    inner = startGateway({
    hostname: "127.0.0.1",
    port: config.gateway.port,
    token: config.gateway.token,
    workspace: config.workspace,
    queue,
    // Telegram answers only through Telegram: a browser token must not be able to answer its approvals.
    approvals: approvals.forGateway(["telegram"]),
    webUi: config.channels.web ? { html: WEB_HTML, js: WEB_JS } : undefined,
    // The browser polls /v1/pending, so the prompt itself needs no push.
    onMessage: async ({ session, text }) => { const r = await app.handle(session, text, approvals.approverFor(() => {})); return { reply: r.reply, runId: r.runId }; },
    feedback: ({ session, runId, verdict, note }) => app.feedback(session, runId, verdict, note),
  });
  } catch (error) {
    app.close();
    const busy = (error as NodeJS.ErrnoException).code === "EADDRINUSE" || /in use/i.test((error as Error).message);
    io.print(busy ? `Port ${config.gateway.port} is busy: is August already running? (change gateway.port in ${configPath})` : `Could not start the gateway: ${(error as Error).message}`);
    return { code: 1 };
  }

  let telegram: TelegramChannel | undefined;
  if (config.channels.telegram) {
    const token = resolveSecret(config.channels.telegram.tokenSecret, app.secrets, io.env);
    if (!token) {
      io.print(`Telegram is configured but ${config.channels.telegram.tokenSecret} is not set.`);
    } else {
      telegram = new TelegramChannel({
        token,
        workspace: config.workspace,
        allowedUsers: config.channels.telegram.allowedUsers,
        approvals,
        fetch: io.fetch,
        handle: (session, text, approver) => app.handle(session, text, approver),
        feedback: (session, runId, verdict) => app.feedback(session, runId, verdict),
        onError: (m) => io.print(`telegram: ${m}`),
      });
      void telegram.run();
      io.print("Telegram bot is listening.");
    }
  }

  const stop = () => {
    telegram?.stop();
    inner.stop();
    app.close();
  };
  const gateway: RunningGateway = { port: inner.port, stop };
  io.print(`Gateway on http://127.0.0.1:${gateway.port}`);
  if (config.channels.web) io.print(`Chat in your browser: http://127.0.0.1:${gateway.port}/#token=${config.gateway.token}`);
  return { code: 0, gateway, stop };
}

async function secret(args: readonly string[], io: CliIo): Promise<CliResult> {
  const store = storeFor(io);
  // `--for <capability>` keeps a secret in that capability's own namespace: only it can ever receive it.
  const forIndex = args.indexOf("--for");
  const capability = forIndex >= 0 ? args[forIndex + 1] : undefined;
  const rest = forIndex >= 0 ? [...args.slice(0, forIndex), ...args.slice(forIndex + 2)] : [...args];
  const [action, name] = rest;
  if (forIndex >= 0 && (!capability || !/^[A-Za-z0-9_-]+$/.test(capability))) {
    io.print("Usage: august secret set|rm --for CAPABILITY NAME");
    return { code: 1 };
  }
  if (action === "list") {
    const names = store.list();
    io.print(names.length ? names.join("\n") : "(no secrets)");
    io.print(`Stored in: ${store.kind}`);
    return { code: 0 };
  }
  if ((action === "set" || action === "rm") && name && SECRET_NAME.test(name)) {
    const key = capability ? scopedSecretName(capability, name) : name;
    const label = capability ? `${name} for ${capability}` : name;
    if (action === "rm") {
      io.print(store.delete(key) ? `Removed ${label}.` : `${label} was not set.`);
      return { code: 0 };
    }
    const value = (await io.ask(`${label}: `))?.trim();
    if (!value) {
      io.print("Nothing saved.");
      return { code: 1 };
    }
    store.set(key, value);
    io.print(`Saved ${label} (${store.kind}).`);
    return { code: 0 };
  }
  io.print("Usage: august secret set NAME | list | rm NAME   (names look like OPENAI_API_KEY)\n       august secret set|rm --for CAPABILITY NAME   (a secret only that capability can receive)");
  return { code: 1 };
}

function mcp(configPath: string, args: readonly string[], io: CliIo): CliResult {
  const config = loadConfig(configPath);
  const [action, id, ...hosts] = args;
  if (action === undefined || action === "list") {
    if (!config.mcp.length) io.print('No MCP servers. Ask the agent to find one, e.g. "find a tool for GitHub".');
    for (const s of config.mcp) {
      const what = s.url ?? (s.artifact ? `${s.artifact.registry}:${s.artifact.name}@${s.artifact.version} (verified, ${s.artifact.signature === "none" ? "unsigned" : "registry-signed"})` : [s.command, ...(s.args ?? [])].join(" "));
      const reach = s.egress?.length ? `egress: ${s.egress.join(", ")}` : s.network === true || (s.network === undefined && s.trust && s.trust !== "community") ? "network: open" : "network: none";
      io.print(`${s.id}  ${what}  (trust: ${s.trust ?? "community"}; ${reach})`);
    }
    return { code: 0 };
  }
  if (action === "rm" && id) {
    if (!config.mcp.some((s) => s.id === id)) {
      io.print(`No server "${id}".`);
      return { code: 1 };
    }
    writeConfig(configPath, { ...config, mcp: config.mcp.filter((s) => s.id !== id) });
    // An installed package goes with its entry; nothing of it stays behind to be started again.
    rmSync(join(config.dataDir, "capabilities", id), { recursive: true, force: true });
    io.print(`Removed "${id}". It stops on the next start.`);
    return { code: 0 };
  }
  if ((action === "allow" || action === "deny") && id) {
    const server = config.mcp.find((s) => s.id === id);
    if (!server) { io.print(`No server "${id}".`); return { code: 1 }; }
    if (action === "deny") {
      const { egress: _egress, ...rest } = server;
      writeConfig(configPath, { ...config, mcp: config.mcp.map((s) => (s.id === id ? rest : s)) });
      io.print(`"${id}" can no longer reach any host. It picks this up on the next start.`);
      return { code: 0 };
    }
    if (!hosts.length || !hosts.every((h) => EGRESS_ENTRY.test(h))) { io.print("Usage: august mcp allow ID HOST...   (hosts like api.github.com, *.example.com or host:port)"); return { code: 1 }; }
    const egress = [...new Set([...(server.egress ?? []), ...hosts.map((h) => h.toLowerCase())])];
    writeConfig(configPath, { ...config, mcp: config.mcp.map((s) => (s.id === id ? { ...s, egress } : s)) });
    io.print(`"${id}" may now reach: ${egress.join(", ")} (through August's egress proxy; other hosts and private addresses stay blocked). It picks this up on the next start.`);
    return { code: 0 };
  }
  io.print("Usage: august mcp list | rm ID | allow ID HOST... | deny ID");
  return { code: 1 };
}

function skills(configPath: string, io: CliIo): CliResult {
  const config = loadConfig(configPath);
  const app = createApp(config, { ...appDeps(io, configPath), llm: io.llm ?? { name: "none", complete: async () => "" } });
  const { loaded, skipped } = app.meta.reloadSkills();
  io.print(loaded.length ? `Skills: ${loaded.join(", ")}` : `No skills in ${config.skillsDir}`);
  for (const s of skipped) io.print(`Skipped ${s.folder}: ${s.reason}`);
  app.close();
  return { code: 0 };
}

function readStats(config: AugustConfig): ReturnType<DecisionCascade["stats"]> {
  const c = new DecisionCascade({ primary: new HeuristicEngine(), fallback: new HeuristicEngine() });
  try {
    c.restore(JSON.parse(readFileSync(join(config.dataDir, "cascade.json"), "utf8")));
  } catch {
    // no stats yet
  }
  return c.stats();
}

/** An app opened only to read what August has learned; nothing is started and no model is called. */
function openLearningApp(configPath: string, io: CliIo): { config: AugustConfig; app: App } {
  const config = loadConfig(configPath);
  return { config, app: createApp(config, { ...appDeps(io, configPath), llm: io.llm ?? { name: "none", complete: async () => "" } }) };
}

function laya(configPath: string, args: readonly string[], io: CliIo): CliResult {
  const { config, app } = openLearningApp(configPath, io);
  try {
    const s = readStats(config);
    const report = app.activationReport();
    if (args[0] === undefined || args[0] === "status") {
      io.print(config.laya ? `Laya sidecar: ${config.laya.url} (engine ${config.laya.engine ?? "laya"})` : "Laya: not connected (a heuristic stands in). See sidecar/laya_server.py.");
      io.print(`Mode: ${config.laya?.shadow === false ? "deciding" : "shadow (the LLM decides, Laya is measured)"}`);
      io.print(`Verified outcomes: ${report.samples} examples with Laya's answer across ${report.questions.join(", ") || "no question types yet"}`);
      for (const q of report.perQuestion) io.print(`  ${q.questionId}: ${q.samples} samples, accuracy ${(q.accuracy * 100).toFixed(1)}% (lower bound ${(q.accuracyLowerBound * 100).toFixed(1)}%), calibration error ${q.ece.toFixed(3)}${q.passed ? " ✓" : ""}`);
      io.print(`For reference only, shadow agreement with the LLM: ${s.shadowSamples} samples, ${(s.agreementRate * 100).toFixed(1)}%. Agreement does not count: only outcomes you or a check confirmed.`);
      io.print(report.ready ? "Ready to activate." : `Not ready: ${report.reasons.join("; ")}`);
      return { code: 0 };
    }
    if (args[0] === "activate") {
      if (!config.laya) {
        io.print("Connect the Laya sidecar first (laya.url in the config).");
        return { code: 1 };
      }
      const forced = args.includes("--force");
      if (!report.ready && !forced) {
        io.print(`Not enough verified outcomes yet: ${report.reasons.join("; ")}. Use --force to activate anyway.`);
        return { code: 1 };
      }
      writeConfig(configPath, { ...config, laya: { ...config.laya, shadow: false } });
      app.journal.append({ kind: "laya.activated", session: makeSessionKey({ workspace: config.workspace, channel: "system", user: "owner" }), data: { forced, ready: report.ready, samples: report.samples, questions: report.questions, reasons: report.reasons } });
      io.print(forced && !report.ready ? "Laya now decides when it is confident. You overrode the evidence; that is recorded." : "Laya now decides when it is confident; the LLM handles the rest.");
      return { code: 0 };
    }
    io.print("Usage: august laya status | activate [--force]");
    return { code: 1 };
  } finally {
    app.close();
  }
}

function calibrate(configPath: string, io: CliIo): CliResult {
  const { config, app } = openLearningApp(configPath, io);
  try {
    const { examples } = app.learning.examples();
    const usable = examples.filter((e) => e.label.kind === "chosen-worked" && e.primary?.calibration?.raw).length;
    if (usable < 50) {
      io.print(`Only ${usable} verified decisions with Laya's answer are recorded; calibration needs at least 50. Judge answers with /good and /bad in chat, or let the built-in checks confirm them.`);
      return { code: 1 };
    }
    const { samples, segments, table } = app.recalibrate();
    io.print(`Fitted ${segments} segments from ${samples} verified outcomes (engine ${table.engine}).`);
    for (const [id, fit] of Object.entries(table.fits).filter(([, f]) => f.level === "exact")) io.print(`  ${id.replace(/^engine=[^|]+\|/, "")}: temperature ${fit.temperature}, error ${fit.eceBefore.toFixed(3)} -> ${fit.eceAfter.toFixed(3)} (${fit.samples} samples)`);
    io.print(config.laya ? "Applied. Laya uses the fitted temperature for each segment from now on." : "Laya is not connected, so the table is saved but unused.");
    return { code: 0 };
  } finally {
    app.close();
  }
}

function learn(configPath: string, args: readonly string[], io: CliIo): CliResult {
  const { app } = openLearningApp(configPath, io);
  try {
    const [action, a, b, ...note] = args;
    if (action === undefined || action === "status") {
      const s = app.learning.exclusionSummary();
      io.print(`Training examples (verified, untainted): ${s.examples}`);
      io.print(`Not used: ${s["tainted-context"]} made after reading untrusted content, ${s.unresolved} with no verdict yet, ${s["not-executed"]} never executed, ${s["conflicting-evidence"]} with conflicting evidence, ${s["ambiguous-credit"]} where the blame was ambiguous`);
      return { code: 0 };
    }
    if (action === "report") {
      const rows = app.learning.report();
      if (!rows.length) io.print("No runs recorded yet.");
      for (const r of rows) io.print(`${r.stage}: ${r.runs} runs, ${r.verifiedRuns} verified, success ${r.verifiedSuccessRate === null ? "n/a" : `${(r.verifiedSuccessRate * 100).toFixed(0)}%`}, latency ${Math.round(r.avgLatencyMs)} ms, LLM calls ${r.avgLlmCalls?.toFixed(1) ?? "n/a"}, tokens ${r.avgTokens?.toFixed(0) ?? "n/a"}, cost ${r.avgCostMicros === null ? "n/a" : `${(r.avgCostMicros / 1e6).toFixed(4)}`}`);
      return { code: 0 };
    }
    if (action === "export" && a) {
      const n = app.learning.exportJsonl(a);
      io.print(`Wrote ${n} verified examples to ${a} (readable only by you: it contains your requests).`);
      return { code: 0 };
    }
    if (action === "feedback" && a && (b === "good" || b === "bad")) {
      const session = app.learning.sessionOf(app.learning.latestSegmentId(a) ?? a);
      if (!session) { io.print(`No run ${a}.`); return { code: 1 }; }
      app.feedback(session as never, a, b === "good" ? "success" : "failure", note.join(" "));
      io.print("Recorded.");
      return { code: 0 };
    }
    io.print("Usage: august learn status | report | export FILE | feedback RUN good|bad [note]");
    return { code: 1 };
  } catch (error) {
    io.print((error as Error).message);
    return { code: 1 };
  } finally {
    app.close();
  }
}

function patterns(configPath: string, args: readonly string[], io: CliIo): CliResult {
  const { app } = openLearningApp(configPath, io);
  try {
    const [action, id] = args;
    const report = app.distill.report();
    if (action === undefined || action === "list" || action === "report") {
      const t = report.totals;
      io.print(`Patterns: ${t.patterns} learned, ${t.compiled} compiled, ${t.runs} runs, ${t.fallbacks} handed back to the model.`);
      io.print(`Model work avoided by compiled runs: ${t.avoidedDecisions} tool decisions, ${t.avoidedArgumentFills} argument fills, ${t.avoidedAnswers} answers.`);
      for (const p of report.patterns) io.print(`  ${p.id}  ${p.stage}${p.pendingApproval ? " (waiting for your approval: august patterns approve " + p.id + ")" : ""}${p.disabled ? " [disabled]" : ""}  "${p.request}"  streak ${p.streak}${p.lastChange ? `  — ${p.lastChange}` : ""}`);
      return { code: 0 };
    }
    const found = id ? report.patterns.find((p) => p.id === id) : undefined;
    if (action === "show" && found) {
      io.print(`Pattern ${found.id} (${found.stage})\nRequest shape: ${found.request}\nEffects: ${found.effects.join(", ") || "none"}\nSteps:\n${found.procedure}\nRuns per stage (llm, skill, workflow, reflex): ${found.stats.runs.join(", ")}`);
      return { code: 0 };
    }
    if (action === "approve" && id) { const r = app.distill.approve(id); io.print(r.message); return { code: r.ok ? 0 : 1 }; }
    if ((action === "disable" || action === "enable") && found) { app.distill.disable(found.id, action === "disable"); io.print(`${action === "disable" ? "Disabled" : "Enabled"} ${found.id}.`); return { code: 0 }; }
    if (action === "forget" && found) { app.distill.forget(found.id); io.print(`Forgot ${found.id} and its recorded runs.`); return { code: 0 }; }
    io.print("Usage: august patterns [list] | show ID | approve ID | disable ID | enable ID | forget ID");
    return { code: 1 };
  } finally {
    app.close();
  }
}

async function doctor(configPath: string, io: CliIo): Promise<CliResult> {
  let problems = 0;
  const ok = (m: string) => io.print(`✓ ${m}`);
  const warn = (m: string) => io.print(`! ${m}`);
  const bad = (m: string) => {
    problems += 1;
    io.print(`✗ ${m}`);
  };

  const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version;
  if (bunVersion && Number(bunVersion.split(".")[0]) >= 1 && Number(bunVersion.split(".")[1]) >= 1) ok(`Bun ${bunVersion}`);
  else bad("Bun 1.1+ is required");

  let config: AugustConfig;
  try {
    config = loadConfig(configPath);
    ok(`Config ${configPath}`);
  } catch (error) {
    bad((error as Error).message);
    return { code: 1 };
  }
  const store = storeFor(io);
  ok(`Secrets: ${store.kind}${store.kind === "file" ? " (owner-only file, not encrypted)" : ""}`);

  const keyName = config.llm.apiKeyEnv;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.llm.baseUrl).hostname);
  if (keyName && !local && !resolveSecret(keyName, store, io.env)) bad(`No key for the model: august secret set ${keyName}`);
  else ok(`Model: ${config.llm.model} at ${new URL(config.llm.baseUrl).host}`);

  const sandbox = io.sandboxKind ?? detectSandbox();
  if (sandbox === "none") warn(`No sandbox for MCP servers (${process.platform === "linux" ? "install bubblewrap" : "unsupported here"}); servers run with your rights`);
  else ok(`Sandbox: ${sandbox}`);

  if (config.laya) {
    try {
      const r = await (io.fetch ?? fetch)(`${config.laya.url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) ok(`Laya sidecar at ${config.laya.url}`);
      else bad(`Laya sidecar answered HTTP ${r.status}`);
    } catch {
      bad(`Laya sidecar not reachable at ${config.laya.url} (python sidecar/laya_server.py)`);
    }
  } else {
    warn("Laya not connected; a heuristic stands in and decisions are logged for later");
  }

  for (const s of config.mcp) {
    const names = [...(s.envFrom ?? []), ...Object.values(s.headersFrom ?? {})];
    const missing = names.filter((n) => !resolveSecret(n, store, io.env));
    if (missing.length) bad(`MCP "${s.id}" needs: ${missing.join(", ")}`);
    else ok(`MCP "${s.id}"`);
  }
  if (config.channels.telegram) {
    if (resolveSecret(config.channels.telegram.tokenSecret, store, io.env)) ok(`Telegram for user(s) ${config.channels.telegram.allowedUsers.join(", ")}`);
    else bad(`Telegram token missing: august secret set ${config.channels.telegram.tokenSecret}`);
  }
  io.print(problems ? `${problems} problem(s) found.` : "All good.");
  return { code: problems ? 1 : 0 };
}
