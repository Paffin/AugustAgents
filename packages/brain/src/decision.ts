import { tokenize } from "@august/capabilities";
import { optionBucket, scriptOf, segmentId, temperatureFor, temperatureScale, type CalibrationTable, type SegmentKey } from "./calibration.ts";
import type { LlmUsageObserver } from "./usage.ts";

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
  onUsage?: LlmUsageObserver;
  requireUsage?: boolean;
  maxCompletionTokens?: number;
  beforeCall?: () => void;
  remainingTokens?: () => number;
}

export interface DecisionResult {
  choice: string;
  probs: Record<string, number>;
  confidence: number;
  /** Which calibration was applied: the segment it belongs to and how specific the fit was. Absent for engines that do not calibrate. */
  calibration?: { segment: string; level: string; temperature: number; /** Normalized probabilities before temperature scaling: what calibration is fitted on. */ raw: Record<string, number> };
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
export interface LayaPrediction {
  probs: Record<string, number>;
  /**
   * False when the backend only reported the winning option, not real
   * probabilities. Confidence is then unknown and set to `inexactConfidence`.
   */
  exact?: boolean;
}

export type LayaPredictFn = (request: LayaPredictRequest) => Promise<LayaPrediction>;

export interface LayaEngineOptions {
  /** One temperature for everything, used only where the table has nothing for the segment; 1 means uncalibrated. */
  temperature?: number;
  /** Segmented temperatures fitted from verified outcomes. Wins over `temperature` wherever it has a fit. */
  calibration?: CalibrationTable;
  /** Identity of the model weights. A calibration belongs to one engine; a new model starts uncalibrated. Default "laya". */
  engine?: string;
  maxStateChars?: number;
  /** Confidence reported for inexact (one-hot) answers. Default 0.5: below the usual threshold, so the LLM decides. */
  inexactConfidence?: number;
}

/** Wraps a Laya transport: clips the state, checks the answer, applies calibration. */
export class LayaEngine implements DecisionEngine {
  private readonly temperature: number;
  private readonly maxStateChars: number;
  private readonly inexactConfidence: number;
  private readonly engine: string;
  private table: CalibrationTable | undefined;

  constructor(private readonly predict: LayaPredictFn, options: LayaEngineOptions = {}) {
    this.temperature = options.temperature ?? 1;
    this.engine = options.engine ?? "laya";
    this.table = options.calibration;
    this.maxStateChars = options.maxStateChars ?? DEFAULT_STATE_CHARS;
    this.inexactConfidence = options.inexactConfidence ?? 0.5;
  }

  /** Swap in a newly fitted table without restarting. */
  setCalibration(table: CalibrationTable | undefined): void {
    this.table = table;
  }

  /** The segment a decision belongs to, for calibration and for recording. */
  segmentOf(input: DecisionInput, question: DecisionQuestion): SegmentKey {
    return { question: question.id, options: optionBucket(question.options.length), script: scriptOf(input.state), engine: this.engine };
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
    const segment = this.segmentOf(input, question);
    const fitted = temperatureFor(this.table, segment);
    const temperature = fitted.level === "none" ? this.temperature : fitted.temperature;
    const normalized = ordered.map((p) => p / total);
    const scaled = temperatureScale(normalized, temperature);
    const rawProbs: Record<string, number> = {};
    keys.forEach((k, i) => (rawProbs[k] = normalized[i] ?? 0));
    const probs: Record<string, number> = {};
    keys.forEach((k, i) => (probs[k] = scaled[i] ?? 0));
    const top = argmax(probs, keys);
    return { choice: top.key, probs, confidence: raw.exact === false ? this.inexactConfidence : top.p, calibration: { segment: segmentId(segment), level: fitted.level === "none" ? (this.temperature === 1 ? "none" : "global") : fitted.level, temperature, raw: rawProbs } };
  }
}

export class LayaTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayaTransportError";
  }
}

export interface LayaHttpOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Transport to the Laya sidecar (sidecar/laya_server.py). The state holds the
 * person's private text, so only a sidecar on this machine is accepted.
 */
export function layaHttpTransport(url: string, options: LayaHttpOptions = {}): LayaPredictFn {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new LayaTransportError("invalid Laya sidecar address"); }
  if (!["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new LayaTransportError("the Laya sidecar must run on this machine (127.0.0.1)");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new LayaTransportError("the Laya sidecar address must not contain credentials, query or fragment");
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/predict`;
  const endpoint = parsed.href;
  const fetchFn = options.fetch ?? fetch;
  return async ({ state, question }) => {
    let response: Response;
    try {
      response = await fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        body: JSON.stringify({
          state,
          question: { id: question.id, instructions: question.instructions, options: question.options },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
    } catch (error) {
      throw new LayaTransportError(`Laya sidecar unreachable (${(error as Error).name})`);
    }
    if (!response.ok) throw new LayaTransportError(`Laya sidecar HTTP ${response.status}`);
    const body = (await response.json()) as { probs?: unknown; exact?: unknown };
    if (!body.probs || typeof body.probs !== "object") throw new LayaTransportError("Laya sidecar reply has no probs");
    return { probs: body.probs as Record<string, number>, exact: body.exact !== false };
  };
}
