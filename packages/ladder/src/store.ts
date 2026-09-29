import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import type { Effect } from "@august/policy";
import type { ObservedCall, PatternTemplate } from "./pattern.ts";
import type { TaskState } from "./ladder.ts";

const SCHEMA_VERSION = "1";
/** Verified examples kept per pattern: enough to replay against, bounded so the file cannot grow without limit. */
const EXAMPLES_PER_PATTERN = 20;
const UNSETTLED_LIMIT = 500;

export class PatternStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternStoreError";
  }
}

export interface PatternStats {
  /** Runs per stage: llm, skill, workflow, reflex. */
  runs: [number, number, number, number];
  /** Runs where a plan handed the task back to the model. */
  fallbacks: number;
  /** What compiled runs did not have to ask a model (counted exactly, not priced). */
  avoidedDecisions: number;
  avoidedArgumentFills: number;
  avoidedAnswers: number;
}

export const emptyStats = (): PatternStats => ({ runs: [0, 0, 0, 0], fallbacks: 0, avoidedDecisions: 0, avoidedArgumentFills: 0, avoidedAnswers: 0 });

export interface PatternRow {
  id: string;
  template: PatternTemplate;
  state: TaskState;
  stats: PatternStats;
  /** A disabled pattern is never routed and never learns again until the owner re-enables it. */
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastChange?: string;
}

export interface ObservationRow {
  runId: string;
  patternId: string;
  request: string;
  calls: ObservedCall[];
  effects: Effect[];
  tainted: boolean;
  ranAt: number;
  /** null until an independent verdict arrives. */
  settled: "verified" | "failed" | null;
  at: number;
}

/** Where patterns and their evidence live: separate from the learning store, because they steer execution. */
export class PatternStore {
  private readonly db: Database;

  constructor(path = ":memory:") {
    const fresh = path === ":memory:" || !existsSync(path);
    this.db = new Database(path);
    if (fresh) {
      this.db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.db.run("INSERT INTO meta VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
      this.db.run("CREATE TABLE patterns (id TEXT PRIMARY KEY, template_json TEXT NOT NULL, state_json TEXT NOT NULL, stats_json TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_change TEXT)");
      this.db.run("CREATE TABLE observations (run_id TEXT PRIMARY KEY, pattern_id TEXT NOT NULL, request TEXT NOT NULL, calls_json TEXT NOT NULL, effects_json TEXT NOT NULL, tainted INTEGER NOT NULL, ran_at INTEGER NOT NULL, settled TEXT CHECK(settled IN ('verified','failed')), at INTEGER NOT NULL)");
      this.db.run("CREATE INDEX observations_pattern ON observations(pattern_id, settled)");
    }
    const version = this.db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | null;
    if (version?.value !== SCHEMA_VERSION) throw new PatternStoreError(`unsupported pattern schema ${version?.value ?? "missing"}`);
    if (path !== ":memory:") { this.db.run("PRAGMA journal_mode = WAL"); chmodSync(path, 0o600); }
  }

  close(): void {
    this.db.close();
  }

  patterns(): PatternRow[] {
    return (this.db.query("SELECT * FROM patterns ORDER BY created_at, id").all() as Array<Record<string, unknown>>).map(toPattern);
  }

  pattern(id: string): PatternRow | undefined {
    const row = this.db.query("SELECT * FROM patterns WHERE id=?").get(id) as Record<string, unknown> | null;
    return row ? toPattern(row) : undefined;
  }

  savePattern(p: PatternRow): void {
    this.db.query("INSERT INTO patterns (id, template_json, state_json, stats_json, disabled, created_at, updated_at, last_change) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json, stats_json=excluded.stats_json, disabled=excluded.disabled, updated_at=excluded.updated_at, last_change=excluded.last_change")
      .run(p.id, JSON.stringify(p.template), JSON.stringify(p.state), JSON.stringify(p.stats), p.disabled ? 1 : 0, p.createdAt, p.updatedAt, p.lastChange ?? null);
  }

  addObservation(o: ObservationRow): void {
    this.db.transaction(() => {
      this.db.query("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?)").run(o.runId, o.patternId, o.request, JSON.stringify(o.calls), JSON.stringify(o.effects), o.tainted ? 1 : 0, o.ranAt, o.settled, o.at);
      // Unsettled rows are bounded oldest-first; a verdict that never came is not evidence.
      this.db.run("DELETE FROM observations WHERE settled IS NULL AND run_id NOT IN (SELECT run_id FROM observations WHERE settled IS NULL ORDER BY at DESC LIMIT ?)", [UNSETTLED_LIMIT]);
    })();
  }

  observation(runId: string): ObservationRow | undefined {
    const row = this.db.query("SELECT * FROM observations WHERE run_id=?").get(runId) as Record<string, unknown> | null;
    return row ? toObservation(row) : undefined;
  }

  /**
   * Records the verdict. A run is settled once, except that a later failure overrides an earlier verification (the
   * owner can contradict a host check); a failure is final. Returns false when nothing changed.
   */
  settle(runId: string, verdict: "verified" | "failed"): boolean {
    return this.db.transaction(() => {
      const r = this.db.query("UPDATE observations SET settled=? WHERE run_id=? AND (settled IS NULL OR (settled='verified' AND ?='failed'))").run(verdict, runId, verdict);
      const row = this.db.query("SELECT pattern_id FROM observations WHERE run_id=?").get(runId) as { pattern_id: string } | null;
      if (row) this.db.run("DELETE FROM observations WHERE settled='verified' AND pattern_id=? AND run_id NOT IN (SELECT run_id FROM observations WHERE settled='verified' AND pattern_id=? ORDER BY at DESC LIMIT ?)", [row.pattern_id, row.pattern_id, EXAMPLES_PER_PATTERN]);
      return r.changes === 1;
    })();
  }

  /** Runs that were independently verified as successful, newest first: what a pattern is replayed against. */
  verifiedExamples(patternId: string): ObservationRow[] {
    return (this.db.query("SELECT * FROM observations WHERE pattern_id=? AND settled='verified' AND tainted=0 ORDER BY at DESC").all(patternId) as Array<Record<string, unknown>>).map(toObservation);
  }

  forget(patternId: string): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM observations WHERE pattern_id=?", [patternId]);
      this.db.run("DELETE FROM patterns WHERE id=?", [patternId]);
    })();
  }
}

function toPattern(r: Record<string, unknown>): PatternRow {
  return {
    id: r.id as string, template: JSON.parse(r.template_json as string), state: JSON.parse(r.state_json as string), stats: JSON.parse(r.stats_json as string),
    disabled: r.disabled === 1, createdAt: r.created_at as number, updatedAt: r.updated_at as number, ...(r.last_change ? { lastChange: r.last_change as string } : {}),
  };
}

function toObservation(r: Record<string, unknown>): ObservationRow {
  return {
    runId: r.run_id as string, patternId: r.pattern_id as string, request: r.request as string, calls: JSON.parse(r.calls_json as string), effects: JSON.parse(r.effects_json as string),
    tainted: r.tainted === 1, ranAt: r.ran_at as number, settled: (r.settled as ObservationRow["settled"]) ?? null, at: r.at as number,
  };
}
