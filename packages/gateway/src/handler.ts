import { LaneQueue, QueueOverflowError, makeSessionKey, type SessionKey } from "@august/core";
import {
  allowedHostHeaders,
  allowedOriginList,
  assertSafeBind,
  bearerToken,
  tokensEqual,
  type BindConfig,
} from "./guard.ts";

export const MAX_BODY_BYTES = 64 * 1024;

export interface IncomingMessage {
  session: SessionKey;
  text: string;
}

export interface ApprovalView {
  /** Identifies the approval. Shown to the person and handed back with the answer. */
  id: string;
  /** Secret half of the binding: the answer must return the one that was displayed. */
  nonce: string;
  tool: string;
  reason: string;
  details?: string;
  args: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

export type ApprovalAnswer = { ok: true; status: "approved" | "denied" } | { ok: false; reason: "unknown" | "nonce" | "session" | "resolver" | "expired" | "already-resolved" };

export interface GatewayApprovals {
  /** The approval this session is waiting on, if any. */
  pending(session: SessionKey): ApprovalView | null;
  /** Answer that approval by id and nonce. Nothing else can be resolved through it. */
  resolve(input: { session: SessionKey; approvalId: string; nonce: string; allow: boolean }): ApprovalAnswer;
}

export interface WebUi {
  html: string;
  js: string;
}

export interface GatewayOptions extends BindConfig {
  workspace: string;
  /** The agent loop. Called serially per session, in parallel across sessions. */
  onMessage(message: IncomingMessage): Promise<{ reply: string }>;
  queue?: LaneQueue;
  /** Approvals for browser and API clients. They bypass the lane: the lane is busy waiting for them. */
  approvals?: GatewayApprovals;
  /** Chat page served at "/". The token reaches it in the URL fragment, which browsers never send. */
  webUi?: WebUi;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Builds the request handler without binding a port, so every rule can be
 * tested directly. Order: Host (DNS rebinding) -> Origin (cross-site pages)
 * -> token (header only) -> route.
 */
export function createGatewayHandler(options: GatewayOptions): (request: Request) => Promise<Response> {
  assertSafeBind(options);
  const hosts = allowedHostHeaders(options);
  const origins = allowedOriginList(options);
  const queue = options.queue ?? new LaneQueue();

  return async (request) => {
    const host = request.headers.get("host")?.toLowerCase() ?? "";
    if (!hosts.has(host)) return json(421, { error: "unexpected host" });

    const origin = request.headers.get("origin");
    if (origin !== null && !origins.has(origin.toLowerCase())) {
      return json(403, { error: "origin not allowed" });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json(200, { ok: true });
    if (options.webUi && request.method === "GET" && (url.pathname === "/" || url.pathname === "/app.js")) {
      const isJs = url.pathname === "/app.js";
      return new Response(isJs ? options.webUi.js : options.webUi.html, {
        headers: {
          "content-type": isJs ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }

    // A token in the URL ends up in logs, history and Referer headers.
    if (url.searchParams.has("token")) {
      return json(400, { error: "send the token in the Authorization header, not the URL" });
    }
    const given = bearerToken(request);
    if (given === null || !tokensEqual(given, options.token)) {
      return json(401, { error: "unauthorized" });
    }

    const sessionFrom = (channel: unknown, user: unknown): SessionKey | null => {
      if (typeof channel !== "string" || typeof user !== "string") return null;
      try {
        return makeSessionKey({ workspace: options.workspace, channel, user });
      } catch {
        return null;
      }
    };

    if (url.pathname === "/v1/pending" && request.method === "GET") {
      const session = sessionFrom(url.searchParams.get("channel"), url.searchParams.get("user"));
      if (!session) return json(400, { error: "channel and user are required" });
      return json(200, { approval: options.approvals?.pending(session) ?? null });
    }

    if (url.pathname === "/v1/approve" && request.method === "POST") {
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        return json(415, { error: "content-type must be application/json" });
      }
      const raw = await readBody(request);
      if (raw === null) return json(413, { error: "body too large" });
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) ?? {};
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      const session = sessionFrom(payload.channel, payload.user);
      if (!session || typeof payload.allow !== "boolean" || typeof payload.approvalId !== "string" || typeof payload.nonce !== "string") {
        return json(400, { error: "channel, user, approvalId, nonce and allow are required" });
      }
      const answer = options.approvals?.resolve({ session, approvalId: payload.approvalId, nonce: payload.nonce, allow: payload.allow }) ?? { ok: false as const, reason: "unknown" as const };
      if (answer.ok) return json(200, { ok: true, status: answer.status });
      // A wrong nonce or session says nothing about whether the id exists; both look the same from outside.
      const gone = answer.reason === "expired" || answer.reason === "already-resolved";
      return json(gone ? 410 : 409, { error: gone ? "that approval is no longer open" : "no matching approval is waiting" });
    }

    if (url.pathname === "/v1/message" && request.method === "POST") {
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        return json(415, { error: "content-type must be application/json" });
      }
      const raw = await readBody(request);
      if (raw === null) return json(413, { error: "body too large" });

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      const { channel, user, text } = (payload ?? {}) as Record<string, unknown>;
      if (typeof channel !== "string" || typeof user !== "string" || typeof text !== "string" || text.length === 0) {
        return json(400, { error: "channel, user and text are required strings" });
      }
      let session: SessionKey;
      try {
        session = makeSessionKey({ workspace: options.workspace, channel, user });
      } catch {
        return json(400, { error: "invalid channel or user" });
      }
      try {
        const result = await queue.enqueue(session, () => options.onMessage({ session, text }));
        return json(200, { reply: result.reply });
      } catch (error) {
        if (error instanceof QueueOverflowError) return json(429, { error: "too many pending messages" });
        return json(500, { error: "agent failed" });
      }
    }

    return json(404, { error: "not found" });
  };
}

export interface RunningGateway {
  readonly port: number;
  stop(): void;
}

export function startGateway(options: GatewayOptions): RunningGateway {
  const fetchHandler = createGatewayHandler(options);
  const server = Bun.serve({ hostname: options.hostname, port: options.port, fetch: fetchHandler });
  return { port: server.port ?? options.port, stop: () => void server.stop(true) };
}
