import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ApprovalRequest, Approver } from "@august/agent";
import { DecisionCascade, HeuristicEngine, NativeLayaTransport, nativeLayaIdentity } from "@august/brain";
import { PendingApprovals, TelegramChannel, WEB_HTML, WEB_JS } from "@august/channels";
import { DurableRuntimeStore, LaneQueue, RuntimeOwnerInUseError, makeSessionKey, type DurableRun } from "@august/core";
import { startGateway, type GatewayRunView, type RunningGateway } from "@august/gateway";
import { evaluateRetrieval, isMemoryClass, type RetrievalCase } from "@august/memory";
import { detectSandbox, type SandboxKind } from "@august/mcp";
import { createApp, type App, type AppDeps } from "./bootstrap.ts";
import { ConfigError, EGRESS_ENTRY, defaultConfig, defaultConfigPath, loadConfig, parseConfig, writeConfig, type AugustConfig, type LlmPricing } from "./config.ts";
import { MasterKeyError, keyFromRecoveryCode, keyIdOf, loadMasterKey, recoveryCode, writeMasterKeyFile } from "./masterkey.ts";
import { EncryptedFileStore, SecretError, SECRET_NAME, openSecretStore, resolveSecret, scopedSecretName, type SecretStore } from "./secrets.ts";
import { openAuditInspection } from "./audit-context.ts";

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
  august secret key status | recovery-code | recover CODE | rotate   the master key that seals your secrets
  august secret migrate      seal a plaintext secrets file from an older version
  august audit verify [--anchors URL] | anchor | publish | export FILE   verify without changing evidence
  august mcp list | rm ID | allow ID HOST... | deny ID      configured MCP servers
  august skills                installed skills
  august laya status | activate [--force]
  august calibrate             fit Laya's confidence on verified outcomes (per question, language, option count)
  august learn status | report | export FILE | feedback FEEDBACK_ID good|bad [note]   exact-result outcomes and training data
  august memory list [KIND] | search WORDS | show ID | add semantic|procedural TEXT | trust ID | forget ID | erase --yes | eval FILE   what August remembers, and where each item came from
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

const keyDirFor = (io: CliIo): string => io.env.AUGUST_KEY_DIR ?? join(io.home, ".config", "august");

function keyBoundaries(io: CliIo): string[] {
  const roots = [join(io.home, ".august")];
  // Keep recovery usable with broken config, but do not invent safety for its unknown workspace.
  try { const config = loadConfig(defaultConfigPath(io.home)); roots.push(config.root, resolve(config.dataDir)); }
  catch { roots.push(join(io.home, "August")); }
  return roots;
}

function storeFor(io: CliIo, createKey = true): SecretStore {
  return io.secrets ?? openSecretStore(join(io.home, ".august"), { env: io.env, keyDir: keyDirFor(io), protectedDirectories: keyBoundaries(io), createKey });
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
      case "audit":
        return await auditCommand(configPath, rest, io);
      case "memory":
        return memoryCommand(configPath, rest, io);
      case "patterns":
        return patterns(configPath, rest, io);
      default:
        io.print(HELP);
        return { code: command === undefined || command === "help" || command === "--help" ? 0 : 1 };
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof SecretError || error instanceof MasterKeyError || error instanceof RuntimeOwnerInUseError) {
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
  io.print('Next: run "august setup" to select your model, configure its pricing and store its key.');
  return { code: 0 };
}

interface Provider {
  label: string;
  baseUrl: string;
  keyName?: string;
}

export const PROVIDERS: Provider[] = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyName: "OPENAI_API_KEY" },
  { label: "OpenRouter (many models, one key)", baseUrl: "https://openrouter.ai/api/v1", keyName: "OPENROUTER_API_KEY" },
  { label: "Ollama endpoint on this computer", baseUrl: "http://localhost:11434/v1" },
];

async function modelCatalog(provider: Provider, key: string | undefined, io: CliIo): Promise<Array<{ id: string; loaded: boolean }>> {
  let response: Response;
  try {
    response = await (io.fetch ?? fetch)(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {}, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch { io.print("Model catalog unavailable; enter your model identifier explicitly."); return []; }
  if (response.status === 401 || response.status === 403) throw new ConfigError("Model catalog authentication failed; check the provider credential.");
  if (!response.ok) { io.print("Model catalog unavailable; enter your model identifier explicitly."); return []; }
  const reader = response.body?.getReader(); if (!reader) return [];
  let size = 0; const chunks: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new ConfigError("Model catalog exceeds the safe response size"); } chunks.push(value); }
  let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { io.print("Model catalog was not readable; enter your model identifier explicitly."); return []; }
  const rows = (value as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const ids = new Set<string>();
  return rows.flatMap(row => {
    if (!row || typeof row.id !== "string" || !row.id.trim() || row.id.length > 256 || /[\x00-\x1f\x7f]/.test(row.id) || ids.has(row.id)) return [];
    ids.add(row.id); return [{ id: row.id, loaded: row.loaded === true }];
  });
}

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
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
    provider = { label: "custom", baseUrl: url, keyName: local ? undefined : "LLM_API_KEY" };
  }
  parseConfig({ ...base, llm: { ...base.llm, baseUrl: provider.baseUrl } });
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(provider.baseUrl).hostname);
  let pricing: LlmPricing = { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, source: "local API price", asOf: new Date().toISOString().slice(0, 10) };
  if (!local) {
    const rates = (await io.ask("Input/output microdollars per million tokens (from your provider's tariff): "))?.trim().split(/[\s,/]+/).map(Number);
    if (!rates || rates.length !== 2 || rates.some((n) => !Number.isSafeInteger(n) || n < 0)) { io.print("Pricing needs two non-negative integer rates."); return { code: 1 }; }
    pricing = { inputMicrosPerMillion: rates[0]!, outputMicrosPerMillion: rates[1]!, source: provider.baseUrl, asOf: new Date().toISOString().slice(0, 10) };
  }
  let key: string | undefined;
  if (provider.keyName) {
    const existing = resolveSecret(provider.keyName, store, io.env);
    key = (await io.ask(`2/3 ${provider.keyName}${existing ? " [press Enter to keep the saved one]" : ""}: `))?.trim() || existing;
    if (!key) {
      io.print("A key is needed for this provider.");
      return { code: 1 };
    }
  } else {
    io.print("2/3 No key needed for a local model.");
  }

  const catalog = await modelCatalog(provider, key, io);
  for (const model of catalog) io.print(`  ${model.id}${model.loaded ? " (loaded)" : ""}`);
  const loaded = catalog.filter(model => model.loaded);
  const previous = base.llm.baseUrl.replace(/\/+$/, "") === provider.baseUrl.replace(/\/+$/, "") && catalog.some(model => model.id === base.llm.model) ? base.llm.model : undefined;
  const preferred = previous ?? (loaded.length === 1 ? loaded[0]!.id : undefined);
  const model = (await io.ask(`Model identifier [${preferred ?? "required"}]: `))?.trim() || preferred;
  if (!model || model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) { io.print("Choose an explicit model identifier."); return { code: 1 }; }
  if (key && provider.keyName) store.set(provider.keyName, key);

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

  const config = parseConfig({ ...base, llm: { baseUrl: provider.baseUrl, model, apiKeyEnv: provider.keyName, pricing }, channels });
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
  io.print(`\nAugust · ${config.workspace}\nModel: ${config.llm.model}\nDescribe the result you need. /help shows controls; /exit leaves the chat.`);
  const help = '/tasks — recent task state and usage\n/resume ID — continue a safely paused task\n/good or /bad [why] — assess the last completed answer\n/exit — leave the chat\nApprovals require an explicit y. Use august secret set for credentials, never chat.';
  const report = (run: DurableRun) => {
    io.print(`  ${run.id} · ${run.state}\n  ${run.steps}/${run.budget.maxSteps} steps · ${run.usage.totalTokens}/${run.budget.maxTokens} tokens · ${run.usage.costMicros} µUSD estimate (not a vendor bill)`);
    const accounting = app.runs.modelAccounting(run.id);
    if (accounting.unresolvedCalls) { io.print(`  Unresolved usage: ${accounting.unresolvedCalls} call(s), ${accounting.reservedTokens} tokens / ${accounting.reservedCostMicros} µUSD held (not billed).`); for (const attempt of app.runs.modelAttempts(run.id, true)) io.print(`  Receipt/estimate: /reconcile ${attempt.id} INPUT_TOKENS OUTPUT_TOKENS --confirm`); }
    if (accounting.ownerReceipts) io.print("  Includes owner reconciliation, not provider receipts.");
    if (accounting.legacyUsage) io.print("  Legacy estimate: earlier unreported usage cannot be reconstructed.");
  };
  let lastRun: string | undefined;
  for (;;) {
    const line = await io.ask("you> ");
    if (line === null || ["exit", "/exit"].includes(line.trim())) break;
    if (line.trim() === "") continue;
    if (line.trim() === "/help") { io.print(help); continue; }
    if (line.trim() === "/tasks") {
      const runs = app.listRuns({ session, limit: 10 });
      if (!runs.length) io.print("No tasks yet. Describe the result you need.");
      for (const run of runs) { report(run); io.print(`  ${run.request.slice(0, 200)}`); if (runView(app, run).canResume) io.print(`  Continue: /resume ${run.id}`); }
      continue;
    }
    const reconcile = /^\/reconcile\s+([A-Za-z0-9_-]{1,64})\s+([0-9]+)\s+([0-9]+)\s+--confirm$/.exec(line.trim());
    if (reconcile) {
      const attempt = app.runs.getModelAttempt(reconcile[1]!), run = attempt ? app.getRun(attempt.runId) : undefined;
      const inputTokens = Number(reconcile[2]), outputTokens = Number(reconcile[3]);
      if (!attempt || !run || run.session !== session || ["created","running","waiting_approval","waiting_external","verifying"].includes(run.state) || ![inputTokens,outputTokens,inputTokens+outputTokens].every(Number.isSafeInteger)) { io.print("No inactive owned attempt or valid token counts. Check /tasks."); continue; }
      try { app.runs.reportModelAttempt(attempt.id, { inputTokens, outputTokens, totalTokens: inputTokens+outputTokens }, "owner"); io.print("Owner reconciliation recorded; this does not certify a provider bill."); report(app.getRun(run.id)!); }
      catch { io.print("Receipt conflicts or storage is unavailable. Check /tasks before retrying."); }
      continue;
    }
    const resume = /^\/resume\s+([A-Za-z0-9_-]{1,64})$/.exec(line.trim());
    if (resume) {
      const run = app.getRun(resume[1]!);
      if (!run || run.session !== session || !runView(app, run).canResume) { io.print("Cannot safely continue that task in this session. Check /tasks."); continue; }
      io.print("Continuing from the saved safe boundary…");
      try { const result = await app.resumeRun(run.id); lastRun = result.feedbackId; io.print(result.reply); report(app.getRun(run.id)!); }
      catch { io.print("Continuation failed. Check /tasks before retrying."); }
      continue;
    }
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
    if (line.trim().startsWith("/")) { io.print("Unknown command. Use /help or send a task without a leading slash."); continue; }
    try {
      io.print("Working…");
      const { reply, feedbackId, runId } = await app.handle(session, line);
      lastRun = feedbackId;
      io.print(reply);
      const run = app.getRun(runId); if (run) report(run);
    } catch {
      io.print("Something went wrong.");
    }
  }
  app.close();
  return { code: 0 };
}

function runView(app: App, run: DurableRun): GatewayRunView {
    const feedbackId = run.state === "completed" ? app.learning.latestSegmentId(run.id) : undefined;
    const accounting = app.runs.modelAccounting(run.id);
    const providerWait = run.error === "provider-unavailable" && run.checkpoint?.providerRetryAt !== undefined;
    return { id: run.id, state: run.state, request: run.request,
    accounting, unresolvedAttempts: app.runs.modelAttempts(run.id, true).map(({id,provider,model,state,quote,reservedTokens,reservedCostMicros,failure}) => ({id,provider,model,state,quote,reservedTokens,reservedCostMicros,failure})),
    feedbackId, feedbackRecorded: feedbackId ? app.learning.hasOwnerFeedback(feedbackId) : false,
    steps: run.steps, usage: run.usage, budget: run.budget, reply: ["paused", "completed", "failed", "cancelled"].includes(run.state) || providerWait ? run.reply : undefined, updatedAt: run.updatedAt,
    canResume: !accounting.unresolvedCalls && (["paused", "recovering"].includes(run.state) || (run.state === "waiting_external" && providerWait)) && (!providerWait || Date.now() >= run.checkpoint!.providerRetryAt!) && run.checkpoint?.safeToResume === true && run.checkpoint.phase !== "tool_started" && Boolean(run.checkpoint.taint && run.checkpoint.loop) && run.checkpoint.steps !== undefined && run.checkpoint.externalEffects !== undefined,
  }; }

async function serve(configPath: string, io: CliIo): Promise<CliResult> {
  const config = loadConfig(configPath);
  const app = createApp(config, appDeps(io, configPath));
  await reportServers(app, io);
  const approvals = new PendingApprovals(app.approvals);
  const queue = new LaneQueue();
  const controlRun = async (session: string, id: string, action: "pause" | "cancel" | "resume"): Promise<GatewayRunView> => {
    const run = app.getRun(id); if (!run || run.session !== session) throw Error("no run for session");
    if (action === "resume") {
      if (!runView(app, run).canResume) throw Error("unsafe checkpoint");
      await queue.enqueue(session, () => app.resumeRun(id, approvals.approverFor(() => {})));
    } else {
      if (!["created", "running", "waiting_approval", "waiting_external", "paused", "recovering"].includes(run.state)) throw Error("run is not active");
      await (action === "pause" ? app.pauseRun(id) : app.cancelRun(id));
    }
    return runView(app, app.getRun(id)!);
  };
  const gatewayRunSession = (session: string) => { if (session.split(":")[1] === "telegram") throw Error("channel has its own transport"); };

  let inner: RunningGateway;
  try {
    inner = startGateway({
    hostname: "127.0.0.1",
    port: config.gateway.port,
    token: config.gateway.token,
    workspace: config.workspace,
    queue,
    audit: () => app.audit.externalStatus(),
    providerHealth: () => app.providerHealth(),
    // Telegram answers only through Telegram: a browser token must not be able to answer its approvals.
    approvals: approvals.forGateway(["telegram"]),
    webUi: config.channels.web ? { html: WEB_HTML, js: WEB_JS } : undefined,
    // The browser polls /v1/pending, so the prompt itself needs no push.
    onMessage: async ({ session, text, budget }) => { const r = await app.handle(session, text, approvals.approverFor(() => {}), { budget }); return { reply: r.reply, runId: r.runId, state: app.getRun(r.runId)?.state, feedbackId: r.feedbackId }; },
    runs: {
      list: (session, limit) => { gatewayRunSession(session); return app.listRuns({ session, limit }).map(run => runView(app, run)); },
      control: async ({ session, id, action }) => {
        gatewayRunSession(session);
        return controlRun(session, id, action);
      },
      reconcile: async ({ session, attemptId, inputTokens, outputTokens }) => {
        gatewayRunSession(session);
        const attempt = app.runs.getModelAttempt(attemptId), run = attempt ? app.getRun(attempt.runId) : undefined;
        if (!run || run.session !== session || ["created","running","waiting_approval","waiting_external","verifying"].includes(run.state)) throw Error("no inactive owned model attempt");
        app.runs.reportModelAttempt(attemptId, { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, "owner");
        app.journal.append({ kind: "model.reconciled", session, data: { attemptId, runId: run.id, source: "owner", inputTokens, outputTokens } });
        return runView(app, app.getRun(run.id)!);
      },
    },
    feedback: ({ session, feedbackId, verdict, note }) => app.feedback(session, feedbackId, verdict, note),
    secrets: app.secrets.kind === "file" ? undefined : {
      list: () => ({ backend: app.secrets.kind, names: app.secrets.list() }),
      set: (name, value) => {
        app.secrets.set(name, value);
        app.journal.append({ kind: "secret.updated", session: makeSessionKey({ workspace: config.workspace, channel: "system", user: "owner" }), data: { name, backend: app.secrets.kind, source: "owner-api" } });
      },
      delete: name => {
        const listed = app.secrets.list().includes(name);
        const changed = listed ? app.secrets.delete(name) : false;
        if (listed && !changed) throw new SecretError("could not confirm credential deletion");
        app.journal.append({ kind: "secret.deleted", session: makeSessionKey({ workspace: config.workspace, channel: "system", user: "owner" }), data: { name, backend: app.secrets.kind, source: "owner-api", changed } });
      },
    },
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
        queue,
        fetch: io.fetch,
        handle: (session, text, approver) => app.handle(session, text, approver),
        runs: {
          list: (session, limit) => app.listRuns({ session, limit }).map(run => runView(app, run)),
          control: async (session, id, action) => {
            // Resume approvals must return to Telegram, not the browser's pending poll.
            if (action !== "resume") return controlRun(session, id, action);
            const run = app.getRun(id);
            if (!run || run.session !== session || !runView(app, run).canResume) throw Error("unsafe checkpoint");
            const user = Number(session.split(":")[2]);
            await queue.enqueue(session, () => app.resumeRun(id, approvals.approverFor((text, view) => telegram!.send(user, text, view))));
            return runView(app, app.getRun(id)!);
          },
        },
        feedback: (session, runId, verdict) => app.feedback(session, runId, verdict),
        onError: (m) => io.print(`telegram: ${m}`),
      });
      void telegram.run();
      io.print("Telegram bot is listening.");
    }
  }

  // Only this transport's safe model waits auto-resume; ambiguous effects and owner-paused work never do.
  let closing = false;
  const recoveringProviders = new Set<string>();
  const providerTimer = setInterval(() => {
    if (closing) return;
    for (const run of app.listRuns({ states: ["waiting_external", "recovering"], limit: 100 })) {
      if (run.session.split(":")[1] !== "web" || run.error !== "provider-unavailable" || run.checkpoint?.providerRetryAt === undefined || !runView(app, run).canResume || recoveringProviders.has(run.id)) continue;
      recoveringProviders.add(run.id);
      void queue.enqueue(run.session, async () => { if (!closing) await app.resumeRun(run.id, approvals.approverFor(() => {})); })
        .catch(() => { if (!closing) io.print("Provider recovery did not complete; inspect the task's retained state."); })
        .finally(() => recoveringProviders.delete(run.id));
    }
  }, 1000);
  providerTimer.unref();
  const stop = () => {
    closing = true; clearInterval(providerTimer);
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
  if (action === "key") return secretKey(rest.slice(1), store, io);
  if (action === "migrate") {
    if (!(store instanceof EncryptedFileStore)) { io.print(`Secrets are in ${store.kind}; there is no plaintext file to move.`); return { code: 0 }; }
    const { moved } = store.migrate();
    io.print(moved ? `Sealed ${moved} secret(s) under your master key and destroyed the plaintext file.` : "No plaintext secrets file to move.");
    return { code: 0 };
  }
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

function secretKey(args: readonly string[], store: SecretStore, io: CliIo): CliResult {
  const [action, code] = args;
  const keyDir = keyDirFor(io);
  const protectedDirectories = keyBoundaries(io);
  const current = loadMasterKey({ env: io.env, keyDir, protectedDirectories });
  if (action === "status" || action === undefined) {
    io.print(current ? `Master key ${current.id} (${current.source === "env" ? "from AUGUST_MASTER_KEY" : current.source === "passphrase" ? "from AUGUST_MASTER_PASSPHRASE" : `file ${current.path}`}). It is outside the data folder.` : "No master key yet; one is created the first time a secret is stored.");
    io.print(`Secrets are stored in: ${store.kind}`);
    return { code: 0 };
  }
  if (action === "recovery-code") {
    if (!current) { io.print("There is no master key to back up yet."); return { code: 1 }; }
    io.print(`Recovery code for master key ${current.id}. Write it down and keep it offline, apart from your backups; anyone holding it can open your secrets:\n${recoveryCode(current.key)}`);
    return { code: 0 };
  }
  if (action === "recover" && code) {
    const key = keyFromRecoveryCode(args.slice(1).join("-").replace(/\s+/g, ""));
    const path = writeMasterKeyFile(keyDir, key, protectedDirectories);
    io.print(`Restored master key ${keyIdOf(key)} to ${path}. The previous key file, if any, was kept beside it.`);
    return { code: 0 };
  }
  if (action === "rotate") {
    if (!(store instanceof EncryptedFileStore) || !current) { io.print("Only the encrypted file store has a master key to rotate."); return { code: 1 }; }
    if (current.source !== "file" && current.source !== "new") { io.print("The key comes from the environment, so August cannot replace it. Set a new AUGUST_MASTER_KEY yourself and enter the secrets again."); return { code: 1 }; }
    const next = randomBytes(32);
    const target = store.rotate(next);
    writeMasterKeyFile(keyDir, next, protectedDirectories);
    io.print(`Re-sealed ${target.list().length} secret(s) under new master key ${target.keyId}. Your recovery code changed: run august secret key recovery-code and store the new one.`);
    return { code: 0 };
  }
  io.print("Usage: august secret key status | recovery-code | recover CODE | rotate");
  return { code: 1 };
}

async function auditCommand(configPath: string, args: readonly string[], io: CliIo): Promise<CliResult> {
  const config = loadConfig(configPath);
  const [action = "verify", file] = args;
  if (action === "verify" || action === "export") {
    if (action === "verify" && args.length > 1 && !(args.length === 3 && file === "--anchors" && args[2])) throw new ConfigError("Usage: august audit verify [--anchors configured-URL]");
    if (action === "export" && (!file || args.length !== 2)) throw new ConfigError("Usage: august audit export FILE");
    let inspection: ReturnType<typeof openAuditInspection>;
    try { inspection = openAuditInspection(config, io); }
    catch { io.print("Audit inspection unavailable: existing key/journal required, and active WAL must be checkpointed. No evidence was changed."); return { code: 1 }; }
    try {
      if (action === "export") {
        const anchors = inspection.anchors();
        try { writeFileSync(file!, JSON.stringify({ keyId: inspection.keyId, publicKey: inspection.publicKey, anchors }, null, 2), { mode: 0o600, flag: "wx" }); }
        catch { io.print("Could not create the export file; existing files were not overwritten."); return { code: 1 }; }
        io.print(`Wrote ${anchors.length} anchors and the public key to ${file}. Existing evidence was not modified. Keep an independent copy.`);
        return { code: 0 };
      }
      const external = file === "--anchors" ? await inspection.verifyExternal(args[2]) : undefined;
      if (external?.state === "unavailable") { io.print(`External audit unavailable (${external.reason}); no evidence was changed. Verification is NOT established.`); return { code: 1 }; }
      const r = external ? external.report : inspection.verify();
      io.print(`Journal chain: ${r.chainBrokenAt === null ? "intact" : `BROKEN at entry ${r.chainBrokenAt}`}. Anchors: ${r.anchors}, vouching through entry ${r.anchoredThrough}; ${r.unanchored} newer entries not yet anchored.`);
      for (const p of r.problems) io.print(`  ✗ ${p}`);
      if (external) {
        io.print(`External coverage: entries 1-${r.anchoredThrough}. Tail gap: ${r.unanchored} retained unanchored entries; removed entries after the last external anchor cannot be proven or ruled out. No repair or signing was performed.`);
        io.print(external.state === "tampered" ? "The journal does not match independent signed evidence." : external.state === "unanchored" ? "No external anchors: independently verified coverage is empty." : "The anchored prefix matches independent signed evidence; this does not certify an unknown tail.");
        return { code: external.state === "verified" && r.unanchored === 0 ? 0 : 1 };
      }
      io.print(r.ok ? "Nothing has been altered or removed behind an anchor. Unanchored history and removal of the local anchor file are not certified." : "The journal does not match its signed anchors.");
      return { code: r.ok && r.anchors > 0 && r.unanchored === 0 ? 0 : 1 };
    } catch (error) {
      io.print(error instanceof ConfigError ? error.message : "Audit evidence is unreadable; no repair or signing was performed.");
      return { code: 1 };
    } finally { inspection.close(); }
  }
  if (!["anchor", "publish"].includes(action) || args.length !== 1) { io.print("Usage: august audit verify [--anchors URL] | anchor | publish | export FILE"); return { code: 1 }; }
  const { app } = openLearningApp(configPath, io);
  try {
    const a = app.audit;
    if (!a.enabled) { io.print(`Audit anchoring is off: ${a.reason}`); return { code: 1 }; }
    if (!config.auditExternal) {
      if (action === "anchor") { const x = a.anchor(); io.print(x ? `Anchored entry ${x.seq} (anchor ${x.n}).` : "Nothing new to anchor."); }
      io.print("External audit sink is not configured; local anchors do not survive removal of their file."); return { code: action === "anchor" ? 0 : 1 };
    }
    await a.publish();
    const status = await a.publish();
    io.print(`External audit: ${status.state}, independently retained through entry ${status.anchoredThrough}.`);
    return { code: status.state === "published" && status.anchoredThrough >= status.localThrough ? 0 : 1 };
  } finally { app.close(); }
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
      io.print(config.laya?.onnx ? `Native Laya ONNX: ${config.laya.onnx.directory} (engine ${nativeLayaIdentity(config.laya.onnx)})` : config.laya ? `Laya sidecar: ${config.laya.url} (engine ${config.laya.engine ?? "laya"})` : "Laya: not connected (a heuristic stands in). Configure laya.onnx or laya.url.");
      io.print(`Mode: ${config.laya?.shadow === false ? "deciding" : "shadow (the LLM decides, Laya is measured)"}`);
      io.print(`Verified outcomes: ${report.samples} examples with Laya's answer across ${report.questions.join(", ") || "no question types yet"}`);
      for (const q of report.perQuestion) io.print(`  ${q.questionId}: ${q.samples} samples, accuracy ${(q.accuracy * 100).toFixed(1)}% (lower bound ${(q.accuracyLowerBound * 100).toFixed(1)}%), calibration error ${q.ece.toFixed(3)}${q.passed ? " ✓" : ""}`);
      io.print(`For reference only, shadow agreement with the LLM: ${s.shadowSamples} samples, ${(s.agreementRate * 100).toFixed(1)}%. Agreement does not count: only outcomes you or a check confirmed.`);
      io.print(report.ready ? "Ready to activate." : `Not ready: ${report.reasons.join("; ")}`);
      return { code: 0 };
    }
    if (args[0] === "activate") {
      if (!config.laya) {
        io.print("Connect native Laya or a local sidecar first (laya.onnx or laya.url in the config).");
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
      const session = app.learning.sessionOf(a);
      if (!session) { io.print(`No run ${a}.`); return { code: 1 }; }
      app.feedback(session as never, a, b === "good" ? "success" : "failure", note.join(" "));
      io.print("Recorded.");
      return { code: 0 };
    }
    io.print("Usage: august learn status | report | export FILE | feedback FEEDBACK_ID good|bad [note]");
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

function memoryCommand(configPath: string, args: readonly string[], io: CliIo): CliResult {
  const { config, app } = openLearningApp(configPath, io);
  try {
    const rest = [...args];
    const at = rest.indexOf("--session");
    let scope = makeSessionKey({ workspace: config.workspace, channel: "cli", user: "local" }) as string;
    if (at >= 0) { scope = rest[at + 1] ?? ""; rest.splice(at, 2); }
    const [action, a, ...more] = rest;
    const m = app.memory;
    const line = (e: ReturnType<typeof m.list>[number]) => `${e.id}  ${e.class}${e.trust === "untrusted" ? " (untrusted)" : ""}${e.status === "superseded" ? " (superseded)" : ""}  ${new Date(e.updatedAt).toISOString().slice(0, 10)}  ${e.text.length > 100 ? `${e.text.slice(0, 100)}...` : e.text}`;
    if (action === undefined || action === "list") {
      const cls = a === undefined ? undefined : isMemoryClass(a) ? a : null;
      if (cls === null) { io.print("Kinds: working, episodic, semantic, procedural."); return { code: 1 }; }
      const entries = m.list(scope, { class: cls });
      if (!entries.length) io.print("Nothing remembered yet.");
      for (const e of entries) io.print(line(e));
      const st = m.stats(scope);
      io.print(`${st.semantic} semantic, ${st.procedural} procedural, ${st.episodic} episodic, ${st.working} working; ${st.untrusted} written under untrusted influence (review them, then: august memory trust ID)`);
      return { code: 0 };
    }
    if (action === "search" && a) { const hits = m.recall({ scope, query: [a, ...more].join(" "), touch: false }); if (!hits.length) io.print("No matches."); for (const h of hits) io.print(line(h.entry)); return { code: 0 }; }
    if (action === "show" && a) { const e = m.get(scope, a); if (!e) { io.print("No such memory."); return { code: 1 }; } io.print(`${line(e)}\nOrigin: ${e.origin.kind} ${e.origin.source}${e.origin.locator ? ` (${e.origin.locator})` : ""}; sensitivity ${e.sensitivity}; used ${e.useCount} times${e.expiresAt ? `; expires ${new Date(e.expiresAt).toISOString().slice(0, 10)}` : ""}\n${e.text}`); return { code: 0 }; }
    if (action === "add" && (a === "semantic" || a === "procedural") && more.length) { const r = m.remember({ scope, class: a, text: more.join(" "), origin: { kind: "user", source: "owner" }, trust: "trusted", sensitivity: "personal" }); io.print(`${r.created ? "Remembered" : "Already remembered"}: ${r.entry.id}`); return { code: 0 }; }
    if (action === "trust" && a) { io.print(m.trust(scope, a) ? "Marked as trusted." : "Nothing to change."); return { code: 0 }; }
    if (action === "forget" && a) { const n = m.forget(scope, a); io.print(n ? `Forgot ${n} item(s).` : "No such memory."); return { code: n ? 0 : 1 }; }
    if (action === "forget-source" && a) { io.print(`Forgot ${m.forgetBySource(scope, a)} item(s) from ${a}.`); return { code: 0 }; }
    if (action === "erase") { if (a !== "--yes") { io.print("This deletes everything August remembers for this session and cannot be undone. Run: august memory erase --yes"); return { code: 1 }; } io.print(`Erased ${m.forgetScope(scope)} item(s).`); return { code: 0 }; }
    if (action === "sweep") { io.print(`Removed ${m.sweep()} expired item(s).`); return { code: 0 }; }
    if (action === "eval" && a) {
      const cases = JSON.parse(readFileSync(a, "utf8")) as RetrievalCase[];
      const r = evaluateRetrieval(m, scope, cases);
      io.print(`Retrieval on ${r.cases} questions: recall@${r.k} ${(r.recallAtK * 100).toFixed(0)}%, MRR ${r.mrr.toFixed(2)}`);
      for (const q of r.misses) io.print(`  missed: ${q}`);
      return { code: 0 };
    }
    io.print("Usage: august memory [--session KEY] list [KIND] | search WORDS | show ID | add semantic|procedural TEXT | trust ID | forget ID | forget-source SOURCE | erase --yes | sweep | eval FILE");
    return { code: 1 };
  } catch (error) {
    io.print((error as Error).message);
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
  const store = storeFor(io, false);
  if (store.kind === "file") warn("Secrets: explicitly selected plaintext store; use OS credentials or an encrypted-file store");
  else ok(`Secrets: ${store.kind}`);
  if (store instanceof EncryptedFileStore && store.plaintextNames().length) warn(`${store.plaintextNames().length} secret(s) are still in a plaintext file from an older version: run august secret migrate`);

  if (!config.auditExternal) warn("External audit sink is not configured; deleting local anchors defeats independent custody. Set auditExternal.url and tokenEnv.");
  else {
    let inspection: ReturnType<typeof openAuditInspection> | undefined;
    try {
      inspection = openAuditInspection(config, { ...io, secrets: store });
      const result = await inspection.verifyExternal();
      if (result.state === "verified") {
        ok(`External audit anchored through entry ${result.report.anchoredThrough}`);
        warn(`External audit tail gap: ${result.report.unanchored} retained unanchored entries; removal after the last anchor is unknown`);
      } else bad(`External audit ${result.state}; independent integrity is not established`);
    } catch { bad("External audit unavailable; no evidence or keys were changed by inspection"); }
    finally { inspection?.close(); }
  }

  const keyName = config.llm.apiKeyEnv;
  if (keyName && !resolveSecret(keyName, store, io.env)) bad(`No key for the model: august secret set ${keyName}`);
  else ok(`Model: ${config.llm.model} at ${new URL(config.llm.baseUrl).host}`);
  if (config.llm.backup) {
    const backup = config.llm.backup;
    if (backup.apiKeyEnv && !resolveSecret(backup.apiKeyEnv, store, io.env)) bad(`Backup credential missing: august secret set ${backup.apiKeyEnv}`);
    else ok(`Backup: ${backup.model} at ${new URL(backup.baseUrl).host}`);
    if (!backup.pricing) bad("Backup pricing missing: configure its own quote or explicit zero");
  }
  if (!config.llm.model.trim()) bad("No model selected: august setup");
  if (!config.llm.pricing) bad("Model pricing missing: configure an owner quote or explicit zero");
  // A catalog probe is read-only reachability evidence, not a generation or inference-quality claim.
  if (!io.llm) await Promise.all([config.llm, ...(config.llm.backup ? [config.llm.backup] : [])].map(async (connection, i) => {
    const label = i === 0 ? "Primary" : "Backup", key = connection.apiKeyEnv ? resolveSecret(connection.apiKeyEnv, store, io.env) : undefined;
    if (connection.apiKeyEnv && !key) return;
    try {
      const response = await (io.fetch ?? fetch)(`${connection.baseUrl.replace(/\/+$/, "")}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, redirect: "error", signal: AbortSignal.timeout(3000) });
      if (response.status === 404 || response.status === 405) warn(`${label} catalog unsupported; inference availability is not established`);
      else if (!response.ok) bad(`${label} catalog returned HTTP ${response.status}; check endpoint access`);
      else { await response.body?.cancel(); ok(`${label} endpoint catalog reachable; inference was not probed`); }
    } catch { bad(`${label} endpoint is unreachable; no generation was sent`); }
  }));
  const runtimePath = join(config.dataDir, "runtime.db");
  if (existsSync(runtimePath)) {
    let runtime: DurableRuntimeStore | undefined;
    try {
      runtime = new DurableRuntimeStore(runtimePath, { readOnly: true });
      const states = runtime.providerCircuits();
      for (const [name, circuit] of Object.entries(states)) warn(`Provider ${name}: ${circuit.retryAt > Date.now() ? "open" : "half-open"}, ${circuit.failures} failure(s), next probe after ${new Date(circuit.retryAt).toISOString()}`);
    } catch { warn("Provider circuit inspection unavailable; use a stopped, checkpointed runtime snapshot"); }
    finally { runtime?.close(); }
  }

  const sandbox = io.sandboxKind ?? detectSandbox();
  if (sandbox === "none") warn(`No sandbox for MCP servers (${process.platform === "linux" ? "install bubblewrap" : "unsupported here"}); servers run with your rights`);
  else ok(`Sandbox: ${sandbox}`);

  if (config.laya) {
    if (config.laya.onnx) {
      const native = new NativeLayaTransport(config.laya.onnx);
      try { await native.ready(); ok(`Native Laya ONNX verified and loaded (${native.identity})`); }
      catch { bad("Native Laya unavailable: check pinned bundle files and native runtime dependencies"); }
      finally { await native.close(); }
    } else {
      try {
        const r = await (io.fetch ?? fetch)(`${config.laya.url!.replace(/\/+$/, "")}/health`, { redirect: "error", signal: AbortSignal.timeout(2000) });
        if (r.ok) ok(`Laya sidecar at ${config.laya.url}`);
        else bad(`Laya sidecar answered HTTP ${r.status}`);
      } catch {
        bad(`Laya sidecar not reachable at ${config.laya.url} (python sidecar/laya_server.py)`);
      }
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
