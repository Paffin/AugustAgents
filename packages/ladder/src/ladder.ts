import { CONTROLLED_EFFECTS, widenedEffects, type Effect } from "@august/policy";

/** 0 = LLM every time, 1 = SKILL.md, 2 = workflow with Laya branches, 3 = reflex without the LLM. */
export type Step = 0 | 1 | 2 | 3;

export const STEP_NAMES = ["llm", "skill", "workflow", "reflex"] as const;

export interface RunReport {
  success: boolean;
  /**
   * The outcome was confirmed by a check or eval, not by the model saying
   * "done". Only verified successes count toward promotion.
   */
  verified: boolean;
  effects: readonly Effect[];
  /** The run was driven by untrusted text; it is not a clean example. */
  tainted?: boolean;
  /** The step this run actually used. Defaults to the task's current step. */
  ranAt?: Step;
}

export type LadderChange =
  | "none"
  | "promoted"
  | "demoted"
  | "pending-approval"
  | "effects-widened";

export interface LadderResult {
  step: Step;
  change: LadderChange;
}

export interface TaskState {
  step: Step;
  streak: number;
  effects: Effect[];
  pendingApproval: boolean;
  sinceAudit: number;
}

export interface LadderOptions {
  /** Consecutive verified successes needed to move up one step. Default 3. */
  repeatsToPromote?: number;
  /** A reflex is re-run with the full workflow after this many runs. Default 10. */
  auditEvery?: number;
}

/**
 * Turns repeated work into cheaper, faster steps, and takes it back when it
 * stops working. Promotion needs evidence; a failure, or a task that starts
 * doing something new, sends it down.
 */
export class DistillationLadder {
  private readonly tasks = new Map<string, TaskState>();
  private readonly repeats: number;
  private readonly auditEvery: number;

  constructor(options: LadderOptions = {}) {
    this.repeats = options.repeatsToPromote ?? 3;
    this.auditEvery = options.auditEvery ?? 10;
    if (this.repeats < 1) throw new Error("repeatsToPromote must be at least 1");
  }

  state(task: string): Readonly<TaskState> | undefined {
    return this.tasks.get(task);
  }

  step(task: string): Step {
    return this.tasks.get(task)?.step ?? 0;
  }

  /** The step to use for the next run: the task's own, or one below it when a reflex is due for an audit. */
  nextMode(task: string): Step {
    const s = this.tasks.get(task);
    if (!s) return 0;
    return s.step === 3 && s.sinceAudit >= this.auditEvery ? 2 : s.step;
  }

  record(task: string, run: RunReport): LadderResult {
    let s = this.tasks.get(task);
    if (!s) {
      s = { step: 0, streak: 0, effects: [...new Set(run.effects)], pendingApproval: false, sinceAudit: 0 };
      this.tasks.set(task, s);
    }

    const ranAt = run.ranAt ?? s.step;
    if (s.step === 3) s.sinceAudit = ranAt === 3 ? s.sinceAudit + 1 : 0;

    if (!run.success) return this.demote(s);

    const widened = widenedEffects(s.effects, run.effects);
    if (widened.length > 0) {
      // New behaviour under an old name: what was earned no longer applies.
      s.effects = [...new Set([...s.effects, ...run.effects])];
      const wasHigher = s.step > 0;
      s.step = 0;
      s.streak = 0;
      s.pendingApproval = false;
      s.sinceAudit = 0;
      return { step: 0, change: wasHigher ? "effects-widened" : "none" };
    }

    if (!run.verified || run.tainted) return { step: s.step, change: "none" };

    s.streak += 1;
    if (s.streak < this.repeats || s.step === 3) return { step: s.step, change: "none" };

    const next = (s.step + 1) as Step;
    if (next === 3 && s.effects.some((e) => CONTROLLED_EFFECTS.has(e))) {
      // A reflex acts without anyone reading it; controlled effects need a person to agree first.
      s.pendingApproval = true;
      return { step: s.step, change: "pending-approval" };
    }
    s.step = next;
    s.streak = 0;
    return { step: next, change: "promoted" };
  }

  /** A person agreed to let a task with controlled effects run as a reflex. */
  approve(task: string): LadderResult {
    const s = this.tasks.get(task);
    if (!s || !s.pendingApproval) return { step: this.step(task), change: "none" };
    s.pendingApproval = false;
    s.step = 3;
    s.streak = 0;
    s.sinceAudit = 0;
    return { step: 3, change: "promoted" };
  }

  reset(task: string): void {
    this.tasks.delete(task);
  }

  export(): Record<string, TaskState> {
    return Object.fromEntries([...this.tasks].map(([k, v]) => [k, { ...v, effects: [...v.effects] }]));
  }

  import(data: Record<string, TaskState>): void {
    this.tasks.clear();
    for (const [k, v] of Object.entries(data)) this.tasks.set(k, { ...v, effects: [...v.effects] });
  }

  private demote(s: TaskState): LadderResult {
    const before = s.step;
    s.step = Math.max(0, s.step - 1) as Step;
    s.streak = 0;
    s.pendingApproval = false;
    s.sinceAudit = 0;
    return { step: s.step, change: before === s.step ? "none" : "demoted" };
  }
}
