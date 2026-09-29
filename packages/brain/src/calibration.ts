export interface CalibrationSample {
  /** Model probabilities over the options, in option order. */
  probs: readonly number[];
  /** Index of the correct option. */
  correct: number;
}

/** Temperature scaling of a probability vector: p^(1/T), renormalised. */
export function temperatureScale(probs: readonly number[], temperature: number): number[] {
  if (!(temperature > 0)) throw new Error("temperature must be positive");
  const logits = probs.map((p) => Math.log(Math.max(p, 1e-12)) / temperature);
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/** Mean negative log-likelihood of the correct option. */
export function negativeLogLikelihood(samples: readonly CalibrationSample[], temperature: number): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const s of samples) {
    const scaled = temperatureScale(s.probs, temperature);
    total -= Math.log(Math.max(scaled[s.correct] ?? 0, 1e-12));
  }
  return total / samples.length;
}

/**
 * Fit one temperature on held-out data. Laya ships uncalibrated and
 * over-confident, so thresholds on its raw confidence mean little until this
 * has run on the user's own data.
 */
export function fitTemperature(samples: readonly CalibrationSample[]): number {
  if (samples.length === 0) return 1;
  let best = 1;
  let bestLoss = Infinity;
  for (let t = 0.25; t <= 6.0001; t += 0.05) {
    const loss = negativeLogLikelihood(samples, t);
    if (loss < bestLoss) {
      bestLoss = loss;
      best = t;
    }
  }
  return Math.round(best * 100) / 100;
}

/** Expected calibration error over `bins` equal-width confidence bins. */
export function expectedCalibrationError(samples: readonly CalibrationSample[], temperature = 1, bins = 10): number {
  if (samples.length === 0) return 0;
  const sums = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const s of samples) {
    const scaled = temperatureScale(s.probs, temperature);
    let top = 0;
    for (let i = 1; i < scaled.length; i++) if ((scaled[i] ?? 0) > (scaled[top] ?? 0)) top = i;
    const conf = scaled[top] ?? 0;
    const bin = sums[Math.min(bins - 1, Math.floor(conf * bins))]!;
    bin.n += 1;
    bin.conf += conf;
    bin.acc += top === s.correct ? 1 : 0;
  }
  let ece = 0;
  for (const b of sums) if (b.n) ece += (b.n / samples.length) * Math.abs(b.acc / b.n - b.conf / b.n);
  return ece;
}

// ---------------------------------------------------------------------------------------------
// Segmented calibration. Laya is over-confident in different ways on different questions, option
// counts and languages, and again after every weight update, so one temperature is not honest.
// Labels come only from verified outcomes (DEC-0004); the LLM's choice is never a label.
// ---------------------------------------------------------------------------------------------

export type Script = "latin" | "cyrillic" | "cjk" | "other";
export type OptionBucket = "2-4" | "5-8" | "9-16";

/** What a calibration is specific to. Two decisions with the same key are calibrated together. */
export interface SegmentKey {
  /** Question type, e.g. "tool-choice". */
  question: string;
  options: OptionBucket;
  /** Dominant script of the state text: languages are a segment because Laya is uneven across them. */
  script: Script;
  /** Model identity (weights version). A new model starts uncalibrated. */
  engine: string;
}

export function optionBucket(count: number): OptionBucket {
  return count <= 4 ? "2-4" : count <= 8 ? "5-8" : "9-16";
}

/** The dominant writing system among the letters of `text`. */
export function scriptOf(text: string): Script {
  const counts = { latin: 0, cyrillic: 0, cjk: 0, other: 0 };
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (!/\p{L}/u.test(ch)) continue;
    if ((c >= 0x41 && c <= 0x24f)) counts.latin += 1;
    else if (c >= 0x400 && c <= 0x52f) counts.cyrillic += 1;
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)) counts.cjk += 1;
    else counts.other += 1;
  }
  const top = (Object.entries(counts) as Array<[Script, number]>).sort((a, b) => b[1] - a[1])[0]!;
  return top[1] === 0 ? "latin" : top[0];
}

export const SEGMENT_LEVELS = ["exact", "question-options", "question", "engine"] as const;
export type SegmentLevel = (typeof SEGMENT_LEVELS)[number];

/** Key for a level: the exact segment, then progressively coarser groups to fall back on. */
export function segmentId(key: SegmentKey, level: SegmentLevel = "exact"): string {
  const parts = [`engine=${key.engine}`];
  if (level !== "engine") parts.push(`q=${key.question}`);
  if (level === "exact" || level === "question-options") parts.push(`opts=${key.options}`);
  if (level === "exact") parts.push(`script=${key.script}`);
  return parts.join("|");
}

export interface SegmentedSample extends CalibrationSample {
  segment: SegmentKey;
}

export interface SegmentFit {
  level: SegmentLevel;
  temperature: number;
  samples: number;
  /** Expected calibration error before (temperature 1) and after fitting, on the fitting data. */
  eceBefore: number;
  eceAfter: number;
}

export interface CalibrationTable {
  version: 1;
  engine: string;
  fittedAt: string;
  /** Segments with fewer samples than this are not fitted and use the next coarser level. */
  minSamples: number;
  fits: Record<string, SegmentFit>;
}

export interface FitTableOptions {
  engine: string;
  /** Default 30. */
  minSamples?: number;
  now?: () => number;
}

/** Fits a temperature for every segment, at every level, that has enough verified examples. Segments of other engines are ignored. */
export function fitCalibrationTable(samples: readonly SegmentedSample[], options: FitTableOptions): CalibrationTable {
  const minSamples = options.minSamples ?? 30;
  const groups = new Map<string, { level: SegmentLevel; samples: CalibrationSample[] }>();
  for (const sample of samples) {
    if (sample.segment.engine !== options.engine) continue;
    for (const level of SEGMENT_LEVELS) {
      const id = segmentId(sample.segment, level);
      const g = groups.get(id) ?? { level, samples: [] };
      g.samples.push({ probs: sample.probs, correct: sample.correct });
      groups.set(id, g);
    }
  }
  const fits: Record<string, SegmentFit> = {};
  for (const [id, g] of groups) {
    if (g.samples.length < minSamples) continue;
    const temperature = fitTemperature(g.samples);
    fits[id] = { level: g.level, temperature, samples: g.samples.length, eceBefore: expectedCalibrationError(g.samples, 1), eceAfter: expectedCalibrationError(g.samples, temperature) };
  }
  return { version: 1, engine: options.engine, fittedAt: new Date((options.now ?? Date.now)()).toISOString(), minSamples, fits };
}

/** The most specific fitted temperature for this segment, falling back level by level, and 1 (uncalibrated) when nothing applies. */
export function temperatureFor(table: CalibrationTable | undefined, key: SegmentKey): { temperature: number; level: SegmentLevel | "none"; segment: string } {
  if (table && table.engine === key.engine) {
    for (const level of SEGMENT_LEVELS) {
      const id = segmentId(key, level);
      const fit = table.fits[id];
      if (fit) return { temperature: fit.temperature, level, segment: id };
    }
  }
  return { temperature: 1, level: "none", segment: segmentId(key) };
}

/** A table read back from disk is checked field by field: a damaged one is refused, never half-applied. */
export function parseCalibrationTable(value: unknown): CalibrationTable {
  const t = value as Partial<CalibrationTable> | null;
  const bad = (): never => { throw new Error("invalid calibration table"); };
  if (!t || typeof t !== "object" || t.version !== 1 || typeof t.engine !== "string" || typeof t.fittedAt !== "string" || !Number.isInteger(t.minSamples) || (t.minSamples as number) < 1 || !t.fits || typeof t.fits !== "object") return bad();
  for (const [id, f] of Object.entries(t.fits)) {
    if (typeof id !== "string" || !f || !(SEGMENT_LEVELS as readonly string[]).includes(f.level) || !(f.temperature > 0) || !Number.isInteger(f.samples) || f.samples < 1 || !Number.isFinite(f.eceBefore) || !Number.isFinite(f.eceAfter)) return bad();
  }
  return t as CalibrationTable;
}
