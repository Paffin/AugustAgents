import { tokenize } from "@august/capabilities";
import { temperatureScale } from "./calibration.ts";

/** Laya reads `choice` questions best with at most this many options. */
export const LAYA_MAX_OPTIONS = 16;
/** Question text and options share a fixed ~256 token head budget in Laya. */
export const LAYA_HEAD_TOKEN_BUDGET = 256;
/** Keep the most recent part of the state; Laya reads 1024 tokens by default. */
export const DEFAULT_STATE_CHARS = 2400;

export interface DecisionOption {
  key: string;
  description: string;
}

export interface DecisionQuestion {
  id: string;
  instructions: string;
  options: readonly DecisionOption[];
}

export interface DecisionInput {
  state: string;
  /** The state contains text from an untrusted source. */
  tainted: boolean;
}

export interface DecisionResult {
  choice: string;
  probs: Record<string, number>;
  confidence: number;
}

export interface DecisionEngine {
  decide(input: DecisionInput, question: DecisionQuestion): Promise<DecisionResult>;
}

export class DecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionError";
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Only `choice` questions are supported: `score` is Laya's weakest primitive. */
export function validateQuestion(question: DecisionQuestion): void {
  const { options } = question;
  if (options.length < 2) throw new DecisionError(`question "${question.id}" needs at least 2 options`);
  if (options.length > LAYA_MAX_OPTIONS) {
    throw new DecisionError(`question "${question.id}" has ${options.length} options; shortlist to ${LAYA_MAX_OPTIONS} or fewer`);
  }
  const keys = new Set<string>();
  for (const o of options) {
    if (!o.key) throw new DecisionError(`question "${question.id}" has an empty option key`);
    if (keys.has(o.key)) throw new DecisionError(`question "${question.id}" repeats option key "${o.key}"`);
    keys.add(o.key);
  }
  const head = question.instructions + options.map((o) => `${o.key} ${o.description}`).join(" ");
  if (estimateTokens(head) > LAYA_HEAD_TOKEN_BUDGET) {
    throw new DecisionError(`question "${question.id}" is too long for Laya's ${LAYA_HEAD_TOKEN_BUDGET}-token head; shorten the option descriptions`);
  }
}

/** Adds the "none of these" option that lets a bad shortlist fail safely. */
export function withNoneOption(options: readonly DecisionOption[], description = "none of the above fits"): DecisionOption[] {
  return options.some((o) => o.key === "none") ? [...options] : [...options, { key: "none", description }];
}

export function clipState(state: string, maxChars = DEFAULT_STATE_CHARS): string {
  return state.length <= maxChars ? state : state.slice(state.length - maxChars);
}

function argmax(probs: Record<string, number>, keys: readonly string[]): { key: string; p: number } {
  let best = { key: keys[0]!, p: probs[keys[0]!] ?? 0 };
  for (const k of keys) {
    const p = probs[k] ?? 0;
    if (p > best.p) best = { key: k, p };
  }
  return best;
}

/** Word-overlap baseline. Stands in until a real Laya backend is wired; low confidence hands off to the LLM. */
export class HeuristicEngine implements DecisionEngine {
  async decide(input: DecisionInput, question: DecisionQuestion): Promise<DecisionResult> {
    validateQuestion(question);
    const stateTokens = new Set(tokenize(`${input.state} ${question.instructions}`));
    const keys = question.options.map((o) => o.key);
    const overlap = question.options.map((o) => {
      const tokens = new Set(tokenize(`${o.key.replace(/[._-]+/g, " ")} ${o.description}`));
      let n = 0;
      for (const t of tokens) if (stateTokens.has(t)) n += 1;
      return n / Math.max(1, tokens.size);
    });
    const exps = overlap.map((o) => Math.exp(3 * o));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs: Record<string, number> = {};
    keys.forEach((k, i) => (probs[k] = (exps[i] ?? 0) / sum));
    const top = argmax(probs, keys);
    return { choice: top.key, probs, confidence: top.p };
  }
}

export interface LayaPredictRequest {
  state: string;
  question: DecisionQuestion;
}

/** Transport to a real Laya model (ONNX in-process, MLX, or an HTTP sidecar). Returns raw probabilities per option key. */
export type LayaPredictFn = (request: LayaPredictRequest) => Promise<{ probs: Record<string, number> }>;

export interface LayaEngineOptions {
  /** Fitted with fitTemperature() on held-out data; 1 means uncalibrated. */
  temperature?: number;
  maxStateChars?: number;
}

/** Wraps a Laya transport: clips the state, checks the answer, applies calibration. */
export class LayaEngine implements DecisionEngine {
  private readonly temperature: number;
  private readonly maxStateChars: number;

  constructor(private readonly predict: LayaPredictFn, options: LayaEngineOptions = {}) {
    this.temperature = options.temperature ?? 1;
    this.maxStateChars = options.maxStateChars ?? DEFAULT_STATE_CHARS;
  }

  async decide(input: DecisionInput, question: DecisionQuestion): Promise<DecisionResult> {
    validateQuestion(question);
    const raw = await this.predict({ state: clipState(input.state, this.maxStateChars), question });
    const keys = question.options.map((o) => o.key);
    const ordered = keys.map((k) => {
      const p = raw.probs[k];
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0) {
        throw new DecisionError(`Laya returned no valid probability for option "${k}"`);
      }
      return p;
    });
    const total = ordered.reduce((a, b) => a + b, 0);
    if (total <= 0) throw new DecisionError("Laya returned all-zero probabilities");
    const scaled = temperatureScale(ordered.map((p) => p / total), this.temperature);
    const probs: Record<string, number> = {};
    keys.forEach((k, i) => (probs[k] = scaled[i] ?? 0));
    const top = argmax(probs, keys);
    return { choice: top.key, probs, confidence: top.p };
  }
}
