import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatMessage, LlmProvider } from "@august/brain";
import { AgentCheckpointError, type ApprovalRequest } from "@august/agent";
import { LlmUsageObserverError } from "@august/brain";
import { DurableRuntimeStore, IdempotencyConflictError, RunInProgressError, makeSessionKey } from "@august/core";
import { LoopGuard } from "@august/policy";
import {
  BuiltinExecutor,
  ConfigError,
  MAX_READ_BYTES,
  PathEscapeError,
  createApp as composeApp,
  defaultConfigPath,
  loadConfig,
  main,
  parseConfig,
  openSecretStore,
  resolveInside,
  writeConfig,
  type CliIo,
} from "../src/index.ts";
import { defaultConfig, configureTestPricing } from "./config-fixture.ts";
import { defaultConfig as productionTemplate, resolveLlmPricing } from "../src/config.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "august-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Safety/security invariant (REQ-SEC-004): App fixtures own their home and credential backend.
function createApp(config: Parameters<typeof composeApp>[0], deps: Parameters<typeof composeApp>[1]) {
  const home = deps.home ?? dirname(dirname(config.dataDir));
  const secrets = deps.secrets ?? openSecretStore(dirname(config.dataDir), {
    kind: "encrypted-file", env: {}, keyDir: join(home, ".config", "august"),
    run: () => { throw new Error("App fixture attempted a host credential process"); },
  });
  return composeApp(config, { ...deps, home, secrets });
}

describe("config", () => {
  const good = () => defaultConfig("/home/u");

  test("the default config is valid and gets a fresh token each time", () => {
    expect(() => parseConfig(good())).not.toThrow();
    expect(good().gateway.token).not.toBe(good().gateway.token);
  });

  test("Safety (REQ-FUNC-007): native Laya and sidecar selection are exclusive and content-pinned", () => {
    const onnx = { directory: "/owner/models/laya", sha256: { model: "a".repeat(64), tokenizer: "b".repeat(64), tokenizerConfig: "c".repeat(64), modelConfig: "d".repeat(64) } };
    expect(parseConfig({ ...good(), laya: { onnx } }).laya?.onnx).toEqual(onnx);
    expect(() => parseConfig({ ...good(), laya: { onnx, url: "http://127.0.0.1:7788" } })).toThrow(/exactly one/);
    expect(() => parseConfig({ ...good(), laya: {} })).toThrow(/exactly one/);
    expect(() => parseConfig({ ...good(), laya: { onnx: { ...onnx, sha256: {} } } })).toThrow(/SHA-256/);
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

  test("Product behavior: pricing is explicit and unknown remote models fail before a run", () => {
    expect(productionTemplate("/home/u").llm.pricing).toBeUndefined();
    expect(good().llm.pricing).toMatchObject({ inputMicrosPerMillion: 150_000, outputMicrosPerMillion: 600_000, asOf: "2026-09-29" });
    expect(() => parseConfig({ ...good(), llm: { ...good().llm, pricing: { inputMicrosPerMillion: -1, outputMicrosPerMillion: 1, source: "x", asOf: "2026-09-29" } } })).toThrow(/pricing/);
    const home = tmp(); const unknown = { ...defaultConfig(home), llm: { baseUrl: "https://llm.example/v1", model: "custom" } };
    expect(() => createApp(unknown, { env: {}, llm: { name: "unused", complete: async () => "unused" } })).toThrow(/pricing is missing/);
  });

  test("Product behavior (REQ-REL-002): known names do not invent prices; explicit free and proxy tariffs survive", () => {
    for (const llm of [{ baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }, { baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen3-32b" }]) {
      expect(() => resolveLlmPricing({ ...good(), llm })).toThrow(/pricing is missing/);
    }
    const free = { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, source: "owner quote", asOf: "2026-01-01" };
    expect(resolveLlmPricing({ ...good(), llm: { ...good().llm, pricing: free } })).toEqual(free);
    const paid = { ...free, inputMicrosPerMillion: 17 };
    expect(resolveLlmPricing({ ...good(), llm: { baseUrl: "http://localhost:8888/v1", model: "proxy-model", pricing: paid } })).toEqual(paid);
    expect(() => resolveLlmPricing({ ...good(), llm: { baseUrl: "http://localhost:8888/v1", model: "local" } })).toThrow(/pricing is missing/);
    expect(() => parseConfig({ ...good(), llm: { ...good().llm, pricing: { ...free, asOf: "2026-02-31" } } })).toThrow(/calendar date/);
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
    const read = await ex.call("fs.read", { path: "a.txt" });
    expect(read.content).toBe("hello");
    // Owner's file: personal, and written by whoever put it there, so untrusted.
    expect(read.parts).toEqual([{ text: "hello", origin: { kind: "file", source: "fs.read", locator: "a.txt" }, trust: "untrusted", sensitivity: "personal" }]);
    const listed = await ex.call("fs.list", {});
    expect(listed.content.split("\n")).toEqual(["a.txt", "sub/"]);
    expect(listed.parts![0]).toMatchObject({ trust: "untrusted", sensitivity: "personal", origin: { kind: "file", locator: "." } });
    expect((await ex.call("clock.now", {})).parts![0]).toMatchObject({ trust: "trusted", sensitivity: "public", origin: { kind: "builtin" } });
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
      await options?.onUsage?.({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
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
    get secrets() {
      return openSecretStore(join(home, ".august"), {
        kind: "encrypted-file", env: {}, keyDir: join(home, ".config", "august"),
        run: () => { throw new Error("CLI fixture attempted a host credential process"); },
      });
    },
    llm,
    sandboxKind: "none",
  };
  return { io, out, prompts };
}

describe("cli", () => {
  test("Safety: web run views hide checkpoints and controls cannot cross sessions or resume uncertain effects", async () => {
    const home = tmp(); const { io } = makeIo(home, [], scriptedLlm({ tool: "none", args: {}, reply: "finished" }));
    await main(["init"], io); configureTestPricing(home);
    const cfg = loadConfig(defaultConfigPath(home)); const port = 21000 + Math.floor(Math.random() * 20000);
    writeConfig(defaultConfigPath(home), { ...cfg, gateway: { ...cfg.gateway, port } });
    const session = makeSessionKey({ workspace: cfg.workspace, channel: "web", user: "local" });
    const db = new DurableRuntimeStore(join(cfg.dataDir, "runtime.db"));
    const safe = db.startRun({ session, request: "continue my local task" }).run;
    db.transition(safe.id, "running"); db.checkpoint(safe.id, { phase: "before_decision", safeToResume: true, history: [], taint: { tainted: false, sources: [] }, loop: { steps: 0, repeats: [] }, steps: 0, externalEffects: 0 }); db.transition(safe.id, "paused");
    const unsafe = db.startRun({ session, request: "uncertain external task" }).run;
    db.transition(unsafe.id, "running"); db.checkpoint(unsafe.id, { phase: "tool_started", safeToResume: false, history: ["private-checkpoint-value"], lastTool: "mail.send", taint: { tainted: false, sources: [] }, loop: { steps: 0, repeats: [] }, steps: 0, externalEffects: 1 }); db.transition(unsafe.id, "recovering"); db.close();
    const running = await main(["serve"], io);
    try {
      const headers = { authorization: `Bearer ${cfg.gateway.token}`, "content-type": "application/json" };
      const response = await fetch(`http://127.0.0.1:${port}/v1/runs?channel=web&user=local`, { headers });
      const text = await response.text(); expect(text).not.toContain("private-checkpoint-value"); expect(text).not.toContain('"checkpoint"');
      expect(JSON.parse(text).runs.find((run: any) => run.id === unsafe.id).canResume).toBe(false);
      const control = (id: string, action: string, user = "local") => fetch(`http://127.0.0.1:${port}/v1/runs/${id}`, { method: "POST", headers, body: JSON.stringify({ channel: "web", user, action }) });
      expect((await control(safe.id, "cancel", "another-user")).status).toBe(409);
      expect((await control(unsafe.id, "resume")).status).toBe(409);
      const resumed = await control(safe.id, "resume"); expect(resumed.status).toBe(200); expect((await resumed.json() as { run: { state: string } }).run.state).toBe("completed");
      expect((await fetch(`http://127.0.0.1:${port}/v1/runs?channel=telegram&user=local`, { headers })).status).toBe(409);
    } finally { running.stop?.(); }
  });

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
    expect(out.join("\n")).toContain("august setup");
    expect(cfg.llm.pricing).toBeUndefined();
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
    await main(["init"], io); configureTestPricing(io.home);
    expect((await main(["chat"], io)).code).toBe(0);
    expect(out).toContain("It says Welcome.");
    const cfg = loadConfig(defaultConfigPath(home));
    const decisions = readFileSync(join(cfg.dataDir, "decisions.jsonl"), "utf8");
    expect(decisions).not.toBe("");
  });

  test("chat ends cleanly when input ends", async () => {
    const home = tmp();
    const { io } = makeIo(home, [null]);
    await main(["init"], io); configureTestPricing(io.home);
    expect((await main(["chat"], io)).code).toBe(0);
  });

  test("serve starts a loopback gateway that needs the token", async () => {
    const home = tmp();
    const { io } = makeIo(home, [], scriptedLlm({ tool: "none", args: {}, reply: "hi from gateway" }));
    await main(["init"], io); configureTestPricing(io.home);
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
      expect(await ok.json()).toEqual({ reply: "hi from gateway", runId: expect.any(String), state: "completed" });
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
    const cfg = { ...defaultConfig(home), llm: { baseUrl: "http://localhost:11434/v1", model: "qwen", pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, source: "owner local quote", asOf: new Date().toISOString().slice(0, 10) } } };
    expect(() => createApp(cfg, { env: {} })).not.toThrow();
  });

  test("starts in shadow mode with the built-in tools installed", () => {
    const home = tmp();
    const app = createApp(defaultConfig(home), { env: { OPENAI_API_KEY: "k" } });
    expect(app.cascade.shadowMode).toBe(true);
    expect(app.registry.enabledTools().map((t) => t.name).sort()).toEqual(["august.find_tools", "august.install_skill", "august.install_tool", "clock.now", "fs.list", "fs.read", "memory.forget", "memory.recall", "memory.remember"]);
    app.close();
  });

  const runtimeSession = makeSessionKey({ workspace: "home", channel: "test", user: "runtime" });
  function contextualLlm(final: (messages: readonly ChatMessage[]) => string | Promise<string>): LlmProvider {
    return { name: "contextual", complete: async (messages, options) => { await options?.onUsage?.({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }); return options?.jsonSchema?.name === "decision" ? JSON.stringify({ choice: "none" }) : options?.jsonSchema?.name === "arguments" ? "{}" : final(messages); } };
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

  test("Safety/reliability invariant: token and cost exhaustion stop before another model or tool call", async () => {
    for (const [budget, reason] of [[{ maxTokens: 2 }, "token-budget"], [{ maxTokens: 100, maxCostMicros: 1 }, "cost-budget"]] as const) {
      const home = tmp(); let calls = 0; const app = createApp(defaultConfig(home), { env: { OPENAI_API_KEY: "k" }, llm: contextualLlm(() => (++calls, "unused")) });
      const result = await app.handle(runtimeSession, reason, undefined, { budget }); const run = app.getRun(result.runId)!;
      expect(result).toMatchObject({ stopReason: reason, steps: 0 }); expect(calls).toBe(1); expect(run).toMatchObject({ state: "failed", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costMicros: 1 } }); app.close();
      const reopened = createApp(defaultConfig(home), { env: { OPENAI_API_KEY: "k" }, llm: contextualLlm(() => "unused") }); expect(reopened.getRun(result.runId)?.usage).toEqual(run.usage); reopened.close();
    }
  });

  test("Safety/reliability (REQ-REL-002): zero money starts no paid generation while explicit free generation works", async () => {
    let calls = 0;
    const paid = createApp(defaultConfig(tmp()), { env: {}, llm: contextualLlm(() => { calls++; return "unwanted"; }) });
    const stopped = await paid.handle(runtimeSession, "hi", undefined, { budget: { maxCostMicros: 0 } });
    expect(stopped.stopReason).toBe("cost-budget");
    expect(calls).toBe(0);
    expect(paid.getRun(stopped.runId)?.usage.totalTokens).toBe(0);
    paid.close();
    const cfg = defaultConfig(tmp()); cfg.llm.pricing = { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, source: "owner free quote", asOf: "2026-01-01" };
    const free = createApp(cfg, { env: {}, llm: contextualLlm(() => "free reply") });
    const result = await free.handle(runtimeSession, "hi", undefined, { budget: { maxCostMicros: 0 } });
    expect(result.reply).toBe("free reply");
    expect(free.getRun(result.runId)?.usage.costMicros).toBe(0);
    free.close();
  });

  test("Safety/reliability invariant: missing usage fails and accounting persistence errors propagate", async () => {
    const missing = createApp(defaultConfig(tmp()), { env: { OPENAI_API_KEY: "k" }, llm: { name: "missing", complete: async () => JSON.stringify({ choice: "none" }) } }); const reply = await missing.handle(runtimeSession, "missing"); expect(reply.error).toBe("LlmUsageError"); expect(missing.getRun(reply.runId)).toMatchObject({ state: "failed", usage: { totalTokens: 0 } }); missing.close();
    const app = createApp(defaultConfig(tmp()), { env: { OPENAI_API_KEY: "k" }, llm: contextualLlm(() => "unused") }); app.runs.recordUsage = () => { throw new Error("disk full"); }; await expect(app.handle(runtimeSession, "persist")).rejects.toBeInstanceOf(LlmUsageObserverError); expect(app.listRuns({ session: runtimeSession })[0]?.state).toBe("failed"); app.close();
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
    // Owner-configured servers (trust "known") may run unsandboxed on a machine with no sandbox; community ones may not (see containment.test.ts).
    const cfg = parseConfig(withMcp(home, [server({ trust: "known" }), server({ id: "broken", trust: "known", command: "/no/such/binary" }), server({ id: "needs", trust: "known", envFrom: ["MISSING_KEY"] })]));
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
    await main(["init"], io); configureTestPricing(io.home);
    const path = defaultConfigPath(home);
    const cfg = loadConfig(path);
    // The owner explicitly runs this community server without a sandbox: the only way to do so.
    writeConfig(path, parseConfig({ ...cfg, mcp: [server({ sandbox: "off" })] }));
    io.env = { ...io.env, PATH: process.env.PATH };
    await main(["chat"], io);
    expect(out).toContain("Tools from: fake (not sandboxed)");
    expect(prompts.filter((p) => p.includes("Allow once?"))).toHaveLength(2);
    expect(out.some((l) => l.includes("was not approved"))).toBe(true);
    expect(out).toContain("The server said pong.");
  });
});
