import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunUsageLedger } from "../src/index.ts";

// Suite category: Product behavior (usage accounting) and Safety/reliability invariants (no estimated figures, durable across restart).
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDb = () => { const dir = mkdtempSync(join(tmpdir(), "august-usage-")); dirs.push(dir); return join(dir, "usage.db"); };

describe("RunUsageLedger", () => {
  test("totals sum reported calls per run and survive a restart with owner-only permissions", () => {
    const path = tempDb(); let ledger = new RunUsageLedger(path);
    ledger.append("r1", { provider: "p", model: "m", inputTokens: 100, outputTokens: 20, costMicros: 300, currency: "USD" }, 1);
    ledger.append("r1", { provider: "p", model: "m", inputTokens: 50, outputTokens: 5, costMicros: 120, currency: "USD" }, 2);
    ledger.append("r2", { provider: "p", model: "m", inputTokens: 7, outputTokens: 1 }, 3);
    ledger.close(); ledger = new RunUsageLedger(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ledger.totals("r1")).toEqual({ inputTokens: 150, outputTokens: 25, costMicros: 420, calls: 2, unreportedCalls: 0 });
    expect(ledger.totals("r2")).toEqual({ inputTokens: 7, outputTokens: 1, costMicros: 0, calls: 1, unreportedCalls: 0 });
    expect(ledger.totals("none")).toEqual({ inputTokens: 0, outputTokens: 0, costMicros: 0, calls: 0, unreportedCalls: 0 });
    expect(ledger.entries("r1").map((e) => [e.inputTokens, e.costMicros, e.currency])).toEqual([[100, 300, "USD"], [50, 120, "USD"]]);
    expect(ledger.entries("r2")[0]).not.toHaveProperty("costMicros");
    ledger.close();
  });

  test("a call the provider did not report is counted as unreported and adds no tokens or money", () => {
    const ledger = new RunUsageLedger(); ledger.appendUnreported("r", "local");
    expect(ledger.totals("r")).toEqual({ inputTokens: 0, outputTokens: 0, costMicros: 0, calls: 1, unreportedCalls: 1 });
    expect(ledger.entries("r")[0]).toMatchObject({ reported: false, provider: "local" });
    ledger.close();
  });

  test("invalid figures are rejected and an unknown schema is refused", () => {
    const ledger = new RunUsageLedger();
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => ledger.append("r", { provider: "p", model: "m", inputTokens: bad, outputTokens: 0 })).toThrow(/invalid usage/);
    expect(() => ledger.append("r", { provider: "p", model: "m", inputTokens: 1, outputTokens: 0, costMicros: -1 })).toThrow(/invalid usage/);
    expect(ledger.totals("r").calls).toBe(0);
    ledger.close();
  });
});
