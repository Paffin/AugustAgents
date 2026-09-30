import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { defaultConfig } from "./config-fixture.ts";

// Public configuration boundary regressions; no model or owner credential access.
describe("owner budget configuration", () => {
  test("optional policy resolves an explicit owner timezone without inventing limits or prices", () => {
    const config = defaultConfig("/owned-budget-config-fixture");
    expect(parseConfig(config).budgets).toBeUndefined();
    expect(parseConfig({ ...config, budgets: {} }).budgets).toEqual({ timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone });
    const budgets = { timeZone: "Asia/Kathmandu", daily: { tokens: 0, costMicros: Number.MAX_SAFE_INTEGER }, tools: { "writer.create_file": { calls: 0, tokens: 12, costMicros: 34, callCostMicros: 0 }, "fs.read": {} } };
    const parsed = parseConfig({ ...config, budgets }).budgets!;
    expect(parsed.timeZone).toBe(new Intl.DateTimeFormat("en", { timeZone: budgets.timeZone }).resolvedOptions().timeZone);
    expect(parsed.daily).toEqual(budgets.daily); expect(parsed.tools).toEqual(budgets.tools);
    expect(parsed.tools?.["fs.read"]?.callCostMicros).toBeUndefined();
    expect(parseConfig({ ...config, budgets: { tools: { "writer..metadata": { calls: 1 } } } }).budgets?.tools?.["writer..metadata"]?.calls).toBe(1);
    budgets.tools["writer.create_file"].calls = 99;
    expect(parsed.tools?.["writer.create_file"]?.calls).toBe(0);
  });

  test("rejects invalid zones, unexpected keys, wildcard identities and unsafe numeric allowances", () => {
    const config = defaultConfig("/owned-budget-config-fixture");
    for (const budgets of [null, [], "daily", { timeZone: "not-a-timezone" }, { timeZone: " UTC " }, { timeZone: 7 }, { typo: 1 }, { daily: null }, { daily: [] }, { daily: { calls: 3 } }, { tools: [] }, { tools: { "writer.*": {} } }, { tools: { " writer.create_file": {} } }, { tools: { "writer": {} } }, { tools: { "fs.read": { vendorFee: 0 } } }]) expect(() => parseConfig({ ...config, budgets })).toThrow();
    for (const invalid of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10", null]) {
      for (const key of ["tokens", "costMicros"]) expect(() => parseConfig({ ...config, budgets: { daily: { [key]: invalid } } })).toThrow();
      for (const key of ["calls", "tokens", "costMicros", "callCostMicros"]) expect(() => parseConfig({ ...config, budgets: { tools: { "fs.read": { [key]: invalid } } } })).toThrow();
    }
  });
});
