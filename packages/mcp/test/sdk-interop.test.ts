import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CapabilityRegistry } from "@august/capabilities";
import { McpConnection, McpHost, McpHttpConnection, type McpSession } from "../src/index.ts";
import { buildServer } from "./sdk-server.ts";

// Suite category: External compatibility contract. Consumer: any MCP server built on the official SDK (the reference implementation).
// Evidence that August's adapter interoperates over both transports with a conformant peer. Retained while the adapter exists (DEC-0007).
const opened: McpSession[] = [];
const servers: Server[] = [];
afterEach(() => { opened.splice(0).forEach((c) => c.close()); servers.splice(0).forEach((s) => s.close()); });

async function httpServer(): Promise<string> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer(async (req, res) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { transports.set(id, transport!); } });
      await buildServer().connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
}

const stdio = () => McpConnection.connect({ id: "ref", command: process.execPath, args: [join(import.meta.dir, "sdk-server.ts")] }, { requestTimeoutMs: 5000 });
const transports: Array<[string, () => Promise<McpSession>]> = [
  ["stdio", stdio],
  ["streamable HTTP", async () => McpHttpConnection.connect({ id: "ref", url: await httpServer() }, { requestTimeoutMs: 5000 })],
];

for (const [name, connect] of transports) {
  describe(`official SDK reference server over ${name}`, () => {
    test("negotiates, lists tools with their schemas and annotations, and calls them", async () => {
      const c = await connect(); opened.push(c);
      const tools = await c.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["add", "boom", "mixed"]);
      const add = tools.find((t) => t.name === "add")!;
      expect(add.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(add.inputSchema).toMatchObject({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } } });
      const r = await c.callTool("add", { a: 2, b: 40 });
      expect(r.isError).toBe(false);
      expect(r.parts.map((p) => [p.kind, p.text])).toEqual([["text", "42"], ["structured", '{"sum":42}']]);
    });

    test("tool errors are results, and a result that breaks the tool's own output schema is refused", async () => {
      const c = await connect(); opened.push(c);
      await c.listTools();
      expect(await c.callTool("boom", {})).toMatchObject({ isError: true, content: "kaput" });
      await expect(c.callTool("add", { a: "x", b: 1 })).resolves.toMatchObject({ isError: true });
    });

    test("through the host: mixed content is split into parts with the right trust, and installs are pinned", async () => {
      const registry = new CapabilityRegistry(); const host = new McpHost(registry, { connect: async () => { const c = await stdio(); return c; }, connectHttp: async (spec) => McpHttpConnection.connect(spec, { requestTimeoutMs: 5000 }) });
      try {
        if (name === "stdio") await host.add({ id: "ref", command: process.execPath, args: [join(import.meta.dir, "sdk-server.ts")] }, "known", { sensitivity: "public" });
        else await host.add({ id: "ref", url: await httpServer() }, "known", { sensitivity: "public" });
        const add = registry.enabledTools().find((t) => t.name === "ref.add")!;
        expect(add.effects).toEqual(["read"]); expect(add.producesUntrusted).toBe(false);
        const mixed = await host.call("ref.mixed", {});
        expect(mixed.parts!.map((p) => [p.trust, p.origin.locator ?? null])).toEqual([
          ["untrusted", null], ["untrusted", "https://evil.example/doc"], ["untrusted", "https://evil.example/next"], ["untrusted", null],
        ]);
        const sum = await host.call("ref.add", { a: 1, b: 2 });
        expect(sum.parts!.every((p) => p.trust === "trusted" && p.sensitivity === "public")).toBe(true);
        expect(await host.liveDescriptors("ref")).toBeDefined();
        expect(registry.verify("ref", (await host.liveDescriptors("ref"))!)).toBe("ok");
      } finally { host.closeAll(); }
    });
  });
}
