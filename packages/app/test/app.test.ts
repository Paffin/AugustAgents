import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, LlmProvider } from "@august/brain";
import { AgentCheckpointError, type ApprovalRequest } from "@august/agent";
import { IdempotencyConflictError, RunInProgressError, UnsupportedBudgetError, makeSessionKey } from "@august/core";
import { LoopGuard } from "@august/policy";
import {
  BuiltinExecutor,
  ConfigError,
  MAX_READ_BYTES,
  PathEscapeError,
  createApp,
  defaultConfig,
  defaultConfigPath,
  loadConfig,
  main,
  parseConfig,
  resolveInside,
  writeConfig,
  type CliIo,
} from "../src/index.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "august-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("config", () => {
  const good = () => defaultConfig("/home/u");

  test("the default config is valid and gets a fresh token each time", () => {
    expect(() => parseConfig(good())).not.toThrow();
    expect(good().gateway.token).not.toBe(good().gateway.token);
  });

  test("refuses a key-looking apiKeyEnv, a short token and a bad port", () => {
    expect(() => parseConfig({ ...good(), llm: { ...good().llm, apiKeyEnv: "sk-abc123" } })).toThrow(/environment variable name/);
    expect(() => parseConfig({ ...good(), gateway: { port: 1, token: "short" } })).toThrow(/16/);
    expect(() => parseConfig({ ...good(), gateway: { port: 70000, token: "x".repeat(20) } })).toThrow(/port/);
  });

  test("refuses plain http to a remote host but allows localhost", () => {
    expect(() => parseConfig({ ...good(), llm: { ...good().llm, baseUrl: "http://llm.example.com/v1" } })).toThrow(/https/);
    expect(() => parseConfig({ ...good(), llm: { ...good().llm, baseUrl: "http://localhost:11434/v1" } })).not.toThrow();
  });

  test("refuses a workspace name that would break session keys", () => {
    expect(() => parseConfig({ ...good(), workspace: "a:b" })).toThrow(ConfigError);
  });

  test("the file is private and round-trips", () => {
    const home = tmp();
    const path = defaultConfigPath(home);
    const cfg = defaultConfig(home);
    writeConfig(path, cfg);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(path)).toEqual({ ...cfg, llm: { ...cfg.llm } });
  });

  test("a missing or broken file gives a helpful error", () => {
    const home = tmp();
    expect(() => loadConfig(join(home, "nope.json"))).toThrow(/august init/);
    writeFileSync(join(home, "bad.json"), "{");
    expect(() => loadConfig(join(home, "bad.json"))).toThrow(/not valid JSON/);
  });
});

describe("built-in file tools", () => {
  function setup() {
    const base = tmp();
    const root = join(base, "root");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "hello");
    writeFileSync(join(base, "outside.txt"), "secret");
    return { base, root, ex: new BuiltinExecutor(root) };
  }

  test("reads and lists inside the root", async () => {
    const { ex } = setup();
    expect(await ex.call("fs.read", { path: "a.txt" })).toEqual({ content: "hello" });
    expect((await ex.call("fs.list", {})).content.split("\n")).toEqual(["a.txt", "sub/"]);
  });

  test("blocks ../ and absolute paths and never leaks the host path", async () => {
    const { base, ex } = setup();
    for (const path of ["../outside.txt", join(base, "outside.txt"), "sub/../../outside.txt"]) {
      const r = await ex.call("fs.read", { path });
      expect(r.isError).toBe(true);
      expect(r.content).not.toContain("secret");
      expect(r.content).not.toContain(base);
    }
  });

  test("a symlink cannot lead out of the root", async () => {
    const { base, root, ex } = setup();
    symlinkSync(join(base, "outside.txt"), join(root, "link.txt"));
    symlinkSync(base, join(root, "linkdir"));
    expect((await ex.call("fs.read", { path: "link.txt" })).isError).toBe(true);
    expect((await ex.call("fs.list", { path: "linkdir" })).isError).toBe(true);
    expect(() => resolveInside(root, "link.txt")).toThrow(PathEscapeError);
  });

  test("a sibling folder with the same prefix is outside", () => {
    const { base, root } = setup();
    mkdirSync(join(base, "root-evil"));
    expect(() => resolveInside(root, "../root-evil")).toThrow(PathEscapeError);
  });

  test("big files and directories are refused, unknown tools error", async () => {
    const { root, ex } = setup();
    writeFileSync(join(root, "big.bin"), "x".repeat(MAX_READ_BYTES + 1));
    expect((await ex.call("fs.read", { path: "big.bin" })).isError).toBe(true);
    expect((await ex.call("fs.read", { path: "sub" })).isError).toBe(true);
    expect((await ex.call("fs.read", { path: "missing.txt" })).isError).toBe(true);
    expect((await ex.call("nope.tool", {})).isError).toBe(true);
  });

  test("clock.now uses the injected clock", async () => {
    const ex = new BuiltinExecutor(tmp(), () => new Date("2026-09-29T12:00:00Z"));
    expect((await ex.call("clock.now", {})).content).toBe("2026-09-29T12:00:00.000Z");
  });
});

/** Answers by schema name: which tool, which arguments, the final text. */
function scriptedLlm(plan: { tool: string; args: Record<string, unknown>; reply: string }): LlmProvider {
  return {
    name: "scripted",
    async complete(messages, options) {
      const name = options?.jsonSchema?.name;
      // Pick the tool until a result is in the state, then say none.
      if (name === "decision") return JSON.stringify({ choice: messages.some((m) => m.content.includes("Result of")) ? "none" : plan.tool });
      if (name === "arguments") return JSON.stringify(plan.args);
      return plan.reply;
    },
  };
}

function makeIo(home: string, answers: Array<string | null> = [], llm?: LlmProvider) {
  const out: string[] = [];
  const prompts: string[] = [];
  const io: CliIo = {
    print: (l) => void out.push(l),
    ask: async (p) => (prompts.push(p), answers.length ? answers.shift()! : null),
    env: { OPENAI_API_KEY: "sk-test" },
    home,
    llm,
    sandboxKind: "none",
  };
  return { io, out, prompts };
}

describe("cli", () => {
  test("help lists the commands; an unknown command fails", async () => {
    const { io, out } = makeIo(tmp());
    expect((await main([], io)).code).toBe(0);
    expect(out.join("\n")).toContain("august chat");
    expect((await main(["bogus"], io)).code).toBe(1);
  });

  test("init creates config, folder and welcome note, and won't overwrite without --force", async () => {
    const home = tmp();
    const { io, out } = makeIo(home);
    expect((await main(["init"], io)).code).toBe(0);
    const cfg = loadConfig(defaultConfigPath(home));
    expect(readFileSync(join(cfg.root, "welcome.md"), "utf8")).toContain("Welcome");
    expect(out.join("\n")).toContain("august secret set OPENAI_API_KEY");
    const token = cfg.gateway.token;
    expect((await main(["init"], io)).code).toBe(1);
    expect(loadConfig(defaultConfigPath(home)).gateway.token).toBe(token);
    expect((await main(["init", "--force"], io)).code).toBe(0);
    expect(loadConfig(defaultConfigPath(home)).gateway.token).not.toBe(token);
  });

  test("chat before init explains what to do", async () => {
    const { io, out } = makeIo(tmp());
    expect((await main(["chat"], io)).code).toBe(1);
    expect(out.join("\n")).toContain("august init");
  });

  test("chat answers from a file, end to end, and journals the task", async () => {
    const home = tmp();
    const llm = scriptedLlm({ tool: "fs.read", args: { path: "welcome.md" }, reply: "It says Welcome." });
    const { io, out } = makeIo(home, ["what is in welcome.md? read the file", "exit"], llm);
    await main(["init"], io);
    expect((await main(["chat"], io)).code).toBe(0);
    expect(out).toContain("It says Welcome.");
    const cfg = loadConfig(defaultConfigPath(home));
    const decisions = readFileSync(join(cfg.dataDir, "decisions.jsonl"), "utf8");
    expect(decisions).not.toBe("");
  });

  test("chat ends cleanly when input ends", async () => {
    const home = tmp();
    const { io } = makeIo(home, [null]);
    await main(["init"], io);
    expect((await main(["chat"], io)).code).toBe(0);
  });

  test("serve starts a loopback gateway that needs the token", async () => {
    const home = tmp();
    const { io } = makeIo(home, [], scriptedLlm({ tool: "none", args: {}, reply: "hi from gateway" }));
    await main(["init"], io);
    const cfg = loadConfig(defaultConfigPath(home));
    const port = 21000 + Math.floor(Math.random() * 20000);
    writeConfig(defaultConfigPath(home), { ...cfg, gateway: { ...cfg.gateway, port } });
    const r = await main(["serve"], io);
    try {
      const url = `http://127.0.0.1:${port}/v1/message`;
      const body = JSON.stringify({ channel: "web", user: "dan", text: "hello" });
      const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(denied.status).toBe(401);
      const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.gateway.token}` }, body });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ reply: "hi from gateway" });
    } finally {
      r.gateway?.stop();
    }
  });
});

describe("createApp", () => {
  test("asks for the API key by name when it is missing, without echoing anything else", () => {
    const home = tmp();
    const cfg = defaultConfig(home);
    expect(() => createApp(cfg, { env: {} })).toThrow(/august secret set OPENAI_API_KEY/);
  });

  test("a local model needs no key", () => {
    const home = tmp();
    const cfg = { ...defaultConfig(home), llm: { baseUrl: "http://localhost:11434/v1", model: "qwen", apiKeyEnv: "OPENAI_API_KEY" } };
    expect(() => createApp(cfg, { env: {} })).not.toThrow();
  });

  test("starts in shadow mode with the built-in tools installed", () => {
    const home = tmp();
    const app = createApp(defaultConfig(home), { env: { OPENAI_API_KEY: "k" } });
    expect(app.cascade.shadowMode).toBe(true);
    expect(app.registry.enabledTools().map((t) => t.name).sort()).toEqual(["august.find_tools", "august.install_skill", "august.install_tool", "clock.now", "fs.list", "fs.read"]);
    app.close();
  });

  const runtimeSession = makeSessionKey({ workspace: "home", channel: "test", user: "runtime" });
  function contextualLlm(final: (messages: readonly ChatMessage[]) => string | Promise<string>): LlmProvider {
    return { name: "contextual", complete: async (messages, options) => options?.jsonSchema?.name === "decision" ? JSON.stringify({ choice: "none" }) : options?.jsonSchema?.name === "arguments" ? "{}" : final(messages) };
  }

  test("Product behavior: a second App process receives durable conversation context", async () => {
    const home = tmp(); const cfg = defaultConfig(home);
    let app = createApp(cfg, { env: { OPENAI_API_KEY: "k" }, llm: contextualLlm(() => "Запомнил NEPTUNE-7429") });
    await app.handle(runtimeSession, "Запомни NEPTUNE-7429"); app.close();
    app = createApp(cfg, { env: { OPENAI_API_KEY: "k" }, llm: contextualLlm((messages) => messages.at(-1)!.content.includes("NEPTUNE-7429") ? "NEPTUNE-7429" : "не помню") });
    expect((await app.handle(runtimeSession, "Какое кодовое слово?")).reply).toBe("NEPTUNE-7429");
    expect(app.runs.messages(runtimeSession).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    app.close();
  });

  // Real OpenAiCompatibleProvider over a fake /chat/completions endpoint that reports usage the way providers do.
  function usageEndpoint(perCall: { prompt: number; completion: number } | undefined, seenBodies: Array<Record<string, unknown>> = []) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const body = JSON.parse(String(init!.body)) as { response_format?: { json_schema?: { name?: string } } } & Record<string, unknown>; seenBodies.push(body);
      const name = body.response_format?.json_schema?.name;
      const content = name === "decision" ? JSON.stringify({ choice: "none" }) : name === "arguments" ? "{}" : "готово";
      return new Response(JSON.stringify({ choices: [{ message: { content } }], ...(perCall ? { usage: { prompt_tokens: perCall.prompt, completion_tokens: perCall.completion } } : {}) }));
    }) as unknown as typeof fetch;
  }
  const meteredConfig = (home: string, extra: Record<string, unknown> = {}) => parseConfig({ ...defaultConfig(home), llm: { baseUrl: "http://127.0.0.1:9/v1", model: "local-m", pricing: { currency: "USD", inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } }, ...extra });

  test("Product behavior: provider-reported usage and price are recorded per run and survive restart", async () => {
    const home = tmp(); const cfg = meteredConfig(home);
    let app = createApp(cfg, { env: {}, fetch: usageEndpoint({ prompt: 100, completion: 10 }) });
    const reply = await app.handle(runtimeSession, "привет"); const { totals, entries } = app.runUsage(reply.runId);
    expect(reply.error).toBeUndefined(); expect(totals.calls).toBeGreaterThanOrEqual(2);
    expect(totals).toMatchObject({ inputTokens: 100 * totals.calls, outputTokens: 10 * totals.calls, costMicros: 120 * totals.calls, unreportedCalls: 0 });
    expect(entries.every((e) => e.provider === "local-m" && e.currency === "USD" && e.costMicros === 120)).toBe(true);
    app.close(); app = createApp(cfg, { env: {}, fetch: usageEndpoint(undefined) });
    expect(app.runUsage(reply.runId).totals).toEqual(totals);
    expect(readFileSync(join(cfg.dataDir, "usage.db")).includes("sk-")).toBe(false);
    app.close();
  });

  test("Safety/reliability invariant: a token budget stops the run durably and a retry starts from its own zero", async () => {
    const home = tmp(); const cfg = meteredConfig(home); const bodies: Array<Record<string, unknown>> = [];
    const app = createApp(cfg, { env: {}, fetch: usageEndpoint({ prompt: 400, completion: 100 }, bodies) });
    const stopped = await app.handle(runtimeSession, "дорого", undefined, { idempotencyKey: "k1", budget: { maxTokens: 700 } });
    expect(stopped).toMatchObject({ stopReason: "token-budget" });
    const run = app.getRun(stopped.runId)!; expect(run).toMatchObject({ state: "failed", error: "token-budget" }); expect(run.budget.maxTokens).toBe(700);
    const usage = app.runUsage(stopped.runId).totals; expect(usage.calls).toBe(2); expect(usage.inputTokens + usage.outputTokens).toBe(1000);
    const callsBefore = bodies.length;
    const retried = await app.retryRun(stopped.runId, { idempotencyKey: "k2", budget: { maxTokens: 700 } });
    expect(retried.runId).not.toBe(stopped.runId); expect(app.runUsage(stopped.runId).totals.calls).toBe(2); expect(bodies.length).toBeGreaterThan(callsBefore);
    app.close();
  });

  test("Safety/reliability invariant: a monetary budget stops the run and cannot be set without configured pricing", async () => {
    const home = tmp(); const app = createApp(meteredConfig(home), { env: {}, fetch: usageEndpoint({ prompt: 1000, completion: 500 }) });
    // 1000 in + 500 out = 1000 + 1000 = 2000 micros per call.
    const stopped = await app.handle(runtimeSession, "деньги", undefined, { budget: { maxCostMicros: 2500 } });
    expect(stopped.stopReason).toBe("cost-budget"); expect(app.getRun(stopped.runId)).toMatchObject({ state: "failed", error: "cost-budget" });
    expect(app.runUsage(stopped.runId).totals.costMicros).toBe(4000);
    app.close();
    const unpriced = createApp(defaultConfig(tmp()), { env: { OPENAI_API_KEY: "k" }, fetch: usageEndpoint({ prompt: 1, completion: 1 }) });
    await expect(unpriced.handle(runtimeSession, "x", undefined, { budget: { maxCostMicros: 10 } })).rejects.toBeInstanceOf(UnsupportedBudgetError);
    expect(unpriced.listRuns()).toHaveLength(0); unpriced.close();
  });

  test("Safety/reliability invariant: a provider that reports no usage fails a budgeted run closed and is counted when unbudgeted", async () => {
    const home = tmp(); const app = createApp(meteredConfig(home), { env: {}, fetch: usageEndpoint(undefined) });
    const budgeted = await app.handle(runtimeSession, "a", undefined, { budget: { maxTokens: 10_000 } });
    expect(budgeted.stopReason).toBe("usage-unreported"); expect(app.getRun(budgeted.runId)!.state).toBe("failed");
    const free = await app.handle(runtimeSession, "b"); expect(free.error).toBeUndefined();
    expect(app.runUsage(free.runId).totals).toMatchObject({ inputTokens: 0, costMicros: 0 }); expect(app.runUsage(free.runId).totals.unreportedCalls).toBeGreaterThanOrEqual(2);
    app.close();
  });

  test("Product behavior: config runBudget applies to every run unless the call overrides it", async () => {
    const home = tmp(); const app = createApp(meteredConfig(home, { runBudget: { maxTokens: 300 } }), { env: {}, fetch: usageEndpoint({ prompt: 200, completion: 50 }) });
    expect((await app.handle(runtimeSession, "a")).stopReason).toBe("token-budget");
    const overridden = await app.handle(runtimeSession, "b", undefined, { budget: { maxTokens: 100_000 } }); expect(overridden.stopReason).toBeUndefined();
    app.close();
  });

  test("Safety/reliability invariant: the completion is clamped to the tokens a run has left", async () => {
    const bodies: Array<Record<string, unknown>> = []; const app = createApp(meteredConfig(tmp()), { env: {}, fetch: usageEndpoint({ prompt: 500, completion: 0 }, bodies) });
    const stopped = await app.handle(runtimeSession, "мало", undefined, { budget: { maxTokens: 520 } });
    expect(stopped.stopReason).toBe("token-budget"); expect(bodies).toHaveLength(2); expect(bodies[1]!.max_tokens).toBe(20);
    app.close();
  });

  test("Safety/reliability invariant: a paused run resumes against the tokens it already used", async () => {
    const cfg = meteredConfig(tmp()); const calls: number[] = []; let gate!: () => void; const held = new Promise<void>((resolve) => { gate = resolve; }); let second!: () => void; const secondCall = new Promise<void>((resolve) => { second = resolve; });
    const inner = usageEndpoint({ prompt: 300, completion: 0 });
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => { calls.push(calls.length + 1); if (calls.length === 2) { second(); await held; } return inner(input, init); }) as unknown as typeof fetch;
    const app = createApp(cfg, { env: {}, fetch: fetchFn });
    const running = app.handle(runtimeSession, "долго", undefined, { budget: { maxTokens: 700 } }); await secondCall;
    const pausing = app.pauseRun((app.listRuns({ states: ["running", "waiting_external"] })[0]!).id); gate();
    const paused = await pausing; await running; expect(paused.state).toBe("paused"); expect(app.runUsage(paused.id).totals).toMatchObject({ calls: 2, inputTokens: 600 });
    const resumed = await app.resumeRun(paused.id);
    // 600 tokens were already spent, so the very next call crosses 700. A fresh meter would have allowed three more calls.
    expect(resumed.stopReason).toBe("token-budget"); expect(app.runUsage(paused.id).totals).toMatchObject({ calls: 3, inputTokens: 900 });
    app.close();
  });

  test("config: pricing and runBudget are validated", () => {
    const base = defaultConfig("/home/u");
    const bad = (patch: Record<string, unknown>) => () => parseConfig({ ...base, ...patch });
    const pricing = { currency: "USD", inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2 };
    expect(parseConfig({ ...base, llm: { ...base.llm, pricing }, runBudget: { maxTokens: 5, maxCostMicros: 9 } })).toMatchObject({ llm: { pricing }, runBudget: { maxTokens: 5, maxCostMicros: 9 } });
    expect(bad({ llm: { ...base.llm, pricing: { ...pricing, currency: "usd" } } })).toThrow(ConfigError);
    expect(bad({ llm: { ...base.llm, pricing: { ...pricing, inputMicrosPerMillionTokens: -1 } } })).toThrow(ConfigError);
    expect(bad({ llm: { ...base.llm, pricing: { ...pricing, outputMicrosPerMillionTokens: 1.5 } } })).toThrow(ConfigError);
    expect(bad({ runBudget: { maxTokens: 0 } })).toThrow(/positive integer/);
    expect(bad({ runBudget: { maxCostMicros: 5 } })).toThrow(/needs llm.pricing/);
    expect(parseConfig(base)).not.toHaveProperty("runBudget");
  });

  test("Safety/reliability invariant: App idempotency blocks active/conflicting duplicates and replays completed replies", async () => {
    const home = tmp(); let release!: (value: string) => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<string>((resolve) => { release = resolve; });
    let calls = 0;
    const app = createApp(defaultConfig(home), { env: { OPENAI_API_KEY: "k" }, llm: contextualLlm(() => { calls++; entered(); return blocked; }) });
    const pending = app.handle(runtimeSession, "once", undefined, { idempotencyKey: "request-1" }); await started;
    expect(app.handle(runtimeSession, "once", undefined, { idempotencyKey: "request-1" })).rejects.toBeInstanceOf(RunInProgressError);
    expect(app.handle(runtimeSession, "different", undefined, { idempotencyKey: "request-1" })).rejects.toBeInstanceOf(IdempotencyConflictError);
    release("done"); const first = await pending; const callsBeforeReplay = calls;
    const replay = await app.handle(runtimeSession, "once", undefined, { idempotencyKey: "request-1" });
    expect(replay).toMatchObject({ reply: "done", runId: first.runId, replayed: true }); expect(calls).toBe(callsBeforeReplay);
    app.close();
  });

  test("Safety/reliability invariant: provider failures persist as failed runs", async () => {
    const home = tmp(); const app = createApp(defaultConfig(home), { env: { OPENAI_API_KEY: "k" }, llm: { name: "broken", complete: async () => { throw new Error("offline"); } } });
    const reply = await app.handle(runtimeSession, "hello"); expect(reply.error).toBe("Error"); expect(app.getRun(reply.runId)).toMatchObject({ state: "failed", reply: reply.reply }); expect(app.runs.messages(runtimeSession).map((m) => m.role)).toEqual(["user", "assistant"]); app.close();
  });

  test("Safety/reliability invariant: a failed post-effect checkpoint leaves the run recovering", async () => {
    const home = tmp(); const app = createApp(defaultConfig(home), { env: { OPENAI_API_KEY: "k" }, llm: scriptedLlm({ tool: "clock.now", args: {}, reply: "done" }) });
    const checkpoint = app.runs.checkpoint.bind(app.runs); app.runs.checkpoint = (id, value, now) => { if (value.phase === "tool_finished") throw new Error("disk full"); return checkpoint(id, value, now); };
    await expect(app.handle(runtimeSession, "what time is it?")).rejects.toBeInstanceOf(AgentCheckpointError);
    expect(app.listRuns({ session: runtimeSession })[0]?.state).toBe("recovering"); app.close();
  });

  test("Safety/reliability invariant: cooperative pause waits for a model step and resumes the same run", async () => {
    const home = tmp(); let release!: (value: string) => void; let entered!: () => void; let calls = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<string>((resolve) => { release = resolve; });
    const app = createApp(defaultConfig(home), { env: { OPENAI_API_KEY: "k" }, llm: contextualLlm(() => (++calls === 1 ? (entered(), blocked) : "resumed")) });
    const pending = app.handle(runtimeSession, "pause me"); await started;
    const id = app.listRuns({ session: runtimeSession })[0]!.id; const pausing = app.pauseRun(id); release("late answer");
    expect(await pausing).toMatchObject({ state: "paused", reply: "Stopped: paused." }); expect((await pending).stopReason).toBe("cancelled"); expect(app.runs.messages(runtimeSession).at(-1)?.content).toBe("Stopped: paused.");
    expect((await app.resumeRun(id)).reply).toBe("resumed"); expect(app.getRun(id)?.state).toBe("completed");
    app.close();
  });

  test("Safety/reliability invariant: recovery resumes safe checkpoints and blocks ambiguous effects", async () => {
    const home = tmp(); const cfg = defaultConfig(home); const prompts: string[] = []; const deps = { env: { OPENAI_API_KEY: "k" }, llm: contextualLlm((messages) => (prompts.push(messages.at(-1)!.content), "recovered")) };
    let app = createApp(cfg, deps); const safe = app.runs.startRun({ session: runtimeSession, request: "safe" }).run;
    const safeLoop = new LoopGuard(); safeLoop.record("notes.search", { q: "x" }); app.runs.transition(safe.id, "running"); app.runs.checkpoint(safe.id, { phase: "tool_finished", safeToResume: true, history: ["Result of notes.search: meeting at 5"], taint: { tainted: false, sources: [] }, loop: safeLoop.snapshot(), steps: 1, externalEffects: 0 }); app.close();
    app = createApp(cfg, deps); expect(app.getRun(safe.id)?.state).toBe("recovering"); expect((await app.resumeRun(safe.id)).reply).toBe("recovered"); expect(prompts.some((prompt) => prompt.includes("meeting at 5"))).toBe(true);
    const ambiguous = app.runs.startRun({ session: runtimeSession, request: "send" }).run; app.runs.transition(ambiguous.id, "running"); const loop = new LoopGuard(); loop.record("mail.send", {});
    app.runs.checkpoint(ambiguous.id, { phase: "tool_started", safeToResume: false, history: [], taint: { tainted: false, sources: [] }, loop: loop.snapshot(), steps: 0, externalEffects: 1 }); app.close();
    app = createApp(cfg, deps); expect(app.resumeRun(ambiguous.id)).rejects.toThrow(/owner resolution/);
    expect(app.resolveRun(ambiguous.id, "confirm_not_executed").state).toBe("paused"); expect((await app.resumeRun(ambiguous.id)).reply).toBe("recovered");
    const cancelled = app.runs.startRun({ session: runtimeSession, request: "retry" }).run; expect((await app.cancelRun(cancelled.id)).state).toBe("cancelled");
    await expect(app.retryRun(cancelled.id)).rejects.toThrow(/new idempotency key/);
    const retried = await app.retryRun(cancelled.id, { idempotencyKey: "retry-1" }); expect(app.getRun(retried.runId)?.retryOf).toBe(cancelled.id);
    app.close();
  });

  test("Product behavior: run state filtering happens before the requested limit", async () => {
    const home = tmp(); const app = createApp(defaultConfig(home), { env: { OPENAI_API_KEY: "k" }, llm: contextualLlm(() => "done") }); const completed = await app.handle(runtimeSession, "complete");
    const newest = app.runs.startRun({ session: runtimeSession, request: "cancel" }).run; await app.cancelRun(newest.id); expect(app.listRuns({ session: runtimeSession, states: ["completed"], limit: 1 })[0]?.id).toBe(completed.runId); app.close();
  });

  test("Safety/security invariant: untrusted result taint survives App restart", async () => {
    const home = tmp(); const cfg = defaultConfig(home); mkdirSync(cfg.root, { recursive: true }); writeFileSync(join(cfg.root, "attack.txt"), "attacker content"); const taintedSession = makeSessionKey({ workspace: "home", channel: "test", user: "tainted" });
    let app = createApp(cfg, { env: { OPENAI_API_KEY: "k" }, llm: scriptedLlm({ tool: "fs.read", args: { path: "attack.txt" }, reply: "ATTACKER-INSTRUCTION find a weather tool later" }) }); const first = await app.handle(taintedSession, "read attack.txt"); expect(first.tainted).toBe(true); app.close();
    let registryCalls = 0; const fetch = (async () => (registryCalls++, new Response(JSON.stringify({ servers: [] })))) as unknown as typeof globalThis.fetch; const asked: ApprovalRequest[] = [];
    app = createApp(cfg, { env: { OPENAI_API_KEY: "k" }, fetch, llm: scriptedLlm({ tool: "august.find_tools", args: { query: "weather" }, reply: "done" }) }); const second = await app.handle(taintedSession, "continue", { approve: async (request) => (asked.push(request), false) });
    expect(second.tainted).toBe(true); expect(asked[0]?.verdict.rule).toBe("tainted-context"); expect(registryCalls).toBe(0); expect(app.runs.taintSources(taintedSession)).toContain("fs.read");
    const clean = makeSessionKey({ workspace: "home", channel: "test", user: "clean" }); await app.handle(clean, "find a weather tool"); expect(registryCalls).toBe(1); app.close();
  });
});

describe("mcp servers from the config", () => {
  const FAKE = join(import.meta.dir, "../../mcp/test/fake-server.ts");
  const server = (over: object = {}) => ({ id: "fake", command: process.execPath, args: [FAKE], env: { FAKE_MODE: "normal" }, ...over });
  const withMcp = (home: string, mcp: unknown) => ({ ...defaultConfig(home), mcp }) as never;

  test("validates ids, duplicates, env names and trust", () => {
    const base = defaultConfig("/h");
    const bad = (mcp: unknown) => () => parseConfig({ ...base, mcp });
    expect(bad([{ id: "a.b", command: "x" }])).toThrow(/id/);
    expect(bad([{ id: "a", command: "x" }, { id: "a", command: "y" }])).toThrow(/twice/);
    expect(bad([{ id: "a", command: "x", envFrom: ["sk-123"] }])).toThrow(/environment variable names/);
    expect(bad([{ id: "a", command: "x", trust: "verified" }])).toThrow(/trust/);
    expect(bad([{ id: "a" }])).toThrow(/command/);
    expect(bad("nope")).toThrow(/list/);
    expect(() => parseConfig({ ...base, mcp: [{ id: "a", command: "x", trust: "known" }] })).not.toThrow();
  });

  test("a config without mcp still loads", () => {
    const { mcp: _drop, ...old } = defaultConfig("/h");
    expect(parseConfig(old).mcp).toEqual([]);
  });

  test("starts servers, reports failures, and one failure does not stop the rest", async () => {
    const home = tmp();
    const cfg = parseConfig(withMcp(home, [server(), server({ id: "broken", command: "/no/such/binary" }), server({ id: "needs", envFrom: ["MISSING_KEY"] })]));
    const app = createApp(cfg, { sandboxKind: "none", env: { OPENAI_API_KEY: "k", PATH: process.env.PATH }, llm: scriptedLlm({ tool: "none", args: {}, reply: "" }) });
    try {
      const r = await app.startServers();
      expect(r.started).toEqual([{ id: "fake", isolation: "none" }]);
      expect(r.failed.map((f) => f.id).sort()).toEqual(["broken", "needs"]);
      expect(r.failed.find((f) => f.id === "needs")!.error).toContain("MISSING_KEY is not set");
      expect(app.registry.enabledTools().map((t) => t.name)).toContain("fake.echo");
    } finally {
      app.mcp.closeAll();
    }
  });

  test("chat uses an MCP tool, but asks first because a community server may reach the network", async () => {
    const home = tmp();
    const llm = scriptedLlm({ tool: "fake.echo", args: { text: "pong" }, reply: "The server said pong." });
    const { io, out, prompts } = makeIo(home, ["echo pong with the fake server", "n", "echo pong with the fake server", "y", "exit"], llm);
    await main(["init"], io);
    const path = defaultConfigPath(home);
    const cfg = loadConfig(path);
    writeConfig(path, parseConfig({ ...cfg, mcp: [server()] }));
    io.env = { ...io.env, PATH: process.env.PATH };
    await main(["chat"], io);
    expect(out).toContain("Tools from: fake (not sandboxed)");
    expect(prompts.filter((p) => p.includes("Allow once?"))).toHaveLength(2);
    expect(out.some((l) => l.includes("was not approved"))).toBe(true);
    expect(out).toContain("The server said pong.");
  });
});
