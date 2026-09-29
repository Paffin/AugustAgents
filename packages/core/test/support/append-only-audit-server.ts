/** Owned independent-process fixture, NOT a deployed immutable custody service. */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnchorLog, anchorHash, verifyAnchorSignature } from "../../src/audit.ts";
import { parseAuditAnchor } from "../../src/external-audit.ts";

const directory = process.argv[2]!;
const config = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8")) as {
  token: string; publicKey: string; mode?: "normal" | "drop-ack" | "redirect" | "cycle" | "large" | "hang" | "error";
  redirectTo?: string; tls?: boolean;
};
const log = new AnchorLog(join(directory, "external-anchors.jsonl"));
const key = Buffer.from(config.publicKey, "base64");
const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
let dropped = false; let posts = 0; let requests = 0;
const authorized = (request: Request) => {
  const expected = Buffer.from(`Bearer ${config.token}`), actual = Buffer.from(request.headers.get("authorization") ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  ...(config.tls ? { tls: { cert: readFileSync(join(directory, "certificate.pem")), key: readFileSync(join(directory, "private.pem")) } } : {}),
  async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  requests++;
  if (!authorized(request)) return new Response(null, { status: 401 });
  if (url.pathname === "/stats") return Response.json({ posts, requests, anchors: log.list().length });
  if (url.pathname !== "/anchors") return new Response(null, { status: 404 });
  if (config.mode === "redirect") return new Response(null, { status: 307, headers: { Location: config.redirectTo! } });
  if (config.mode === "large") return new Response("x".repeat(1024 * 1024));
  if (config.mode === "error") return Response.json({ error: config.token }, { status: 500 });
  if (config.mode === "hang") return new Promise<Response>(() => {});
  if (request.method === "GET") {
    const after = Number(url.searchParams.get("after") ?? 0), limit = Number(url.searchParams.get("limit") ?? 128);
    const anchors = log.list().filter(a => a.n > after);
    if (config.mode === "cycle") return Response.json({ anchors: anchors.slice(0, limit), nextAfter: after });
    const page = anchors.slice(0, limit);
    return Response.json({ anchors: page, nextAfter: anchors.length > limit ? page.at(-1)!.n : null });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    const anchor = parseAuditAnchor(await request.json());
    if (anchor.keyId !== id || request.headers.get("idempotency-key") !== anchorHash(anchor)) return new Response(null, { status: 400 });
    const existing = log.list();
    const duplicate = existing[anchor.n - 1];
    if (duplicate) return anchorHash(duplicate) === anchorHash(anchor)
      ? Response.json({ hash: anchorHash(anchor) }) : new Response(null, { status: 409 });
    if (anchor.n !== existing.length + 1) return new Response(null, { status: 409 });
    // Independent verifier has only public metadata/key, not the app journal or signing key.
    const signed = JSON.stringify([anchor.n, anchor.seq, anchor.hash, anchor.ts, anchor.prev, anchor.keyId]);
    const previous = existing.at(-1);
    if (!verifyAnchorSignature(key, signed, anchor.sig) || anchor.prev !== (previous ? anchorHash(previous) : "0".repeat(64)) ||
        anchor.seq <= (previous?.seq ?? 0)) return new Response(null, { status: 409 });
    log.append(anchor); posts++;
    if (config.mode === "drop-ack" && !dropped) { dropped = true; return new Response(null, { status: 503 }); }
    return Response.json({ hash: anchorHash(anchor) }, { status: 201 });
  } catch { return new Response(null, { status: 400 }); }
} });
console.log(JSON.stringify({ url: `${config.tls ? "https" : "http"}://127.0.0.1:${server.port}/anchors` }));
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
