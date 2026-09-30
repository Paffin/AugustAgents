import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableRuntimeStore,
  IdempotencyConflictError,
  InvalidRunTransitionError,
  RunInProgressError,
  RuntimeOwnerInUseError,
  inspectRuntimeSchema,
  makeSessionKey,
} from "../src/index.ts";

const dirs: string[] = [];
const tempDb = () => { const dir = mkdtempSync(join(tmpdir(), "august-runtime-")); dirs.push(dir); return join(dir, "runtime.db"); };
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const session = makeSessionKey({ workspace: "home", channel: "test", user: "u" });
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function createV1(path: string): string {
  const db = new Database(path); const id = "legacy-run"; const budget = { maxSteps: 12, maxWallMs: 300_000, maxExternalEffects: 8, maxTokens: "unavailable", maxCostMicros: "unavailable" };
  db.run("CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); db.run("INSERT INTO runtime_meta VALUES ('schema_version','1')");
  db.run("CREATE TABLE messages (session TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session,seq))");
  db.run("CREATE TABLE runs (id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL, request_fingerprint TEXT NOT NULL, idempotency_key TEXT, reply TEXT, error TEXT, budget_json TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0, external_effects INTEGER NOT NULL DEFAULT 0, checkpoint_json TEXT, retry_of TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(session,idempotency_key))");
  db.run("CREATE INDEX runs_session_updated ON runs(session,updated_at DESC)"); db.query("INSERT INTO messages VALUES (?,?,?,?,?)").run(session, 1, "user", "legacy", 1); db.query("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, session, "completed", "legacy request", "old-fingerprint", "legacy-key", "done", null, JSON.stringify(budget), 2, 1, JSON.stringify({ phase: "before_decision", safeToResume: true, history: [], taint: { tainted: true, sources: ["legacy.tool"] } }), null, 1, 2); db.close(); return id;
}
function createV3(path: string): string {
  const store=new DurableRuntimeStore(path),run=store.startRun({session,request:"owned retained v3 receipt"}).run;
  store.transition(run.id,"running");store.appendMessage(session,"user","retained v3 message");
  store.beginModelAttempt(run.id,{id:"v3-attempt",provider:"owned",model:"fixture",requestHash:"a".repeat(64),completionTokens:10},{inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000});
  store.reportModelAttempt("v3-attempt",{inputTokens:2,outputTokens:3,totalTokens:5});store.finishRun(run.id,"completed","retained v3 reply");store.close();
  // Downgrade only this unique synthesized fixture to the prior published schema.
  const raw=new Database(path);raw.run("DROP TABLE tool_attempts");raw.run("DROP INDEX model_attempts_day");raw.run("ALTER TABLE model_attempts DROP COLUMN tool_id");raw.run("UPDATE runtime_meta SET value='3' WHERE key='schema_version'");raw.run("PRAGMA wal_checkpoint(TRUNCATE)");raw.close();return run.id;
}

describe("DurableRuntimeStore", () => {
  test("Product behavior: owner-only WAL database reopens messages in order", () => {
    const path = tempDb();
    let store = new DurableRuntimeStore(path);
    expect(store.schemaVersion()).toBe(4);
    expect(store.journalMode()).toBe("wal");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.appendMessage(session, "user", "first", 1);
    store.appendMessage(session, "assistant", "second", 2);
    const persistedRun = store.startRun({ session, request: "persist budget" }).run;
    store.close();
    store = new DurableRuntimeStore(path);
    expect(store.messages(session).map((m) => [m.seq, m.role, m.content])).toEqual([[1, "user", "first"], [2, "assistant", "second"]]);
    expect(store.getRun(persistedRun.id)).toMatchObject({ budget: { maxTokens: 50_000, maxCostMicros: 100_000 }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 } });
    store.close();
  });

  test("Safety/reliability invariant: backup copies open read-only without recovery writes", () => {
    const path = tempDb(); const backup = tempDb(); const writer = new DurableRuntimeStore(path); writer.appendMessage(session, "user", "kept"); writer.close(); copyFileSync(path, backup);
    const reader = new DurableRuntimeStore(backup, { readOnly: true }); expect(reader.schemaVersion()).toBe(4); expect(reader.counts()).toEqual({ messages: 1, runs: 0 }); expect(existsSync(`${backup}-shm`)).toBe(false);
    expect(() => reader.appendMessage(session, "assistant", "blocked")).toThrow(); reader.close();
  });

  test("Product behavior: StateView keeps newest messages within exact bounds", () => {
    const store = new DurableRuntimeStore();
    for (let i = 1; i <= 45; i++) store.appendMessage(session, i % 2 ? "user" : "assistant", `message-${i}`);
    const view = store.stateView(session, 40, 500);
    expect(view.length).toBeLessThanOrEqual(40);
    expect(view.at(-1)).toContain("message-45");
    expect(view.join("\n").length).toBeLessThanOrEqual(500);
    store.close();
  });

  test("Product behavior: StateView tail-clips an older message and preserves its role", () => {
    const store = new DurableRuntimeStore(); store.appendMessage(session, "user", "x".repeat(200)); store.appendMessage(session, "assistant", "new");
    const view = store.stateView(session, 40, 70); expect(view).toHaveLength(2); expect(view[0]).toStartWith("User: [earlier content truncated]"); expect(view[0]).toEndWith("x"); expect(view[1]).toBe("Assistant: new"); expect(view.join("\n").length).toBe(70); store.close();
  });

  test("Safety/reliability invariant: idempotency binds request and blocks active duplicates", () => {
    const store = new DurableRuntimeStore();
    const first = store.startRun({ session, request: "hello", idempotencyKey: "req-1" });
    expect(first.replayed).toBe(false);
    expect(() => store.startRun({ session, request: "hello", idempotencyKey: "req-1" })).toThrow(RunInProgressError);
    expect(() => store.startRun({ session, request: "different", idempotencyKey: "req-1" })).toThrow(IdempotencyConflictError);
    store.transition(first.run.id, "running");
    store.transition(first.run.id, "completed", { reply: "done" });
    const replay = store.startRun({ session, request: "hello", idempotencyKey: "req-1" });
    expect(replay.replayed).toBe(true);
    expect(replay.run.reply).toBe("done");
    store.close();
  });

  test("Safety/reliability invariant: two store handles serialize one idempotency winner", async () => {
    const path = tempDb(); const a = new DurableRuntimeStore(path); const b = new DurableRuntimeStore(path);
    const results = await Promise.allSettled([Promise.resolve().then(() => a.startRun({ session, request: "same", idempotencyKey: "race" })), Promise.resolve().then(() => b.startRun({ session, request: "same", idempotencyKey: "race" }))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); expect(results.filter((r) => r.status === "rejected")[0]).toMatchObject({ reason: expect.any(RunInProgressError) }); expect(a.listRuns(session)).toHaveLength(1); a.close(); b.close();
  });

  test("Safety/reliability invariant: existing malformed schemas fail closed without reseeding", () => {
    const path = tempDb(); const raw = new Database(path); raw.run("CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); raw.close();
    expect(() => new DurableRuntimeStore(path)).toThrow(); const check = new Database(path); expect(check.query("SELECT COUNT(*) count FROM runtime_meta").get()).toEqual({ count: 0 }); check.close();
    const wrong = tempDb(); const store = new DurableRuntimeStore(wrong); store.close(); const corrupt = new Database(wrong); corrupt.run("UPDATE runtime_meta SET value='5' WHERE key='schema_version'"); corrupt.close(); expect(() => new DurableRuntimeStore(wrong)).toThrow(/unsupported runtime schema 5/);
    const badBudget = tempDb(); const budgetStore = new DurableRuntimeStore(badBudget); budgetStore.startRun({ session, request: "x" }); budgetStore.close(); const budgetDb = new Database(badBudget); budgetDb.run("UPDATE runs SET budget_json='{}'"); budgetDb.close(); expect(() => new DurableRuntimeStore(badBudget)).toThrow(/invalid persisted run budget/);
  });

  test("Safety/reliability invariant: transitions reject invalid edges", () => {
    const store = new DurableRuntimeStore();
    const { run } = store.startRun({ session, request: "x" });
    expect(() => store.transition(run.id, "completed")).toThrow(InvalidRunTransitionError);
    store.transition(run.id, "running");
    store.transition(run.id, "waiting_approval");
    store.transition(run.id, "paused");
    store.transition(run.id, "running");
    store.transition(run.id, "verifying");
    store.transition(run.id, "completed", { reply: "ok" });
    expect(() => store.transition(run.id, "running")).toThrow(InvalidRunTransitionError);
    store.close();
  });

  test("Safety/reliability invariant: reply and terminal state commit atomically", () => {
    const store = new DurableRuntimeStore(); const { run } = store.startRun({ session, request: "finish" });
    expect(() => store.finishRun(run.id, "completed", "nope")).toThrow(InvalidRunTransitionError); expect(store.messages(session)).toHaveLength(0);
    store.transition(run.id, "running"); const finished = store.finishRun(run.id, "completed", "done", { steps: 1 }); expect(finished).toMatchObject({ state: "completed", reply: "done", steps: 1 }); expect(store.messages(session).at(-1)).toMatchObject({ role: "assistant", content: "done" }); store.close();
  });

  test("Safety/reliability invariant: session taint survives terminal runs", () => {
    const store = new DurableRuntimeStore(); const { run } = store.startRun({ session, request: "tainted" }); store.transition(run.id, "running");
    store.checkpoint(run.id, { phase: "before_decision", safeToResume: true, history: [], taint: { tainted: true, sources: ["web.fetch"] }, loop: { steps: 0, repeats: [] }, steps: 0, externalEffects: 0 }); store.finishRun(run.id, "completed", "done");
    expect(store.taintSources(session)).toEqual(["web.fetch"]); store.close();
  });

  test("Safety/reliability invariant: startup marks interrupted tool calls ambiguous", () => {
    const path = tempDb();
    let store = new DurableRuntimeStore(path);
    const { run } = store.startRun({ session, request: "send" });
    store.transition(run.id, "running");
    store.checkpoint(run.id, { phase: "tool_started", safeToResume: false, history: [], lastTool: "mail.send", argsHash: "abc" });
    store.transition(run.id, "waiting_external");
    store.close();
    store = new DurableRuntimeStore(path, { exclusiveOwner: true });
    expect(store.getRun(run.id)?.state).toBe("recovering");
    expect(() => store.transition(run.id, "running")).toThrow(InvalidRunTransitionError);
    const resolved = store.resolveRun(run.id, "confirm_not_executed");
    expect(resolved.state).toBe("paused");
    expect(resolved.checkpoint?.safeToResume).toBe(true);
    store.close();
  });

  test("Safety/reliability invariant: only an exclusive runtime owner recovers work; observers never interrupt it", () => {
    const path = tempDb(); const owner = new DurableRuntimeStore(path, { exclusiveOwner: true });
    const run = owner.startRun({ session, request: "running task" }).run; owner.transition(run.id, "running");
    const observer = new DurableRuntimeStore(path);
    expect(observer.getRun(run.id)?.state).toBe("running");
    expect(() => new DurableRuntimeStore(path, { exclusiveOwner: true })).toThrow(RuntimeOwnerInUseError);
    expect(owner.getRun(run.id)?.state).toBe("running"); observer.close();
    expect(() => new DurableRuntimeStore(path, { exclusiveOwner: true })).toThrow(RuntimeOwnerInUseError);
    owner.close(); owner.close();
    const replacement = new DurableRuntimeStore(path, { exclusiveOwner: true });
    expect(replacement.getRun(run.id)?.state).toBe("recovering"); replacement.close();
  });

  test("Safety/reliability invariant: actual exited owner is reclaimed without replaying its uncertain tool", () => {
    const path = tempDb(); const moduleUrl = new URL("../src/durable-runtime.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--eval", `import { DurableRuntimeStore } from ${JSON.stringify(moduleUrl)}; const s = new DurableRuntimeStore(${JSON.stringify(path)}, {exclusiveOwner:true}); const r = s.startRun({session:"home:test:u", request:"owned crash"}).run; s.transition(r.id,"running"); s.checkpoint(r.id,{phase:"tool_started",safeToResume:false,history:[]}); process.exit(0);`], { encoding: "utf8" });
    expect(child.status).toBe(0);
    const replacement = new DurableRuntimeStore(path, { exclusiveOwner: true });
    const run = replacement.listRuns()[0]!; expect(run.state).toBe("recovering");
    expect(() => replacement.transition(run.id, "running")).toThrow(InvalidRunTransitionError); replacement.close();
    const bad = new Database(path); bad.query("INSERT INTO runtime_meta VALUES ('runtime_owner',?)").run("invalid-owned-fixture"); bad.close();
    expect(() => new DurableRuntimeStore(path, { exclusiveOwner: true })).toThrow(/invalid runtime owner/);
    expect(() => new DurableRuntimeStore(path, { readOnly: true, exclusiveOwner: true })).toThrow(/read-only/);
  });

  test("durable pause/cancel intent survives abrupt owner exit, and cancel cannot be downgraded", () => {
    const moduleUrl = new URL("../src/durable-runtime.ts", import.meta.url).href;
    for (const desired of ["paused", "cancelled"] as const) {
      const path = tempDb();
      const child = spawnSync(process.execPath, ["--eval", `import { DurableRuntimeStore } from ${JSON.stringify(moduleUrl)}; const s=new DurableRuntimeStore(${JSON.stringify(path)},{exclusiveOwner:true}); const r=s.startRun({session:"home:test:u",request:"owned interrupted model"}).run; s.transition(r.id,"running"); s.checkpoint(r.id,{phase:"before_decision",safeToResume:true,history:[]}); s.requestStop(r.id,${JSON.stringify(desired)}); ${desired === "cancelled" ? 'if(s.requestStop(r.id,"paused")!=="cancelled")throw Error("cancel downgraded");' : ""} process.exit(0);`], { encoding: "utf8" });
      expect(child.status).toBe(0);
      const restarted = new DurableRuntimeStore(path, { exclusiveOwner: true });
      const run = restarted.listRuns()[0]!; expect(run.state).toBe(desired); expect(run.reply).toBe(`Stopped: ${desired}.`);
      expect(restarted.requestedStop(run.id)).toBeUndefined(); expect(restarted.messages(session)).toHaveLength(1);
      restarted.close(); const again = new DurableRuntimeStore(path, { exclusiveOwner: true });
      expect(again.messages(session)).toHaveLength(1); expect(again.getRun(run.id)?.state).toBe(desired); again.close();
    }
  });

  test("recovered pause cannot make an uncertain effect resumable; cancelled further work never replays it", () => {
    for (const desired of ["paused", "cancelled"] as const) {
      const path = tempDb(), store = new DurableRuntimeStore(path, { exclusiveOwner: true });
      const run = store.startRun({ session, request: "uncertain owned call" }).run; store.transition(run.id, "running");
      store.checkpoint(run.id, { phase: "tool_started", safeToResume: false, history: [] }); store.requestStop(run.id, desired); store.close();
      const restarted = new DurableRuntimeStore(path, { exclusiveOwner: true });
      expect(restarted.getRun(run.id)?.state).toBe(desired === "paused" ? "recovering" : "cancelled");
      expect(() => restarted.transition(run.id, "running")).toThrow(InvalidRunTransitionError);
      if (desired === "cancelled") expect(restarted.getRun(run.id)?.reply).toContain("effect may be uncertain");
      else expect(restarted.requestedStop(run.id)).toBe("paused"); restarted.close();
    }
  });

  test("accepted cancel survives an intervening runtime failure, preserving its error", () => {
    const path = tempDb(), owner = new DurableRuntimeStore(path, { exclusiveOwner: true });
    const run = owner.startRun({ session, request: "owned failure after cancel" }).run; owner.transition(run.id, "running");
    owner.requestStop(run.id, "cancelled"); owner.transition(run.id, "failed", { error: "owned accounting failure" }); owner.close();
    const restarted = new DurableRuntimeStore(path, { exclusiveOwner: true });
    expect(restarted.getRun(run.id)?.state).toBe("cancelled"); expect(restarted.getRun(run.id)?.error).toBe("owned accounting failure"); restarted.close();
  });

  test("Product behavior: retry creates a new related run", () => {
    const store = new DurableRuntimeStore();
    const { run } = store.startRun({ session, request: "retry me", idempotencyKey: "old" });
    store.transition(run.id, "running");
    store.transition(run.id, "failed", { error: "boom" });
    const retry = store.retryRun(run.id, { idempotencyKey: "new" });
    expect(retry.run.id).not.toBe(run.id);
    expect(retry.run.retryOf).toBe(run.id);
    expect(() => store.retryRun(run.id)).toThrow(/new idempotency key/);
    expect(() => store.retryRun(run.id, { idempotencyKey: "old" })).toThrow(IdempotencyConflictError);
    store.close();
  });

  test("Product behavior: numeric usage budgets persist and validate", () => {
    const store = new DurableRuntimeStore();
    const { run } = store.startRun({ session, request: "supported", budget: { maxTokens: 100, maxCostMicros: 10 } }); expect(run.budget).toMatchObject({ maxTokens: 100, maxCostMicros: 10 });
    expect(() => store.startRun({ session, request: "x", budget: { maxTokens: 0 } })).toThrow(/maxTokens/); expect(() => store.startRun({ session, request: "x", budget: { maxCostMicros: -1 } })).toThrow(/maxCostMicros/);
    expect(() => store.checkpoint(run.id, { phase: "before_decision", safeToResume: true, history: ["я".repeat(40_000)] })).toThrow(/too large/);
    store.close();
  });

  test("Temporary migration: v1 migrates with exact owner-only backup and preserved data", () => {
    const path = tempDb(); const id = createV1(path); const before = sha256(path); const store = new DurableRuntimeStore(path); const backup = `${path}.v1.backup`;
    expect(store.schemaVersion()).toBe(4); expect(sha256(backup)).toBe(before); expect(readFileSync(`${backup}.sha256`, "utf8").trim()).toBe(`sha256:${before}`); expect(statSync(backup).mode & 0o777).toBe(0o600); expect(inspectRuntimeSchema(backup)).toBe(1);
    expect(store.messages(session).at(0)?.content).toBe("legacy"); expect(store.getRun(id)).toMatchObject({ state: "completed", reply: "done", steps: 2, externalEffects: 1, usage: { totalTokens: 0, costMicros: 0 } }); expect(store.taintSources(session)).toEqual(["legacy.tool"]); expect(store.startRun({ session, request: "legacy request", idempotencyKey: "legacy-key" }).replayed).toBe(true); store.close();
    const rollback = tempDb(); copyFileSync(backup, rollback); expect(inspectRuntimeSchema(rollback)).toBe(1); const raw = new Database(rollback, { readonly: true }); expect(raw.query("SELECT reply FROM runs WHERE id=?").get(id)).toEqual({ reply: "done" }); raw.close();
  });

  test("Temporary migration: validated existing backup is reused and corrupt backup fails closed", () => {
    const reusable = tempDb(); createV1(reusable); const digest = sha256(reusable); copyFileSync(reusable, `${reusable}.v1.backup`); writeFileSync(`${reusable}.v1.backup.sha256`, `sha256:${digest}\n`, { mode: 0o600 }); const store = new DurableRuntimeStore(reusable); expect(store.schemaVersion()).toBe(4); store.close();
    const corrupt = tempDb(); createV1(corrupt); const original = sha256(corrupt); copyFileSync(corrupt, `${corrupt}.v1.backup`); writeFileSync(`${corrupt}.v1.backup.sha256`, `sha256:${original}\n`); writeFileSync(`${corrupt}.v1.backup`, "corrupt"); expect(() => new DurableRuntimeStore(corrupt)).toThrow(/invalid runtime v1 backup/); expect(inspectRuntimeSchema(corrupt)).toBe(1); expect(sha256(corrupt)).toBe(original);
  });

  test("Product behavior: usage accounting is cumulative, rounded once, durable, and budgeted", async () => {
    const path = tempDb(); const a = new DurableRuntimeStore(path); const run = a.startRun({ session, request: "meter", budget: { maxTokens: 10, maxCostMicros: 2 } }).run; a.transition(run.id, "running");
    expect(a.recordUsage(run.id, { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, { inputMicrosPerMillion: 150_000, outputMicrosPerMillion: 600_000 }).run.usage.costMicros).toBe(1);
    const b = new DurableRuntimeStore(path); await Promise.all([Promise.resolve().then(() => a.recordUsage(run.id, { inputTokens: 3, outputTokens: 0, totalTokens: 3 }, { inputMicrosPerMillion: 150_000, outputMicrosPerMillion: 600_000 })), Promise.resolve().then(() => b.recordUsage(run.id, { inputTokens: 0, outputTokens: 1, totalTokens: 1 }, { inputMicrosPerMillion: 150_000, outputMicrosPerMillion: 600_000 }))]);
    expect(a.getRun(run.id)?.usage).toEqual({ inputTokens: 4, outputTokens: 1, totalTokens: 5, costMicros: 2 }); expect(a.recordUsage(run.id, { inputTokens: 5, outputTokens: 0, totalTokens: 5 }, { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 }).exhausted).toBe("token-budget"); a.close(); b.close(); const reopened = new DurableRuntimeStore(path); expect(reopened.getRun(run.id)?.usage.totalTokens).toBe(10); reopened.close();
  });

  test("Safety/reliability invariant: usage rejects bad data and terminal writes", () => {
    const store = new DurableRuntimeStore(); const run = store.startRun({ session, request: "strict", budget: { maxCostMicros: 0 } }).run; store.transition(run.id, "running");
    expect(store.recordUsage(run.id, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 }).exhausted).toBeUndefined(); expect(() => store.recordUsage(run.id, { inputTokens: 1, outputTokens: 0, totalTokens: 2 }, { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 })).toThrow(/invalid provider usage/); expect(() => store.recordUsage(run.id, { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, { inputMicrosPerMillion: -1, outputMicrosPerMillion: 0 })).toThrow(/invalid usage pricing/); store.transition(run.id, "failed"); expect(() => store.recordUsage(run.id, { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 })).toThrow(/terminal/); store.close();
  });

  test("model attempts hold unknown billing across restart and settle one immutable quote exactly once", () => {
    const path = tempDb(); let store = new DurableRuntimeStore(path, { exclusiveOwner: true });
    const run = store.startRun({ session, request: "owned pending generation", budget: { maxTokens: 100, maxCostMicros: 100 } }).run;
    store.transition(run.id, "running");
    const quote = { inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 500_000, source: "owned quote", asOf: "2026-09-30" };
    store.beginModelAttempt(run.id, { id: "attempt-owned-1", provider: "owned-provider", model: "owned-model", requestHash: "a".repeat(64) }, quote);
    quote.outputMicrosPerMillion = 1;
    expect(store.modelAccounting(run.id)).toEqual({ unresolvedCalls: 1, reservedTokens: 100, reservedCostMicros: 100 });
    expect(() => store.beginModelAttempt(run.id, { id: "attempt-owned-2", provider: "p", model: "m", requestHash: "b".repeat(64) }, quote)).toThrow(/unresolved/);
    store.finishRun(run.id, "cancelled", "owner cancelled"); store.close();
    store = new DurableRuntimeStore(path, { exclusiveOwner: true });
    expect(store.getModelAttempt("attempt-owned-1")?.state).toBe("unknown");
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    expect(store.reportModelAttempt("attempt-owned-1", usage, "owner").run.usage).toEqual({ ...usage, costMicros: 2 });
    expect(store.reportModelAttempt("attempt-owned-1", usage).run.usage.totalTokens).toBe(12);
    expect(() => store.reportModelAttempt("attempt-owned-1", { inputTokens: 1, outputTokens: 1, totalTokens: 2 })).toThrow(/conflicts/);
    expect(store.modelAccounting(run.id).unresolvedCalls).toBe(0); expect(store.getRun(run.id)?.state).toBe("cancelled"); store.close();
  });

  test("known unsent attempts release the hold; new tariffs never reprice earlier usage", () => {
    const store = new DurableRuntimeStore(); const run = store.startRun({ session, request: "quotes" }).run; store.transition(run.id, "running");
    const quote = { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 };
    store.beginModelAttempt(run.id, { id: "unsent", provider: "p", model: "m", requestHash: "a".repeat(64) }, quote);
    store.finishModelAttempt("unsent", "not_sent", "connection_refused"); expect(store.modelAccounting(run.id).unresolvedCalls).toBe(0);
    store.recordUsage(run.id, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, quote);
    expect(store.recordUsage(run.id, { inputTokens: 2, outputTokens: 0, totalTokens: 2 }, { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 }).run.usage.costMicros).toBe(3);
    store.close();
  });

  test("v2→v3 preserves rows/costs, verifies its exact backup, and refuses a live owner", () => {
    const v2 = () => {
      const path = tempDb(), store = new DurableRuntimeStore(path);
      const run = store.startRun({ session, request: "legacy received estimate" }).run; store.transition(run.id, "running");
      store.recordUsage(run.id, { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 0 });
      store.finishRun(run.id, "completed", "retained"); store.close();
      const raw = new Database(path); raw.run("DROP TABLE model_attempts");raw.run("DROP TABLE tool_attempts"); raw.run("ALTER TABLE runs DROP COLUMN cost_numerator"); raw.run("UPDATE runtime_meta SET value='2' WHERE key='schema_version'"); raw.run("PRAGMA wal_checkpoint(TRUNCATE)"); raw.close();
      return { path, id: run.id };
    };
    const { path, id } = v2(), before = sha256(path), migrated = new DurableRuntimeStore(path);
    expect(migrated.schemaVersion()).toBe(4); expect(migrated.getRun(id)).toMatchObject({ reply: "retained", usage: { totalTokens: 12, costMicros: 10 } });
    expect(migrated.modelAccounting(id).legacyUsage).toBe(true); expect(sha256(`${path}.v2.backup`)).toBe(before);
    expect(inspectRuntimeSchema(`${path}.v2.backup`)).toBe(2); migrated.close();
    const reader = new DurableRuntimeStore(`${path}.v2.backup`, { readOnly: true }); expect(reader.getRun(id)?.reply).toBe("retained"); reader.close();
    const invalid = v2(); copyFileSync(invalid.path, `${invalid.path}.v2.backup`); writeFileSync(`${invalid.path}.v2.backup.sha256`, "invalid-owned-fixture");
    expect(() => new DurableRuntimeStore(invalid.path)).toThrow(/invalid runtime v2 backup/); expect(inspectRuntimeSchema(invalid.path)).toBe(2);
    const live = v2(), raw = new Database(live.path); raw.query("INSERT INTO runtime_meta VALUES ('runtime_owner',?)").run(JSON.stringify({ pid: process.pid, nonce: "owned-fixture" })); raw.close();
    const unchanged = sha256(live.path); expect(() => new DurableRuntimeStore(live.path)).toThrow(RuntimeOwnerInUseError);
    expect(sha256(live.path)).toBe(unchanged); expect(existsSync(`${live.path}.v2.backup`)).toBe(false);
  });

  test("v3→v4 preserves exact receipts/messages, checksum backup and readonly rollback",()=>{
    const path=tempDb(),id=createV3(path),before=sha256(path),store=new DurableRuntimeStore(path,{budgetPolicy:{timeZone:"UTC"}});
    expect(store.schemaVersion()).toBe(4);expect(store.getRun(id)).toMatchObject({reply:"retained v3 reply",usage:{totalTokens:5,costMicros:5}});
    expect(store.modelAttempts(id)[0]).toMatchObject({id:"v3-attempt",state:"reported",usage:{totalTokens:5}});
    expect(store.messages(session)[0]?.content).toBe("retained v3 message");expect(store.budgetSnapshot().daily).toMatchObject({tokens:5,costMicros:5});store.close();
    expect(sha256(`${path}.v3.backup`)).toBe(before);expect(statSync(`${path}.v3.backup`).mode&0o777).toBe(0o600);
    expect(readFileSync(`${path}.v3.backup.sha256`,"utf8").trim()).toBe(`sha256:${before}`);expect(inspectRuntimeSchema(`${path}.v3.backup`)).toBe(3);
    const backup=new DurableRuntimeStore(`${path}.v3.backup`,{readOnly:true});expect(backup.getRun(id)?.reply).toBe("retained v3 reply");expect(()=>backup.budgetSnapshot()).toThrow("schema v4");backup.close();
    const raw=new Database(path,{readonly:true});expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);raw.close();
  });
  test("v3→v4 refuses corrupt backup and live owner before schema mutation",()=>{
    const corrupt=tempDb();createV3(corrupt);const before=sha256(corrupt);copyFileSync(corrupt,`${corrupt}.v3.backup`);writeFileSync(`${corrupt}.v3.backup.sha256`,"invalid-owned-fixture");
    expect(()=>new DurableRuntimeStore(corrupt)).toThrow("invalid runtime v3 backup");expect(inspectRuntimeSchema(corrupt)).toBe(3);expect(sha256(corrupt)).toBe(before);
    const live=tempDb();createV3(live);const raw=new Database(live);raw.query("INSERT INTO runtime_meta VALUES ('runtime_owner',?)").run(JSON.stringify({pid:process.pid,nonce:"owned-v3-fixture"}));raw.close();
    const unchanged=sha256(live);expect(()=>new DurableRuntimeStore(live)).toThrow(RuntimeOwnerInUseError);expect(sha256(live)).toBe(unchanged);expect(existsSync(`${live}.v3.backup`)).toBe(false);
  });
  test("v3→v4 rolls back atomically if retained receipt foreign keys are broken",()=>{
    const path=tempDb();createV3(path);const raw=new Database(path);raw.run("UPDATE model_attempts SET run_id='owned-missing-run'");raw.close();
    expect(()=>new DurableRuntimeStore(path)).toThrow("foreign-key violation");expect(inspectRuntimeSchema(path)).toBe(3);
    const inspected=new Database(path,{readonly:true});expect((inspected.query("PRAGMA table_info(model_attempts)").all() as Array<{name:string}>).some(c=>c.name==="tool_id")).toBe(false);inspected.close();
  });
  test("busy WAL snapshots refuse v1/v2/v3 migration before creating an incomplete backup", () => {
    for (const version of [1,2,3]) {
      const path = tempDb();
      if (version === 1) createV1(path);
      else if(version===3)createV3(path);
      else {
        const store = new DurableRuntimeStore(path); store.close();
        const raw = new Database(path); raw.run("DROP TABLE model_attempts");raw.run("DROP TABLE tool_attempts"); raw.run("ALTER TABLE runs DROP COLUMN cost_numerator"); raw.run("UPDATE runtime_meta SET value='2' WHERE key='schema_version'"); raw.close();
      }
      const writer = new Database(path); writer.run("PRAGMA journal_mode=WAL");
      let seq = (writer.query("SELECT COALESCE(MAX(seq),0) n FROM messages WHERE session=?").get(session) as {n:number}).n;
      writer.query("INSERT INTO messages VALUES (?,?,?,?,?)").run(session, ++seq, "user", "owned-before-snapshot", 1);
      const reader = new Database(path); reader.run("BEGIN"); reader.query("SELECT COUNT(*) n FROM messages").get();
      writer.query("INSERT INTO messages VALUES (?,?,?,?,?)").run(session, ++seq, "user", "owned-committed-in-WAL", 2);
      expect(() => new DurableRuntimeStore(path)).toThrow(/WAL checkpoint is busy/);
      expect(existsSync(`${path}.v${version}.backup`)).toBe(false);
      expect((writer.query("SELECT value FROM runtime_meta WHERE key='schema_version'").get() as {value:string}).value).toBe(String(version));
      reader.run("ROLLBACK"); reader.close(); writer.close();
      const migrated = new DurableRuntimeStore(path); expect(migrated.messages(session).at(-1)?.content).toBe("owned-committed-in-WAL"); migrated.close();
      const image = new Uint8Array(readFileSync(`${path}.v${version}.backup`)); image[18] = 1; image[19] = 1;
      const backup = Database.deserialize(image);
      expect(backup.query("SELECT content FROM messages ORDER BY seq DESC LIMIT 1").get()).toEqual({ content: "owned-committed-in-WAL" }); backup.close();
    }
  });

  test("read-only snapshots reject active WAL rather than returning stale billing or missing runs", () => {
    const path = tempDb(), writer = new DurableRuntimeStore(path);
    const run = writer.startRun({ session, request: "committed only in WAL" }).run; writer.transition(run.id, "running");
    writer.appendMessage(session, "user", "retained WAL message");
    expect(() => new DurableRuntimeStore(path, { readOnly: true })).toThrow(/uncheckpointed WAL/);
    writer.close(); const reader = new DurableRuntimeStore(path, { readOnly: true });
    expect(reader.getRun(run.id)?.state).toBe("running"); expect(reader.messages(session)[0]?.content).toBe("retained WAL message"); reader.close();
  });
});

describe("DurableRuntimeStore provenance (Safety/security invariant, REQ-SEC-001)", () => {
  test("untrusted sources and the highest sensitivity of earlier runs survive for the next run, and corrupt values fail closed", () => {
    const store = new DurableRuntimeStore();
    const a = store.startRun({ session, request: "one" }).run; const b = store.startRun({ session, request: "two", idempotencyKey: "k" }).run;
    const cp = (taint: unknown) => ({ phase: "before_decision" as const, safeToResume: true, history: [], taint, loop: { steps: 0, repeats: [] }, steps: 0, externalEffects: 0 });
    expect(store.provenance(session)).toEqual({ sources: [], sensitivity: "public" });
    store.checkpoint(a.id, cp({ tainted: false, sources: [], sensitivity: "personal" }));
    store.checkpoint(b.id, cp({ tainted: true, sources: ["web.fetch"], sensitivity: "secret" }));
    expect(store.provenance(session)).toEqual({ sources: ["web.fetch"], sensitivity: "secret" });
    expect(store.taintSources(session)).toEqual(["web.fetch"]);
    const other = makeSessionKey({ workspace: "home", channel: "test", user: "other" });
    expect(store.provenance(other)).toEqual({ sources: [], sensitivity: "public" });
    store.checkpoint(a.id, cp({ tainted: false, sources: [], sensitivity: "top-secret" }));
    expect(() => store.provenance(session)).toThrow(/invalid persisted checkpoint taint/);
    store.close();
  });
});
