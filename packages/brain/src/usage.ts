import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatMessage, CompleteOptions, LlmProvider } from "./llm.ts";

/** Usage exactly as the provider reported it, priced with the configured rates. */
export interface TokenUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Millionths of `currency`. Absent when no pricing is configured for the provider. */
  costMicros?: number;
  currency?: string;
}

/** Price per million tokens, in millionths of `currency` (so 1 USD = 1_000_000). */
export interface Pricing {
  currency: string;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
}

/** Rounded up: a bill is never under-counted. */
export function priceUsage(pricing: Pricing, inputTokens: number, outputTokens: number): number {
  const micros = (BigInt(inputTokens) * BigInt(pricing.inputMicrosPerMillionTokens) + BigInt(outputTokens) * BigInt(pricing.outputMicrosPerMillionTokens) + 999_999n) / 1_000_000n;
  return Number(micros);
}

export type BudgetDimension = "tokens" | "cost";

export class BudgetExceededError extends Error {
  constructor(public readonly dimension: BudgetDimension, public readonly used: number, public readonly limit: number) {
    super(`${dimension} budget exceeded (${used}/${limit})`);
    this.name = "BudgetExceededError";
  }
}

/** A budget is active but the provider did not report what a call used, so it cannot be enforced. */
export class UsageUnavailableError extends Error {
  constructor(public readonly missing: "usage" | "pricing") {
    super(missing === "usage" ? "provider did not report token usage while a usage budget is active" : "provider usage has no price while a cost budget is active");
    this.name = "UsageUnavailableError";
  }
}

export interface UsageTotals { inputTokens: number; outputTokens: number; costMicros: number; calls: number; unreportedCalls: number }
export interface UsageLimits { maxTokens?: number; maxCostMicros?: number }

export interface RunMeterOptions {
  limits: UsageLimits;
  /** What earlier segments of the same run already used (pause/resume, restart). */
  totals?: UsageTotals;
  /** Durable append; must succeed before the run continues. */
  persist(usage: TokenUsage): void;
  persistUnreported(provider: string): void;
}

/**
 * Per-run accounting. `admit` runs before a provider call and refuses once a
 * limit is spent; `record` runs after and stops the run on the call that
 * crosses a limit. A single call can overshoot by its own size: providers do
 * not allow a hard cap on prompt tokens, so the completion is clamped and the
 * rest is bounded by refusing the next call.
 */
export class RunMeter {
  private readonly state: UsageTotals;

  constructor(private readonly options: RunMeterOptions) {
    this.state = { ...(options.totals ?? { inputTokens: 0, outputTokens: 0, costMicros: 0, calls: 0, unreportedCalls: 0 }) };
  }

  get totals(): UsageTotals { return { ...this.state }; }
  get limited(): boolean { return this.options.limits.maxTokens !== undefined || this.options.limits.maxCostMicros !== undefined; }

  /** Tokens left for the next completion, or undefined when tokens are not limited. */
  admit(): { remainingTokens?: number } {
    const { maxTokens, maxCostMicros } = this.options.limits;
    const tokens = this.state.inputTokens + this.state.outputTokens;
    if (maxTokens !== undefined && tokens >= maxTokens) throw new BudgetExceededError("tokens", tokens, maxTokens);
    if (maxCostMicros !== undefined && this.state.costMicros >= maxCostMicros) throw new BudgetExceededError("cost", this.state.costMicros, maxCostMicros);
    return maxTokens === undefined ? {} : { remainingTokens: maxTokens - tokens };
  }

  record(usage: TokenUsage): void {
    const { maxTokens, maxCostMicros } = this.options.limits;
    if (maxCostMicros !== undefined && usage.costMicros === undefined) {
      // Count the tokens that were spent, then refuse to go on unpriced.
      this.options.persist(usage); this.add(usage);
      throw new UsageUnavailableError("pricing");
    }
    this.options.persist(usage); this.add(usage);
    const tokens = this.state.inputTokens + this.state.outputTokens;
    if (maxTokens !== undefined && tokens > maxTokens) throw new BudgetExceededError("tokens", tokens, maxTokens);
    if (maxCostMicros !== undefined && this.state.costMicros > maxCostMicros) throw new BudgetExceededError("cost", this.state.costMicros, maxCostMicros);
  }

  recordUnreported(provider: string): void {
    this.options.persistUnreported(provider); this.state.calls += 1; this.state.unreportedCalls += 1;
    if (this.limited) throw new UsageUnavailableError("usage");
  }

  private add(usage: TokenUsage): void {
    this.state.inputTokens += usage.inputTokens; this.state.outputTokens += usage.outputTokens; this.state.costMicros += usage.costMicros ?? 0; this.state.calls += 1;
  }
}

const scope = new AsyncLocalStorage<RunMeter>();

/** Every provider call made inside `fn` (however deep) is metered against `meter`. */
export function withUsageMeter<T>(meter: RunMeter, fn: () => T): T {
  return scope.run(meter, fn);
}

/**
 * Wraps the provider once at the composition root. Inside a metered scope it
 * enforces the run's limits and records what the provider reports; outside one
 * it is a pass-through. Usage is recorded here, after the provider returns,
 * because FallbackProvider would swallow a budget error thrown from a callback.
 */
export class MeteredProvider implements LlmProvider {
  constructor(private readonly inner: LlmProvider) {}
  get name(): string { return this.inner.name; }

  async complete(messages: readonly ChatMessage[], options: CompleteOptions = {}): Promise<string> {
    const meter = scope.getStore();
    if (!meter) return this.inner.complete(messages, options);
    const { remainingTokens } = meter.admit();
    const reported: TokenUsage[] = [];
    const maxTokens = remainingTokens === undefined ? options.maxTokens : Math.min(options.maxTokens ?? remainingTokens, remainingTokens);
    const text = await this.inner.complete(messages, { ...options, ...(maxTokens === undefined ? {} : { maxTokens }), onUsage: (usage) => { reported.push(usage); options.onUsage?.(usage); } });
    if (reported.length === 0) meter.recordUnreported(this.inner.name);
    for (const usage of reported) meter.record(usage);
    return text;
  }
}
