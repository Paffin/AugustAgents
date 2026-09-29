import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { anchorHash, verifyAudit, type AnchorLog, type AuditAnchor, type AuditReport } from "./audit.ts";
import type { EventJournal } from "./journal.ts";

/** The endpoint's independent append-only custody is an owner trust boundary, not a property of HTTP. */
export interface ExternalAnchorTransport {
  list(): Promise<AuditAnchor[]>;
  append(anchor: AuditAnchor): Promise<void>;
}

export class ExternalAuditUnavailable extends Error {
  constructor() { super("external audit evidence is unavailable"); this.name = "ExternalAuditUnavailable"; }
}
export class ExternalAuditConflict extends Error {
  constructor() { super("external audit anchors conflict with retained evidence"); this.name = "ExternalAuditConflict"; }
}

export interface ExternalAnchorHttpOptions {
  /** Collection URL: GET ?after=N&limit=N → {anchors,nextAfter}; POST anchor → {hash}. */
  url: string;
  /** Resolved by the owner adapter; never store this value in config or model context. */
  token: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxPages?: number;
  pageSize?: number;
  signal?: AbortSignal;
  /** Explicit owner TLS trust anchor; verification is never disabled. */
  certificateAuthority?: Buffer;
  /** DNS seam for deterministic security regression; production defaults to OS lookup. */
  resolve?: (host: string) => Promise<string[]>;
}

const HEX = /^[0-9a-f]{64}$/;
const FIELDS = ["n", "seq", "hash", "ts", "prev", "keyId", "sig"];
/** Validate untrusted metadata without preserving arbitrary content fields. */
export function parseAuditAnchor(value: unknown): AuditAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExternalAuditUnavailable();
  const a = value as Record<string, unknown>;
  if (Object.keys(a).length !== FIELDS.length || FIELDS.some(k => !(k in a)) ||
      !Number.isSafeInteger(a.n) || (a.n as number) < 1 || !Number.isSafeInteger(a.seq) || (a.seq as number) < 1 ||
      !Number.isSafeInteger(a.ts) || (a.ts as number) < 0 || typeof a.hash !== "string" || !HEX.test(a.hash) ||
      typeof a.prev !== "string" || !HEX.test(a.prev) || typeof a.keyId !== "string" || !/^[0-9a-f]{16}$/.test(a.keyId) ||
      typeof a.sig !== "string" || a.sig.length !== 88 || Buffer.from(a.sig, "base64").length !== 64 ||
      Buffer.from(a.sig, "base64").toString("base64") !== a.sig) throw new ExternalAuditUnavailable();
  return { n: a.n as number, seq: a.seq as number, hash: a.hash, ts: a.ts as number,
    prev: a.prev, keyId: a.keyId, sig: a.sig };
}

const bounded = (n: number | undefined, fallback: number, maximum: number): number => {
  const value = n ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ExternalAuditUnavailable();
  return value;
};
const v4 = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
function publicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return !BLOCKED_V4.some(([base, bits]) =>
    Math.floor(v4(ip) / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits)));
  if (isIP(ip) !== 6 || ip.includes("%")) return false;
  const [first = "0", second = "0"] = ip.toLowerCase().split(":");
  const a = parseInt(first || "0", 16), b = parseInt(second || "0", 16);
  // Conservative global-unicast policy: reject mapped/NAT64, 6to4, special 2001 and 3ffe/3fff ranges.
  // RFC 9637 reserves 3fff::/20 as non-forwardable documentation space.
  return a >= 0x2000 && a < 0x3ffe && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
}
const numericLoopback = (host: string) => host === "::1" || (isIP(host) === 4 && host.startsWith("127."));

/** No redirects/proxy inheritance. DNS results are validated, then the request connects to that exact numeric IP. */
export function externalAnchorHttp(options: ExternalAnchorHttpOptions): ExternalAnchorTransport {
  let base: URL;
  try { base = new URL(options.url); } catch { throw new ExternalAuditUnavailable(); }
  const host = base.hostname.replace(/^\[|\]$/g, "");
  const local = numericLoopback(host);
  if (base.username || base.password || base.search || base.hash || base.port === "0" ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && local)) ||
      (!local && isIP(host) && !publicAddress(host)) || /[\r\n]/.test(options.token) ||
      !options.token || options.token.length > 8192) throw new ExternalAuditUnavailable();
  const timeoutMs = bounded(options.timeoutMs, 5000, 60_000);
  const maxResponseBytes = bounded(options.maxResponseBytes, 256 * 1024, 1024 * 1024);
  const maxPages = bounded(options.maxPages, 128, 1024);
  const pageSize = bounded(options.pageSize, 128, 512);
  const resolve = options.resolve ?? (async h => (await lookup(h, { all: true })).map(x => x.address));

  async function exchange(method: "GET" | "POST", after?: number, anchor?: AuditAnchor): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      if (signal.aborted) throw new ExternalAuditUnavailable();
      const addresses = local || isIP(host) ? [host] : await Promise.race([
        resolve(host), new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new ExternalAuditUnavailable()), { once: true })),
      ]);
      if (!addresses.length || (!local && !addresses.every(publicAddress))) throw new ExternalAuditUnavailable();
      const target = new URL(base);
      if (after !== undefined) { target.searchParams.set("after", String(after)); target.searchParams.set("limit", String(pageSize)); }
      const address = addresses[0]!;
      target.hostname = isIP(address) === 6 ? `[${address}]` : address;
      const payload = anchor ? JSON.stringify(anchor) : undefined;
      return await new Promise<unknown>((accept, reject) => {
        const req = (base.protocol === "https:" ? httpsRequest : httpRequest)(target, {
          method, agent: false, signal, rejectUnauthorized: true,
          ...(options.certificateAuthority ? { ca: options.certificateAuthority } : {}),
          ...(!isIP(host) && base.protocol === "https:" ? { servername: host } : {}),
          headers: { Host: base.host, Authorization: `Bearer ${options.token}`, Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "Idempotency-Key": anchorHash(anchor!) } : {}) },
        }, response => {
          if (response.statusCode === 409) { response.destroy(); reject(new ExternalAuditConflict()); return; }
          if (response.statusCode !== 200 && !(method === "POST" && response.statusCode === 201)) {
            response.destroy(); reject(new ExternalAuditUnavailable()); return;
          }
          let bytes = 0; const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxResponseBytes) { response.destroy(); reject(new ExternalAuditUnavailable()); }
            else chunks.push(chunk);
          });
          response.on("error", () => reject(new ExternalAuditUnavailable()));
          response.on("end", () => { try { accept(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new ExternalAuditUnavailable()); } });
        });
        req.on("error", () => reject(new ExternalAuditUnavailable()));
        req.end(payload);
      });
    } catch (error) {
      if (error instanceof ExternalAuditConflict) throw error;
      throw new ExternalAuditUnavailable();
    } finally { clearTimeout(timer); }
  }
  return {
    async list() {
      const anchors: AuditAnchor[] = []; let after = 0;
      for (let page = 0; page < maxPages; page++) {
        const result = await exchange("GET", after) as { anchors?: unknown; nextAfter?: unknown } | null;
        if (!result || !Array.isArray(result.anchors) || result.anchors.length > pageSize ||
            !(result.nextAfter === null || Number.isSafeInteger(result.nextAfter))) throw new ExternalAuditUnavailable();
        const received = result.anchors.map(parseAuditAnchor);
        if (received.some((a, i) => a.n <= (received[i - 1]?.n ?? after))) throw new ExternalAuditUnavailable();
        anchors.push(...received);
        if (result.nextAfter === null) return anchors;
        if (!received.length || result.nextAfter !== received.at(-1)!.n) throw new ExternalAuditUnavailable();
        after = result.nextAfter as number;
      }
      throw new ExternalAuditUnavailable();
    },
    async append(anchor) {
      const safe = parseAuditAnchor(anchor);
      const result = await exchange("POST", undefined, safe) as { hash?: unknown } | null;
      if (!result || result.hash !== anchorHash(safe)) throw new ExternalAuditUnavailable();
    },
  };
}

export type ExternalAuditResult =
  | { state: "verified" | "tampered" | "unanchored"; report: AuditReport }
  | { state: "unavailable"; reason: "transport" | "unsupported-key" };
const keyId = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** An unanchored tail is exposure, not proof of truncation. Unknown key rotation is not silently trusted. */
export async function verifyExternalAudit(journal: EventJournal, transport: ExternalAnchorTransport, trustedPublicKey: Buffer): Promise<ExternalAuditResult> {
  let anchors: AuditAnchor[];
  try { anchors = (await transport.list()).map(parseAuditAnchor); } catch { return { state: "unavailable", reason: "transport" }; }
  if (anchors.some(a => a.keyId !== keyId(trustedPublicKey))) return { state: "unavailable", reason: "unsupported-key" };
  const report = verifyAudit(journal, anchors, trustedPublicKey, keyId(trustedPublicKey));
  return { state: report.ok ? (anchors.length ? "verified" : "unanchored") : "tampered", report };
}

/** Local signed AnchorLog is the durable backlog; readback resolves a lost POST acknowledgement without a new outbox. */
export async function publishExternalAnchors(journal: EventJournal, local: Pick<AnchorLog, "list">, transport: ExternalAnchorTransport, trustedPublicKey: Buffer): Promise<{ published: number; anchoredThrough: number }> {
  const external = (await transport.list()).map(parseAuditAnchor);
  const retained = local.list().map(parseAuditAnchor);
  if (retained.some(a => a.keyId !== keyId(trustedPublicKey))) throw new ExternalAuditUnavailable();
  if (!verifyAudit(journal, retained, trustedPublicKey, keyId(trustedPublicKey)).ok) throw new ExternalAuditConflict();
  if (external.length > retained.length || external.some((a, i) => anchorHash(a) !== anchorHash(retained[i]!))) throw new ExternalAuditConflict();
  let published = 0;
  for (const anchor of retained.slice(external.length)) { await transport.append(anchor); published++; }
  const confirmed = await transport.list();
  if (confirmed.length < retained.length || retained.some((a, i) => anchorHash(a) !== anchorHash(confirmed[i]!))) throw new ExternalAuditConflict();
  return { published, anchoredThrough: retained.at(-1)?.seq ?? 0 };
}
