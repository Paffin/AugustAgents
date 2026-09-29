import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableRuntimeStore,
  IdempotencyConflictError,
  InvalidRunTransitionError,
  RunInProgressError,
  UnsupportedBudgetError,
  makeSessionKey,
} from "../src/index.ts";

const dirs: string[] = [];
const tempDb = () => { const dir = mkdtempSync(join(tmpdir(), "august-runtime-")); dirs.push(dir); return join(dir, "runtime.db"); };
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const session = makeSessionKey({ workspace: "home", channel: "test", user: "u" });

describe("DurableRuntimeStore", () => {
  test("Product behavior: owner-only WAL database reopens messages in order", () => {
    const path = tempDb();
    let store = new DurableRuntimeStore(path);
    expect(store.schemaVersion()).toBe(1);
    expect(store.journalMode()).toBe("wal");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.appendMessage(session, "user", "first", 1);
    store.appendMessage(session, "assistant", "second", 2);
    const persistedRun = store.startRun({ session, request: "persist budget" }).run;
    store.close();
    store = new DurableRuntimeStore(path);
    expect(store.messages(session).map((m) => [m.seq, m.role, m.content])).toEqual([[1, "user", "first"], [2, "assistant", "second"]]);
    expect(store.getRun(persistedRun.id)?.budget).toMatchObject({ maxTokens: "unavailable", maxCostMicros: "unavailable" });
    store.close();
  });

  test("Safety/reliability invariant: backup copies open read-only without recovery writes", () => {
    const path = tempDb(); const backup = tempDb(); const writer = new DurableRuntimeStore(path); writer.appendMessage(session, "user", "kept"); writer.close(); copyFileSync(path, backup);
    const reader = new DurableRuntimeStore(backup, { readOnly: true }); expect(reader.schemaVersion()).toBe(1); expect(reader.counts()).toEqual({ messages: 1, runs: 0 }); expect(existsSync(`${backup}-shm`)).toBe(false);
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
    const wrong = tempDb(); const store = new DurableRuntimeStore(wrong); store.close(); const corrupt = new Database(wrong); corrupt.run("UPDATE runtime_meta SET value='2' WHERE key='schema_version'"); corrupt.close(); expect(() => new DurableRuntimeStore(wrong)).toThrow(/unsupported runtime schema 2/);
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

  test("Safety/reliability invariant: startup marks interrupted tool calls ambiguous", () => {
    const path = tempDb();
    let store = new DurableRuntimeStore(path);
    const { run } = store.startRun({ session, request: "send" });
    store.transition(run.id, "running");
    store.checkpoint(run.id, { phase: "tool_started", safeToResume: false, history: [], lastTool: "mail.send", argsHash: "abc" });
    store.transition(run.id, "waiting_external");
    store.close();
    store = new DurableRuntimeStore(path);
    expect(store.getRun(run.id)?.state).toBe("recovering");
    expect(() => store.transition(run.id, "running")).toThrow(InvalidRunTransitionError);
    const resolved = store.resolveRun(run.id, "confirm_not_executed");
    expect(resolved.state).toBe("paused");
    expect(resolved.checkpoint?.safeToResume).toBe(true);
    store.close();
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

  test("Safety/reliability invariant: unsupported usage budgets fail before run creation", () => {
    const store = new DurableRuntimeStore();
    expect(() => store.startRun({ session, request: "x", budget: { maxTokens: 100 } })).toThrow(UnsupportedBudgetError);
    expect(() => store.startRun({ session, request: "x", budget: { maxCostMicros: 10 } })).toThrow(UnsupportedBudgetError);
    expect(store.listRuns()).toHaveLength(0);
    const { run } = store.startRun({ session, request: "supported" }); expect(run.budget).toMatchObject({ maxTokens: "unavailable", maxCostMicros: "unavailable" });
    expect(() => store.checkpoint(run.id, { phase: "before_decision", safeToResume: true, history: ["я".repeat(40_000)] })).toThrow(/too large/);
    store.close();
  });
});
