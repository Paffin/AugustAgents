import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpError as SdkMcpError, ErrorCode, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * The oldest MCP protocol revision August speaks. The SDK negotiates older ones too, but no
 * consumer of them is evidenced, so a server that only speaks an older revision is refused with a
 * clear error. To support one, add the evidence and a sunset here (DEC-0007).
 */
export const MIN_PROTOCOL_VERSION = "2025-06-18";

export interface McpServerSpec {
  /** Namespace for the server's tools. Letters, digits, `_` and `-` only. */
  id: string;
  command: string;
  args?: readonly string[];
  /** Extra environment for this server. Nothing else from our own environment is passed on. */
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

/**
 * One item of a tool result as the wire delivered it. The host, not the server,
 * decides what trust each kind gets; nothing in here (annotations, audience,
 * priority) is carried forward as a claim.
 */
export interface McpResultPart {
  kind: "text" | "structured" | "resource" | "link" | "binary";
  text: string;
  /** Resource or link URI, when the item names one. */
  uri?: string;
}

export interface McpCallResult {
  /** All parts joined, for callers that only need text. */
  content: string;
  parts: McpResultPart[];
  isError: boolean;
}

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpConnectOptions {
  requestTimeoutMs?: number;
  /** A single message larger than this kills the connection. */
  maxMessageBytes?: number;
  /** Cap on the text returned by one tool call. */
  maxResultChars?: number;
  /** Cap on how many pages of tools/list are followed. */
  maxToolPages?: number;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Enough to find and run programs, and nothing that could carry a secret. */
const SAFE_ENV = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "LANG"];

/** What the host needs from any MCP connection, whatever the transport. */
export interface McpSession {
  readonly id: string;
  readonly alive: boolean;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): void;
}

export function resolveConnectOptions(options: McpConnectOptions = {}): Required<McpConnectOptions> {
  return {
    requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
    maxMessageBytes: options.maxMessageBytes ?? 1024 * 1024,
    maxResultChars: options.maxResultChars ?? 20_000,
    maxToolPages: options.maxToolPages ?? 10,
  };
}

export const CLIENT_INFO = { name: "august", version: "0.1.0" };

const MAX_URI_CHARS = 500;

function resultParts(result: { content?: unknown; structuredContent?: unknown }): McpResultPart[] {
  const parts: McpResultPart[] = [];
  const items = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = typeof item.type === "string" ? item.type : "unknown";
    if (type === "text" && typeof item.text === "string") { parts.push({ kind: "text", text: item.text }); continue; }
    if (type === "resource" && item.resource && typeof item.resource === "object") {
      const res = item.resource as { uri?: unknown; text?: unknown };
      const uri = typeof res.uri === "string" ? res.uri.slice(0, MAX_URI_CHARS) : undefined;
      parts.push(typeof res.text === "string" ? { kind: "resource", text: res.text, uri } : { kind: "binary", text: "[binary resource omitted]", uri });
      continue;
    }
    if (type === "resource_link") {
      const uri = typeof item.uri === "string" ? item.uri.slice(0, MAX_URI_CHARS) : undefined;
      const name = typeof item.name === "string" ? item.name : "";
      parts.push({ kind: "link", text: `[link] ${name} ${uri ?? ""}`.trim(), uri });
      continue;
    }
    parts.push({ kind: "binary", text: `[${type} content omitted]` });
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) parts.push({ kind: "structured", text: JSON.stringify(result.structuredContent) });
  return parts;
}

export function formatCallResult(result: unknown, maxChars: number): McpCallResult {
  const r = (result ?? {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  let left = maxChars;
  const parts: McpResultPart[] = [];
  for (const part of resultParts(r)) {
    if (left <= 0) break;
    if (part.text.length > left) { parts.push({ ...part, text: `${part.text.slice(0, left)}\n[truncated]` }); left = 0; break; }
    parts.push(part); left -= part.text.length;
  }
  return { content: parts.map((p) => p.text).join("\n"), parts, isError: r.isError === true };
}

/** What went wrong, in words that never carry arguments, headers or server-controlled text. */
export function describeFailure(id: string, method: string, error: unknown, exitCode?: number | null): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof SdkMcpError) {
    if (error.code === ErrorCode.RequestTimeout) return new McpError(`${id}: ${method} timed out`);
    if (error.code === ErrorCode.ConnectionClosed) return new McpError(exitCode === undefined ? `${id}: connection closed` : `${id}: server exited (${exitCode})`);
    // The server's own JSON-RPC error message, without the SDK's "MCP error <code>:" prefix.
    return new McpError(`${id}: ${error.message.replace(/^MCP error -?\d+:\s*/, "").slice(0, 300) || "request failed"}`);
  }
  if (error instanceof StreamableHTTPError) return new McpError(`${id}: HTTP ${error.code ?? "error"}`);
  if (/ZodError/.test((error as Error | undefined)?.name ?? "")) return new McpError(`${id}: ${method} returned an invalid response`);
  const message = (error as Error | undefined)?.message ?? "";
  if (/timed out|TimeoutError/i.test(message)) return new McpError(`${id}: ${method} timed out`);
  if (/too large|exceeded maximum size/i.test(message)) return new McpError(`${id}: message too large`);
  return new McpError(`${id}: ${method} failed`);
}

/** The August-facing session over an SDK client: pagination cap, size cap, result mapping, and stable error text. */
export abstract class SdkSession implements McpSession {
  protected closed = false;
  protected constructor(readonly id: string, protected readonly client: Client, protected readonly options: Required<McpConnectOptions>) {}

  abstract get alive(): boolean;
  protected abstract exitCode(): number | null | undefined;
  protected abstract shutdown(): void;

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < this.options.maxToolPages; page++) {
        const result = await this.client.listTools(cursor ? { cursor } : {}, { timeout: this.options.requestTimeoutMs });
        for (const t of result.tools) if (t && typeof t.name === "string" && t.name.length > 0) tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });
        if (!result.nextCursor) return tools;
        cursor = result.nextCursor;
      }
    } catch (error) {
      throw this.fail("tools/list", error);
    }
    throw new McpError(`${this.id}: tools/list has too many pages`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    try {
      return formatCallResult(await this.client.callTool({ name, arguments: args }, undefined, { timeout: this.options.requestTimeoutMs }), this.options.maxResultChars);
    } catch (error) {
      throw this.fail("tools/call", error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shutdown();
  }

  protected fail(method: string, error: unknown): McpError {
    return describeFailure(this.id, method, error, this.exitCode());
  }
}

/** Refuse a server whose negotiated revision is older than we support, before any tool is listed. */
export function requireSupportedVersion(id: string, version: string | undefined): void {
  if (version === undefined || version < MIN_PROTOCOL_VERSION) {
    throw new McpError(`${id}: server speaks MCP ${version ?? "an unknown revision"}, older than the supported ${MIN_PROTOCOL_VERSION}`);
  }
}

/**
 * Stdio transport with August's process policy: the server gets only a small set of environment
 * variables plus what the config gives it, stderr is kept for diagnostics and never returned as a
 * result, and one oversized message ends the connection. Framing is the SDK's.
 */
class HardenedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  protocolVersion?: string;
  stderrTail = "";
  exit: number | null | undefined;
  private child?: ChildProcess;
  private readonly buffer: ReadBuffer;
  private finished = false;

  get ended(): boolean {
    return this.finished;
  }

  constructor(private readonly spec: McpServerSpec, maxMessageBytes: number, private readonly baseEnv: Record<string, string | undefined>) {
    this.buffer = new ReadBuffer({ maxBufferSize: maxMessageBytes });
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  start(): Promise<void> {
    const env: Record<string, string> = {};
    for (const key of SAFE_ENV) {
      const v = this.baseEnv[key];
      if (v !== undefined) env[key] = v;
    }
    Object.assign(env, this.spec.env);
    return new Promise((resolve, reject) => {
      const child = spawn(this.spec.command, [...(this.spec.args ?? [])], { env, cwd: this.spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      child.stdout!.on("data", (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
        } catch (error) {
          this.onerror?.(error as Error);
          void this.close();
          return;
        }
        for (;;) {
          try {
            const message = this.buffer.readMessage();
            if (message === null) break;
            this.onmessage?.(message);
          } catch {
            // Some servers print logs to stdout; a line that is not a JSON-RPC message is skipped.
          }
        }
      });
      // Stderr is for humans debugging a server; it never goes into the model's context.
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-2000);
      });
      child.on("error", (e) => {
        reject(new McpError(`${this.spec.id}: could not start (${(e as NodeJS.ErrnoException).code ?? "error"})`));
        this.finish(null);
      });
      child.on("spawn", () => resolve());
      child.on("exit", (code) => this.finish(code));
      // Writing to a dead pipe must not crash us.
      child.stdin!.on("error", () => undefined);
    });
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.finished || !this.child?.stdin?.writable) throw new SdkMcpError(ErrorCode.ConnectionClosed, "Connection closed");
    this.child.stdin.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.child?.kill();
    this.finish(this.exit);
  }

  private finish(code: number | null | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.exit = code;
    this.onclose?.();
  }
}

export class McpConnection extends SdkSession {
  private constructor(readonly spec: McpServerSpec, client: Client, options: Required<McpConnectOptions>, private readonly transport: HardenedStdioTransport) {
    super(spec.id, client, options);
  }

  static async connect(spec: McpServerSpec, options: McpConnectOptions = {}, baseEnv: Record<string, string | undefined> = process.env): Promise<McpConnection> {
    if (!ID_PATTERN.test(spec.id)) throw new McpError(`invalid server id "${spec.id}"`);
    const resolved = resolveConnectOptions(options);
    const transport = new HardenedStdioTransport(spec, resolved.maxMessageBytes, baseEnv);
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const conn = new McpConnection(spec, client, resolved, transport);
    try {
      await client.connect(transport, { timeout: resolved.requestTimeoutMs });
      requireSupportedVersion(spec.id, transport.protocolVersion);
    } catch (error) {
      conn.close();
      throw error instanceof McpError && /could not start|older than/.test(error.message) ? error : describeFailure(spec.id, "initialize", error, transport.exit);
    }
    return conn;
  }

  get alive(): boolean {
    return !this.closed && !this.transport.ended;
  }

  /** Last lines the server wrote to stderr, for the person debugging a server. */
  get diagnostics(): string {
    return this.transport.stderrTail;
  }

  protected exitCode(): number | null | undefined {
    return this.transport.exit;
  }

  protected shutdown(): void {
    void this.client.close().catch(() => undefined);
  }
}
