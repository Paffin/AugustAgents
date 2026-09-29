import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";

export interface LedgerUsage { provider: string; model: string; inputTokens: number; outputTokens: number; costMicros?: number; currency?: string }
export interface LedgerEntry extends LedgerUsage { runId: string; at: number; reported: boolean }
export interface RunUsageTotals { inputTokens: number; outputTokens: number; costMicros: number; calls: number; unreportedCalls: number }

const SCHEMA_VERSION = "1";
const nonNegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Append-only record of what the provider reported for each model call of a
 * run. It lives in its own database so adding usage accounting never rewrites
 * the schema of an existing runtime.db. Money is integer millionths of one
 * currency unit; a call the provider did not report is stored as unreported,
 * never estimated.
 */
export class RunUsageLedger {
  private readonly db: Database;

  constructor(path = ":memory:") {
    const fresh = path === ":memory:" || !existsSync(path);
    this.db = new Database(path);
    if (fresh) {
      this.db.run("CREATE TABLE usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.db.run("INSERT INTO usage_meta VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
      this.db.run("CREATE TABLE run_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at INTEGER NOT NULL, reported INTEGER NOT NULL CHECK(reported IN (0,1)), provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0), output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0), cost_micros INTEGER CHECK(cost_micros >= 0), currency TEXT)");
      this.db.run("CREATE INDEX run_usage_run ON run_usage(run_id, id)");
    }
    const version = this.db.query("SELECT value FROM usage_meta WHERE key='schema_version'").get() as { value: string } | null;
    if (version?.value !== SCHEMA_VERSION) throw new Error(`unsupported usage schema ${version?.value ?? "missing"}`);
    if (path !== ":memory:") { this.db.run("PRAGMA journal_mode = WAL"); this.db.run("PRAGMA synchronous = FULL"); chmodSync(path, 0o600); }
  }

  append(runId: string, usage: LedgerUsage, now = Date.now()): void {
    if (!nonNegative(usage.inputTokens) || !nonNegative(usage.outputTokens) || (usage.costMicros !== undefined && !nonNegative(usage.costMicros))) throw new Error("invalid usage figures");
    this.db.query("INSERT INTO run_usage (run_id,at,reported,provider,model,input_tokens,output_tokens,cost_micros,currency) VALUES (?,?,1,?,?,?,?,?,?)")
      .run(runId, now, usage.provider, usage.model, usage.inputTokens, usage.outputTokens, usage.costMicros ?? null, usage.currency ?? null);
  }

  appendUnreported(runId: string, provider = "unknown", model = "unknown", now = Date.now()): void {
    this.db.query("INSERT INTO run_usage (run_id,at,reported,provider,model,input_tokens,output_tokens) VALUES (?,?,0,?,?,0,0)").run(runId, now, provider, model);
  }

  totals(runId: string): RunUsageTotals {
    const row = this.db.query("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cost_micros),0) c, COUNT(*) n, COALESCE(SUM(1-reported),0) u FROM run_usage WHERE run_id=?").get(runId) as { i: number; o: number; c: number; n: number; u: number };
    return { inputTokens: row.i, outputTokens: row.o, costMicros: row.c, calls: row.n, unreportedCalls: row.u };
  }

  entries(runId: string): LedgerEntry[] {
    return (this.db.query("SELECT * FROM run_usage WHERE run_id=? ORDER BY id").all(runId) as Array<Record<string, unknown>>).map((r) => ({
      runId: r.run_id as string, at: r.at as number, reported: r.reported === 1, provider: r.provider as string, model: r.model as string,
      inputTokens: r.input_tokens as number, outputTokens: r.output_tokens as number,
      ...(r.cost_micros === null ? {} : { costMicros: r.cost_micros as number }), ...(r.currency === null ? {} : { currency: r.currency as string }),
    }));
  }

  close(): void { this.db.close(); }
}
