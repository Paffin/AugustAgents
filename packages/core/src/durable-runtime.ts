import { Database } from "bun:sqlite";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { SessionKey } from "./session.ts";

export type MessageRole = "user" | "assistant";
export type RunState = "created" | "running" | "waiting_approval" | "waiting_external" | "paused" | "recovering" | "verifying" | "completed" | "failed" | "cancelled";

export interface ConversationMessage { session: SessionKey; seq: number; role: MessageRole; content: string; createdAt: number }
export interface RunBudget { maxSteps: number; maxWallMs: number; maxExternalEffects: number; maxTokens: number; maxCostMicros: number }
export interface RunBudgetRequest { maxSteps?: number; maxWallMs?: number; maxExternalEffects?: number; maxTokens?: number; maxCostMicros?: number }
export interface RunUsage { inputTokens: number; outputTokens: number; totalTokens: number; costMicros: number }
export interface UsageDelta { inputTokens: number; outputTokens: number; totalTokens: number }
export interface UsagePricing { inputMicrosPerMillion: number; outputMicrosPerMillion: number }
export interface ModelQuote extends UsagePricing { source?: string; asOf?: string }
export interface ModelAttempt {
  id: string; runId: string; provider: string; model: string; requestHash: string;
  quote: ModelQuote; state: "in_flight" | "reported" | "unknown" | "not_sent";
  reservedTokens: number; reservedCostMicros: number; usage?: UsageDelta;
  receiptSource?: "provider" | "owner"; failure?: string; createdAt: number; updatedAt: number;
}
export interface ModelAccounting { unresolvedCalls: number; reservedTokens: number; reservedCostMicros: number; unknownCalls?: number; ownerReceipts?: number; legacyUsage?: boolean }
export interface ProviderCircuitSnapshot { failures: number; retryAt: number }
export type UsageBudgetExhaustion = "token-budget" | "cost-budget";
export interface RunCheckpoint { phase: "before_decision" | "waiting_approval" | "tool_started" | "tool_finished"; safeToResume: boolean; history: string[]; taint?: unknown; loop?: unknown; steps?: number; externalEffects?: number; lastTool?: string; argsHash?: string; providerRetryAt?: number }
export interface DurableRun {
  id: string; session: SessionKey; state: RunState; request: string; requestFingerprint: string;
  idempotencyKey?: string; reply?: string; error?: string; budget: RunBudget; usage: RunUsage;
  steps: number; externalEffects: number; checkpoint?: RunCheckpoint; retryOf?: string;
  createdAt: number; updatedAt: number;
}
export interface StartRunInput { session: SessionKey; request: string; idempotencyKey?: string; budget?: RunBudgetRequest; retryOf?: string; now?: number }
export interface DurableRuntimeStoreOptions {
  readOnly?: boolean;
  /** Runtime owners recover interrupted work; ordinary storage handles never do. Local host only. */
  exclusiveOwner?: boolean;
}

export class RuntimeOwnerInUseError extends Error {
  constructor() { super("This runtime already has a live owner. Stop its gateway or CLI before starting another runtime."); this.name = "RuntimeOwnerInUseError"; }
}

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

export function normalizeRunBudget(partial: RunBudgetRequest = {}): RunBudget {
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
  const version = Number(row?.value); if (![1, 2, 3].includes(version)) throw new Error(`unsupported runtime schema ${row?.value ?? "missing"}`); return version;
}
/**
 * Read-only opens load a private in-memory image: the SQLite URI `immutable=1` flag is not honored by every
 * platform build of bun:sqlite, and a plain read-only open of a WAL file creates -wal/-shm sidecars. WAL header
 * flags are cleared on the copy only; the file on disk is never written.
 */
function openImmutable(path: string): Database {
  if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 32) throw new Error("runtime has uncheckpointed WAL; use a stopped, checkpointed snapshot for read-only inspection");
  const image = new Uint8Array(readFileSync(path));
  if (image.length >= 100 && image[18] === 2 && image[19] === 2) { image[18] = 1; image[19] = 1; }
  const db = Database.deserialize(image); db.run("PRAGMA query_only = ON"); return db;
}
export function inspectRuntimeSchema(path: string): number { const db = openImmutable(path); try { return schema(db); } finally { db.close(); } }
function fileDigest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function checkpointForMigration(db: Database): void {
  const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number };
  if (!result || result.busy !== 0 || result.log !== result.checkpointed) throw new Error("runtime WAL checkpoint is busy; stop all readers/writers before migration");
}
function migrateV1(path: string): void {
  let db = new Database(path); let version: number;
  try { version = schema(db); if (version === 1) { for (const { budget_json } of db.query("SELECT budget_json FROM runs").all() as Array<{ budget_json: string }>) parseLegacyBudget(budget_json); checkpointForMigration(db); } } finally { db.close(); }
  if (version! === 2) return;
  const backup = `${path}.v1.backup`; const digestPath = `${backup}.sha256`; const digest = fileDigest(path);
  if (!existsSync(backup)) { copyFileSync(path, backup); chmodSync(backup, 0o600); const fd = openSync(backup, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } writeFileSync(digestPath, `sha256:${digest}\n`, { flag: "wx", mode: 0o600 }); }
  const recorded = existsSync(digestPath) ? readFileSync(digestPath, "utf8").trim() : "";
  if (recorded !== `sha256:${digest}` || fileDigest(backup) !== digest || inspectRuntimeSchema(backup) !== 1) throw new Error("invalid runtime v1 backup or digest");
  db = new Database(path);
  try { db.transaction(() => { db.run("ALTER TABLE runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0)"); db.run("ALTER TABLE runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0)"); db.run("ALTER TABLE runs ADD COLUMN cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(cost_micros >= 0)"); for (const row of db.query("SELECT id,request,budget_json FROM runs").all() as Array<{ id: string; request: string; budget_json: string }>) { const budget = parseLegacyBudget(row.budget_json); db.query("UPDATE runs SET budget_json=?,request_fingerprint=? WHERE id=?").run(JSON.stringify(budget), fingerprint(row.request, budget), row.id); } db.run("UPDATE runtime_meta SET value='2' WHERE key='schema_version'"); }).immediate(); } finally { db.close(); }
  if (inspectRuntimeSchema(path) !== 2) throw new Error("runtime migration did not produce schema v2");
}

function assertOwnerInactive(db: Database): void {
  const previous = db.query("SELECT value FROM runtime_meta WHERE key='runtime_owner'").get() as { value: string } | null;
  if (!previous) return;
  let owner: { pid?: unknown; nonce?: unknown };
  try { owner = JSON.parse(previous.value); } catch { throw new Error("invalid runtime owner receipt; recovery refused"); }
  if (!owner || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.nonce !== "string") throw new Error("invalid runtime owner receipt; recovery refused");
  try { process.kill(owner.pid as number, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
  throw new RuntimeOwnerInUseError();
}

const MODEL_ATTEMPTS_SQL = `CREATE TABLE model_attempts (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),provider TEXT NOT NULL,model TEXT NOT NULL,request_hash TEXT NOT NULL,quote_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('in_flight','reported','unknown','not_sent')),reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>=0),reserved_cost_micros INTEGER NOT NULL CHECK(reserved_cost_micros>=0),usage_json TEXT,receipt_source TEXT,failure TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`;
/** Forward-only v2→v3. Restore the verified v2 snapshot only with a stopped runtime. */
function migrateV2(path: string): void {
  let db = new Database(path);
  try { assertOwnerInactive(db); checkpointForMigration(db); } finally { db.close(); }
  const backup = `${path}.v2.backup`, digestPath = `${backup}.sha256`, digest = fileDigest(path);
  if (!existsSync(backup)) {
    copyFileSync(path, backup); chmodSync(backup, 0o600);
    const fd = openSync(backup, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    writeFileSync(digestPath, `sha256:${digest}\n`, { flag: "wx", mode: 0o600 });
  }
  if (!existsSync(digestPath) || readFileSync(digestPath, "utf8").trim() !== `sha256:${digest}` || fileDigest(backup) !== digest || inspectRuntimeSchema(backup) !== 2) throw new Error("invalid runtime v2 backup or digest");
  db = new Database(path);
  try { db.transaction(() => {
    assertOwnerInactive(db);
    db.run("ALTER TABLE runs ADD COLUMN cost_numerator TEXT NOT NULL DEFAULT '0'");
    db.run(MODEL_ATTEMPTS_SQL); db.run("CREATE INDEX model_attempts_run ON model_attempts(run_id,created_at)");
    db.run("CREATE UNIQUE INDEX model_attempts_pending ON model_attempts(run_id) WHERE state IN ('in_flight','unknown')");
    // Preserve received legacy estimates; never reprice old tokens using a new tariff.
    for (const row of db.query("SELECT id,cost_micros FROM runs").all() as Array<{ id: string; cost_micros: number }>) {
      if (!Number.isSafeInteger(row.cost_micros) || row.cost_micros < 0) throw new Error("invalid legacy cost");
      db.query("UPDATE runs SET cost_numerator=? WHERE id=?").run((BigInt(row.cost_micros) * 1_000_000n).toString(), row.id);
      db.query("INSERT INTO runtime_meta (key,value) VALUES (?,?)").run(`billing_legacy:${row.id}`, "received_only");
    }
    db.run("UPDATE runtime_meta SET value='3' WHERE key='schema_version'");
  }).immediate(); } finally { db.close(); }
}

export class DurableRuntimeStore {
  private readonly db: Database;
  private ownerReceipt?: string;
  private closed = false;
  constructor(path = ":memory:", options: DurableRuntimeStoreOptions = {}) {
    if (options.readOnly && options.exclusiveOwner) throw new Error("read-only storage cannot own a runtime");
    const fresh = path === ":memory:" || !existsSync(path);
    if (!fresh && !options.readOnly) {
      const probe = new Database(path); let version: number;
      try { version = schema(probe); } finally { probe.close(); }
      if (version! === 1) { migrateV1(path); version = 2; }
      if (version! === 2) migrateV2(path);
    }
    this.db = options.readOnly && path !== ":memory:" ? openImmutable(path) : new Database(path);
    this.db.run("PRAGMA foreign_keys = ON");
    if (fresh && !options.readOnly) {
      this.db.run("CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); this.db.run("INSERT INTO runtime_meta VALUES ('schema_version','3')");
      this.db.run(`CREATE TABLE messages (session TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session,seq))`);
      this.db.run(`CREATE TABLE runs (id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, request TEXT NOT NULL, request_fingerprint TEXT NOT NULL, idempotency_key TEXT, reply TEXT, error TEXT, budget_json TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0, external_effects INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0), output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0), cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(cost_micros >= 0), checkpoint_json TEXT, retry_of TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(session,idempotency_key))`);
      this.db.run("CREATE INDEX runs_session_updated ON runs(session,updated_at DESC)");
      this.db.run("ALTER TABLE runs ADD COLUMN cost_numerator TEXT NOT NULL DEFAULT '0'");
      this.db.run(MODEL_ATTEMPTS_SQL); this.db.run("CREATE INDEX model_attempts_run ON model_attempts(run_id,created_at)");
      this.db.run("CREATE UNIQUE INDEX model_attempts_pending ON model_attempts(run_id) WHERE state IN ('in_flight','unknown')");
    }
    const version = schema(this.db);
    if (version !== 3 && !(options.readOnly && version === 2)) throw new Error("runtime schema requires writable migration");
    const columns = (this.db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(({ name }) => name); for (const name of ["input_tokens", "output_tokens", "cost_micros"]) if (!columns.includes(name)) throw new Error("runtime schema v2 is incomplete");
    for (const row of this.db.query("SELECT budget_json FROM runs").all() as Array<{ budget_json: string }>) parseBudget(row.budget_json);
    if (this.db.query("SELECT id FROM runs WHERE input_tokens < 0 OR output_tokens < 0 OR cost_micros < 0 LIMIT 1").get()) throw new Error("invalid persisted run usage");
    if (version === 3) {
      if (!columns.includes("cost_numerator")) throw new Error("runtime schema v3 is incomplete");
      this.db.query("SELECT id,run_id,provider,model,request_hash,quote_json,state,reserved_tokens,reserved_cost_micros,usage_json,receipt_source,failure,created_at,updated_at FROM model_attempts LIMIT 0").all();
      if (this.db.query("PRAGMA foreign_key_check").get()) throw new Error("runtime foreign-key violation");
    }
    if (!options.readOnly && path !== ":memory:") { this.db.run("PRAGMA journal_mode = WAL"); chmodSync(path, 0o600); }
    if (options.exclusiveOwner) {
      try {
        this.db.transaction(() => {
          assertOwnerInactive(this.db);
          const receipt = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
          this.db.query("INSERT OR REPLACE INTO runtime_meta (key,value) VALUES ('runtime_owner',?)").run(receipt);
          this.db.run("UPDATE runs SET state='recovering', updated_at=? WHERE state IN ('created','running','waiting_approval','waiting_external','verifying')", [Date.now()]);
          this.db.run("UPDATE model_attempts SET state='unknown',failure='interrupted',updated_at=? WHERE state='in_flight'", [Date.now()]);
          // A durable owner stop wins over restart's generic interrupted classification.
          for (const intent of this.db.query("SELECT key,value FROM runtime_meta WHERE key GLOB 'run_stop:*'").all() as Array<{ key: string; value: string }>) {
            const id = intent.key.slice("run_stop:".length), desired = this.requestedStop(id);
            const run = this.getRun(id); if (!run || !desired) throw new Error("invalid persisted stop intent");
            if (run.state === "cancelled" || run.state === desired || (TERMINAL.has(run.state) && desired === "paused")) { this.db.query("DELETE FROM runtime_meta WHERE key=?").run(intent.key); continue; }
            const uncertain = run.checkpoint?.phase === "tool_started";
            if (desired === "paused" && uncertain) continue; // Never turn an uncertain effect into a resumable pause.
            const reply = uncertain ? "Cancelled further work. A started external effect may be uncertain." : `Stopped: ${desired}.`;
            const now = Date.now(), seq = (this.db.query("SELECT COALESCE(MAX(seq),0)+1 seq FROM messages WHERE session=?").get(run.session) as { seq: number }).seq;
            this.db.query("INSERT INTO messages VALUES (?,?,?,?,?)").run(run.session, seq, "assistant", reply, now);
            this.db.query("UPDATE runs SET state=?,reply=?,error=?,updated_at=? WHERE id=?").run(desired, reply, uncertain ? "cancelled-uncertain-effect" : run.error ?? desired, now, id);
            this.db.query("DELETE FROM runtime_meta WHERE key=?").run(intent.key);
          }
          this.ownerReceipt = receipt;
        }).immediate();
      } catch (error) { this.db.close(); throw error; }
    }
  }

  schemaVersion(): number { return Number((this.db.query("SELECT value FROM runtime_meta WHERE key='schema_version'").get() as { value: string }).value); }
  journalMode(): string { return (this.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode; }
  counts(): { messages: number; runs: number } { return { messages: (this.db.query("SELECT COUNT(*) count FROM messages").get() as { count: number }).count, runs: (this.db.query("SELECT COUNT(*) count FROM runs").get() as { count: number }).count }; }
  /** What earlier runs of this session read: the untrusted sources and the most sensitive content, from their checkpoints. */
  provenance(session: SessionKey): { sources: string[]; sensitivity: "public" | "personal" | "secret" } {
    const sources = new Set<string>(); let sensitivity: "public" | "personal" | "secret" = "public"; const rank = ["public", "personal", "secret"] as const;
    for (const row of this.db.query("SELECT checkpoint_json FROM runs WHERE session=? AND checkpoint_json IS NOT NULL").all(session) as Array<{ checkpoint_json: string }>) {
      const taint = (JSON.parse(row.checkpoint_json) as { taint?: { tainted?: unknown; sources?: unknown; sensitivity?: unknown } }).taint;
      if (!taint || typeof taint.tainted !== "boolean" || !Array.isArray(taint.sources) || taint.sources.some((source) => typeof source !== "string") || taint.tainted !== (taint.sources.length > 0)) throw new Error("invalid persisted checkpoint taint");
      if (taint.sensitivity !== undefined && !rank.includes(taint.sensitivity as never)) throw new Error("invalid persisted checkpoint taint");
      for (const source of taint.sources) sources.add(source as string);
      if (taint.sensitivity && rank.indexOf(taint.sensitivity as never) > rank.indexOf(sensitivity)) sensitivity = taint.sensitivity as typeof sensitivity;
    }
    return { sources: [...sources].sort(), sensitivity };
  }
  taintSources(session: SessionKey): string[] { return this.provenance(session).sources; }
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
    const budget = normalizeRunBudget(input.budget); const fp = fingerprint(input.request, budget); const now = input.now ?? Date.now();
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
  requestedStop(id: string): "paused" | "cancelled" | undefined {
    const row = this.db.query("SELECT value FROM runtime_meta WHERE key=?").get(`run_stop:${id}`) as { value: string } | null;
    if (!row) return undefined;
    if (row.value !== "paused" && row.value !== "cancelled") throw new Error("invalid persisted stop intent");
    return row.value;
  }
  /** Commit intent before interrupting any in-flight operation. Cancellation cannot be downgraded. */
  requestStop(id: string, desired: "paused" | "cancelled"): "paused" | "cancelled" {
    if (desired !== "paused" && desired !== "cancelled") throw new Error("invalid stop intent");
    return this.db.transaction(() => {
      const run = this.getRun(id); if (!run || TERMINAL.has(run.state)) throw new Error("run is not active");
      const effective = this.requestedStop(id) === "cancelled" ? "cancelled" : desired;
      this.db.query("INSERT OR REPLACE INTO runtime_meta (key,value) VALUES (?,?)").run(`run_stop:${id}`, effective);
      return effective;
    }).immediate();
  }
  clearSettledStop(id: string): void {
    const run = this.getRun(id), intent = this.requestedStop(id);
    if (intent && run && (run.state === intent || TERMINAL.has(run.state))) this.db.query("DELETE FROM runtime_meta WHERE key=?").run(`run_stop:${id}`);
  }
  modelAccounting(id: string): ModelAccounting {
    if (this.schemaVersion() < 3) return { unresolvedCalls: 0, reservedTokens: 0, reservedCostMicros: 0, legacyUsage: true };
    const row = this.db.query("SELECT COUNT(*) n,COALESCE(SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END),0) unknown,COALESCE(SUM(reserved_tokens),0) tokens,COALESCE(SUM(reserved_cost_micros),0) cost FROM model_attempts WHERE run_id=? AND state IN ('in_flight','unknown')").get(id) as { n: number; unknown: number; tokens: number; cost: number };
    if (![row.n,row.tokens,row.cost].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("invalid model reservation totals");
    const owner = (this.db.query("SELECT COUNT(*) n FROM model_attempts WHERE run_id=? AND receipt_source='owner'").get(id) as { n: number }).n;
    const legacy = this.db.query("SELECT value FROM runtime_meta WHERE key=?").get(`billing_legacy:${id}`);
    return { unresolvedCalls: row.n, reservedTokens: row.tokens, reservedCostMicros: row.cost, ...(row.unknown ? { unknownCalls: row.unknown } : {}), ...(owner ? { ownerReceipts: owner } : {}), ...(legacy ? { legacyUsage: true } : {}) };
  }
  modelAttempts(id: string, unresolvedOnly = false): ModelAttempt[] { return (this.db.query(`SELECT * FROM model_attempts WHERE run_id=?${unresolvedOnly ? " AND state IN ('in_flight','unknown')" : ""} ORDER BY created_at,id LIMIT 200`).all(id) as ModelAttemptRow[]).map(toAttempt); }
  getModelAttempt(id: string): ModelAttempt | undefined { const row = this.db.query("SELECT * FROM model_attempts WHERE id=?").get(id) as ModelAttemptRow | null; return row ? toAttempt(row) : undefined; }
  /** Hold the remaining allowance until a receipt proves what was spent. A hold is not a bill. */
  beginModelAttempt(runId: string, input: { id: string; provider: string; model: string; requestHash: string }, quote: ModelQuote, now = Date.now()): ModelAttempt {
    validatePricing(quote);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id) || !/^[a-f0-9]{64}$/.test(input.requestHash) || [input.provider, input.model].some(value => !value || value.length > 512)) throw new Error("invalid model attempt");
    return this.db.transaction(() => {
      const run = this.getRun(runId); if (!run || !["running","waiting_approval"].includes(run.state)) throw new Error("run is not executing");
      if (this.getModelAttempt(input.id)) throw new Error("model attempt already exists");
      if (this.modelAccounting(runId).unresolvedCalls) throw new Error("model billing is unresolved; reconcile before another call");
      const tokens = Math.max(0, run.budget.maxTokens - run.usage.totalTokens), money = Math.max(0, run.budget.maxCostMicros - run.usage.costMicros);
      if (!tokens || (!money && (quote.inputMicrosPerMillion > 0 || quote.outputMicrosPerMillion > 0))) throw new Error("model budget exhausted");
      const snapshot: ModelQuote = { inputMicrosPerMillion: quote.inputMicrosPerMillion, outputMicrosPerMillion: quote.outputMicrosPerMillion, ...(quote.source !== undefined ? { source: quote.source } : {}), ...(quote.asOf !== undefined ? { asOf: quote.asOf } : {}) };
      this.db.query("INSERT INTO model_attempts (id,run_id,provider,model,request_hash,quote_json,state,reserved_tokens,reserved_cost_micros,created_at,updated_at) VALUES (?,?,?,?,?,?,'in_flight',?,?,?,?)")
        .run(input.id, runId, input.provider, input.model, input.requestHash, JSON.stringify(snapshot), tokens, quote.inputMicrosPerMillion > 0 || quote.outputMicrosPerMillion > 0 ? money : 0, now, now);
      return this.getModelAttempt(input.id)!;
    }).immediate();
  }
  finishModelAttempt(id: string, state: "unknown" | "not_sent", failure: string, now = Date.now()): ModelAttempt {
    if (!["unknown","not_sent"].includes(state) || !/^[A-Za-z0-9_-]{1,64}$/.test(failure)) throw new Error("invalid model attempt disposition");
    return this.db.transaction(() => {
      const attempt = this.getModelAttempt(id); if (!attempt) throw new Error("unknown model attempt");
      if (attempt.state !== "reported" && attempt.state !== "not_sent") this.db.query("UPDATE model_attempts SET state=?,failure=?,updated_at=? WHERE id=?").run(state, failure, now, id);
      return this.getModelAttempt(id)!;
    }).immediate();
  }
  reportModelAttempt(id: string, usage: UsageDelta, source: "provider" | "owner" = "provider", now = Date.now()): { run: DurableRun; exhausted?: UsageBudgetExhaustion } {
    validateUsage(usage); if (source !== "provider" && source !== "owner") throw new Error("invalid receipt source");
    const received = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens };
    return this.db.transaction(() => {
      const attempt = this.getModelAttempt(id); if (!attempt) throw new Error("unknown model attempt");
      if (attempt.state === "reported") {
        if (!attempt.usage || attempt.usage.inputTokens !== received.inputTokens || attempt.usage.outputTokens !== received.outputTokens || attempt.usage.totalTokens !== received.totalTokens) throw new Error("receipt conflicts with recorded usage");
        return this.usageResult(attempt.runId);
      }
      if (attempt.state === "not_sent") throw new Error("receipt conflicts with unsent request");
      const result = this.applyUsage(attempt.runId, received, attempt.quote, now, true);
      this.db.query("UPDATE model_attempts SET state='reported',usage_json=?,receipt_source=?,updated_at=? WHERE id=?").run(JSON.stringify(received), source, now, id);
      return result;
    }).immediate();
  }
  recordUsage(id: string, usage: UsageDelta, pricing: UsagePricing, now = Date.now()): { run: DurableRun; exhausted?: UsageBudgetExhaustion } {
    validateUsage(usage); validatePricing(pricing);
    return this.db.transaction(() => this.applyUsage(id, usage, pricing, now, false)).immediate();
  }
  private applyUsage(id: string, usage: UsageDelta, pricing: UsagePricing, now: number, allowTerminal: boolean): { run: DurableRun; exhausted?: UsageBudgetExhaustion } {
    const before = this.getRun(id); if (!before) throw new Error(`unknown run ${id}`);
    if (!allowTerminal && TERMINAL.has(before.state)) throw new Error("cannot record usage for a terminal run");
    const input = before.usage.inputTokens + usage.inputTokens, output = before.usage.outputTokens + usage.outputTokens;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || !Number.isSafeInteger(input + output)) throw new Error("usage total exceeds safe integer range");
    const stored = (this.db.query("SELECT cost_numerator FROM runs WHERE id=?").get(id) as { cost_numerator: string }).cost_numerator;
    if (!/^(0|[1-9][0-9]{0,63})$/.test(stored)) throw new Error("invalid persisted cost numerator");
    const numerator = BigInt(stored) + BigInt(usage.inputTokens) * BigInt(pricing.inputMicrosPerMillion) + BigInt(usage.outputTokens) * BigInt(pricing.outputMicrosPerMillion);
    const cost = Number((numerator + 999_999n) / 1_000_000n); if (!Number.isSafeInteger(cost)) throw new Error("usage cost exceeds safe integer range");
    this.db.query("UPDATE runs SET input_tokens=?,output_tokens=?,cost_micros=?,cost_numerator=?,updated_at=? WHERE id=?").run(input, output, cost, numerator.toString(), now, id);
    return this.usageResult(id);
  }
  private usageResult(id: string): { run: DurableRun; exhausted?: UsageBudgetExhaustion } {
    const run = this.getRun(id)!;
    const exhausted: UsageBudgetExhaustion | undefined = run.usage.totalTokens >= run.budget.maxTokens ? "token-budget" : run.usage.costMicros > 0 && run.usage.costMicros >= run.budget.maxCostMicros ? "cost-budget" : undefined;
    return exhausted ? { run, exhausted } : { run };
  }
  listRuns(session?: SessionKey, limit = 100, states?: RunState[]): DurableRun[] { const where = [session ? "session=?" : "", states?.length ? `state IN (${states.map(() => "?").join(",")})` : ""].filter(Boolean).join(" AND "); const params: Array<string | number> = [...(session ? [session] : []), ...(states ?? []), limit]; const rows = this.db.query(`SELECT * FROM runs${where ? ` WHERE ${where}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...params) as RunRow[]; return rows.map(toRun); }
  providerCircuits(): Record<string, ProviderCircuitSnapshot> {
    const row = this.db.query("SELECT value FROM runtime_meta WHERE key='provider_circuits'").get() as { value: string } | null;
    if (!row) return {};
    const states = JSON.parse(row.value) as Record<string, ProviderCircuitSnapshot>;
    if (!states || typeof states !== "object" || Array.isArray(states) || Object.values(states).some(s => !s || !Number.isSafeInteger(s.failures) || s.failures < 1 || !Number.isSafeInteger(s.retryAt) || s.retryAt < 0)) throw new Error("invalid retained provider circuits");
    return states;
  }
  saveProviderCircuits(states: Record<string, ProviderCircuitSnapshot>): void {
    if (Object.values(states).some(s => !Number.isSafeInteger(s.failures) || s.failures < 1 || !Number.isSafeInteger(s.retryAt) || s.retryAt < 0)) throw new Error("invalid provider circuits");
    this.db.query("INSERT INTO runtime_meta(key,value) VALUES ('provider_circuits',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(states));
  }
  transition(id: string, to: RunState, patch: { reply?: string; error?: string; steps?: number; externalEffects?: number; now?: number } = {}): DurableRun {
    const run = this.getRun(id); if (!run) throw new Error(`unknown run ${id}`); if (!TRANSITIONS[run.state].has(to)) throw new InvalidRunTransitionError(run.state, to);
    if (run.state === "recovering" && to === "running" && (!run.checkpoint?.safeToResume || run.checkpoint.phase === "tool_started")) throw new InvalidRunTransitionError(run.state, to);
    this.db.query("UPDATE runs SET state=?,reply=COALESCE(?,reply),error=?,steps=COALESCE(?,steps),external_effects=COALESCE(?,external_effects),updated_at=? WHERE id=?")
      .run(to, patch.reply ?? null, patch.error ?? (to === "running" ? null : run.error ?? null), patch.steps ?? null, patch.externalEffects ?? null, patch.now ?? Date.now(), id);
    return this.getRun(id)!;
  }
  checkpoint(id: string, value: RunCheckpoint, now = Date.now()): DurableRun { const json = JSON.stringify(value); if (Buffer.byteLength(json, "utf8") > 65_536) throw new Error("checkpoint is too large"); this.db.query("UPDATE runs SET checkpoint_json=?,steps=COALESCE(?,steps),external_effects=COALESCE(?,external_effects),updated_at=? WHERE id=?").run(json, value.steps ?? null, value.externalEffects ?? null, now, id); const run = this.getRun(id); if (!run) throw new Error(`unknown run ${id}`); return run; }
  finishRun(id: string, to: "completed" | "failed" | "cancelled" | "paused" | "waiting_external", reply: string, patch: { error?: string; steps?: number; externalEffects?: number; now?: number } = {}): DurableRun { return this.db.transaction(() => { let run = this.getRun(id); if (!run) throw new Error(`unknown run ${id}`); if (to === "completed" && run.state !== "verifying") { if (!TRANSITIONS[run.state].has("verifying")) throw new InvalidRunTransitionError(run.state, "verifying"); this.db.query("UPDATE runs SET state='verifying' WHERE id=?").run(id); run = { ...run, state: "verifying" }; } if (!TRANSITIONS[run.state].has(to)) throw new InvalidRunTransitionError(run.state, to); const seq = (this.db.query("SELECT COALESCE(MAX(seq),0)+1 seq FROM messages WHERE session=?").get(run.session) as { seq: number }).seq; this.db.query("INSERT INTO messages VALUES (?,?,?,?,?)").run(run.session, seq, "assistant", reply, patch.now ?? Date.now()); this.db.query("UPDATE runs SET state=?,reply=?,error=COALESCE(?,error),steps=COALESCE(?,steps),external_effects=COALESCE(?,external_effects),updated_at=? WHERE id=?").run(to, reply, patch.error ?? null, patch.steps ?? null, patch.externalEffects ?? null, patch.now ?? Date.now(), id); return this.getRun(id)!; }).immediate(); }
  retryRun(id: string, options: { idempotencyKey?: string; budget?: RunBudgetRequest; now?: number } = {}): { run: DurableRun; replayed: boolean } { const old = this.getRun(id); if (!old || !["failed", "cancelled"].includes(old.state)) throw new Error("only failed or cancelled runs can retry"); if (!options.idempotencyKey) throw new Error("retry requires a new idempotency key"); const used = this.db.query("SELECT id FROM runs WHERE session=? AND idempotency_key=?").get(old.session, options.idempotencyKey) as { id: string } | null; if (used) throw new IdempotencyConflictError(used.id); return this.startRun({ session: old.session, request: old.request, idempotencyKey: options.idempotencyKey, budget: options.budget ?? old.budget, retryOf: old.id, now: options.now }); }
  resolveRun(id: string, resolution: "abandon" | "confirm_not_executed"): DurableRun { const run = this.getRun(id); if (!run || run.state !== "recovering") throw new Error("run is not recovering"); if (resolution === "abandon") return this.transition(id, "failed", { error: "owner abandoned ambiguous run" }); const cp = run.checkpoint; if (!cp || cp.phase !== "tool_started") throw new Error("run has no ambiguous tool checkpoint"); this.checkpoint(id, { ...cp, phase: "before_decision", safeToResume: true }); return this.transition(id, "paused"); }
  close(): void {
    if (this.closed) return;
    if (this.ownerReceipt) this.db.query("DELETE FROM runtime_meta WHERE key='runtime_owner' AND value=?").run(this.ownerReceipt);
    this.db.close(); this.closed = true;
  }
}

interface MessageRow { session: string; seq: number; role: MessageRole; content: string; created_at: number }
interface ModelAttemptRow { id: string; run_id: string; provider: string; model: string; request_hash: string; quote_json: string; state: ModelAttempt["state"]; reserved_tokens: number; reserved_cost_micros: number; usage_json: string | null; receipt_source: ModelAttempt["receiptSource"] | null; failure: string | null; created_at: number; updated_at: number }
function toAttempt(row: ModelAttemptRow): ModelAttempt {
  const quote = JSON.parse(row.quote_json) as ModelQuote; validatePricing(quote);
  const usage = row.usage_json ? JSON.parse(row.usage_json) as UsageDelta : undefined; if (usage) validateUsage(usage);
  return { id: row.id, runId: row.run_id, provider: row.provider, model: row.model, requestHash: row.request_hash, quote, state: row.state, reservedTokens: row.reserved_tokens, reservedCostMicros: row.reserved_cost_micros, usage, receiptSource: row.receipt_source ?? undefined, failure: row.failure ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
}
interface RunRow { id: string; session: string; state: RunState; request: string; request_fingerprint: string; idempotency_key: string | null; reply: string | null; error: string | null; budget_json: string; steps: number; external_effects: number; input_tokens: number; output_tokens: number; cost_micros: number; checkpoint_json: string | null; retry_of: string | null; created_at: number; updated_at: number }
function parseBudget(json: string): RunBudget { try { const b = JSON.parse(json) as Partial<RunBudget>; if (![b.maxSteps, b.maxWallMs, b.maxExternalEffects, b.maxTokens].every((v) => Number.isSafeInteger(v) && (v as number) > 0) || !Number.isSafeInteger(b.maxCostMicros) || (b.maxCostMicros as number) < 0) throw new Error(); return b as RunBudget; } catch { throw new Error("invalid persisted run budget"); } }
function parseLegacyBudget(json: string): RunBudget { const b = JSON.parse(json) as Record<string, unknown>; if (![b.maxSteps, b.maxWallMs, b.maxExternalEffects].every((value) => Number.isSafeInteger(value) && (value as number) > 0) || b.maxTokens !== "unavailable" || b.maxCostMicros !== "unavailable") throw new Error("invalid persisted run budget"); return normalizeRunBudget({ maxSteps: b.maxSteps as number, maxWallMs: b.maxWallMs as number, maxExternalEffects: b.maxExternalEffects as number }); }
function validateUsage(usage: UsageDelta): void { if (![usage.inputTokens, usage.outputTokens, usage.totalTokens].every((v) => Number.isSafeInteger(v) && v >= 0) || usage.inputTokens + usage.outputTokens !== usage.totalTokens) throw new Error("invalid provider usage"); }
function validatePricing(pricing: UsagePricing): void { if (![pricing.inputMicrosPerMillion, pricing.outputMicrosPerMillion].every((v) => Number.isSafeInteger(v) && v >= 0)) throw new Error("invalid usage pricing"); }
function toRun(r: RunRow): DurableRun { const usage = { inputTokens:r.input_tokens, outputTokens:r.output_tokens, totalTokens:r.input_tokens+r.output_tokens, costMicros:r.cost_micros }; return { id:r.id, session:r.session as SessionKey, state:r.state, request:r.request, requestFingerprint:r.request_fingerprint, idempotencyKey:r.idempotency_key ?? undefined, reply:r.reply ?? undefined, error:r.error ?? undefined, budget:parseBudget(r.budget_json), usage, steps:r.steps, externalEffects:r.external_effects, checkpoint:r.checkpoint_json ? JSON.parse(r.checkpoint_json) as RunCheckpoint : undefined, retryOf:r.retry_of ?? undefined, createdAt:r.created_at, updatedAt:r.updated_at }; }
