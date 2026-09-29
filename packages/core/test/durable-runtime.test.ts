import { afterAll, describe, expect, test } from "bun:test";
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
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.appendMessage(session, "user", "first", 1);
    store.appendMessage(session, "assistant", "second", 2);
    store.close();
    store = new DurableRuntimeStore(path);
    expect(store.messages(session).map((m) => [m.seq, m.role, m.content])).toEqual([[1, "user", "first"], [2, "assistant", "second"]]);
    store.close();
  });

  test("Safety/reliability invariant: backup copies open read-only without recovery writes", () => {
    const path = tempDb(); const backup = tempDb(); const writer = new DurableRuntimeStore(path); writer.appendMessage(session, "user", "kept"); writer.close(); copyFileSync(path, backup);
    const reader = new DurableRuntimeStore(backup, { readOnly: true }); expect(reader.schemaVersion()).toBe(1); expect(reader.messages(session)).toHaveLength(1); expect(existsSync(`${backup}-shm`)).toBe(false);
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
    expect(() => store.transition(run.id, "running")).not.toThrow();
    store.transition(run.id, "recovering");
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
    expect(() => store.retryRun(run.id, { idempotencyKey: "old" })).toThrow(IdempotencyConflictError);
    store.close();
  });

  test("Safety/reliability invariant: unsupported usage budgets fail before run creation", () => {
    const store = new DurableRuntimeStore();
    expect(() => store.startRun({ session, request: "x", budget: { maxTokens: 100 } })).toThrow(UnsupportedBudgetError);
    expect(() => store.startRun({ session, request: "x", budget: { maxCostMicros: 10 } })).toThrow(UnsupportedBudgetError);
    expect(store.listRuns()).toHaveLength(0);
    store.close();
  });
});
