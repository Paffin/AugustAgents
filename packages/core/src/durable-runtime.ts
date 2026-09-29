import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { SessionKey } from "./session.ts";

export type MessageRole = "user" | "assistant";
export type RunState = "created" | "running" | "waiting_approval" | "waiting_external" | "paused" | "recovering" | "verifying" | "completed" | "failed" | "cancelled";

export interface ConversationMessage { session: SessionKey; seq: number; role: MessageRole; content: string; createdAt: number }
export interface RunBudget { maxSteps: number; maxWallMs: number; maxExternalEffects: number; maxTokens?: number; maxCostMicros?: number }
export interface RunCheckpoint { phase: "before_decision" | "waiting_approval" | "tool_started" | "tool_finished"; safeToResume: boolean; history: string[]; taint?: unknown; loop?: unknown; steps?: number; externalEffects?: number; lastTool?: string; argsHash?: string }
export interface DurableRun {
  id: string; session: SessionKey; state: RunState; request: string; requestFingerprint: string;
  idempotencyKey?: string; reply?: string; error?: string; budget: RunBudget;
  steps: number; externalEffects: number; checkpoint?: RunCheckpoint; retryOf?: string;
  createdAt: number; updatedAt: number;
}
export interface StartRunInput { session: SessionKey; request: string; idempotencyKey?: string; budget?: Partial<RunBudget>; retryOf?: string; now?: number }
export interface DurableRuntimeStoreOptions { readOnly?: boolean }

export class IdempotencyConflictError extends Error { constructor(public readonly runId: string) { super(`idempotency key belongs to another request (${runId})`); this.name = "IdempotencyConflictError"; } }
export class RunInProgressError extends Error { constructor(public readonly runId: string, public readonly state: RunState) { super(`run ${runId} is already ${state}`); this.name = "RunInProgressError"; } }
export class InvalidRunTransitionError extends Error { constructor(from: RunState, to: RunState) { super(`invalid run transition ${from} -> ${to}`); this.name = "InvalidRunTransitionError"; } }
export class UnsupportedBudgetError extends Error { constructor(dimension: string) { super(`${dimension} budget requires provider usage accounting`); this.name = "UnsupportedBudgetError"; } }

const DEFAULT_BUDGET: RunBudget = { maxSteps: 12, maxWallMs: 300_000, maxExternalEffects: 8 };
const TERMINAL = new Set<RunState>(["completed", "failed", "cancelled"]);
const TRANSITIONS: Record<RunState, ReadonlySet<RunState>> = {
  created: new Set(["running", "recovering", "cancelled"]),
  running: new Set(["waiting_approval", "waiting_external", "paused", "recovering", "verifying", "completed", "failed", "cancelled"]),
  waiting_approval: new Set(["running", "paused", "recovering", "failed", "cancelled"]),
  waiting_external: new Set(["running", "paused", "recovering", "failed", "cancelled"]),
  paused: new Set(["running", "failed", "cancelled"]),
  recovering: new Set(["running", "paused", "failed", "cancelled"]),
  verifying: new Set(["recovering", "completed", "failed", "cancelled"]),
  completed: new Set(), failed: new Set(), cancelled: new Set(),
};

function normalizeBudget(partial: Partial<RunBudget> = {}): RunBudget {
  if (partial.maxTokens !== undefined) throw new UnsupportedBudgetError("token");
  if (partial.maxCostMicros !== undefined) throw new UnsupportedBudgetError("monetary");
  const b = { ...DEFAULT_BUDGET, ...partial };
  for (const [name, value] of Object.entries(b)) if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer`);
  return b;
}
function fingerprint(request: string, budget: RunBudget): string { return createHash("sha256").update(JSON.stringify([request, budget])).digest("hex"); }

export class DurableRuntimeStore {
  readonly db: Database;
  constructor(path = ":memory:", options: DurableRuntimeStoreOptions = {}) {
    this.db = new Database(path, options.readOnly ? { readonly: true } : undefined);
    this.db.run("PRAGMA foreign_keys = ON");
    if (!options.readOnly && path !== ":memory:") { this.db.run("PRAGMA journal_mode = WAL"); chmodSync(path, 0o600); }
    if (!options.readOnly) { this.db.run("CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); this.db.run("INSERT OR IGNORE INTO runtime_meta VALUES ('schema_version','1')"); }
    const version = this.db.query("SELECT value FROM runtime_meta WHERE key='schema_version'").get() as { value: string } | null;
    if (version?.value !== "1") throw new Error(`unsupported runtime schema ${version?.value ?? "missing"}`);
    if (!options.readOnly) this.db.run(`CREATE TABLE IF NOT EXISTS messages (
      session TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session,seq))`);
    if (!options.readOnly) this.db.run(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, idempotency_key TEXT, reply TEXT, error TEXT,
      budget_json TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0, external_effects INTEGER NOT NULL DEFAULT 0,
      checkpoint_json TEXT, retry_of TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(session,idempotency_key))`);
    if (!options.readOnly) { this.db.run("CREATE INDEX IF NOT EXISTS runs_session_updated ON runs(session,updated_at DESC)"); this.db.run("UPDATE runs SET state='recovering', updated_at=? WHERE state IN ('created','running','waiting_approval','waiting_external','verifying')", [Date.now()]); }
  }

  schemaVersion(): number { return 1; }
  appendMessage(session: SessionKey, role: MessageRole, content: string, now = Date.now()): ConversationMessage {
    return this.db.transaction(() => {
      const row = this.db.query("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE session=?").get(session) as { seq: number };
      this.db.query("INSERT INTO messages VALUES (?,?,?,?,?)").run(session, row.seq, role, content, now);
      return { session, seq: row.seq, role, content, createdAt: now };
    }).immediate();
  }
  messages(session: SessionKey, limit = 40): ConversationMessage[] {
    const rows = this.db.query("SELECT * FROM messages WHERE session=? ORDER BY seq DESC LIMIT ?").all(session, limit) as MessageRow[];
    return rows.reverse().map((r) => ({ session: r.session as SessionKey, seq: r.seq, role: r.role, content: r.content, createdAt: r.created_at }));
  }
  stateView(session: SessionKey, maxMessages = 40, maxChars = 24_000): string[] {
    const selected: string[] = [];
    let left = maxChars;
    for (const m of this.messages(session, maxMessages).reverse()) {
      const line = `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`;
      const separator = selected.length ? 1 : 0;
      if (line.length + separator <= left) { selected.push(line); left -= line.length + separator; continue; }
      if (selected.length === 0 && left > 32) selected.push(`[earlier content truncated]${line.slice(-(left - 28))}`);
      break;
    }
    return selected.reverse();
  }
  startRun(input: StartRunInput): { run: DurableRun; replayed: boolean } {
    const budget = normalizeBudget(input.budget); const fp = fingerprint(input.request, budget); const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      if (input.idempotencyKey) {
        const found = this.db.query("SELECT * FROM runs WHERE session=? AND idempotency_key=?").get(input.session, input.idempotencyKey) as RunRow | null;
        if (found) { const run = toRun(found); if (run.requestFingerprint !== fp) throw new IdempotencyConflictError(run.id); if (run.state === "completed") return { run, replayed: true }; throw new RunInProgressError(run.id, run.state); }
      }
      const id = randomUUID();
      this.db.query("INSERT INTO runs (id,session,state,request,request_fingerprint,idempotency_key,budget_json,retry_of,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, input.session, "created", input.request, fp, input.idempotencyKey ?? null, JSON.stringify(budget), input.retryOf ?? null, now, now);
      return { run: this.getRun(id)!, replayed: false };
    }).immediate();
  }
  getRun(id: string): DurableRun | undefined { const row = this.db.query("SELECT * FROM runs WHERE id=?").get(id) as RunRow | null; return row ? toRun(row) : undefined; }
  listRuns(session?: SessionKey, limit = 100): DurableRun[] { const rows = (session ? this.db.query("SELECT * FROM runs WHERE session=? ORDER BY updated_at DESC LIMIT ?").all(session, limit) : this.db.query("SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?").all(limit)) as RunRow[]; return rows.map(toRun); }
  transition(id: string, to: RunState, patch: { reply?: string; error?: string; steps?: number; externalEffects?: number; now?: number } = {}): DurableRun {
    const run = this.getRun(id); if (!run) throw new Error(`unknown run ${id}`); if (!TRANSITIONS[run.state].has(to)) throw new InvalidRunTransitionError(run.state, to);
    this.db.query("UPDATE runs SET state=?,reply=COALESCE(?,reply),error=COALESCE(?,error),steps=COALESCE(?,steps),external_effects=COALESCE(?,external_effects),updated_at=? WHERE id=?")
      .run(to, patch.reply ?? null, patch.error ?? null, patch.steps ?? null, patch.externalEffects ?? null, patch.now ?? Date.now(), id);
    return this.getRun(id)!;
  }
  checkpoint(id: string, value: RunCheckpoint, now = Date.now()): DurableRun { const json = JSON.stringify(value); if (json.length > 65_536) throw new Error("checkpoint is too large"); this.db.query("UPDATE runs SET checkpoint_json=?,steps=COALESCE(?,steps),external_effects=COALESCE(?,external_effects),updated_at=? WHERE id=?").run(json, value.steps ?? null, value.externalEffects ?? null, now, id); const run = this.getRun(id); if (!run) throw new Error(`unknown run ${id}`); return run; }
  retryRun(id: string, options: { idempotencyKey?: string; budget?: Partial<RunBudget>; now?: number } = {}): { run: DurableRun; replayed: boolean } { const old = this.getRun(id); if (!old || !["failed", "cancelled"].includes(old.state)) throw new Error("only failed or cancelled runs can retry"); if (options.idempotencyKey && options.idempotencyKey === old.idempotencyKey) throw new IdempotencyConflictError(old.id); return this.startRun({ session: old.session, request: old.request, idempotencyKey: options.idempotencyKey, budget: options.budget ?? old.budget, retryOf: old.id, now: options.now }); }
  resolveRun(id: string, resolution: "abandon" | "confirm_not_executed"): DurableRun { const run = this.getRun(id); if (!run || run.state !== "recovering") throw new Error("run is not recovering"); if (resolution === "abandon") return this.transition(id, "failed", { error: "owner abandoned ambiguous run" }); const cp = run.checkpoint; if (!cp || cp.phase !== "tool_started") throw new Error("run has no ambiguous tool checkpoint"); this.checkpoint(id, { ...cp, phase: "before_decision", safeToResume: true }); return this.transition(id, "paused"); }
  close(): void { this.db.close(); }
}

interface MessageRow { session: string; seq: number; role: MessageRole; content: string; created_at: number }
interface RunRow { id: string; session: string; state: RunState; request: string; request_fingerprint: string; idempotency_key: string | null; reply: string | null; error: string | null; budget_json: string; steps: number; external_effects: number; checkpoint_json: string | null; retry_of: string | null; created_at: number; updated_at: number }
function toRun(r: RunRow): DurableRun { return { id:r.id, session:r.session as SessionKey, state:r.state, request:r.request, requestFingerprint:r.request_fingerprint, idempotencyKey:r.idempotency_key ?? undefined, reply:r.reply ?? undefined, error:r.error ?? undefined, budget:JSON.parse(r.budget_json) as RunBudget, steps:r.steps, externalEffects:r.external_effects, checkpoint:r.checkpoint_json ? JSON.parse(r.checkpoint_json) as RunCheckpoint : undefined, retryOf:r.retry_of ?? undefined, createdAt:r.created_at, updatedAt:r.updated_at }; }
