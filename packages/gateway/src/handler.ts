import { LaneQueue, QueueOverflowError, makeSessionKey, normalizeRunBudget, type RunBudget, type RunBudgetRequest, type RunState, type RunUsage, type SessionKey } from "@august/core";
import {
  allowedHostHeaders,
  allowedOriginList,
  assertSafeBind,
  bearerToken,
  tokensEqual,
  type BindConfig,
} from "./guard.ts";

export const MAX_BODY_BYTES = 64 * 1024;

/** The owner's verdict on an answer they were shown. Throws when the run is not theirs or was already judged. */
export type FeedbackSink = (input: { session: SessionKey; runId: string; feedbackId: string; verdict: "success" | "failure"; note?: string }) => void;

export interface IncomingMessage {
  session: SessionKey;
  text: string;
  budget?: RunBudgetRequest;
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

/** Owner credential controls. Deliberately no value-reading operation. */
export interface GatewaySecrets {
  list(): { backend: string; names: readonly string[] };
  set(name: string, value: string): void;
  delete(name: string): void;
}

const SECRET_API_NAME = /^(?:[A-Za-z0-9_-]{1,64}\.)?[A-Z_][A-Z0-9_]{0,127}$/;

export interface GatewayRunView {
  id: string; state: RunState; request: string; steps: number; usage: RunUsage;
  budget: RunBudget; canResume: boolean; reply?: string; feedbackId?: string; feedbackRecorded?: boolean; updatedAt: number;
  accounting?: import("@august/core").ModelAccounting;
  unresolvedAttempts?: Array<Pick<import("@august/core").ModelAttempt, "id" | "provider" | "model" | "state" | "quote" | "reservedTokens" | "reservedCostMicros">>;
}
export interface GatewayRuns {
  list(session: SessionKey, limit: number): readonly GatewayRunView[];
  control(input: { session: SessionKey; id: string; action: "pause" | "cancel" | "resume" }): Promise<GatewayRunView>;
  reconcile?(input: { session: SessionKey; attemptId: string; inputTokens: number; outputTokens: number }): Promise<GatewayRunView>;
}

export interface GatewayOptions extends BindConfig {
  workspace: string;
  /** The agent loop. Called serially per session, in parallel across sessions. */
  onMessage(message: IncomingMessage): Promise<{ reply: string; runId?: string; state?: RunState; feedbackId?: string }>;
  /** Records the owner's judgement of an answer as an independent outcome. Absent: the route answers 404. */
  feedback?: FeedbackSink;
  queue?: LaneQueue;
  /** Approvals for browser and API clients. They bypass the lane: the lane is busy waiting for them. */
  approvals?: GatewayApprovals;
  /** Chat page served at "/". The token reaches it in the URL fragment, which browsers never send. */
  webUi?: WebUi;
  /** Owner-token-only controls; absent (including plaintext backends): 404. */
  secrets?: GatewaySecrets;
  runs?: GatewayRuns;
  /** Owner-only status; never includes endpoint credentials or journal contents. */
  audit?: () => { state: "not-configured" | "pending" | "published" | "unavailable" | "conflict"; anchoredThrough: number; localThrough: number; checkedAt?: number };
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

    if (url.pathname === "/v1/audit" && request.method === "GET") {
      if (!options.audit) return json(404, { error: "audit status unavailable" });
      try { return json(200, options.audit()); }
      catch { return json(503, { error: "audit status unavailable" }); }
    }
    if (url.pathname === "/v1/runs" && request.method === "GET") {
      if (!options.runs) return json(404, { error: "run controls unavailable" });
      const session = sessionFrom(url.searchParams.get("channel"), url.searchParams.get("user"));
      const limit = Number(url.searchParams.get("limit") ?? 20);
      if (!session || !Number.isInteger(limit) || limit < 1 || limit > 50) return json(400, { error: "invalid session or limit" });
      try { return json(200, { runs: options.runs.list(session, limit) }); }
      catch { return json(409, { error: "run session unavailable" }); }
    }
    if (url.pathname.startsWith("/v1/runs/") && request.method === "POST") {
      if (!options.runs) return json(404, { error: "run controls unavailable" });
      const id = url.pathname.slice("/v1/runs/".length);
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || id !== id.trim()) return json(400, { error: "invalid run id" });
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "content-type must be application/json" });
      const raw = await readBody(request); if (raw === null) return json(413, { error: "body too large" });
      let body: Record<string, unknown>;
      try { const value = JSON.parse(raw); if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(); body = value; } catch { return json(400, { error: "invalid JSON" }); }
      const session = sessionFrom(body.channel, body.user);
      if (!session || typeof body.action !== "string" || !["pause", "cancel", "resume"].includes(body.action) || Object.keys(body).some(key => !["channel", "user", "action"].includes(key))) return json(400, { error: "invalid run control" });
      try { return json(200, { run: await options.runs.control({ session, id, action: body.action as "pause" | "cancel" | "resume" }) }); }
      catch { return json(409, { error: "run unavailable or unsafe to control" }); }
    }
    if (url.pathname.startsWith("/v1/model-attempts/") && request.method === "POST") {
      if (!options.runs?.reconcile) return json(404, { error: "model reconciliation unavailable" });
      const attemptId = url.pathname.slice("/v1/model-attempts/".length);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(attemptId) || attemptId !== attemptId.trim()) return json(400, { error: "invalid model attempt" });
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "content-type must be application/json" });
      const raw = await readBody(request); if (raw === null) return json(413, { error: "body too large" });
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); if (!body || typeof body !== "object" || Array.isArray(body)) throw Error(); } catch { return json(400, { error: "invalid JSON" }); }
      const session = sessionFrom(body.channel, body.user), input = body.inputTokens, output = body.outputTokens;
      if (!session || body.confirm !== true || ![input,output].every(value => Number.isSafeInteger(value) && (value as number) >= 0) || !Number.isSafeInteger((input as number) + (output as number)) || Object.keys(body).some(key => !["channel","user","inputTokens","outputTokens","confirm"].includes(key))) return json(400, { error: "confirmed non-negative usage is required" });
      try { return json(200, { run: await options.runs.reconcile({ session, attemptId, inputTokens: input as number, outputTokens: output as number }) }); }
      catch { return json(409, { error: "model attempt unavailable or conflicting receipt" }); }
    }

    if (url.pathname === "/v1/secrets" && request.method === "GET") {
      if (!options.secrets) return json(404, { error: "secure credential controls unavailable" });
      try { const snapshot = options.secrets.list(); return json(200, { backend: snapshot.backend, names: [...snapshot.names] }); }
      catch { return json(500, { error: "credential store unavailable" }); }
    }
    if (url.pathname.startsWith("/v1/secrets/") && (request.method === "PUT" || request.method === "DELETE")) {
      if (!options.secrets) return json(404, { error: "secure credential controls unavailable" });
      let name: string;
      try { name = decodeURIComponent(url.pathname.slice("/v1/secrets/".length)); } catch { return json(400, { error: "invalid credential name" }); }
      if (!SECRET_API_NAME.test(name) || name !== name.trim()) return json(400, { error: "invalid credential name" });
      if (request.method === "DELETE") {
        try { options.secrets.delete(name); return json(200, { ok: true }); }
        catch { return json(500, { error: "credential store unavailable" }); }
      }
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "content-type must be application/json" });
      const raw = await readBody(request);
      if (raw === null) return json(413, { error: "body too large" });
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { return json(400, { error: "invalid JSON" }); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some(key => key !== "value")) return json(400, { error: "only value is accepted" });
      const value = (payload as { value?: unknown }).value;
      if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 8192) return json(400, { error: "credential value must contain 1 to 8192 bytes" });
      try { options.secrets.set(name, value); return json(200, { ok: true }); }
      catch { return json(500, { error: "credential store unavailable" }); }
    }

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

    if (url.pathname === "/v1/feedback" && request.method === "POST") {
      if (!options.feedback) return json(404, { error: "not found" });
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "content-type must be application/json" });
      const raw = await readBody(request);
      if (raw === null) return json(413, { error: "body too large" });
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(raw) ?? {}; } catch { return json(400, { error: "invalid JSON" }); }
      const session = sessionFrom(payload.channel, payload.user);
      if (!session || typeof payload.runId !== "string" || payload.runId.length === 0 || payload.runId.length > 200 || typeof payload.feedbackId !== "string" || payload.feedbackId.length === 0 || payload.feedbackId.length > 220 || (payload.feedbackId !== payload.runId && !payload.feedbackId.startsWith(payload.runId + "~")) || (payload.verdict !== "success" && payload.verdict !== "failure") || (payload.note !== undefined && (typeof payload.note !== "string" || payload.note.length > 300))) {
        return json(400, { error: "channel, user, runId, matching feedbackId and verdict are required" });
      }
      try {
        options.feedback({ session, runId: payload.runId, feedbackId: payload.feedbackId, verdict: payload.verdict, note: payload.note as string | undefined });
        return json(200, { ok: true });
      } catch (error) {
        // Not theirs, unknown or already judged look the same from outside.
        return json(/already/.test((error as Error).message) ? 410 : 409, { error: /already/.test((error as Error).message) ? "that answer was already judged" : "no such answer for this session" });
      }
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
      const { channel, user, text, budget } = (payload ?? {}) as Record<string, unknown>;
      if (typeof channel !== "string" || typeof user !== "string" || typeof text !== "string" || text.length === 0) {
        return json(400, { error: "channel, user and text are required strings" });
      }
      if (budget !== undefined) {
        if (!budget || typeof budget !== "object" || Array.isArray(budget) || Object.keys(budget).some((key) => !["maxSteps", "maxWallMs", "maxExternalEffects", "maxTokens", "maxCostMicros"].includes(key))) return json(400, { error: "invalid budget" });
        try { normalizeRunBudget(budget as RunBudgetRequest); } catch { return json(400, { error: "invalid budget" }); }
      }
      let session: SessionKey;
      try {
        session = makeSessionKey({ workspace: options.workspace, channel, user });
      } catch {
        return json(400, { error: "invalid channel or user" });
      }
      try {
        const result = await queue.enqueue(session, () => options.onMessage({ session, text, ...(budget === undefined ? {} : { budget: budget as RunBudgetRequest }) }));
        return json(200, { reply: result.reply, ...(result.runId ? { runId: result.runId } : {}), ...(result.state ? { state: result.state } : {}), ...(result.feedbackId ? { feedbackId: result.feedbackId } : {}) });
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
