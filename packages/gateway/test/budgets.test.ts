import { describe, expect, test } from "bun:test";
import type { BudgetSnapshot } from "@august/core";
import { createGatewayHandler } from "../src/index.ts";

// Security/public-interface coverage; synthetic accounting metadata, not live budget acceptance.
describe("owner budget accounting route", () => {
  const token = "owned-budget-test-credential";
  const snapshot: BudgetSnapshot = { period: { key: "2026-09-30", timeZone: "UTC", startsAt: 1790726400000, endsAt: 1790812800000 }, daily: { tokens: 10, costMicros: 3, heldTokens: 20, heldCostMicros: 5, calls: 1, heldCalls: 1, unpricedCalls: 1, limits: { tokens: 100, costMicros: 50 }, remainingTokens: 70, remainingCostMicros: 42 }, tools: {} };
  const make = (budgets?: () => BudgetSnapshot) => createGatewayHandler({ hostname: "127.0.0.1", port: 7777, token, workspace: "owned", onMessage: async () => ({ reply: "unused" }), budgets });
  const request = (headers: Record<string, string> = {}, method = "GET", path = "/v1/budgets") => new Request("http://127.0.0.1:7777" + path, { method, headers: { host: "127.0.0.1:7777", authorization: `Bearer ${token}`, ...headers } });

  test("only authenticated same-origin owner requests read the authoritative snapshot", async () => {
    let calls = 0; const handler = make(() => { calls++; return snapshot; });
    expect((await handler(request({ authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await handler(request({ origin: "https://attacker.example" }))).status).toBe(403);
    expect((await handler(request({ host: "attacker.example" }))).status).toBe(421);
    expect((await handler(request({}, "GET", "/v1/budgets?token=private"))).status).toBe(400);
    expect((await handler(request({}, "POST"))).status).toBe(404); expect(calls).toBe(0);
    const response = await handler(request()); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(snapshot); expect(calls).toBe(1);
  });

  test("unwired and failing accounting do not invent availability or leak diagnostics", async () => {
    expect((await make()(request())).status).toBe(404);
    const response = await make(() => { throw Error("private owner pricing/credential diagnostic"); })(request());
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "budget accounting unavailable" });
  });
});
