import { describe, expect, test } from "bun:test";
import {
  GatewayConfigError,
  MAX_BODY_BYTES,
  assertSafeBind,
  createGatewayHandler,
  startGateway,
  tokensEqual,
  type GatewayOptions,
} from "../src/index.ts";

const TOKEN = "correct-horse-battery-staple";

function make(overrides: Partial<GatewayOptions> = {}) {
  const seen: Array<{ session: string; text: string }> = [];
  const handler = createGatewayHandler({
    hostname: "127.0.0.1",
    port: 7777,
    token: TOKEN,
    workspace: "home",
    onMessage: async (m) => {
      seen.push({ session: m.session, text: m.text });
      return { reply: `echo: ${m.text}` };
    },
    ...overrides,
  });
  return { handler, seen };
}

function post(body: unknown, headers: Record<string, string> = {}, path = "/v1/message"): Request {
  return new Request(`http://127.0.0.1:7777${path}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:7777",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const valid = { channel: "cli", user: "dan", text: "hello" };

describe("assertSafeBind", () => {
  test("refuses a short token", () => {
    expect(() => assertSafeBind({ hostname: "127.0.0.1", port: 1, token: "short" })).toThrow(GatewayConfigError);
  });

  test("refuses a non-loopback bind unless allowed", () => {
    expect(() => assertSafeBind({ hostname: "0.0.0.0", port: 1, token: TOKEN })).toThrow(/loopback/);
    expect(() => assertSafeBind({ hostname: "0.0.0.0", port: 1, token: TOKEN, allowRemote: true })).not.toThrow();
    expect(() => assertSafeBind({ hostname: "localhost", port: 1, token: TOKEN })).not.toThrow();
  });

  test("createGatewayHandler applies the same checks", () => {
    expect(() => make({ hostname: "0.0.0.0" })).toThrow(GatewayConfigError);
  });
});

describe("tokensEqual", () => {
  test("matches only identical tokens", () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
    expect(tokensEqual(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokensEqual("", TOKEN)).toBe(false);
    expect(tokensEqual("a", "b")).toBe(false);
  });
});

describe("request guards", () => {
  test("health is open but still checks Host", async () => {
    const { handler } = make();
    const ok = await handler(new Request("http://127.0.0.1:7777/health", { headers: { host: "127.0.0.1:7777" } }));
    expect(ok.status).toBe(200);
    const rebound = await handler(new Request("http://evil.test/health", { headers: { host: "evil.test" } }));
    expect(rebound.status).toBe(421);
  });

  test("a rebound Host header is rejected before auth", async () => {
    const { handler, seen } = make();
    const res = await handler(post(valid, { host: "attacker.example:7777" }));
    expect(res.status).toBe(421);
    expect(seen).toHaveLength(0);
  });

  test("a foreign Origin is rejected even with a valid token", async () => {
    const { handler, seen } = make();
    const res = await handler(post(valid, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  test("the local UI origin and configured origins are accepted", async () => {
    const { handler } = make({ allowedOrigins: ["https://ui.example"] });
    expect((await handler(post(valid, { origin: "http://localhost:7777" }))).status).toBe(200);
    expect((await handler(post(valid, { origin: "https://ui.example" }))).status).toBe(200);
  });

  test("missing or wrong token is 401", async () => {
    const { handler } = make();
    expect((await handler(post(valid, { authorization: "" }))).status).toBe(401);
    expect((await handler(post(valid, { authorization: "Bearer nope" }))).status).toBe(401);
    expect((await handler(post(valid, { authorization: `Basic ${TOKEN}` }))).status).toBe(401);
  });

  test("a token in the URL is refused, not accepted", async () => {
    const { handler, seen } = make();
    const req = new Request(`http://127.0.0.1:7777/v1/message?token=${TOKEN}`, {
      method: "POST",
      headers: { host: "127.0.0.1:7777", "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    expect((await handler(req)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("POST /v1/message", () => {
  test("routes to the agent under a structured session key", async () => {
    const { handler, seen } = make();
    const res = await handler(post(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "echo: hello" });
    expect(seen).toEqual([{ session: "home:cli:dan", text: "hello" }]);
  });

  test("validates content type, JSON, fields and key parts", async () => {
    const { handler } = make();
    expect((await handler(post(valid, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await handler(post("{not json"))).status).toBe(400);
    expect((await handler(post({ channel: "cli", user: "dan" }))).status).toBe(400);
    expect((await handler(post({ ...valid, text: "" }))).status).toBe(400);
    expect((await handler(post({ ...valid, user: "a:b" }))).status).toBe(400);
  });

  test("rejects an oversized body", async () => {
    const { handler, seen } = make();
    const res = await handler(post({ ...valid, text: "x".repeat(MAX_BODY_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  test("a failing agent gives 500 without leaking the error", async () => {
    const { handler } = make({
      onMessage: async () => {
        throw new Error("secret detail sk-123");
      },
    });
    const res = await handler(post(valid));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("sk-123");
  });

  test("messages from one session run in order, other sessions do not wait", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const { handler } = make({
      onMessage: async (m) => {
        order.push(`start:${m.text}`);
        if (m.text === "one") await gate;
        order.push(`end:${m.text}`);
        return { reply: m.text };
      },
    });
    const one = handler(post({ ...valid, text: "one" }));
    const two = handler(post({ ...valid, text: "two" }));
    const other = handler(post({ ...valid, user: "eve", text: "other" }));
    await other;
    expect(order).toContain("end:other");
    expect(order).not.toContain("start:two");
    releaseFirst();
    await Promise.all([one, two]);
    expect(order.indexOf("end:one")).toBeLessThan(order.indexOf("start:two"));
  });

  test("a full lane answers 429", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { LaneQueue } = await import("@august/core");
    const { handler } = make({
      queue: new LaneQueue({ maxPending: 1 }),
      onMessage: async () => {
        await gate;
        return { reply: "ok" };
      },
    });
    const a = handler(post(valid));
    const b = handler(post(valid));
    const c = await handler(post(valid));
    expect(c.status).toBe(429);
    release();
    await Promise.all([a, b]);
  });

  test("unknown routes are 404 after auth", async () => {
    const { handler } = make();
    expect((await handler(post({}, {}, "/nope"))).status).toBe(404);
  });
});

describe("startGateway", () => {
  test("serves real requests on loopback and stops", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const gateway = startGateway({
      hostname: "127.0.0.1",
      port,
      token: TOKEN,
      workspace: "home",
      onMessage: async (m) => ({ reply: m.text.toUpperCase() }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/message`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(valid),
      });
      expect(await res.json()).toEqual({ reply: "HELLO" });
      const denied = await fetch(`http://127.0.0.1:${port}/v1/message`, { method: "POST", body: "{}" });
      expect(denied.status).toBe(401);
    } finally {
      gateway.stop();
    }
  });
});

// Suite category: Product behavior (owner feedback is an independent outcome) and Safety/security invariant (auth, validation, and only the owner's own runs).
describe("/v1/feedback", () => {
  const feedbackReq = (body: unknown, headers: Record<string, string> = {}) => post(body, headers, "/v1/feedback");
  const good = { channel: "web", user: "local", runId: "run-1", verdict: "success" };

  test("is absent unless a sink is wired, needs the token, and passes what it got to the sink", async () => {
    expect((await make().handler(feedbackReq(good))).status).toBe(404);
    const seen: unknown[] = [];
    const { handler } = make({ feedback: (i) => void seen.push(i) });
    expect((await handler(feedbackReq(good, { authorization: "Bearer wrong-token-value" }))).status).toBe(401);
    const ok = await handler(feedbackReq({ ...good, note: "wrong file" }));
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ session: "home:web:local", runId: "run-1", verdict: "success", note: "wrong file" }]);
  });

  test("rejects malformed bodies without calling the sink", async () => {
    const seen: unknown[] = []; const { handler } = make({ feedback: (i) => void seen.push(i) });
    for (const bad of [{ ...good, verdict: "maybe" }, { ...good, runId: "" }, { ...good, runId: "x".repeat(201) }, { ...good, channel: 5 }, { ...good, user: "a b" }, { ...good, note: "y".repeat(301) }, { ...good, note: 5 }, {}, [], "nope"]) {
      expect((await handler(feedbackReq(bad))).status).toBe(400);
    }
    const nonJson = new Request("http://127.0.0.1:7777/v1/feedback", { method: "POST", headers: { host: "127.0.0.1:7777", authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" }, body: "x" });
    expect((await handler(nonJson)).status).toBe(415);
    expect(seen).toEqual([]);
  });

  test("a run that is not this session's, or was already judged, gets a status that says so and nothing else", async () => {
    const { handler } = make({ feedback: ({ runId }) => { if (runId === "dup") throw new Error("owner already gave a verdict"); throw new Error("no such run for this session"); } });
    const notMine = await handler(feedbackReq({ ...good, runId: "other" })); expect(notMine.status).toBe(409); expect(await notMine.json()).toEqual({ error: "no such answer for this session" });
    const again = await handler(feedbackReq({ ...good, runId: "dup" })); expect(again.status).toBe(410); expect(await again.json()).toEqual({ error: "that answer was already judged" });
  });

  test("message replies carry the run id so the page can offer the judgement", async () => {
    const { handler } = make({ onMessage: async () => ({ reply: "hi", runId: "run-9" }) });
    const r = await handler(post({ channel: "web", user: "local", text: "hello" }));
    expect(await r.json()).toEqual({ reply: "hi", runId: "run-9" });
  });
});
