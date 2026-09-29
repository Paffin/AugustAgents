import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, connect, isIP, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface EgressRule {
  /** Lowercase host, or `*.suffix` for every subdomain of suffix (not the suffix itself). */
  host: string;
  port: number;
}

export const DEFAULT_EGRESS_PORT = 443;

/** `host`, `*.suffix`, or either with `:port`. Only https-style tunnels (port 443) unless a port is named. */
export function parseEgress(entries: readonly string[]): EgressRule[] {
  return entries.map((entry) => {
    const m = /^(.+?)(?::([0-9]{1,5}))?$/.exec(entry.trim().toLowerCase());
    const port = m?.[2] ? Number(m[2]) : DEFAULT_EGRESS_PORT;
    if (!m || !m[1] || port < 1 || port > 65535) throw new Error(`invalid egress entry "${entry}"`);
    return { host: m[1], port };
  });
}

export function ruleMatches(rule: EgressRule, host: string, port: number): boolean {
  if (rule.port !== port) return false;
  const h = host.toLowerCase();
  if (rule.host.startsWith("*.")) return h.endsWith(rule.host.slice(1)) && h.length > rule.host.length - 1;
  return rule.host === h;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** Only globally routable unicast addresses. Loopback, private, link-local (cloud metadata), CGNAT, documentation, multicast and reserved ranges are not. */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const n = ipv4ToInt(ip);
    return !V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(ipv4ToInt(base) / 2 ** (32 - bits)));
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex) { const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16); return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if (lower === "::" || lower === "::1") return false;
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8:") || lower.startsWith("2002:") || lower.startsWith("2001:0:") || lower.startsWith("2001:10:") || lower.startsWith("100:")) return false; // NAT64, documentation, 6to4, Teredo, ORCHID, discard
    return true;
  }
  return false;
}

export interface EgressDecision {
  /** Which capability the request came from. */
  capability: string;
  host: string;
  port: number;
  allowed: boolean;
  /** Why: `allowed`, `not-allowlisted`, `private-address`, `unresolvable`, `unsupported`, `bad-request`, `auth`, `busy`. */
  reason: string;
}

export interface EgressOptions {
  capability: string;
  rules: readonly EgressRule[];
  onDecision?: (decision: EgressDecision) => void;
  resolve?: (host: string) => Promise<string[]>;
  /** Tests only: let the proxy tunnel to loopback/private upstreams. Never set in the app. */
  insecureAllowPrivateForTests?: boolean;
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxHeadBytes?: number;
}

const defaultResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((a) => a.address);
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function refuse(socket: Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * A forward proxy that only tunnels (CONNECT) to allowlisted host and port pairs. The address is
 * resolved here, every address must be public (so an allowlisted name cannot be pointed at
 * localhost, the LAN or a cloud metadata service), and the connection goes to the address that was
 * checked, not to a second lookup. Plain HTTP requests are refused: nothing sensitive should cross
 * the wire unencrypted. With a token, callers must present it (needed when it listens on TCP).
 */
export class EgressProxy {
  private open = 0;
  private readonly sockets = new Set<Socket>();

  address: { path: string } | { host: string; port: number };

  private constructor(private readonly server: Server, private readonly options: EgressOptions & { token?: string }, address: EgressProxy["address"], readonly token?: string) {
    this.address = address;
    server.on("connection", (socket) => this.handle(socket));
  }

  static async listenUnix(path: string, options: EgressOptions): Promise<EgressProxy> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) unlinkSync(path);
    const server = createServer();
    const proxy = new EgressProxy(server, options, { path });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
    return proxy;
  }

  /** Loopback TCP with a per-listener token: for platforms whose sandbox shares the host's network namespace. */
  static async listenTcp(options: EgressOptions): Promise<EgressProxy> {
    const token = randomBytes(18).toString("base64url");
    const server = createServer();
    const proxy = new EgressProxy(server, { ...options, token }, { host: "127.0.0.1", port: 0 }, token);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    proxy.address = { host: "127.0.0.1", port: (server.address() as { port: number }).port };
    return proxy;
  }

  /** Stops listening and cuts every tunnel that is still open. */
  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private decide(host: string, port: number, allowed: boolean, reason: string): void {
    this.options.onDecision?.({ capability: this.options.capability, host, port, allowed, reason });
  }

  private handle(client: Socket): void {
    const { maxConnections = 32, idleTimeoutMs = 60_000, maxHeadBytes = 8192 } = this.options;
    client.on("error", () => client.destroy());
    this.sockets.add(client); client.once("close", () => this.sockets.delete(client));
    if (this.open >= maxConnections) { this.decide("", 0, false, "busy"); return refuse(client, "503 Service Unavailable"); }
    this.open += 1;
    client.once("close", () => { this.open -= 1; });
    client.setTimeout(idleTimeoutMs, () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) { if (head.length > maxHeadBytes) { this.decide("", 0, false, "bad-request"); client.destroy(); } return; }
      client.off("data", onData);
      client.pause();
      void this.tunnel(client, head.subarray(0, end).toString("latin1"), head.subarray(end + 4));
    };
    client.on("data", onData);
  }

  private async tunnel(client: Socket, head: string, rest: Buffer): Promise<void> {
    const lines = head.split("\r\n");
    const m = /^CONNECT (\[[0-9a-fA-F:.]+\]|[^\s:\/]+):([0-9]{1,5}) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
    if (!m) { this.decide("", 0, false, "unsupported"); return refuse(client, "403 Forbidden"); }
    const host = m[1]!.replace(/^\[|\]$/g, "").toLowerCase(); const port = Number(m[2]);
    if (this.options.token !== undefined) {
      const auth = lines.find((l) => /^proxy-authorization:/i.test(l))?.split(":").slice(1).join(":").trim() ?? "";
      const given = /^Basic (.+)$/i.exec(auth)?.[1];
      const expected = Buffer.from(`august:${this.options.token}`).toString("base64");
      if (!given || given !== expected) { this.decide(host, port, false, "auth"); return refuse(client, "407 Proxy Authentication Required"); }
    }
    if (port < 1 || port > 65535 || (!isIP(host) && !HOSTNAME.test(host)) || host.length > 253) { this.decide(host, port, false, "bad-request"); return refuse(client, "400 Bad Request"); }
    if (!this.options.rules.some((rule) => ruleMatches(rule, host, port))) { this.decide(host, port, false, "not-allowlisted"); return refuse(client, "403 Forbidden"); }
    let addresses: string[];
    try {
      addresses = isIP(host) ? [host] : await (this.options.resolve ?? defaultResolve)(host);
    } catch {
      this.decide(host, port, false, "unresolvable");
      return refuse(client, "502 Bad Gateway");
    }
    if (addresses.length === 0) { this.decide(host, port, false, "unresolvable"); return refuse(client, "502 Bad Gateway"); }
    if (!this.options.insecureAllowPrivateForTests && !addresses.every(isPublicAddress)) { this.decide(host, port, false, "private-address"); return refuse(client, "403 Forbidden"); }
    const upstream = connect({ host: addresses[0]!, port, timeout: this.options.connectTimeoutMs ?? 10_000 });
    upstream.once("timeout", () => upstream.destroy());
    upstream.on("error", () => { if (!client.destroyed) refuse(client, "502 Bad Gateway"); });
    upstream.once("connect", () => {
      upstream.setTimeout(this.options.idleTimeoutMs ?? 60_000, () => upstream.destroy());
      this.decide(host, port, true, "allowed");
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) upstream.write(rest);
      this.sockets.add(upstream); upstream.once("close", () => this.sockets.delete(upstream));
      client.pipe(upstream); upstream.pipe(client);
      client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
      client.resume();
    });
  }
}

/**
 * Runs inside the sandbox on Linux, where the server has no network at all: it listens on the
 * sandbox's own loopback and hands every connection to the proxy's unix socket. Anything that does
 * not go through it has nowhere to connect. Standalone on purpose: no imports beyond node:net, so
 * it runs under whichever runtime is bound into the sandbox.
 */
export const EGRESS_BRIDGE_JS = `
const net = require("node:net");
const sock = process.env.AUGUST_EGRESS_SOCK;
const port = Number(process.env.AUGUST_EGRESS_PORT || 3128);
if (!sock) { console.error("AUGUST_EGRESS_SOCK is not set"); process.exit(2); }
net.createServer((client) => {
  const up = net.connect(sock);
  client.on("error", () => up.destroy()); up.on("error", () => client.destroy());
  client.pipe(up); up.pipe(client);
}).listen(port, "127.0.0.1");
`;
