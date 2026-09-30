import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface LocalEmbeddingOptions {
  baseUrl: string;
  model: string;
  /** Owner-supplied fingerprint of the weights and preprocessing, not an inferred model alias. */
  identity: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class LocalEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalEmbeddingError";
  }
}

/** Private memory is sent only to a deliberately configured embedding service on this machine. */
export class LocalEmbeddingClient {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly fingerprint: string;
  private readonly headers: Headers;
  private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private dimensions?: number;

  constructor(options: LocalEmbeddingOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new LocalEmbeddingError("invalid local embedding address"); }
    const local = url.hostname === "localhost" || url.hostname === "[::1]" || (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
    if (!["http:", "https:"].includes(url.protocol) || !local) throw new LocalEmbeddingError("embedding endpoint must be loopback on this machine");
    if (url.username || url.password || url.search || url.hash || url.port === "0") throw new LocalEmbeddingError("embedding address must not contain credentials, query or fragment, or port zero");
    // Do not let a hosts/DNS override of localhost send private text elsewhere.
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/embeddings`;
    if (typeof options.model !== "string" || !options.model.trim() || options.model !== options.model.trim()) throw new LocalEmbeddingError("embedding model must be explicitly configured");
    if (typeof options.identity !== "string" || !options.identity.trim() || options.identity !== options.identity.trim()) throw new LocalEmbeddingError("embedding identity must be explicitly configured");
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new LocalEmbeddingError("embedding timeout must be a positive bounded integer");
    if (options.apiKey !== undefined && (typeof options.apiKey !== "string" || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey))) throw new LocalEmbeddingError("invalid embedding credential");
    try {
      this.headers = new Headers({ "content-type": "application/json", accept: "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) });
    } catch { throw new LocalEmbeddingError("invalid embedding credential"); }
    this.endpoint = url.href;
    this.model = options.model;
    this.fingerprint = options.identity;
    this.fetchFn = options.fetch ?? directLocalFetch;
    this.timeoutMs = timeout;
  }

  get identity(): string { return this.fingerprint; }

  /** No model-specific prefixes, retries, remote fallback or price assumptions are applied. */
  async embed(text: string, options: { signal?: AbortSignal } = {}): Promise<number[]> {
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > MAX_INPUT_BYTES) throw new LocalEmbeddingError("embedding input must be nonempty and within the byte limit");
    if (options.signal?.aborted) throw new LocalEmbeddingError("embedding request was aborted");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      const response = await abortable(this.fetchFn(this.endpoint, {
        method: "POST", headers: this.headers, redirect: "error", signal,
        body: JSON.stringify({ model: this.model, input: text, encoding_format: "float" }),
      }), signal);
      if (response.redirected || response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new LocalEmbeddingError(response.redirected ? "embedding redirect is not allowed" : `embedding service HTTP ${response.status}`);
      }
      const body = await boundedJson(response, signal);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new LocalEmbeddingError("invalid embedding response");
      const result = body as { model?: unknown; data?: unknown };
      if (result.model !== this.model) throw new LocalEmbeddingError("embedding response model does not match configuration");
      if (!Array.isArray(result.data) || result.data.length !== 1) throw new LocalEmbeddingError("embedding response must contain one vector");
      const item = result.data[0] as { index?: unknown; embedding?: unknown } | null;
      if (!item || item.index !== 0 || !Array.isArray(item.embedding) || !item.embedding.length ||
        item.embedding.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value)) || !item.embedding.some((value: number) => value !== 0)) {
        throw new LocalEmbeddingError("embedding response must contain a finite nonzero vector at index zero");
      }
      if (this.dimensions !== undefined && this.dimensions !== item.embedding.length) throw new LocalEmbeddingError("embedding dimensions changed within one identity");
      this.dimensions = item.embedding.length;
      return item.embedding as number[];
    } catch (error) {
      if (options.signal?.aborted) throw new LocalEmbeddingError("embedding request was aborted");
      if (controller.signal.aborted) throw new LocalEmbeddingError("embedding request timed out");
      if (error instanceof LocalEmbeddingError) throw error;
      // Provider bodies, network errors and abort reasons may contain private input or credentials.
      throw new LocalEmbeddingError("local embedding request failed");
    } finally { clearTimeout(timer); }
  }
}

/** Bun fetch can use global proxy/debug environment settings; a fresh native agent never does. */
function directLocalFetch(endpoint: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: init.method, headers: Object.fromEntries(new Headers(init.headers)),
      signal: init.signal ?? undefined, agent: false,
      ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
    }, (response) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const body = Readable.toWeb(response, { strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength } }) as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status: response.statusCode, headers }));
      } catch (error) { response.destroy(); reject(error); }
    });
    request.on("error", reject);
    request.end(init.body);
  });
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new LocalEmbeddingError("embedding request was aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, stopped]); }
  finally { if (abort) signal.removeEventListener("abort", abort); }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new LocalEmbeddingError("embedding response exceeds the byte limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new LocalEmbeddingError("invalid embedding response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new LocalEmbeddingError("embedding response exceeds the byte limit");
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new LocalEmbeddingError("embedding response is not valid JSON"); }
  } finally { void reader.cancel().catch(() => {}); }
}
