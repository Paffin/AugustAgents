import type { AgentReply, PlannedStep } from "@august/agent";
import { validateArgs, type JsonSchema } from "@august/brain";
import type { ToolDescriptor } from "@august/capabilities";
import { widenedEffects, type Effect } from "@august/policy";
import { DistillationLadder, STEP_NAMES, type LadderOptions, type Step, type TaskState } from "./ladder.ts";
import { deriveTemplate, describeProcedure, instantiate, matchRequest, patternId, type ObservedCall, type PatternTemplate } from "./pattern.ts";
import { PatternStore, emptyStats, type PatternRow, type PatternStats } from "./store.ts";

export type Stage = (typeof STEP_NAMES)[number];

/** How the next run should start: from the model alone, with a learned procedure as advice, or as a compiled plan. */
export interface Route {
  stage: Stage;
  patternId?: string;
  guidance?: string;
  plan?: PlannedStep[];
  /** Reflex: answer from the results without another model call. */
  verbatim?: boolean;
}

export interface ReplayResult {
  ok: boolean;
  checked: number;
  /** The first request whose compiled calls differed from what was verified. */
  mismatch?: string;
}

export interface PatternReport {
  id: string;
  request: string;
  procedure: string;
  stage: Stage;
  streak: number;
  pendingApproval: boolean;
  disabled: boolean;
  effects: Effect[];
  stats: PatternStats;
  lastChange?: string;
}

export interface EngineOptions extends LadderOptions {
  store: PatternStore;
  now?: () => number;
}

/** The same call with keys in one order, so a model's key order never decides an eval. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const fixedLength = (t: PatternTemplate): number => t.request.replace(/\{\{\d+\}\}/g, "").length;

/**
 * Turns repeated, verified work into a plan the runtime can execute without asking a model to choose or fill
 * each call. A pattern is learned from what actually ran; it climbs only on independent evidence, is replayed
 * against its verified examples before it is compiled, is audited back down periodically, and is dropped on any
 * failure. It never widens authority: every compiled step still passes the same policy and approval as any call.
 */
export class DistillationEngine {
  private readonly ladder: DistillationLadder;
  private readonly store: PatternStore;
  private readonly now: () => number;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.ladder = new DistillationLadder(options);
    for (const p of this.store.patterns()) this.ladder.restore(p.id, p.state);
  }

  /** Decides how a request starts. Anything unmet (a missing tool, arguments the tool would refuse) falls back to advice or the model. */
  route(request: string, tools: readonly ToolDescriptor[]): Route {
    let best: { row: PatternRow; mode: Step } | undefined;
    for (const row of this.store.patterns()) {
      if (row.disabled || !matchRequest(row.template, request)) continue;
      const mode = this.ladder.nextMode(row.id);
      if (mode === 0) continue;
      if (!best || mode > best.mode || (mode === best.mode && fixedLength(row.template) > fixedLength(best.row.template))) best = { row, mode };
    }
    if (!best) return { stage: "llm" };
    const guidance = describeProcedure(best.row.template);
    if (best.mode === 1) return { stage: "skill", patternId: best.row.id, guidance };
    const calls = instantiate(best.row.template, request);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const usable = calls?.every((c) => {
      const tool = byName.get(c.tool);
      return tool !== undefined && validateArgs((tool.inputSchema as JsonSchema | undefined) ?? { type: "object" }, c.args).length === 0;
    });
    if (!calls || !usable) return { stage: "skill", patternId: best.row.id, guidance };
    return { stage: STEP_NAMES[best.mode], patternId: best.row.id, guidance, plan: calls, verbatim: best.mode === 3 };
  }

  /**
   * Records what a finished run did. Nothing is earned here: a run climbs only when `settle` reports independent
   * verification. A run that failed or fell back costs the pattern it was following its place on the ladder.
   */
  observe(o: { runId: string; request: string; reply: AgentReply; route: Route }): void {
    const { reply, route } = o;
    const trace = reply.trace;
    const failedRun = Boolean(reply.error || reply.stopReason || reply.compiled?.fellBack || trace?.executions.some((e) => e.isError));
    if (route.patternId && failedRun) { this.failure(route.patternId); }
    if (!trace || trace.executions.length === 0 || failedRun) return;

    const calls: ObservedCall[] = trace.executions.map((e) => ({ tool: e.tool, args: structuredClone(e.args) }));
    const template = deriveTemplate(o.request, calls);
    if (!template) return;
    const id = patternId(template);
    const effects = [...new Set(trace.executions.flatMap((e) => e.effects as Effect[]))];
    const tainted = reply.tainted || trace.executions.some((e) => e.trust.includes("untrusted"));
    const ranAt = (reply.compiled?.completed ? STEP_NAMES.indexOf(route.stage) : route.stage === "skill" ? 1 : 0) as Step;

    let row = this.store.pattern(id);
    if (row?.disabled) return;
    if (!row) {
      this.ladder.record(id, { success: true, verified: false, effects, tainted, ranAt: 0 });
      row = { id, template, state: this.snapshot(id), stats: emptyStats(), disabled: false, createdAt: this.now(), updatedAt: this.now() };
    } else if (widenedEffects(row.state.effects, effects).length > 0) {
      // A tool now does more than when this pattern was learned; what it earned no longer applies.
      const r = this.ladder.record(id, { success: true, verified: false, effects, tainted, ranAt });
      row.lastChange = r.change === "effects-widened" ? "effects widened: back to the model" : row.lastChange;
    }
    row.stats.runs[ranAt] += 1;
    if (reply.compiled) {
      row.stats.avoidedDecisions += reply.compiled.steps;
      row.stats.avoidedArgumentFills += reply.compiled.steps;
      if (reply.compiled.completed && route.verbatim) row.stats.avoidedAnswers += 1;
    }
    this.save(row);
    this.store.addObservation({ runId: o.runId, patternId: id, request: o.request, calls, effects, tainted, ranAt, settled: null, at: this.now() });
  }

  /** An independent verdict on a run arrived: a host check, or the owner. Applies once per run. */
  settle(runId: string, verdict: "verified" | "failed"): void {
    const obs = this.store.observation(runId);
    if (!obs || !this.store.settle(runId, verdict)) return;
    const row = this.store.pattern(obs.patternId);
    if (!row || row.disabled) return;
    if (verdict === "failed") { this.failure(row.id); return; }
    const result = this.ladder.record(row.id, { success: true, verified: true, effects: obs.effects, tainted: obs.tainted, ranAt: obs.ranAt as Step });
    const fresh = this.store.pattern(row.id)!;
    fresh.state = this.snapshot(row.id);
    if (result.change === "promoted" && result.step >= 2) {
      // Compiling is allowed only if the compiled form reproduces every verified run.
      const replay = this.replay(fresh);
      if (!replay.ok) {
        this.ladder.demoteTask(row.id);
        fresh.state = this.snapshot(row.id);
        fresh.lastChange = `not compiled: replay differed on "${replay.mismatch}"`;
      } else fresh.lastChange = `promoted to ${STEP_NAMES[result.step]} after replaying ${replay.checked} verified runs`;
    } else if (result.change !== "none") fresh.lastChange = `${result.change}: ${STEP_NAMES[result.step]}`;
    this.save(fresh);
  }

  /** Replays the compiled form against the verified runs it was learned from. */
  replay(row: PatternRow): ReplayResult {
    const examples = this.store.verifiedExamples(row.id);
    if (examples.length < 1) return { ok: false, checked: 0, mismatch: "no verified runs" };
    for (const ex of examples) {
      const calls = instantiate(row.template, ex.request);
      if (!calls || canonical(calls) !== canonical(ex.calls)) return { ok: false, checked: examples.length, mismatch: ex.request };
    }
    return { ok: true, checked: examples.length };
  }

  /** The owner agrees that a task with controlled effects may run as a reflex. */
  approve(id: string): { ok: boolean; message: string } {
    const row = this.store.pattern(id);
    if (!row) return { ok: false, message: "no such pattern" };
    if (!row.state.pendingApproval) return { ok: false, message: "this pattern is not waiting for approval" };
    const replay = this.replay(row);
    if (!replay.ok) return { ok: false, message: `replay failed on "${replay.mismatch}"; not compiled` };
    this.ladder.approve(id);
    row.state = this.snapshot(id);
    row.lastChange = "approved by the owner: reflex";
    this.save(row);
    return { ok: true, message: `${id} now runs as a reflex` };
  }

  disable(id: string, disabled = true): boolean {
    const row = this.store.pattern(id);
    if (!row) return false;
    if (disabled) { this.ladder.reset(id); this.ladder.record(id, { success: true, verified: false, effects: row.state.effects, ranAt: 0 }); row.state = this.snapshot(id); }
    row.disabled = disabled; row.lastChange = disabled ? "disabled by the owner" : "re-enabled by the owner";
    this.save(row);
    return true;
  }

  forget(id: string): void {
    this.ladder.reset(id);
    this.store.forget(id);
  }

  report(): { patterns: PatternReport[]; totals: { patterns: number; compiled: number; runs: number; avoidedDecisions: number; avoidedArgumentFills: number; avoidedAnswers: number; fallbacks: number } } {
    const patterns = this.store.patterns().map((p): PatternReport => ({
      id: p.id, request: p.template.request, procedure: describeProcedure(p.template), stage: STEP_NAMES[p.state.step], streak: p.state.streak,
      pendingApproval: p.state.pendingApproval, disabled: p.disabled, effects: p.state.effects, stats: p.stats, ...(p.lastChange ? { lastChange: p.lastChange } : {}),
    }));
    const sum = (f: (s: PatternStats) => number) => patterns.reduce((n, p) => n + f(p.stats), 0);
    return {
      patterns,
      totals: {
        patterns: patterns.length, compiled: patterns.filter((p) => p.stage === "workflow" || p.stage === "reflex").length, runs: sum((s) => s.runs.reduce((a, b) => a + b, 0)),
        avoidedDecisions: sum((s) => s.avoidedDecisions), avoidedArgumentFills: sum((s) => s.avoidedArgumentFills), avoidedAnswers: sum((s) => s.avoidedAnswers), fallbacks: sum((s) => s.fallbacks),
      },
    };
  }

  private failure(id: string): void {
    const row = this.store.pattern(id);
    if (!row || row.disabled) return;
    const before = this.ladder.step(id);
    const result = this.ladder.record(id, { success: false, verified: false, effects: row.state.effects });
    row.state = this.snapshot(id);
    row.stats.fallbacks += 1;
    row.lastChange = result.change === "demoted" ? `demoted from ${STEP_NAMES[before]} to ${STEP_NAMES[result.step]} after a failure` : row.lastChange;
    this.save(row);
  }

  private snapshot(id: string): TaskState {
    const s = this.ladder.state(id)!;
    return { ...s, effects: [...s.effects] };
  }

  private save(row: PatternRow): void {
    row.updatedAt = this.now();
    this.store.savePattern(row);
  }
}
