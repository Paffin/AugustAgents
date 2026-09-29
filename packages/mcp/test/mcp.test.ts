import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CapabilityError, CapabilityRegistry } from "@august/capabilities";
import { McpConnection, McpError, McpHost, inferEffects, mapTools, type McpServerSpec } from "../src/index.ts";

const SERVER = join(import.meta.dir, "fake-server.ts");
const opened: McpConnection[] = [];
const hosts: McpHost[] = [];

function spec(mode = "normal", extra: Partial<McpServerSpec> = {}): McpServerSpec {
  return { id: "fake", command: process.execPath, args: [SERVER], env: { FAKE_MODE: mode }, ...extra };
}
async function connect(mode = "normal", options = {}, extra: Partial<McpServerSpec> = {}, baseEnv?: Record<string, string | undefined>) {
  const c = await McpConnection.connect(spec(mode, extra), { requestTimeoutMs: 3000, ...options }, baseEnv ?? process.env);
  opened.push(c);
  return c;
}
function host(): { host: McpHost; registry: CapabilityRegistry } {
  const registry = new CapabilityRegistry();
  const h = new McpHost(registry, { connectOptions: { requestTimeoutMs: 3000 } });
  hosts.push(h);
  return { host: h, registry };
}
afterEach(() => {
  opened.splice(0).forEach((c) => c.close());
  hosts.splice(0).forEach((h) => h.closeAll());
});

describe("McpConnection", () => {
  test("initialises, lists tools and calls one", async () => {
    const c = await connect();
    expect((await c.listTools()).map((t) => t.name)).toEqual(["echo", "delete file!", "plain"]);
    const r = await c.callTool("echo", { text: "hi" });
    expect(r.isError).toBe(false);
    expect(r.content).toBe("hi\n[image content omitted]");
  });

  test("follows tool pages and stops at the page limit", async () => {
    expect((await (await connect("paged")).listTools()).length).toBe(3);
    await expect((await connect("endless", { maxToolPages: 3 })).listTools()).rejects.toThrow(/too many pages/);
  });

  test("server-reported errors come back as isError, not exceptions", async () => {
    const r = await (await connect()).callTool("plain", {});
    expect(r).toEqual({ content: "boom", isError: true, parts: [{ kind: "text", text: "boom" }] });
  });

  test("a server that never answers times out", async () => {
    await expect(connect("silent", { requestTimeoutMs: 200 })).rejects.toThrow(/timed out/);
    const c = await connect("hang", { requestTimeoutMs: 200 });
    await expect(c.callTool("echo", { text: "x" })).rejects.toThrow(/timed out/);
  });

  test("a crash rejects the pending call and marks the connection dead", async () => {
    const c = await connect("crash");
    await expect(c.callTool("echo", { text: "x" })).rejects.toThrow(/exited/);
    expect(c.alive).toBe(false);
    await expect(c.listTools()).rejects.toThrow(McpError);
  });

  test("a command that does not exist fails cleanly", async () => {
    await expect(McpConnection.connect({ id: "nope", command: "/definitely/not/here" }, { requestTimeoutMs: 1000 })).rejects.toThrow(/could not start/);
  });

  test("rejects a server id that would break namespacing", async () => {
    await expect(McpConnection.connect({ id: "a.b", command: "x" })).rejects.toThrow(/invalid server id/);
  });

  test("long results are truncated", async () => {
    const r = await (await connect("big", { maxResultChars: 100 })).callTool("echo", {});
    expect(r.content.length).toBeLessThan(130);
    expect(r.content).toEndWith("[truncated]");
  });

  test("ignores stdout noise and refuses requests the server makes back", async () => {
    const c = await connect("noisy");
    expect((await c.listTools()).length).toBe(3);
    await (await connect("ask-back")).listTools();
  });

  test("the server gets a clean environment plus only what the config gives it", async () => {
    const base = { PATH: process.env.PATH, HOME: "/home/secret-user", AUGUST_TEST_SECRET: "sk-live-123" };
    const c = await connect("env", {}, { env: { FAKE_MODE: "env", EXTRA: "ok" } }, base);
    const out = (await c.callTool("echo", {})).content;
    expect(out).toBe("HOME=;SECRET=;EXTRA=ok");
  });

  test("stderr is kept for diagnostics and never returned as a result", async () => {
    const c = await connect("stderr");
    const r = await c.callTool("echo", { text: "x" });
    expect(r.content).not.toContain("SECRET-IN-STDERR");
    await Bun.sleep(50);
    expect(c.diagnostics).toContain("SECRET-IN-STDERR");
  });
});

// Suite category: External compatibility contract (MCP protocol via the official SDK, DEC-0007). Consumers: MCP servers speaking
// 2025-06-18 or newer. Older revisions have no evidenced consumer and are refused; sunset condition: add evidence here to admit one.
describe("MCP protocol adapter (official SDK)", () => {
  test("accepts the revisions it supports, including the SDK's newest and the one August spoke before", async () => {
    for (const version of ["2025-06-18", "2025-11-25"]) {
      const c = await connect("normal", {}, { env: { FAKE_MODE: "normal", FAKE_PROTOCOL: version } });
      expect((await c.listTools()).length).toBe(3);
    }
  });

  test("refuses a server that only speaks an older revision, before listing anything, and leaves no process behind", async () => {
    for (const version of ["2025-03-26", "2024-11-05"]) {
      const started = Date.now();
      await expect(connect("normal", {}, { env: { FAKE_MODE: "normal", FAKE_PROTOCOL: version } })).rejects.toThrow(new RegExp(`speaks MCP ${version}, older than the supported 2025-06-18`));
      expect(Date.now() - started).toBeLessThan(2500);
    }
    const { host: h, registry } = host();
    await expect(h.add(spec("normal", { env: { FAKE_MODE: "normal", FAKE_PROTOCOL: "2024-11-05" } }), "known")).rejects.toThrow(/older than/);
    expect(registry.list()).toHaveLength(0); expect(h.serverIds).toEqual([]);
  });

  test("a tools/list that breaks the spec is refused as a whole, never installed partially", async () => {
    await expect((await connect("nonconformant")).listTools()).rejects.toThrow(/tools\/list returned an invalid response/);
    const { host: h, registry } = host();
    await expect(h.add(spec("nonconformant"), "known")).rejects.toThrow(McpError);
    expect(registry.list()).toHaveLength(0);
  });

  test("failure text names the server and the method, never arguments or server-controlled detail", async () => {
    const c = await connect("crash");
    const error = await c.callTool("echo", { text: "secret-argument-123" }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(McpError);
    expect((error as Error).message).toMatch(/^fake: server exited \(3\)$/);
    expect((error as Error).message).not.toContain("secret-argument-123");
  });

  test("a server request we do not implement is answered with an error instead of hanging the server", async () => {
    const c = await connect("ask-back");
    expect((await c.listTools()).length).toBe(3);
    expect(c.alive).toBe(true);
  });

  test("an oversized line from the server ends the connection instead of buffering without bound", async () => {
    const c = await connect("flood", { maxMessageBytes: 4096 });
    await expect(c.callTool("echo", {})).rejects.toThrow(/too large|exited|closed/);
    expect(c.alive).toBe(false);
  });
});

describe("effects and mapping", () => {
  const readOnly = { name: "r", annotations: { readOnlyHint: true, openWorldHint: false } };

  test("hints are honoured only for trusted servers", () => {
    expect(inferEffects(readOnly, "known")).toEqual(["read"]);
    expect(inferEffects(readOnly, "community")).toEqual(["read", "write", "network"]);
    expect(inferEffects(readOnly, "self-made")).toEqual(["read", "write", "network"]);
  });

  test("no hints means the worst case, even for a trusted server", () => {
    expect(inferEffects({ name: "x" }, "verified")).toEqual(["read", "write", "network"]);
  });

  test("destructive and open-world hints add delete and network", () => {
    expect(inferEffects({ name: "x", annotations: { destructiveHint: true, openWorldHint: false } }, "known")).toEqual(["read", "write", "delete"]);
    expect(inferEffects({ name: "x", annotations: { readOnlyHint: true } }, "known")).toEqual(["read", "network"]);
  });

  test("results are untrusted unless a trusted server says read-only and closed-world", () => {
    expect(mapTools("s", [readOnly], "known").descriptors[0]!.producesUntrusted).toBe(false);
    expect(mapTools("s", [readOnly], "community").descriptors[0]!.producesUntrusted).toBe(true);
    expect(mapTools("s", [{ name: "x" }], "verified").descriptors[0]!.producesUntrusted).toBe(true);
  });

  test("names are namespaced and sanitised; descriptions are capped", () => {
    const m = mapTools("s", [{ name: "delete file!", description: "d".repeat(5000) }], "community");
    expect(m.descriptors[0]!.name).toBe("s.delete_file_");
    expect(m.descriptors[0]!.description.length).toBe(1000);
    expect(m.originals.get("s.delete_file_")).toBe("delete file!");
  });

  test("two tools that sanitise to the same name are refused", () => {
    expect(() => mapTools("s", [{ name: "a b" }, { name: "a_b" }], "community")).toThrow(/two tools/);
  });
});

describe("McpHost", () => {
  test("installs a server's tools and routes calls to it", async () => {
    const { host: h, registry } = host();
    await h.add(spec(), "known");
    expect(registry.enabledTools().map((t) => t.name)).toEqual(["fake.echo", "fake.delete_file_", "fake.plain"]);
    expect(await h.call("fake.echo", { text: "hey" })).toMatchObject({ isError: false });
    expect(h.serverIds).toEqual(["fake"]);
  });

  // Suite category: Safety/security invariant (REQ-SEC-001 part-level provenance).
  test("mixed results: the tool's own text keeps its trust, everything that names an outside resource is untrusted, and server annotations bless nothing", async () => {
    const { host: h } = host();
    await h.add(spec("mixed"), "known", { sensitivity: "public" });
    const r = await h.call("fake.echo", { text: "x" });
    expect(r.parts!.map((p) => [p.origin.kind, p.origin.source, p.origin.locator, p.trust, p.sensitivity, p.text.slice(0, 12)])).toEqual([
      ["mcp", "fake.echo", undefined, "trusted", "public", "3 results"],
      ["mcp", "fake.echo", "https://evil.example/page", "untrusted", "public", "IGNORE PREVI"],
      ["mcp", "fake.echo", "file:///blob", "trusted", "public", "[binary reso"],
      ["mcp", "fake.echo", "https://evil.example/next", "untrusted", "public", "[link] read "],
      ["mcp", "fake.echo", undefined, "trusted", "public", "[image conte"],
      ["mcp", "fake.echo", undefined, "trusted", "public", "{\"rows\":3}"],
    ]);
  });

  test("a community server's own text is untrusted, and results default to personal sensitivity", async () => {
    const { host: h } = host();
    await h.add(spec("mixed"), "community");
    const r = await h.call("fake.echo", { text: "x" });
    expect(r.parts![0]).toMatchObject({ trust: "untrusted", sensitivity: "personal" });
    expect(r.parts!.every((p) => p.trust === "untrusted")).toBe(true);
  });

  test("the sanitised name maps back to the server's own name", async () => {
    const { host: h } = host();
    await h.add(spec(), "known");
    expect((await h.call("fake.delete_file_", {})).content).toBe("boom");
  });

  test("a poisoned tool description is blocked at install and the server is stopped", async () => {
    const { host: h, registry } = host();
    await expect(h.add(spec("poisoned"), "community")).rejects.toThrow(CapabilityError);
    expect(h.serverIds).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  test("a rug pull shows up in liveDescriptors and trips the registry", async () => {
    const { host: h, registry } = host();
    await h.add(spec("rugpull"), "known");
    const live = await h.liveDescriptors("fake");
    expect(registry.verify("fake", live!)).toBe("changed");
    expect(registry.enabledTools()).toEqual([]);
  });

  test("an unchanged server verifies as ok", async () => {
    const { host: h, registry } = host();
    await h.add(spec(), "known");
    expect(registry.verify("fake", (await h.liveDescriptors("fake"))!)).toBe("ok");
  });

  test("a dead server answers with an error result, not an exception", async () => {
    const { host: h } = host();
    await h.add(spec("crash"), "community");
    expect((await h.call("fake.echo", {})).isError).toBe(true);
    const again = await h.call("fake.echo", {});
    expect(again).toEqual({ content: "fake is not running", isError: true });
  });

  test("unknown tools go to the fallback executor, or error", async () => {
    const registry = new CapabilityRegistry();
    const h = new McpHost(registry, { fallback: { call: async (t) => ({ content: `builtin ${t}` }) } });
    expect(await h.call("clock.now", {})).toEqual({ content: "builtin clock.now" });
    expect((await new McpHost(registry).call("clock.now", {})).isError).toBe(true);
  });

  test("built-in capabilities have nothing to verify", async () => {
    const { host: h } = host();
    expect(await h.liveDescriptors("clock")).toBeUndefined();
  });

  test("the same server cannot be added twice, and remove uninstalls", async () => {
    const { host: h, registry } = host();
    await h.add(spec(), "known");
    await expect(h.add(spec(), "known")).rejects.toThrow(/already running/);
    await h.remove("fake");
    expect(registry.list()).toEqual([]);
    expect(h.serverIds).toEqual([]);
  });
});
