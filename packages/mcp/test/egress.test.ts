import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressProxy, isPublicAddress, parseEgress, ruleMatches, type EgressDecision, type EgressOptions } from "../src/index.ts";

// Suite category: Safety/security invariant (REQ-SEC-003 egress allowlists, SSRF and DNS-rebinding refusal).
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "august-egress-")); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };

async function echoServer(): Promise<number> {
  const server: Server = createServer((s) => s.on("data", (d) => s.write(`echo:${d}`)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); cleanup.push(() => void server.close());
  return (server.address() as { port: number }).port;
}
async function proxy(rules: string[], extra: Partial<EgressOptions> = {}) {
  const decisions: EgressDecision[] = [];
  const p = await EgressProxy.listenUnix(join(dir(), "e.sock"), { capability: "cap", rules: parseEgress(rules), onDecision: (d) => decisions.push(d), ...extra });
  cleanup.push(() => p.close());
  return { p, decisions, path: (p.address as { path: string }).path };
}
/** Sends a raw request and returns everything the proxy answers until it closes or `until` matches. */
function talk(path: string, request: string, then?: (s: Socket) => void, wait = 300): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(path); let out = "";
    s.on("data", (d) => { out += d; if (then && out.includes("200 Connection Established")) then(s); });
    s.on("error", () => resolve(out)); s.on("close", () => resolve(out));
    s.write(request); setTimeout(() => { s.destroy(); resolve(out); }, wait);
  });
}
const connectReq = (host: string, port: number, extra = "") => `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${extra}\r\n`;

describe("rules", () => {
  test("hosts and wildcards; a wildcard never matches its own apex; ports default to 443", () => {
    const rules = parseEgress(["API.Example.com", "*.cdn.example.org", "db.example.net:5432"]);
    expect(rules).toEqual([{ host: "api.example.com", port: 443 }, { host: "*.cdn.example.org", port: 443 }, { host: "db.example.net", port: 5432 }]);
    const ok = (h: string, p = 443) => rules.some((r) => ruleMatches(r, h, p));
    expect(ok("api.example.com")).toBe(true); expect(ok("API.EXAMPLE.COM")).toBe(true);
    expect(ok("x.cdn.example.org")).toBe(true); expect(ok("a.b.cdn.example.org")).toBe(true);
    expect(ok("cdn.example.org")).toBe(false); expect(ok("evilcdn.example.org")).toBe(false); expect(ok("api.example.com.evil.test")).toBe(false);
    expect(ok("api.example.com", 80)).toBe(false); expect(ok("db.example.net", 5432)).toBe(true); expect(ok("db.example.net")).toBe(false);
    expect(() => parseEgress(["x:99999"])).toThrow(/invalid egress/);
  });

  test("only globally routable addresses are public: loopback, private, link-local, metadata, CGNAT, documentation, multicast, mapped and 6to4 are not", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) expect(isPublicAddress(ip)).toBe(true);
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.51.100.7", "203.0.113.9", "198.18.0.1",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "2002:7f00:1::1", "64:ff9b::7f00:1", "2001:db8::1", "not-an-ip"]) expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
  });
});

describe("EgressProxy", () => {
  test("tunnels to an allowlisted host and port, and reports the decision", async () => {
    const port = await echoServer();
    const { path, decisions } = await proxy([`allowed.test:${port}`], { resolve: async () => ["127.0.0.1"], insecureAllowPrivateForTests: true });
    const out = await talk(path, connectReq("allowed.test", port), (s) => s.write("hi"));
    expect(out).toContain("HTTP/1.1 200 Connection Established"); expect(out).toContain("echo:hi");
    expect(decisions).toEqual([{ capability: "cap", host: "allowed.test", port, allowed: true, reason: "allowed" }]);
  });

  test("refuses hosts and ports that are not allowlisted, plain HTTP, and malformed requests", async () => {
    const { path, decisions } = await proxy(["allowed.test"]);
    expect(await talk(path, connectReq("other.test", 443))).toContain("403 Forbidden");
    expect(await talk(path, connectReq("allowed.test", 22))).toContain("403 Forbidden");
    expect(await talk(path, "GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n")).toContain("403 Forbidden");
    expect(await talk(path, "POST / HTTP/1.1\r\n\r\n")).toContain("403 Forbidden");
    expect(await talk(path, "CONNECT evil host:443 HTTP/1.1\r\n\r\n")).toContain("403 Forbidden");
    expect(await talk(path, connectReq("bad_host!", 443))).toContain("400 Bad Request");
    expect(decisions.map((d) => [d.host, d.reason])).toEqual([["other.test", "not-allowlisted"], ["allowed.test", "not-allowlisted"], ["", "unsupported"], ["", "unsupported"], ["", "unsupported"], ["bad_host!", "bad-request"]]);
    expect(decisions.every((d) => !d.allowed)).toBe(true);
  });

  test("an allowlisted name that resolves to a private address is refused, including DNS rebinding tricks with mixed answers", async () => {
    for (const answers of [["127.0.0.1"], ["10.0.0.5"], ["169.254.169.254"], ["::1"], ["93.184.216.34", "127.0.0.1"], ["::ffff:192.168.0.1"]]) {
      const { path, decisions } = await proxy(["rebind.test"], { resolve: async () => answers });
      expect(await talk(path, connectReq("rebind.test", 443))).toContain("403 Forbidden");
      expect(decisions.map((d) => d.reason)).toEqual(["private-address"]);
    }
  });

  test("IP-literal targets follow the same rules: not allowlisted, or allowlisted but private", async () => {
    const { path, decisions } = await proxy(["127.0.0.1", "169.254.169.254"]);
    expect(await talk(path, connectReq("8.8.8.8", 443))).toContain("403 Forbidden");
    expect(await talk(path, connectReq("127.0.0.1", 443))).toContain("403 Forbidden");
    expect(await talk(path, connectReq("169.254.169.254", 443))).toContain("403 Forbidden");
    expect(await talk(path, connectReq("[::1]", 443))).toContain("403 Forbidden");
    expect(decisions.map((d) => d.reason)).toEqual(["not-allowlisted", "private-address", "private-address", "not-allowlisted"]);
  });

  test("resolution failures are a bad gateway, not a leak", async () => {
    const { path, decisions } = await proxy(["gone.test"], { resolve: async () => { throw new Error("NXDOMAIN"); } });
    expect(await talk(path, connectReq("gone.test", 443))).toContain("502 Bad Gateway");
    expect((await proxy(["empty.test"], { resolve: async () => [] }).then(async ({ path: p }) => talk(p, connectReq("empty.test", 443))))).toContain("502");
    expect(decisions[0]!.reason).toBe("unresolvable");
  });

  test("limits: an oversized head, too many connections and idle sockets are cut", async () => {
    const { path } = await proxy(["allowed.test"], { maxHeadBytes: 64 });
    expect(await talk(path, `CONNECT allowed.test:443 HTTP/1.1\r\n${"X-Pad: y\r\n".repeat(50)}`)).toBe("");
    const busy = await proxy(["allowed.test"], { maxConnections: 1 });
    const holder = connect(busy.path); cleanup.push(() => void holder.destroy()); await Bun.sleep(30);
    expect(await talk(busy.path, connectReq("allowed.test", 443))).toContain("503");
    expect(busy.decisions.at(-1)!.reason).toBe("busy");
  });

  test("the unix socket is owner-only", async () => {
    const { path } = await proxy(["allowed.test"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a TCP listener demands its token, and knowing the port is not enough", async () => {
    const port = await echoServer();
    const p = await EgressProxy.listenTcp({ capability: "cap", rules: parseEgress([`allowed.test:${port}`]), resolve: async () => ["127.0.0.1"], insecureAllowPrivateForTests: true });
    cleanup.push(() => p.close());
    const { port: proxyPort } = p.address as { host: string; port: number };
    const viaTcp = (req: string) => new Promise<string>((resolve) => { const s = connect(proxyPort, "127.0.0.1"); let out = ""; s.on("data", (d) => { out += d; }); s.on("close", () => resolve(out)); s.write(req); setTimeout(() => { s.destroy(); resolve(out); }, 250); });
    expect(await viaTcp(connectReq("allowed.test", port))).toContain("407");
    expect(await viaTcp(connectReq("allowed.test", port, "Proxy-Authorization: Basic YXVndXN0Ondyb25n\r\n"))).toContain("407");
    const good = `Proxy-Authorization: Basic ${Buffer.from(`august:${p.token}`).toString("base64")}\r\n`;
    expect(await viaTcp(connectReq("allowed.test", port, good))).toContain("200 Connection Established");
  });
});
