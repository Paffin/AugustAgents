import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@august/capabilities";
import {
  McpHost,
  McpError,
  McpHttpConnection,
  guardedFetch,
  SandboxError,
  bwrapArgs,
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
      return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "web", version: "1" } } }, { "mcp-session-id": "sess-1" });
    case "tools/list":
      return json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search", description: "search the web", inputSchema: { type: "object" } }] } });
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
    expect(await c.callTool("search", { q: "bun" })).toEqual({ content: "found bun", isError: false, parts: [{ kind: "text", text: "found bun" }] });
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
    handler = (msg) => (msg?.method === "tools/list" ? json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "x", description: "y".repeat(5000), inputSchema: { type: "object" } }] } }) : undefined);
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
});

// Suite category: External compatibility contract (MCP streamable HTTP via the official SDK transport, DEC-0007).
describe("MCP streamable HTTP adapter (official SDK)", () => {
  test("speaks the SDK's newest revision first, identifies itself, and never opens the server push stream", async () => {
    await Bun.sleep(30); seen.length = 0; handler = () => undefined;
    const c = await McpHttpConnection.connect({ id: "web", url: url() });
    await c.listTools();
    expect(seen.find((m) => m.body?.method === "initialize")!.body).toMatchObject({ method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "august" } } });
    expect(seen.some((m) => m.method === "GET")).toBe(false);
    expect(seen.filter((m) => m.method === "POST" && m.body?.method !== "initialize" && m.body?.method !== "notifications/initialized").every((m) => m.headers.get("mcp-protocol-version") === "2025-06-18")).toBe(true);
    c.close();
  });

  test("refuses a server that negotiates an older revision", async () => {
    handler = (msg) => (msg?.method === "initialize" ? json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "old", version: "1" } } }) : undefined);
    await expect(McpHttpConnection.connect({ id: "web", url: url() })).rejects.toThrow(/speaks MCP 2024-11-05, older than the supported 2025-06-18/);
    handler = () => undefined;
  });

  test("errors carry the status only: a hostile body, headers and credentials never reach the message", async () => {
    handler = (msg) => (msg?.method === "tools/list" ? new Response("SECRET-BODY Bearer T", { status: 503 }) : undefined);
    const c = await McpHttpConnection.connect({ id: "web", url: url(), headers: { authorization: "Bearer T" } });
    const error = await c.listTools().catch((e) => e as Error);
    expect((error as Error).message).toBe("web: HTTP 503");
    handler = () => undefined;
  });

  test("a server that never answers times out with a clear error", async () => {
    handler = (msg) => (msg?.method === "tools/call" ? new Promise<Response>(() => undefined) as never : undefined);
    const c = await McpHttpConnection.connect({ id: "web", url: url() }, { requestTimeoutMs: 200 });
    await expect(c.callTool("search", {})).rejects.toThrow(/^web: tools\/call timed out$/);
    handler = () => undefined; c.close();
  });

  test("an oversized event stream is cut off at the limit", async () => {
    handler = (msg) => (msg?.method === "tools/call" ? new Response(`data: ${"x".repeat(5000)}\n\n`.repeat(50), { headers: { "content-type": "text/event-stream" } }) : undefined);
    const c = await McpHttpConnection.connect({ id: "web", url: url() }, { maxMessageBytes: 2000, requestTimeoutMs: 400 });
    await expect(c.callTool("search", {})).rejects.toThrow(McpError);
    handler = () => undefined; c.close();
  });

  test("guardedFetch: no push stream, bounded bodies, and the answer keeps its status and headers", async () => {
    const inner = (async (_u: unknown, init?: RequestInit) => new Response("y".repeat(100), { status: 201, headers: { "x-h": "1", "mcp-session-id": String(init?.method) } })) as unknown as typeof fetch;
    const guarded = guardedFetch(inner, 50);
    expect((await guarded("http://x", { method: "GET" })).status).toBe(405);
    expect((await guarded("http://x")).status).toBe(405);
    const post = await guarded("http://x", { method: "POST" });
    expect([post.status, post.headers.get("x-h")]).toEqual([201, "1"]);
    await expect(post.text()).rejects.toThrow(/too large/);
    const small = await guardedFetch((async () => new Response("ok")) as unknown as typeof fetch, 50)("http://x", { method: "POST" });
    expect(await small.text()).toBe("ok");
  });
});

describe("sandbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "august-sb-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const spec = { id: "s", command: "/usr/bin/node", args: ["server.js"] };
  const base = { network: "open" as const, home: join(dir, "home"), realHome: "/home/dan" };

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
    expect(bwrapArgs(spec, { ...base, network: "none" })).not.toContain("--share-net");
    // The private home is mounted after /home is hidden, or it would be covered.
    expect(a.indexOf("--bind")).toBeGreaterThan(a.indexOf("/home"));
  });

  test("the macOS profile denies the real home and, when asked, the network", () => {
    const p = seatbeltProfile({ ...base, network: "none" });
    expect(p).toContain('(deny file-read* file-write* (subpath "/home/dan"))');
    expect(p).toContain(`(allow file-read* file-write* (subpath "${base.home}"))`);
    expect(p).toContain("(deny network*)");
    expect(seatbeltProfile(base)).not.toContain("network");
    expect(seatbeltProfile({ ...base, realHome: '/x"y' })).toContain('"/x\\"y"');
  });

  test("modes: off passes through, auto runs unisolated when nothing works, required refuses", () => {
    expect(sandboxSpec(spec, { ...base, mode: "off", kind: "bwrap" })).toEqual({ spec, isolation: "none", egress: "open" });
    expect(sandboxSpec(spec, { ...base, mode: "auto", kind: "none" }).isolation).toBe("none");
    expect(() => sandboxSpec(spec, { ...base, mode: "required", kind: "none" })).toThrow(SandboxError);
  });

  test("read-only paths are shown inside the hidden home, after it is hidden", () => {
    const a = bwrapArgs(spec, { ...base, readOnlyPaths: ["/home/dan/.august/data/capabilities/x", "/home/dan/.bun/bin/bun"] });
    const s = a.join(" ");
    expect(s).toContain("--ro-bind /home/dan/.august/data/capabilities/x /home/dan/.august/data/capabilities/x");
    expect(s).toContain("--ro-bind /home/dan/.bun/bin/bun /home/dan/.bun/bin/bun");
    // Mounted after every tmpfs and after the private home, or a path under /tmp, /home, /root or the home itself would be covered again.
    expect(a.indexOf("/home/dan/.august/data/capabilities/x")).toBeGreaterThan(a.lastIndexOf("--tmpfs"));
    expect(a.indexOf("/home/dan/.august/data/capabilities/x")).toBeGreaterThan(a.indexOf(base.home));
    const mac = seatbeltProfile({ ...base, network: "none" }, ["/home/dan/.august/data/capabilities/x"]);
    expect(mac).toContain('(allow file-read* (subpath "/home/dan/.august/data/capabilities/x"))');
  });

  test("egress attachments: unix bridges through a bound socket with no network at all, tcp allows only the proxy's loopback port", () => {
    const unix = { kind: "unix" as const, socket: "/data/e.sock", runtime: "/usr/local/bin/bun", bridgeScript: "/data/bridge.js" };
    const a = bwrapArgs(spec, { ...base, network: unix });
    expect(a).not.toContain("--share-net");
    expect(a.join(" ")).toContain("--ro-bind /usr/local/bin/bun /run/august/runtime");
    expect(a.join(" ")).toContain("--ro-bind /data/bridge.js /run/august/bridge.js");
    expect(a.join(" ")).toContain("--bind /data/e.sock /run/august/egress.sock");
    expect(a.join(" ")).toContain("--setenv HTTPS_PROXY http://127.0.0.1:3128");
    expect(a.join(" ")).toContain("--setenv NODE_USE_ENV_PROXY 1");
    expect(a.slice(a.indexOf("--") + 1)).toEqual(["/bin/sh", "-c", '/run/august/runtime /run/august/bridge.js & exec "$@"', "sh", "/usr/bin/node", "server.js"]);
    expect(a.indexOf("--tmpfs")).toBeLessThan(a.indexOf("/run/august/egress.sock"));
    const tcp = { kind: "tcp" as const, port: 40123, token: "tok" };
    const profile = seatbeltProfile({ ...base, network: tcp });
    expect(profile).toContain("(deny network*)");
    expect(profile.indexOf('(allow network-outbound (remote tcp "localhost:40123"))')).toBeGreaterThan(profile.indexOf("(deny network*)"));
    const mac = sandboxSpec(spec, { ...base, network: tcp, mode: "required", kind: "sandbox-exec" });
    expect(mac.egress).toBe("allowlist");
    expect(mac.spec.env).toMatchObject({ HTTPS_PROXY: "http://august:tok@localhost:40123", NO_PROXY: "" });
    expect(() => sandboxSpec(spec, { ...base, network: tcp, mode: "required", kind: "bwrap" })).toThrow(/cannot enforce/);
    expect(() => sandboxSpec(spec, { ...base, network: unix, mode: "required", kind: "sandbox-exec" })).toThrow(/cannot enforce/);
    expect(sandboxSpec(spec, { ...base, network: "none", mode: "required", kind: "bwrap" }).egress).toBe("none");
    expect(sandboxSpec(spec, { ...base, network: "open", mode: "required", kind: "bwrap" }).egress).toBe("open");
    expect(sandboxSpec(spec, { ...base, network: unix, mode: "required", kind: "bwrap" }).egress).toBe("allowlist");
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
