import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@august/capabilities";
import {
  McpHost,
  McpHttpConnection,
  SandboxError,
  bwrapArgs,
  parseSse,
  sandboxSpec,
  seatbeltProfile,
} from "../src/index.ts";

type Handler = (msg: any, req: Request) => Response | undefined;
let server: ReturnType<typeof Bun.serve>;
let handler: Handler = () => undefined;
const seen: Array<{ headers: Headers; body: any; method: string }> = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = req.method === "POST" ? await req.json() : undefined;
      seen.push({ headers: req.headers, body, method: req.method });
      return handler(body, req) ?? defaultReply(body);
    },
  });
});
afterAll(() => server.stop(true));

const url = () => `http://127.0.0.1:${server.port}/mcp`;
const json = (v: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { headers: { "content-type": "application/json", ...headers } });

function defaultReply(msg: any): Response {
  if (!msg) return new Response(null, { status: 200 });
  if (msg.id === undefined) return new Response(null, { status: 202 });
  switch (msg.method) {
    case "initialize":
      return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { "mcp-session-id": "sess-1" });
    case "tools/list":
      return json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search", description: "search the web" }] } });
    case "tools/call":
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n` +
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `found ${msg.params.arguments.q}` }] } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
  }
  return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
}

describe("McpHttpConnection", () => {
  test("initialises, keeps the session id, reads JSON and SSE replies", async () => {
    seen.length = 0;
    handler = () => undefined;
    const c = await McpHttpConnection.connect({ id: "web", url: url(), headers: { authorization: "Bearer T" } });
    expect((await c.listTools()).map((t) => t.name)).toEqual(["search"]);
    expect(await c.callTool("search", { q: "bun" })).toEqual({ content: "found bun", isError: false });
    const later = seen.filter((s) => s.body?.method === "tools/list")[0]!;
    expect(later.headers.get("mcp-session-id")).toBe("sess-1");
    expect(later.headers.get("authorization")).toBe("Bearer T");
    expect(seen[1]!.body.method).toBe("notifications/initialized");
    c.close();
    await Bun.sleep(20);
    expect(seen.at(-1)!.method).toBe("DELETE");
  });

  test("refuses plain http to a remote host", async () => {
    await expect(McpHttpConnection.connect({ id: "x", url: "http://mcp.example.com/mcp" })).rejects.toThrow(/https/);
  });

  test("HTTP errors, JSON-RPC errors and oversized replies are McpErrors", async () => {
    handler = (msg) => (msg?.method === "tools/list" ? new Response("no", { status: 500 }) : undefined);
    const c = await McpHttpConnection.connect({ id: "web", url: url() });
    await expect(c.listTools()).rejects.toThrow(/HTTP 500/);
    handler = (msg) => (msg?.method === "tools/list" ? json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "x", description: "y".repeat(5000) }] } }) : undefined);
    const small = await McpHttpConnection.connect({ id: "web", url: url() }, { maxMessageBytes: 1000 });
    await expect(small.listTools()).rejects.toThrow(/too large/);
    handler = () => undefined;
  });

  test("an expired session marks the connection dead", async () => {
    const c = await McpHttpConnection.connect({ id: "web", url: url() });
    handler = () => new Response("gone", { status: 404 });
    await expect(c.listTools()).rejects.toThrow(/expired/);
    expect(c.alive).toBe(false);
    handler = () => undefined;
  });

  test("redirects are not followed (they could carry the credentials away)", async () => {
    handler = (msg) => (msg?.method === "tools/list" ? new Response(null, { status: 307, headers: { location: "https://evil.example/" } }) : undefined);
    const c = await McpHttpConnection.connect({ id: "web", url: url(), headers: { authorization: "Bearer T" } });
    await expect(c.listTools()).rejects.toThrow();
    handler = () => undefined;
  });

  test("McpHost installs a remote server through the registry", async () => {
    const registry = new CapabilityRegistry();
    const host = new McpHost(registry);
    await host.add({ id: "web", url: url() }, "community");
    expect(registry.enabledTools().map((t) => t.name)).toEqual(["web.search"]);
    expect(registry.enabledTools()[0]!.effects).toContain("network");
    expect((await host.call("web.search", { q: "x" })).content).toBe("found x");
    host.closeAll();
  });

  test("parseSse keeps only JSON data blocks", () => {
    expect(parseSse("data: {\"a\":1}\n\n: ping\n\ndata: junk\n\ndata: {\"b\":\ndata: 2}\n\n")).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("sandbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "august-sb-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const spec = { id: "s", command: "/usr/bin/node", args: ["server.js"] };
  const base = { network: true, home: join(dir, "home"), realHome: "/home/dan" };

  test("bwrap hides homes and /run, gives a private home, and shares the network only when allowed", () => {
    const a = bwrapArgs(spec, base);
    const s = a.join(" ");
    expect(s).toContain("--ro-bind / /");
    expect(s).toContain("--tmpfs /home");
    expect(s).toContain("--tmpfs /run");
    expect(s).toContain(`--bind ${base.home} /home/dan`);
    expect(s).toContain("--unshare-all");
    expect(a).toContain("--share-net");
    expect(a.slice(-3)).toEqual(["--", "/usr/bin/node", "server.js"]);
    expect(bwrapArgs(spec, { ...base, network: false })).not.toContain("--share-net");
    // The private home is mounted after /home is hidden, or it would be covered.
    expect(a.indexOf("--bind")).toBeGreaterThan(a.indexOf("/home"));
  });

  test("the macOS profile denies the real home and, when asked, the network", () => {
    const p = seatbeltProfile({ ...base, network: false });
    expect(p).toContain('(deny file-read* file-write* (subpath "/home/dan"))');
    expect(p).toContain(`(allow file-read* file-write* (subpath "${base.home}"))`);
    expect(p).toContain("(deny network*)");
    expect(seatbeltProfile(base)).not.toContain("network");
    expect(seatbeltProfile({ ...base, realHome: '/x"y' })).toContain('"/x\\"y"');
  });

  test("modes: off passes through, auto runs unisolated when nothing works, required refuses", () => {
    expect(sandboxSpec(spec, { ...base, mode: "off", kind: "bwrap" })).toEqual({ spec, isolation: "none" });
    expect(sandboxSpec(spec, { ...base, mode: "auto", kind: "none" }).isolation).toBe("none");
    expect(() => sandboxSpec(spec, { ...base, mode: "required", kind: "none" })).toThrow(SandboxError);
  });

  test("wrapping creates a private home and swaps the command", () => {
    const r = sandboxSpec(spec, { ...base, mode: "required", kind: "bwrap" });
    expect(r.isolation).toBe("bwrap");
    expect(r.spec.command).toBe("bwrap");
    expect(statSync(base.home).mode & 0o777).toBe(0o700);
    const mac = sandboxSpec({ ...spec, command: "/home/dan/.bun/bin/bun" }, { ...base, mode: "auto", kind: "sandbox-exec" });
    expect(mac.spec.command).toBe("sandbox-exec");
    expect(mac.spec.args![1]).toContain('(allow file-read* (subpath "/home/dan/.bun"))');
  });
});
