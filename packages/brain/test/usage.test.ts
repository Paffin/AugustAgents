import { describe, expect, test } from "bun:test";
import {
  BudgetExceededError,
  FallbackProvider,
  MeteredProvider,
  OpenAiCompatibleProvider,
  RunMeter,
  UsageUnavailableError,
  priceUsage,
  withUsageMeter,
  type CompleteOptions,
  type LlmProvider,
  type TokenUsage,
} from "../src/index.ts";

// Suite category: Product behavior (usage/pricing accounting) and Safety/reliability invariants (limits stop the run, nothing is estimated).

const reply = (usage: unknown, content = "ok") => new Response(JSON.stringify({ choices: [{ message: { content } }], ...(usage === undefined ? {} : { usage }) }));
const provider = (usage: unknown, pricing?: ConstructorParameters<typeof OpenAiCompatibleProvider>[0]["pricing"]) =>
  new OpenAiCompatibleProvider({ baseUrl: "http://127.0.0.1:1/v1", model: "m1", name: "p1", pricing, fetch: (async () => reply(usage)) as unknown as typeof fetch });

function meter(limits: { maxTokens?: number; maxCostMicros?: number }, seen: { usage: TokenUsage[]; unreported: string[] } = { usage: [], unreported: [] }) {
  return { seen, meter: new RunMeter({ limits, persist: (u) => seen.usage.push(u), persistUnreported: (p) => seen.unreported.push(p) }) };
}
/** A provider that reports a fixed usage and remembers what it was asked. */
function scripted(input: number, output: number, costMicros?: number, calls: CompleteOptions[] = []): LlmProvider {
  return { name: "scripted", complete: async (_m, o = {}) => { calls.push(o); o.onUsage?.({ provider: "scripted", model: "s", inputTokens: input, outputTokens: output, ...(costMicros === undefined ? {} : { costMicros, currency: "USD" }) }); return "text"; } };
}

describe("priceUsage", () => {
  test("prices per million tokens and rounds up so a bill is never under-counted", () => {
    const pricing = { currency: "USD", inputMicrosPerMillionTokens: 150_000, outputMicrosPerMillionTokens: 600_000 };
    expect(priceUsage(pricing, 1_000_000, 1_000_000)).toBe(750_000);
    expect(priceUsage(pricing, 1, 0)).toBe(1);
    expect(priceUsage(pricing, 0, 0)).toBe(0);
    expect(priceUsage({ ...pricing, inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 }, 5000, 5000)).toBe(0);
  });
});

describe("OpenAiCompatibleProvider usage reporting", () => {
  test("reports the provider's own figures with a computed cost", async () => {
    const seen: TokenUsage[] = [];
    await provider({ prompt_tokens: 1200, completion_tokens: 300 }, { currency: "USD", inputMicrosPerMillionTokens: 150_000, outputMicrosPerMillionTokens: 600_000 }).complete([{ role: "user", content: "hi" }], { onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([{ provider: "p1", model: "m1", inputTokens: 1200, outputTokens: 300, costMicros: 360, currency: "USD" }]);
  });

  test("without pricing only tokens are reported", async () => {
    const seen: TokenUsage[] = [];
    await provider({ prompt_tokens: 3, completion_tokens: 4 }).complete([{ role: "user", content: "hi" }], { onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([{ provider: "p1", model: "m1", inputTokens: 3, outputTokens: 4 }]);
  });

  test("missing or malformed usage is never guessed", async () => {
    for (const usage of [undefined, {}, { prompt_tokens: "12", completion_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: 1.5, completion_tokens: 1 }, { prompt_tokens: 1 }]) {
      const seen: TokenUsage[] = [];
      await provider(usage).complete([{ role: "user", content: "hi" }], { onUsage: (u) => seen.push(u) });
      expect(seen).toEqual([]);
    }
  });
});

describe("MeteredProvider and RunMeter", () => {
  test("outside a metered scope it is a pass-through", async () => {
    const calls: CompleteOptions[] = [];
    expect(await new MeteredProvider(scripted(1, 1, undefined, calls)).complete([{ role: "user", content: "x" }])).toBe("text");
    expect(calls[0]!.maxTokens).toBeUndefined();
  });

  test("records every reported call and accumulates totals, including earlier segments of the run", async () => {
    const { meter: m, seen } = meter({});
    const metered = new MeteredProvider(scripted(10, 5, 30));
    await withUsageMeter(m, async () => { await metered.complete([{ role: "user", content: "a" }]); await metered.complete([{ role: "user", content: "b" }]); });
    expect(seen.usage).toHaveLength(2);
    expect(m.totals).toEqual({ inputTokens: 20, outputTokens: 10, costMicros: 60, calls: 2, unreportedCalls: 0 });
    const resumed = new RunMeter({ limits: {}, totals: m.totals, persist: () => {}, persistUnreported: () => {} });
    await withUsageMeter(resumed, () => metered.complete([{ role: "user", content: "c" }]));
    expect(resumed.totals.inputTokens).toBe(30);
  });

  test("the call that crosses the token limit stops the run and the next call is refused before it reaches the provider", async () => {
    const calls: CompleteOptions[] = []; const { meter: m } = meter({ maxTokens: 100 });
    const metered = new MeteredProvider(scripted(80, 40, undefined, calls));
    await withUsageMeter(m, async () => {
      await expect(metered.complete([{ role: "user", content: "a" }])).rejects.toMatchObject({ name: "BudgetExceededError", dimension: "tokens", used: 120, limit: 100 });
      await expect(metered.complete([{ role: "user", content: "b" }])).rejects.toBeInstanceOf(BudgetExceededError);
    });
    expect(calls).toHaveLength(1);
  });

  test("the completion is clamped to the tokens that remain", async () => {
    const calls: CompleteOptions[] = []; const { meter: m } = meter({ maxTokens: 1000 }, undefined);
    const metered = new MeteredProvider(scripted(100, 100, undefined, calls));
    await withUsageMeter(m, async () => { await metered.complete([{ role: "user", content: "a" }]); await metered.complete([{ role: "user", content: "b" }], { maxTokens: 5000 }); await metered.complete([{ role: "user", content: "c" }], { maxTokens: 50 }); });
    expect(calls.map((c) => c.maxTokens)).toEqual([1000, 800, 50]);
  });

  test("the monetary limit stops the run, and an unpriced call cannot be enforced against it", async () => {
    const { meter: m } = meter({ maxCostMicros: 100 });
    await withUsageMeter(m, () => expect(new MeteredProvider(scripted(1, 1, 150)).complete([{ role: "user", content: "a" }])).rejects.toMatchObject({ dimension: "cost", used: 150, limit: 100 }));
    const { meter: unpriced, seen } = meter({ maxCostMicros: 100 });
    await withUsageMeter(unpriced, () => expect(new MeteredProvider(scripted(4, 4)).complete([{ role: "user", content: "a" }])).rejects.toBeInstanceOf(UsageUnavailableError));
    expect(seen.usage).toHaveLength(1);
    expect(unpriced.totals.inputTokens).toBe(4);
  });

  test("a provider that does not report usage is recorded as unreported, and fails closed only when a limit is active", async () => {
    const silent: LlmProvider = { name: "silent", complete: async () => "text" };
    const free = meter({});
    await withUsageMeter(free.meter, () => new MeteredProvider(silent).complete([{ role: "user", content: "a" }]));
    expect(free.seen.unreported).toEqual(["silent"]); expect(free.meter.totals).toMatchObject({ calls: 1, unreportedCalls: 1, inputTokens: 0 });
    const limited = meter({ maxTokens: 10 });
    await withUsageMeter(limited.meter, () => expect(new MeteredProvider(silent).complete([{ role: "user", content: "a" }])).rejects.toMatchObject({ name: "UsageUnavailableError", missing: "usage" }));
  });

  test("a fallback chain cannot swallow a budget stop by trying another provider", async () => {
    let secondCalled = false;
    const second: LlmProvider = { name: "second", complete: async () => { secondCalled = true; return "cheap"; } };
    const chain = new MeteredProvider(new FallbackProvider([scripted(500, 500), second]));
    const { meter: m } = meter({ maxTokens: 10 });
    await withUsageMeter(m, () => expect(chain.complete([{ role: "user", content: "a" }])).rejects.toBeInstanceOf(BudgetExceededError));
    expect(secondCalled).toBe(false);
  });

  test("concurrent runs are metered independently", async () => {
    const metered = new MeteredProvider(scripted(10, 0));
    const a = meter({ maxTokens: 15 }); const b = meter({});
    const run = (m: RunMeter, n: number) => withUsageMeter(m, async () => { for (let i = 0; i < n; i++) { await Promise.resolve(); await metered.complete([{ role: "user", content: "x" }]); } });
    const [ra, rb] = await Promise.allSettled([run(a.meter, 3), run(b.meter, 3)]);
    expect(ra.status).toBe("rejected"); expect(rb.status).toBe("fulfilled");
    expect(a.meter.totals.calls).toBe(2); expect(b.meter.totals.calls).toBe(3);
  });
});
