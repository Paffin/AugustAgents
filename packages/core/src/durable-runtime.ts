import { Database } from "bun:sqlite";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { SessionKey } from "./session.ts";

export type MessageRole = "user" | "assistant";
export type RunState = "created" | "running" | "waiting_approval" | "waiting_external" | "paused" | "recovering" | "verifying" | "completed" | "failed" | "cancelled";

export interface ConversationMessage { session: SessionKey; seq: number; role: MessageRole; content: string; createdAt: number }
export interface RunBudget { maxSteps: number; maxWallMs: number; maxExternalEffects: number; maxTokens: number; maxCostMicros: number }
export interface RunBudgetRequest { maxSteps?: number; maxWallMs?: number; maxExternalEffects?: number; maxTokens?: number; maxCostMicros?: number }
export interface RunUsage { inputTokens: number; outputTokens: number; totalTokens: number; costMicros: number }
export interface UsageDelta { inputTokens: number; outputTokens: number; totalTokens: number }
export interface UsagePricing { inputMicrosPerMillion: number; outputMicrosPerMillion: number }
export type UsageBudgetExhaustion = "token-budget" | "cost-budget";
export interface RunCheckpoint { phase: "before_decision" | "waiting_approval" | "tool_started" | "tool_finished"; safeToResume: boolean; history: string[]; taint?: unknown; loop?: unknown; steps?: number; externalEffects?: number; lastTool?: string; argsHash?: string }
export interface DurableRun {
  id: string; session: SessionKey; state: RunState; request: string; requestFingerprint: string;
  idempotencyKey?: string; reply?: string; error?: string; budget: RunBudget; usage: RunUsage;
  steps: number; externalEffects: number; checkpoint?: RunCheckpoint; retryOf?: string;
  createdAt: number; updatedAt: number;
}
export interface StartRunInput { session: SessionKey; request: string; idempotencyKey?: string; budget?: RunBudgetRequest; retryOf?: string; now?: number }
export interface DurableRuntimeStoreOptions { readOnly?: boolean }

export class IdempotencyConflictError extends Error { constructor(public readonly runId: string) { super(`idempotency key belongs to another request (${runId})`); this.name = "IdempotencyConflictError"; } }
export class RunInProgressError extends Error { constructor(public readonly runId: string, public readonly state: RunState) { super(`run ${runId} is already ${state}`); this.name = "RunInProgressError"; } }
export class InvalidRunTransitionError extends Error { constructor(from: RunState, to: RunState) { super(`invalid run transition ${from} -> ${to}`); this.name = "InvalidRunTransitionError"; } }
const DEFAULT_BUDGET: RunBudget = { maxSteps: 12, maxWallMs: 300_000, maxExternalEffects: 8, maxTokens: 50_000, maxCostMicros: 100_000 };
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

function normalizeBudget(partial: RunBudgetRequest = {}): RunBudget {
  const b: RunBudget = { ...DEFAULT_BUDGET, ...partial };
  for (const name of ["maxSteps", "maxWallMs", "maxExternalEffects", "maxTokens"] as const) if (!Number.isSafeInteger(b[name]) || b[name] <= 0) throw new Error(`${name} must be a positive integer`);
  if (!Number.isSafeInteger(b.maxCostMicros) || b.maxCostMicros < 0) throw new Error("maxCostMicros must be a non-negative integer");
  return b;
}
function fingerprint(request: string, budget: RunBudget): string { return createHash("sha256").update(JSON.stringify([request, budget])).digest("hex"); }
function schema(db: Database): number {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runtime_meta','messages','runs') ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  if (tables.join(",") !== "messages,runs,runtime_meta") throw new Error("runtime schema is incomplete");
  const row = db.query("SELECT value FROM runtime_meta WHERE key='schema_version'").get() as { value: string } | null;
  const version = Number(row?.value); if (![1, 2].includes(version)) throw new Error(`unsupported runtime schema ${row?.value ?? "missing"}`); return version;
}
function immutable(path: string): string { const url = pathToFileURL(path); url.searchParams.set("immutable", "1"); return url.href; }
export function inspectRuntimeSchema(path: string): number { const db = new Database(immutable(path), { readonly: true }); try { return schema(db); } finally { db.close(); } }
function fileDigest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function migrateV1(path: string): void {
  let db = new Database(path); let version: number;
  try { version = schema(db); if (version === 1) { for (const { budget_json } of db.query("SELECT budget_json FROM runs").all() as Array<{ budget_json: string }>) parseLegacyBudget(budget_json); db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } } finally { db.close(); }
  if (version! === 2) return;
  const backup = `${path}.v1.backup`; const digestPath = `${backup}.sha256`; const digest = fileDigest(path);
  if (!existsSync(backup)) { copyFileSync(path, backup); chmodSync(backup, 0o600); const fd = openSync(backup, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } writeFileSync(digestPath, `sha256:${digest}\n`, { flag: "wx", mode: 0o600 }); }
  const recorded = existsSync(digestPath) ? readFileSync(digestPath, "utf8").trim() : "";
  if (recorded !== `sha256:${digest}` || fileDigest(backup) !== digest || inspectRuntimeSchema(backup) !== 1) throw new Error("invalid runtime v1 backup or digest");
  db = new Database(path);
  try { db.transaction(() => { db.run("ALTER TABLE runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0)"); db.run("ALTER TABLE runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0)"); db.run("ALTER TABLE runs ADD COLUMN cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(cost_micros >= 0)"); for (const row of db.query("SELECT id,request,budget_json FROM runs").all() as Array<{ id: string; request: string; budget_json: string }>) { const budget = parseLegacyBudget(row.budget_json); db.query("UPDATE runs SET budget_json=?,request_fingerprint=? WHERE id=?").run(JSON.stringify(budget), fingerprint(row.request, budget), row.id); } db.run("UPDATE runtime_meta SET value='2' WHERE key='schema_version'"); }).immediate(); } finally { db.close(); }
  if (inspectRuntimeSchema(path) !== 2) throw new Error("runtime migration did not produce schema v2");
}

export class DurableRuntimeStore {
  private readonly db: Database;
  constructor(path = ":memory:", options: DurableRuntimeStoreOptions = {}) {
    const fresh = path === ":memory:" || !existsSync(path);
    if (!fresh && !options.readOnly) migrateV1(path);
    const source = options.readOnly && path !== ":memory:" ? immutable(path) : path;
    this.db = new Database(source, options.readOnly ? { readonly: true } : undefined);
    this.db.run("PRAGMA foreign_keys = ON");
    if (fresh && !options.readOnly) {
      this.db.run("CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); this.db.run("INSERT INTO runtime_meta VALUES ('schema_version','2')");
      this.db.run(`CREATE TABLE messages (session TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session,seq))`);
      this.db.run(`CREATE TABLE runs (id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL, request_fingerprint TEXT NOT NULL, idempotency_key TEXT, reply TEXT, error TEXT, budget_json TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0, external_effects INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0), output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0), cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(cost_micros >= 0), checkpoint_json TEXT, retry_of TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(session,idempotency_key))`);
      this.db.run("CREATE INDEX runs_session_updated ON runs(session,updated_at DESC)");
    }
    if (schema(this.db) !== 2) throw new Error("runtime schema v1 requires writable migration");
    const columns = (this.db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(({ name }) => name); for (const name of ["input_tokens", "output_tokens", "cost_micros"]) if (!columns.includes(name)) throw new Error("runtime schema v2 is incomplete");
    for (const row of this.db.query("SELECT budget_json FROM runs").all() as Array<{ budget_json: string }>) parseBudget(row.budget_json);
    if (this.db.query("SELECT id FROM runs WHERE input_tokens < 0 OR output_tokens < 0 OR cost_micros < 0 LIMIT 1").get()) throw new Error("invalid persisted run usage");
    if (!options.readOnly && path !== ":memory:") { this.db.run("PRAGMA journal_mode = WAL"); chmodSync(path, 0o600); }
    if (!options.readOnly) this.db.run("UPDATE runs SET state='recovering', updated_at=? WHERE state IN ('created','running','waiting_approval','waiting_external','verifying')", [Date.now()]);
  }

  schemaVersion(): number { return Number((this.db.query("SELECT value FROM runtime_meta WHERE key='schema_version'").get() as { value: string }).value); }
  journalMode(): string { return (this.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode; }
  counts(): { messages: number; runs: number } { return { messages: (this.db.query("SELECT COUNT(*) count FROM messages").get() as { count: number }).count, runs: (this.db.query("SELECT COUNT(*) count FROM runs").get() as { count: number }).count }; }
  taintSources(session: SessionKey): string[] { const sources = new Set<string>(); for (const row of this.db.query("SELECT checkpoint_json FROM runs WHERE session=? AND checkpoint_json IS NOT NULL").all(session) as Array<{ checkpoint_json: string }>) { const taint = (JSON.parse(row.checkpoint_json) as { taint?: { tainted?: unknown; sources?: unknown } }).taint; if (!taint || typeof taint.tainted !== "boolean" || !Array.isArray(taint.sources) || taint.sources.some((source) => typeof source !== "string") || taint.tainted !== (taint.sources.length > 0)) throw new Error("invalid persisted checkpoint taint"); for (const source of taint.sources) sources.add(source as string); } return [...sources].sort(); }
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
      const prefix = `${m.role === "user" ? "User" : "Assistant"}: `; const line = `${prefix}${m.content}`;
      const separator = selected.length ? 1 : 0;
      if (line.length + separator <= left) { selected.push(line); left -= line.length + separator; continue; }
      const available = left - separator; const marker = "[earlier content truncated]";
      if (available > prefix.length + marker.length) selected.push(`${prefix}${marker}${m.content.slice(-(available - prefix.length - marker.length))}`);
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
  recordUsage(id: string, usage: UsageDelta, pricing: UsagePricing, now = Date.now()): { run: DurableRun; exhausted?: UsageBudgetExhaustion } {
    validateUsage(usage); validatePricing(pricing);
    return this.db.transaction(() => { const before = this.getRun(id); if (!before) throw new Error(`unknown run ${id}`); if (TERMINAL.has(before.state)) throw new Error("cannot record usage for a terminal run"); const input = before.usage.inputTokens + usage.inputTokens; const output = before.usage.outputTokens + usage.outputTokens; if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || !Number.isSafeInteger(input + output)) throw new Error("usage total exceeds safe integer range"); const numerator = BigInt(input) * BigInt(pricing.inputMicrosPerMillion) + BigInt(output) * BigInt(pricing.outputMicrosPerMillion); const cost = Number((numerator + 999_999n) / 1_000_000n); if (!Number.isSafeInteger(cost)) throw new Error("usage cost exceeds safe integer range"); this.db.query("UPDATE runs SET input_tokens=?,output_tokens=?,cost_micros=?,updated_at=? WHERE id=?").run(input, output, cost, now, id); const run = this.getRun(id)!; const exhausted: UsageBudgetExhaustion | undefined = run.usage.totalTokens >= run.budget.maxTokens ? "token-budget" : run.usage.costMicros > 0 && run.usage.costMicros >= run.budget.maxCostMicros ? "cost-budget" : undefined; return exhausted ? { run, exhausted } : { run }; }).immediate();
  }
  listRuns(session?: SessionKey, limit = 100, states?: RunState[]): DurableRun[] { const where = [session ? "session=?" : "", states?.length ? `state IN (${states.map(() => "?").join(",")})` : ""].filter(Boolean).join(" AND "); const params: Array<string | number> = [...(session ? [session] : []), ...(states ?? []), limit]; const rows = this.db.query(`SELECT * FROM runs${where ? ` WHERE ${where}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params) as RunRow[]; return rows.map(toRun); }
  transition(id: string, to: RunState, patch: { reply?: string; error?: string; steps?: number; externalEffects?: number; now?: number } = {}): DurableRun {
    const run = this.getRun(id); if (!run) throw new Error(`unknown run ${id}`); if (!TRANSITIONS[run.state].has(to)) throw new InvalidRunTransitionError(run.state, to);
    if (run.state === "recovering" && to === "running" && (!run.checkpoint?.safeToResume || run.checkpoint.phase === "tool_started")) throw new InvalidRunTransitionError(run.state, to);
    this.db.query("UPDATE runs SET state=?,reply=COALESCE(?,reply),error=COALESCE(?,error),steps=COALESCE(?,steps),external_effects=COALESCE(?,external_effects),updated_at=? WHERE id=?")
      .run(to, patch.reply ?? null, patch.error ?? null, patch.steps ?? null, patch.externalEffects ?? null, patch.now ?? Date.now(), id);
    return this.getRun(id)!;
  }
  checkpoint(id: string, value: RunCheckpoint, now = Date.now()): DurableRun { const json = JSON.stringify(value); if (Buffer.byteLength(json, "utf8") > 65_536) throw new Error("checkpoint is too large"); this.db.query("UPDATE runs SET checkpoint_json=?,steps=COALESCE(?,steps),external_effects=COALESCE(?,external_effects),updated_at=? WHERE id=?").run(json, value.steps ?? null, value.externalEffects ?? null, now, id); const run = this.getRun(id); if (!run) throw new Error(`unknown run ${id}`); return run; }
  finishRun(id: string, to: "completed" | "failed" | "cancelled" | "paused", reply: string, patch: { error?: string; steps?: number; externalEffects?: number; now?: number } = {}): DurableRun { return this.db.transaction(() => { let run = this.getRun(id); if (!run) throw new Error(`unknown run ${id}`); if (to === "completed" && run.state !== "verifying") { if (!TRANSITIONS[run.state].has("verifying")) throw new InvalidRunTransitionError(run.state, "verifying"); this.db.query("UPDATE runs SET state='verifying' WHERE id=?").run(id); run = { ...run, state: "verifying" }; } if (!TRANSITIONS[run.state].has(to)) throw new InvalidRunTransitionError(run.state, to); const seq = (this.db.query("SELECT COALESCE(MAX(seq),0)+1 seq FROM messages WHERE session=?").get(run.session) as { seq: number }).seq; this.db.query("INSERT INTO messages VALUES (?,?,?,?,?)").run(run.session, seq, "assistant", reply, patch.now ?? Date.now()); this.db.query("UPDATE runs SET state=?,reply=?,error=COALESCE(?,error),steps=COALESCE(?,steps),external_effects=COALESCE(?,external_effects),updated_at=? WHERE id=?").run(to, reply, patch.error ?? null, patch.steps ?? null, patch.externalEffects ?? null, patch.now ?? Date.now(), id); return this.getRun(id)!; }).immediate(); }
  retryRun(id: string, options: { idempotencyKey?: string; budget?: RunBudgetRequest; now?: number } = {}): { run: DurableRun; replayed: boolean } { const old = this.getRun(id); if (!old || !["failed", "cancelled"].includes(old.state)) throw new Error("only failed or cancelled runs can retry"); if (!options.idempotencyKey) throw new Error("retry requires a new idempotency key"); const used = this.db.query("SELECT id FROM runs WHERE session=? AND idempotency_key=?").get(old.session, options.idempotencyKey) as { id: string } | null; if (used) throw new IdempotencyConflictError(used.id); return this.startRun({ session: old.session, request: old.request, idempotencyKey: options.idempotencyKey, budget: options.budget ?? old.budget, retryOf: old.id, now: options.now }); }
  resolveRun(id: string, resolution: "abandon" | "confirm_not_executed"): DurableRun { const run = this.getRun(id); if (!run || run.state !== "recovering") throw new Error("run is not recovering"); if (resolution === "abandon") return this.transition(id, "failed", { error: "owner abandoned ambiguous run" }); const cp = run.checkpoint; if (!cp || cp.phase !== "tool_started") throw new Error("run has no ambiguous tool checkpoint"); this.checkpoint(id, { ...cp, phase: "before_decision", safeToResume: true }); return this.transition(id, "paused"); }
  close(): void { this.db.close(); }
}

interface MessageRow { session: string; seq: number; role: MessageRole; content: string; created_at: number }
interface RunRow { id: string; session: string; state: RunState; request: string; request_fingerprint: string; idempotency_key: string | null; reply: string | null; error: string | null; budget_json: string; steps: number; external_effects: number; input_tokens: number; output_tokens: number; cost_micros: number; checkpoint_json: string | null; retry_of: string | null; created_at: number; updated_at: number }
function parseBudget(json: string): RunBudget { try { const b = JSON.parse(json) as Partial<RunBudget>; if (![b.maxSteps, b.maxWallMs, b.maxExternalEffects, b.maxTokens].every((v) => Number.isSafeInteger(v) && (v as number) > 0) || !Number.isSafeInteger(b.maxCostMicros) || (b.maxCostMicros as number) < 0) throw new Error(); return b as RunBudget; } catch { throw new Error("invalid persisted run budget"); } }
function parseLegacyBudget(json: string): RunBudget { const b = JSON.parse(json) as Record<string, unknown>; if (![b.maxSteps, b.maxWallMs, b.maxExternalEffects].every((value) => Number.isSafeInteger(value) && (value as number) > 0) || b.maxTokens !== "unavailable" || b.maxCostMicros !== "unavailable") throw new Error("invalid persisted run budget"); return normalizeBudget({ maxSteps: b.maxSteps as number, maxWallMs: b.maxWallMs as number, maxExternalEffects: b.maxExternalEffects as number }); }
function validateUsage(usage: UsageDelta): void { if (![usage.inputTokens, usage.outputTokens, usage.totalTokens].every((v) => Number.isSafeInteger(v) && v >= 0) || usage.inputTokens + usage.outputTokens !== usage.totalTokens) throw new Error("invalid provider usage"); }
function validatePricing(pricing: UsagePricing): void { if (![pricing.inputMicrosPerMillion, pricing.outputMicrosPerMillion].every((v) => Number.isSafeInteger(v) && v >= 0)) throw new Error("invalid usage pricing"); }
function toRun(r: RunRow): DurableRun { const usage = { inputTokens:r.input_tokens, outputTokens:r.output_tokens, totalTokens:r.input_tokens+r.output_tokens, costMicros:r.cost_micros }; return { id:r.id, session:r.session as SessionKey, state:r.state, request:r.request, requestFingerprint:r.request_fingerprint, idempotencyKey:r.idempotency_key ?? undefined, reply:r.reply ?? undefined, error:r.error ?? undefined, budget:parseBudget(r.budget_json), usage, steps:r.steps, externalEffects:r.external_effects, checkpoint:r.checkpoint_json ? JSON.parse(r.checkpoint_json) as RunCheckpoint : undefined, retryOf:r.retry_of ?? undefined, createdAt:r.created_at, updatedAt:r.updated_at }; }
