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
