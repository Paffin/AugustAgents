import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import type { RunTrace } from "@august/agent";
import { deriveExamples } from "./eligibility.ts";
import { EVIDENCE_METHODS, type DecisionRow, type EvidenceRow, type ExampleReport, type ExclusionReason, type ExecutionRow, type TrainingExample, type VerifierEvidence } from "./types.ts";

const SCHEMA_VERSION = "1";

export class LearningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningError";
  }
}

export interface RunRecord {
  runId: string;
  session: string;
  startedAt: number;
  finishedAt: number;
  trace: RunTrace;
  /** What the run cost, from the usage ledger; recorded per stage for the value report. */
  usage?: { llmCalls?: number; totalTokens: number; costMicros: number };
  /** The stage that executed it. Only "llm" until the ladder is integrated. */
  stage?: "llm" | "skill" | "workflow" | "reflex";
}

export interface LearningStoreOptions {
  /** Verifier ids evidence may name. Anything else is refused: a model cannot invent a verifier. */
  verifiers: readonly string[];
  now?: () => number;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const json = (v: unknown): string => JSON.stringify(v);

/**
 * What the agent decided, did and later learned it was worth. Decisions and executions are recorded when a run
 * ends; evidence arrives when something independent observes the outcome (a host check right away, the owner's
 * reaction later). Training examples are never stored: they are derived from these rows by one rule, so a
 * change of rule applies to everything, and nothing stale can leak into a dataset.
 */
export class LearningStore {
  private readonly db: Database;
  private readonly verifiers: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(path = ":memory:", options: LearningStoreOptions) {
    const fresh = path === ":memory:" || !existsSync(path);
    this.db = new Database(path);
    this.verifiers = new Set(options.verifiers);
    this.now = options.now ?? Date.now;
    if (fresh) {
      this.db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.db.run("INSERT INTO meta VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
      this.db.run("CREATE TABLE runs (run_id TEXT PRIMARY KEY, session TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, stage TEXT NOT NULL, llm_calls INTEGER, total_tokens INTEGER, cost_micros INTEGER)");
      this.db.run("CREATE TABLE decisions (run_id TEXT NOT NULL, idx INTEGER NOT NULL, question TEXT NOT NULL, instructions TEXT NOT NULL, state TEXT, state_sha256 TEXT NOT NULL, options_json TEXT NOT NULL, choice TEXT NOT NULL, source TEXT NOT NULL, reason TEXT, confidence REAL NOT NULL, primary_json TEXT, tainted INTEGER NOT NULL CHECK(tainted IN (0,1)), taint_sources_json TEXT NOT NULL, sensitivity TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(run_id, idx), CHECK(tainted = 0 OR state IS NULL))");
      this.db.run("CREATE TABLE executions (run_id TEXT NOT NULL, decision_idx INTEGER NOT NULL, tool TEXT NOT NULL, args_hash TEXT NOT NULL, policy_rule TEXT NOT NULL, approved INTEGER NOT NULL, is_error INTEGER NOT NULL, result_hash TEXT NOT NULL, result_chars INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(run_id, decision_idx))");
      this.db.run("CREATE TABLE evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, decision_idx INTEGER, verifier TEXT NOT NULL, method TEXT NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('success','failure')), observed_at INTEGER NOT NULL, detail TEXT NOT NULL)");
      this.db.run("CREATE UNIQUE INDEX evidence_once ON evidence(run_id, COALESCE(decision_idx, -1), verifier)");
      this.db.run("CREATE INDEX decisions_question ON decisions(question)");
    }
    const version = this.db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | null;
    if (version?.value !== SCHEMA_VERSION) throw new LearningError(`unsupported learning schema ${version?.value ?? "missing"}`);
    if (path !== ":memory:") { this.db.run("PRAGMA journal_mode = WAL"); chmodSync(path, 0o600); }
  }

  close(): void {
    this.db.close();
  }

  /** Records a finished run's decisions and executions. Recording the same run twice is refused. */
  recordRun(run: RunRecord): void {
    this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM runs WHERE run_id=?").get(run.runId)) throw new LearningError(`run ${run.runId} is already recorded`);
      this.db.query("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?)").run(run.runId, run.session, run.startedAt, run.finishedAt, run.stage ?? "llm", run.usage?.llmCalls ?? null, run.usage?.totalTokens ?? null, run.usage?.costMicros ?? null);
      for (const d of run.trace.decisions) {
        this.db.query("INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          run.runId, d.index, d.questionId, d.instructions, d.tainted ? null : d.state, sha256(d.state), json(d.options), d.choice, d.source, d.reason ?? null, d.confidence,
          d.primary ? json(d.primary) : null, d.tainted ? 1 : 0, json(d.taintSources), d.sensitivity, d.at,
        );
      }
      for (const e of run.trace.executions) {
        this.db.query("INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?)").run(run.runId, e.decisionIndex, e.tool, e.argsHash, e.policy.rule, e.approved ? 1 : 0, e.isError ? 1 : 0, e.resultHash, e.resultChars, e.finishedAt);
      }
    }).immediate();
  }

  /** A run that is paused and resumed is recorded once per segment: `<id>`, then `<id>~1`, `<id>~2`. */
  nextSegmentId(baseRunId: string): string {
    const rows = this.db.query("SELECT run_id FROM runs WHERE run_id = ? OR run_id LIKE ? ESCAPE '\\'").all(baseRunId, `${baseRunId.replace(/[%_\\]/g, "\\$&")}~%`) as Array<{ run_id: string }>;
    return rows.length === 0 ? baseRunId : `${baseRunId}~${rows.length}`;
  }

  /** The id of the latest recorded segment of a run: the one that produced the answer the owner saw. */
  latestSegmentId(baseRunId: string): string | undefined {
    const next = this.nextSegmentId(baseRunId);
    if (next === baseRunId) return undefined;
    const n = Number(next.split("~")[1] ?? 0);
    return n <= 1 ? baseRunId : `${baseRunId}~${n - 1}`;
  }

  /** The session a recorded run belongs to, so feedback can be checked against the person giving it. */
  sessionOf(runId: string): string | undefined {
    return (this.db.query("SELECT session FROM runs WHERE run_id=?").get(runId) as { session: string } | null)?.session;
  }

  hasRun(runId: string): boolean {
    return this.db.query("SELECT 1 FROM runs WHERE run_id=?").get(runId) !== null;
  }

  /**
   * Adds one piece of independent evidence about a decision (`decisionIndex`) or the run as a whole (`null`).
   * The verifier must be registered, the method one of the allowed kinds, and there is one verdict per verifier
   * and target: a verifier that changes its mind is a conflict to be resolved by a person, not overwritten.
   */
  addEvidence(runId: string, decisionIndex: number | null, evidence: VerifierEvidence): void {
    if (!this.verifiers.has(evidence.verifier)) throw new LearningError(`"${evidence.verifier}" is not a registered verifier`);
    if (!(EVIDENCE_METHODS as readonly string[]).includes(evidence.method)) throw new LearningError(`"${evidence.method}" is not an evidence method`);
    if (evidence.verdict !== "success" && evidence.verdict !== "failure") throw new LearningError("evidence must say success or failure");
    if (!Number.isFinite(evidence.observedAt) || evidence.observedAt > this.now() + 5_000) throw new LearningError("evidence cannot be observed in the future");
    const run = this.db.query("SELECT started_at FROM runs WHERE run_id=?").get(runId) as { started_at: number } | null;
    if (!run) throw new LearningError(`unknown run ${runId}`);
    if (evidence.observedAt < run.started_at) throw new LearningError("evidence cannot predate the run it is about");
    if (decisionIndex !== null && !this.db.query("SELECT 1 FROM decisions WHERE run_id=? AND idx=?").get(runId, decisionIndex)) throw new LearningError(`run ${runId} has no decision ${decisionIndex}`);
    try {
      this.db.query("INSERT INTO evidence (run_id, decision_idx, verifier, method, verdict, observed_at, detail) VALUES (?,?,?,?,?,?,?)").run(runId, decisionIndex, evidence.verifier, evidence.method, evidence.verdict, evidence.observedAt, evidence.detail.slice(0, 300));
    } catch {
      throw new LearningError(`"${evidence.verifier}" already gave a verdict for this target`);
    }
  }

  private rows(runId: string): { decisions: DecisionRow[]; executions: ExecutionRow[]; evidence: EvidenceRow[] } {
    const decisions = (this.db.query("SELECT * FROM decisions WHERE run_id=? ORDER BY idx").all(runId) as Array<Record<string, unknown>>).map((r): DecisionRow => ({
      runId, index: r.idx as number, questionId: r.question as string, instructions: r.instructions as string, state: r.state as string | null, stateSha256: r.state_sha256 as string,
      options: JSON.parse(r.options_json as string), choice: r.choice as string, source: r.source as DecisionRow["source"], ...(r.reason ? { reason: r.reason as string } : {}), confidence: r.confidence as number,
      ...(r.primary_json ? { primary: JSON.parse(r.primary_json as string) } : {}), tainted: r.tainted === 1, taintSources: JSON.parse(r.taint_sources_json as string), sensitivity: r.sensitivity as DecisionRow["sensitivity"], at: r.at as number,
    }));
    const executions = (this.db.query("SELECT * FROM executions WHERE run_id=? ORDER BY decision_idx").all(runId) as Array<Record<string, unknown>>).map((r): ExecutionRow => ({
      runId, decisionIndex: r.decision_idx as number, tool: r.tool as string, argsHash: r.args_hash as string, policyRule: r.policy_rule as string, approved: r.approved === 1, isError: r.is_error === 1, resultHash: r.result_hash as string, resultChars: r.result_chars as number, at: r.at as number,
    }));
    const evidence = (this.db.query("SELECT * FROM evidence WHERE run_id=? ORDER BY id").all(runId) as Array<Record<string, unknown>>).map((r): EvidenceRow => ({
      runId, decisionIndex: r.decision_idx as number | null, verifier: r.verifier as string, method: r.method as EvidenceRow["method"], verdict: r.verdict as EvidenceRow["verdict"], observedAt: r.observed_at as number, detail: r.detail as string,
    }));
    return { decisions, executions, evidence };
  }

  /** Every training example currently supported by evidence, derived by the one eligibility rule. */
  examples(filter: { questionId?: string } = {}): ExampleReport {
    const ids = (this.db.query("SELECT run_id FROM runs ORDER BY started_at, run_id").all() as Array<{ run_id: string }>).map((r) => r.run_id);
    const out: ExampleReport = { examples: [], excluded: [] };
    for (const runId of ids) {
      const report = deriveExamples({ runId, ...this.rows(runId) }, this.now);
      out.examples.push(...report.examples.filter((e) => !filter.questionId || e.questionId === filter.questionId));
      out.excluded.push(...report.excluded);
    }
    return out;
  }

  /** Counts by reason, so the owner can see why data is not being used. */
  exclusionSummary(): Record<ExclusionReason, number> & { examples: number } {
    const { examples, excluded } = this.examples();
    const summary = { examples: examples.length, "tainted-context": 0, "not-executed": 0, unresolved: 0, "conflicting-evidence": 0, "ambiguous-credit": 0, "compiled-plan": 0 };
    for (const e of excluded) summary[e.reason] += 1;
    return summary;
  }

  /**
   * Writes examples as JSON lines for fine-tuning: only verified, untainted ones, each with its bindings. Private
   * state is in the file, so it is created readable by the owner only.
   */
  exportJsonl(path: string, filter: { questionId?: string } = {}): number {
    const { examples } = this.examples(filter);
    writeFileSync(path, examples.map((e) => json({
      id: e.id, question: e.questionId, instructions: e.instructions, state: e.state, options: e.options,
      ...(e.label.kind === "chosen-worked" ? { label: e.label.key } : { avoid: e.label.avoid }), reward: e.reward,
      chosen: e.choice, chosen_by: e.choiceSource, laya: e.primary ? { choice: e.primary.choice, confidence: e.primary.confidence } : undefined,
      execution: e.execution, verified_by: e.evidence.map((v) => `${v.method}:${v.verifier}`), sensitivity: e.provenance.sensitivity, run: e.runId, decision: e.decisionIndex,
    })).join("\n") + (examples.length ? "\n" : ""), { mode: 0o600 });
    chmodSync(path, 0o600);
    return examples.length;
  }

  /** Per stage: how many runs, what they cost, how long they took, and how often they were verified to have worked (REQ-PERF-001). */
  report(): Array<{ stage: string; runs: number; verifiedRuns: number; verifiedSuccessRate: number | null; avgLatencyMs: number; avgLlmCalls: number | null; avgTokens: number | null; avgCostMicros: number | null }> {
    const runs = this.db.query("SELECT run_id, stage, started_at, finished_at, llm_calls, total_tokens, cost_micros FROM runs").all() as Array<{ run_id: string; stage: string; started_at: number; finished_at: number; llm_calls: number | null; total_tokens: number | null; cost_micros: number | null }>;
    const byStage = new Map<string, typeof runs>();
    for (const r of runs) byStage.set(r.stage, [...(byStage.get(r.stage) ?? []), r]);
    const avg = (xs: Array<number | null>): number | null => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    return [...byStage].map(([stage, list]) => {
      let verified = 0; let success = 0;
      for (const r of list) {
        const { decisions, executions, evidence } = this.rows(r.run_id);
        const report = deriveExamples({ runId: r.run_id, decisions, executions, evidence });
        const verdicts = report.examples.map((e) => e.reward);
        if (verdicts.length) { verified += 1; if (verdicts.every((v) => v === 1)) success += 1; }
      }
      return { stage, runs: list.length, verifiedRuns: verified, verifiedSuccessRate: verified ? success / verified : null, avgLatencyMs: avg(list.map((r) => r.finished_at - r.started_at))!, avgLlmCalls: avg(list.map((r) => r.llm_calls)), avgTokens: avg(list.map((r) => r.total_tokens)), avgCostMicros: avg(list.map((r) => r.cost_micros)) };
    });
  }
}

export type { TrainingExample };
