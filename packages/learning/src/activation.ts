import { expectedCalibrationError, optionBucket, scriptOf, type ActivationEvidence, type SegmentedSample } from "@august/brain";
import type { TrainingExample } from "./types.ts";

/** Lower bound of the 95% Wilson interval for a proportion: how good it is, allowing for how little was measured. */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = successes / n; const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/** The engine a Laya decision came from, read from its recorded calibration segment (`engine=<id>|...`). */
export function engineOf(example: TrainingExample): string | undefined {
  return /^engine=([^|]+)/.exec(example.primary?.calibration?.segment ?? "")?.[1];
}

/**
 * Calibration samples: only decisions whose chosen option is verified correct, with Laya's probabilities from
 * before any temperature was applied. Failures and the LLM's mere choice are not labels.
 */
export function calibrationSamples(examples: readonly TrainingExample[], engine: string): SegmentedSample[] {
  const out: SegmentedSample[] = [];
  for (const e of examples) {
    const cal = e.primary?.calibration;
    if (e.label.kind !== "chosen-worked" || !cal || engineOf(e) !== engine) continue;
    const keys = e.options.map((o) => o.key);
    const correct = keys.indexOf(e.label.key);
    const probs = keys.map((k) => cal.raw[k]);
    if (correct < 0 || probs.some((p) => typeof p !== "number")) continue;
    out.push({ probs: probs as number[], correct, segment: { question: e.questionId, options: optionBucket(keys.length), script: scriptOf(e.state), engine } });
  }
  return out;
}

export interface QuestionMetrics {
  questionId: string;
  /** Verified-correct decisions where Laya's answer was recorded. */
  samples: number;
  /** Of those, how often Laya's calibrated top choice was the option that verifiably worked. */
  accuracy: number;
  accuracyLowerBound: number;
  /** Expected calibration error of Laya's calibrated confidence against those outcomes. */
  ece: number;
  /** How often the option that was actually taken (by whoever chose) verifiably worked. The bar Laya has to clear. */
  actedSuccessRate: number | null;
  passed: boolean;
  reasons: string[];
}

export interface ActivationOptions {
  /** Default 200. */
  minSamples?: number;
  /** The accuracy the lower bound must reach. Default 0.9. */
  minAccuracy?: number;
  /** Default 0.1. */
  maxEce?: number;
  now?: () => number;
}

export interface ActivationReport extends ActivationEvidence {
  perQuestion: QuestionMetrics[];
}

/**
 * Whether Laya may decide alone, judged only by verified outcomes. For each question type in use it must have
 * been shown the choices that verifiably worked at least `minSamples` times, picked them with a 95%-confidence
 * accuracy of at least `minAccuracy`, and be calibrated. Agreement with the LLM is not consulted.
 */
export function evaluateActivation(examples: readonly TrainingExample[], options: ActivationOptions = {}): ActivationReport {
  const minSamples = options.minSamples ?? 200; const minAccuracy = options.minAccuracy ?? 0.9; const maxEce = options.maxEce ?? 0.1;
  const questions = [...new Set(examples.map((e) => e.questionId))].sort();
  const perQuestion: QuestionMetrics[] = questions.map((questionId) => {
    const mine = examples.filter((e) => e.questionId === questionId);
    const worked = mine.filter((e) => e.label.kind === "chosen-worked");
    const scored = worked.filter((e) => e.primary?.calibration?.raw);
    const hits = scored.filter((e) => e.primary!.choice === (e.label as { key: string }).key).length;
    const samples = scored.length;
    const accuracy = samples ? hits / samples : 0;
    const lower = wilsonLowerBound(hits, samples);
    const ece = expectedCalibrationError(scored.map((e) => ({ probs: e.options.map((o) => e.primary!.probs[o.key] ?? 0), correct: e.options.findIndex((o) => o.key === (e.label as { key: string }).key) })).filter((s) => s.correct >= 0), 1);
    const reasons: string[] = [];
    if (samples < minSamples) reasons.push(`${questionId}: only ${samples} verified examples with Laya's answer (need ${minSamples})`);
    if (samples >= minSamples && lower < minAccuracy) reasons.push(`${questionId}: accuracy ${(accuracy * 100).toFixed(1)}% (lower bound ${(lower * 100).toFixed(1)}%) is below ${(minAccuracy * 100).toFixed(0)}%`);
    if (samples >= minSamples && ece > maxEce) reasons.push(`${questionId}: calibration error ${ece.toFixed(3)} is above ${maxEce}`);
    return { questionId, samples, accuracy, accuracyLowerBound: lower, ece, actedSuccessRate: mine.length ? worked.length / mine.length : null, passed: reasons.length === 0, reasons };
  });
  const reasons = perQuestion.flatMap((q) => q.reasons);
  if (questions.length === 0) reasons.push("no verified examples yet");
  return {
    source: "verified-outcomes", ready: questions.length > 0 && perQuestion.every((q) => q.passed), questions, samples: perQuestion.reduce((n, q) => n + q.samples, 0),
    evaluatedAt: (options.now ?? Date.now)(), reasons, perQuestion,
  };
}
