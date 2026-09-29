import {
  CLIENT_INFO,
  McpError,
  PROTOCOL_VERSION,
  formatCallResult,
  listToolsPaged,
  resolveConnectOptions,
  type McpCallResult,
  type McpConnectOptions,
  type McpSession,
  type McpTool,
} from "./client.ts";

export interface McpHttpSpec {
  id: string;
  url: string;
  /** Sent with every request (e.g. Authorization). Values come from the secret store. */
  headers?: Record<string, string>;
}

function isLocal(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

async function readLimited(response: Response, maxBytes: number, id: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new McpError(`${id}: message too large`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Messages out of a text/event-stream body: every `data:` block that parses as JSON. */
export function parseSse(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // skip keep-alives and junk
    }
  }
  return out;
}

/**
 * MCP over streamable HTTP. Each request is a POST; the reply is JSON or a
 * short event stream. Only https (or localhost) is allowed, since headers
 * carry credentials.
 */
export class McpHttpConnection implements McpSession {
  private sessionId: string | undefined;
  private nextId = 1;
  private closed = false;
  private readonly options: Required<McpConnectOptions>;

  private constructor(private readonly spec: McpHttpSpec, options: McpConnectOptions, private readonly fetchFn: typeof fetch) {
    this.options = resolveConnectOptions(options);
  }

  static async connect(spec: McpHttpSpec, options: McpConnectOptions = {}, fetchFn: typeof fetch = fetch): Promise<McpHttpConnection> {
    if (!/^[A-Za-z0-9_-]+$/.test(spec.id)) throw new McpError(`invalid server id "${spec.id}"`);
    let url: URL;
    try {
      url = new URL(spec.url);
    } catch {
      throw new McpError(`${spec.id}: invalid url`);
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal(url))) {
      throw new McpError(`${spec.id}: remote MCP servers must use https`);
    }
    const conn = new McpHttpConnection(spec, options, fetchFn);
    await conn.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    await conn.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return conn;
  }

  get id(): string {
    return this.spec.id;
  }

  get alive(): boolean {
    return !this.closed;
  }

  listTools(): Promise<McpTool[]> {
    return listToolsPaged(this.spec.id, (m, p) => this.request(m, p), this.options.maxToolPages);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return formatCallResult(await this.request("tools/call", { name, arguments: args }), this.options.maxResultChars);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sessionId) {
      void this.fetchFn(this.spec.url, { method: "DELETE", headers: this.headers() }).catch(() => undefined);
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      ...this.spec.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  private async post(message: Record<string, unknown>): Promise<Response> {
    if (this.closed) throw new McpError(`${this.spec.id}: connection closed`);
    let response: Response;
    try {
      response = await this.fetchFn(this.spec.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(message),
        redirect: "error", // a redirect could carry our credentials elsewhere
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      throw new McpError(`${this.spec.id}: ${name === "TimeoutError" ? `${String(message.method)} timed out` : "request failed"}`);
    }
    if (response.status === 404 && this.sessionId) {
      this.closed = true;
      throw new McpError(`${this.spec.id}: session expired`);
    }
    if (!response.ok) throw new McpError(`${this.spec.id}: HTTP ${response.status}`);
    const sid = response.headers.get("mcp-session-id");
    if (sid && /^[\x21-\x7e]{1,256}$/.test(sid)) this.sessionId = sid;
    return response;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    const text = await readLimited(response, this.options.maxMessageBytes, this.spec.id);
    const type = response.headers.get("content-type") ?? "";
    const messages = type.includes("text/event-stream") ? parseSse(text) : [safeJson(text)];
    const reply = messages.find((m) => (m as { id?: unknown })?.id === id) as { result?: unknown; error?: { message?: string } } | undefined;
    if (!reply) throw new McpError(`${this.spec.id}: no reply to ${method}`);
    if (reply.error) throw new McpError(`${this.spec.id}: ${reply.error.message ?? "request failed"}`);
    return reply.result ?? {};
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
