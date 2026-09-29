import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  DecisionCascade,
  InMemoryDecisionLog,
  LayaEngine,
  LayaTransportError,
  layaHttpTransport,
  type DecisionQuestion,
} from "../src/index.ts";

const question: DecisionQuestion = {
  id: "tool-choice",
  instructions: "Which tool?",
  options: [
    { key: "fs.read", description: "read a file" },
    { key: "none", description: "no tool" },
  ],
};

describe("layaHttpTransport", () => {
  // Safety/security invariant: private state stays at the explicitly configured local endpoint.
  test("rejects ambiguous or non-HTTP sidecar addresses before dispatch", () => {
    for (const url of ["not-a-url", "ftp://127.0.0.1", "http://owner:secret@127.0.0.1", "http://127.0.0.1?target=x", "http://127.0.0.1#x"]) {
      expect(() => layaHttpTransport(url)).toThrow(LayaTransportError);
    }
  });

  test("Safety: actual HTTP redirect cannot forward private state", async () => {
    let forwarded = 0;
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      forwarded++; await request.text(); return Response.json({ probs: { "fs.read": 1, none: 0 } });
    } });
    const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, {
      status: 307, headers: { location: `http://127.0.0.1:${destination.port}/predict` },
    }) });
    try {
      const predict = layaHttpTransport(`http://127.0.0.1:${source.port}`);
      await expect(predict({ state: "owner-private-state", question })).rejects.toThrow(LayaTransportError);
      expect(forwarded).toBe(0);
    } finally { source.stop(true); destination.stop(true); }
  });

  test("only a sidecar on this machine is accepted", () => {
    expect(() => layaHttpTransport("https://laya.example.com")).toThrow(LayaTransportError);
    expect(() => layaHttpTransport("http://127.0.0.1:7788")).not.toThrow();
  });

  test("sends state and question, returns probs and exactness", async () => {
    let body: any;
    const t = layaHttpTransport("http://127.0.0.1:1/", {
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe("http://127.0.0.1:1/predict");
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ probs: { "fs.read": 1, none: 0 }, exact: false }));
      }) as unknown as typeof fetch,
    });
    const r = await t({ state: "s", question });
    expect(body.question.options).toHaveLength(2);
    expect(r).toEqual({ probs: { "fs.read": 1, none: 0 }, exact: false });
  });

  test("errors are typed and never include the state", async () => {
    const down = layaHttpTransport("http://127.0.0.1:1", { fetch: (async () => { throw new Error("private state text"); }) as unknown as typeof fetch });
    const e = await down({ state: "private state text", question }).catch((x) => x);
    expect(e).toBeInstanceOf(LayaTransportError);
    expect(e.message).not.toContain("private");
    const bad = layaHttpTransport("http://127.0.0.1:1", { fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    await expect(bad({ state: "s", question })).rejects.toThrow(/no probs/);
  });
});

describe("LayaEngine with inexact answers", () => {
  test("one-hot answers get the configured low confidence so the LLM decides", async () => {
    const engine = new LayaEngine(async () => ({ probs: { "fs.read": 1, none: 0 }, exact: false }));
    const r = await engine.decide({ state: "s", tainted: false }, question);
    expect(r.choice).toBe("fs.read");
    expect(r.confidence).toBe(0.5);
  });
});

describe("the decision log (shadow evidence, not labels)", () => {
  test("the log keeps primary probabilities in option order", async () => {
    const log = new InMemoryDecisionLog();
    const primary = new LayaEngine(async () => ({ probs: { "fs.read": 0.6, none: 0.4 } }));
    const fallback = { decide: async () => ({ choice: "none", probs: { none: 1 }, confidence: 1 }) };
    await new DecisionCascade({ primary, fallback, log, shadow: true }).decide({ state: "s", tainted: false }, question);
    expect(log.entries[0]!.primaryProbs).toEqual([0.6, 0.4]);
  });

  test("cascade stats can be restored", () => {
    const c = new DecisionCascade({ primary: { decide: async () => ({ choice: "a", probs: {}, confidence: 1 }) }, fallback: { decide: async () => ({ choice: "a", probs: {}, confidence: 1 }) } });
    c.restore({ shadowSamples: 300, shadowAgreements: 290, total: -5 as number });
    expect(c.stats().shadowSamples).toBe(300);
    expect(c.stats().total).toBe(0);
    expect(c.stats().agreementRate).toBeCloseTo(290 / 300);
  });
});

describe("python sidecar (with a fake laya module)", () => {
  const port = 22000 + Math.floor(Math.random() * 10000);
  let proc: ChildProcess;
  const root = join(import.meta.dir, "../../../sidecar");

  async function start(mode: string, p: number): Promise<ChildProcess> {
    const child = spawn(process.env.AUGUST_TEST_PYTHON ?? "python3", [join(root, "laya_server.py"), "--port", String(p)], {
      env: { ...process.env, PYTHONPATH: join(root, "test/fake"), LAYA_FAKE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = ""; let startup = ""; let probe = ""; let spawnError: Error | undefined;
    child.stderr?.on("data", data => { diagnostics = (diagnostics + String(data)).slice(-2000); });
    child.stdout?.on("data", data => { startup = (startup + String(data)).slice(-1000); });
    child.on("error", error => { spawnError = error; });
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) break;
      try {
        if ((await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(250) })).ok) return child;
      } catch (error) { probe = (error as Error).message; }
      await Bun.sleep(100);
    }
    child.kill();
    throw new Error(`fixture sidecar did not start: ${spawnError?.message ?? `exit=${child.exitCode}; stderr=${diagnostics}; stdout=${startup}; probe=${probe}`}`);
  }

  beforeAll(async () => {
    proc = await start("exact", port);
  });
  afterAll(() => proc?.kill());

  test("answers a choice question through the real HTTP protocol", async () => {
    const engine = new LayaEngine(layaHttpTransport(`http://127.0.0.1:${port}`));
    const r = await engine.decide({ state: "please use fs.read on notes", tainted: false }, question);
    expect(r.choice).toBe("fs.read");
    expect(r.confidence).toBeCloseTo(0.9, 5);
  });

  test("rejects browser origins and bad bodies", async () => {
    const url = `http://127.0.0.1:${port}/predict`;
    const ok = JSON.stringify({ state: "x", question });
    expect((await fetch(url, { method: "POST", headers: { origin: "https://evil.example" }, body: ok })).status).toBe(403);
    expect((await fetch(url, { method: "POST", body: JSON.stringify({ state: "x" }) })).status).toBe(400);
    expect((await fetch(url, { method: "POST", body: JSON.stringify({ state: "x", question: { ...question, options: [question.options[0]] } }) })).status).toBe(400);
  });

  test("a laya that reports only the choice is marked inexact", async () => {
    const p2 = port + 1;
    const child = await start("choice", p2);
    try {
      const r = await layaHttpTransport(`http://127.0.0.1:${p2}`)({ state: "fs.read", question });
      expect(r).toEqual({ probs: { "fs.read": 1, none: 0 }, exact: false });
    } finally {
      child.kill();
    }
  });
});
