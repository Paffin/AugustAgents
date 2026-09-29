import {
  DecisionError,
  LAYA_HEAD_TOKEN_BUDGET,
  LAYA_MAX_OPTIONS,
  estimateTokens,
  withNoneOption,
  type DecisionEngine,
  type DecisionInput,
  type DecisionOption,
  type DecisionQuestion,
  type DecisionResult,
} from "./decision.ts";
import { LlmUsageError, LlmUsageObserverError } from "./llm.ts";

export type DecisionSource = "primary" | "fallback";

export interface CascadeDecision extends DecisionResult {
  source: DecisionSource;
  /** Why the fallback was used, when it was. */
  reason?: "low-confidence" | "primary-error" | "shadow";
  /** What the primary (Laya) said, even when the fallback answered: recorded so it can later be scored against the verified outcome. */
  primary?: DecisionResult;
}

/**
 * Evidence that the primary is right on verified outcomes, produced by the learning package. Agreement with
 * the LLM is not evidence: it measures imitation, not correctness (DEC-0004).
 */
export interface ActivationEvidence {
  source: "verified-outcomes";
  ready: boolean;
  /** Question types the evidence covers; activation applies to the cascade as a whole, so every one of them must have passed. */
  questions: readonly string[];
  samples: number;
  evaluatedAt: number;
  /** Why not, when not ready. */
  reasons: readonly string[];
}

/** One decision the fallback (LLM) made for the primary (Laya) to learn from later. */
export interface DecisionRecord {
  questionId: string;
  state: string;
  options: readonly DecisionOption[];
  primaryChoice?: string;
  primaryConfidence?: number;
  /** Primary probabilities in option order, for calibration. */
  primaryProbs?: number[];
  fallbackChoice: string;
  at: number;
}

export interface DecisionLog {
  record(entry: DecisionRecord): void | Promise<void>;
}

export class InMemoryDecisionLog implements DecisionLog {
  readonly entries: DecisionRecord[] = [];
  record(entry: DecisionRecord): void {
    this.entries.push(entry);
  }
}

export interface CascadeStats {
  total: number;
  primaryAnswers: number;
  fallbackAnswers: number;
  primaryErrors: number;
  shadowSamples: number;
  shadowAgreements: number;
  /** Agreement of the primary with the fallback in shadow mode; 0 with no samples. Shadow diagnostics only: it is not a reason to activate. */
  agreementRate: number;
}

export interface CascadeOptions {
  primary: DecisionEngine;
  fallback: DecisionEngine;
  /** Minimum (calibrated) primary confidence to answer without the fallback. */
  threshold?: number;
  /** Ask both, act on the fallback, and measure how often the primary agrees. */
  shadow?: boolean;
  log?: DecisionLog;
  now?: () => number;
}

/**
 * Laya answers when it is sure; otherwise the LLM does. Every fallback
 * answer is logged as a training pair, except when the state holds
 * untrusted text: a poisoned example would teach the model the injection.
 */
export class DecisionCascade implements DecisionEngine {
  private readonly threshold: number;
  private shadow: boolean;
  private readonly now: () => number;
  private readonly counters = {
    total: 0,
    primaryAnswers: 0,
    fallbackAnswers: 0,
    primaryErrors: 0,
    shadowSamples: 0,
    shadowAgreements: 0,
  };

  constructor(private readonly options: CascadeOptions) {
    this.threshold = options.threshold ?? 0.7;
    this.shadow = options.shadow ?? false;
    this.now = options.now ?? Date.now;
  }

  /** Continue counting from saved stats (they survive restarts). */
  restore(stats: Partial<CascadeStats>): void {
    for (const key of Object.keys(this.counters) as Array<keyof typeof this.counters>) {
      const v = stats[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) this.counters[key] = v;
    }
  }

  get shadowMode(): boolean {
    return this.shadow;
  }

  stats(): CascadeStats {
    const c = this.counters;
    return { ...c, agreementRate: c.shadowSamples === 0 ? 0 : c.shadowAgreements / c.shadowSamples };
  }

  /**
   * Leave shadow mode. Requires outcome evidence that says ready, or an explicit `force` (the owner overriding
   * the evidence, which callers must record). Agreement with the LLM never qualifies.
   */
  activate(evidence?: ActivationEvidence, force = false): void {
    if (!force && !(evidence && evidence.source === "verified-outcomes" && evidence.ready && evidence.questions.length > 0)) {
      throw new DecisionError(`not enough verified outcomes to let the primary decide alone${evidence?.reasons.length ? `: ${evidence.reasons.join("; ")}` : ""}`);
    }
    this.shadow = false;
  }

  async decide(input: DecisionInput, question: DecisionQuestion): Promise<CascadeDecision> {
    input.signal?.throwIfAborted();
    this.counters.total += 1;
    let primary: DecisionResult | undefined;
    try {
      primary = await this.options.primary.decide(input, question);
    } catch (error) {
      if (error instanceof LlmUsageError || error instanceof LlmUsageObserverError) throw error;
      input.signal?.throwIfAborted();
      this.counters.primaryErrors += 1;
    }
    input.signal?.throwIfAborted();

    if (primary && !this.shadow && primary.confidence >= this.threshold) {
      this.counters.primaryAnswers += 1;
      return { ...primary, source: "primary", primary };
    }

    const fallback = await this.options.fallback.decide(input, question);
    this.counters.fallbackAnswers += 1;

    if (this.shadow && primary) {
      this.counters.shadowSamples += 1;
      if (primary.choice === fallback.choice) this.counters.shadowAgreements += 1;
    }
    await this.remember(input, question, primary, fallback);

    const reason = !primary ? "primary-error" : this.shadow ? "shadow" : "low-confidence";
    return { ...fallback, source: "fallback", reason, ...(primary ? { primary } : {}) };
  }

  private async remember(
    input: DecisionInput,
    question: DecisionQuestion,
    primary: DecisionResult | undefined,
    fallback: DecisionResult,
  ): Promise<void> {
    if (!this.options.log || input.tainted) return;
    await this.options.log.record({
      questionId: question.id,
      state: input.state,
      options: question.options,
      primaryChoice: primary?.choice,
      primaryConfidence: primary?.confidence,
      primaryProbs: primary ? question.options.map((o) => primary.probs[o.key] ?? 0) : undefined,
      fallbackChoice: fallback.choice,
      at: this.now(),
    });
  }
}

export interface ToolCandidate {
  name: string;
  description: string;
}

export interface ToolChoice {
  /** The chosen tool, or null when "none" won: the request needs no tool. */
  tool: string | null;
  decision: CascadeDecision;
}

const TOOL_DESCRIPTION_CHARS = 120;

/**
 * The best-ranked prefix of a shortlist that fits Laya's question head. A long tool description, or many tools,
 * would otherwise make the whole decision fail; the lowest-ranked tools are the ones left out.
 */
export function fitShortlist<T extends ToolCandidate>(shortlist: readonly T[], instructions: string): T[] {
  const kept: T[] = [];
  for (const t of shortlist) {
    const next = [...kept, t];
    const head = instructions + [...next.map((c) => `${c.name} ${c.description.slice(0, TOOL_DESCRIPTION_CHARS)}`), "none none of the above fits"].join(" ");
    if (next.length + 1 > LAYA_MAX_OPTIONS || estimateTokens(head) > LAYA_HEAD_TOKEN_BUDGET) break;
    kept.push(t);
  }
  return kept;
}

/** Turns a shortlist into a Laya question with a "none" escape and asks the cascade. */
export async function chooseTool(
  engine: DecisionEngine,
  shortlist: readonly ToolCandidate[],
  input: DecisionInput,
  instructions = "Which tool should handle the request? Choose none if no tool is needed.",
): Promise<ToolChoice> {
  const options = withNoneOption(
    shortlist.map((t) => ({ key: t.name, description: t.description.slice(0, TOOL_DESCRIPTION_CHARS) })),
  );
  if (options.length < 2) {
    // Empty shortlist: nothing to pick from, and nothing to ask the model.
    return { tool: null, decision: { choice: "none", probs: { none: 1 }, confidence: 1, source: "primary" } };
  }
  const decision = await engine.decide(input, { id: "tool-choice", instructions, options });
  return { tool: decision.choice === "none" ? null : decision.choice, decision: decision as CascadeDecision };
}
