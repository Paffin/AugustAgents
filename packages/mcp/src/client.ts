import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const PROTOCOL_VERSION = "2025-06-18";

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

export interface McpCallResult {
  content: string;
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

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal MCP client over stdio: newline-delimited JSON-RPC 2.0. */
export class McpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private dead: Error | null = null;
  private stderrTail = "";

  private constructor(
    readonly spec: McpServerSpec,
    private readonly options: Required<McpConnectOptions>,
    baseEnv: Record<string, string | undefined>,
  ) {
    const env: Record<string, string> = {};
    for (const key of SAFE_ENV) {
      const v = baseEnv[key];
      if (v !== undefined) env[key] = v;
    }
    Object.assign(env, spec.env);
    this.child = spawn(spec.command, [...(spec.args ?? [])], { env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Stderr is for humans debugging a server; it never goes into the model's context.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    this.child.on("error", (e) => this.fail(new McpError(`${spec.id}: could not start (${(e as NodeJS.ErrnoException).code ?? "error"})`)));
    this.child.on("exit", (code) => this.fail(new McpError(`${spec.id}: server exited (${code})`)));
    // Writing to a dead pipe must not crash us.
    this.child.stdin.on("error", () => undefined);
  }

  static async connect(
    spec: McpServerSpec,
    options: McpConnectOptions = {},
    baseEnv: Record<string, string | undefined> = process.env,
  ): Promise<McpConnection> {
    if (!ID_PATTERN.test(spec.id)) throw new McpError(`invalid server id "${spec.id}"`);
    const conn = new McpConnection(
      spec,
      {
        requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
        maxMessageBytes: options.maxMessageBytes ?? 1024 * 1024,
        maxResultChars: options.maxResultChars ?? 20_000,
        maxToolPages: options.maxToolPages ?? 10,
      },
      baseEnv,
    );
    try {
      await conn.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "august", version: "0.1.0" },
      });
      conn.notify("notifications/initialized");
    } catch (error) {
      conn.close();
      throw error;
    }
    return conn;
  }

  get alive(): boolean {
    return this.dead === null;
  }

  /** Last lines the server wrote to stderr, for the person debugging a server. */
  get diagnostics(): string {
    return this.stderrTail;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.options.maxToolPages; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
      for (const t of result.tools ?? []) {
        if (t && typeof t.name === "string" && t.name.length > 0) tools.push(t);
      }
      if (!result.nextCursor) return tools;
      cursor = result.nextCursor;
    }
    throw new McpError(`${this.spec.id}: tools/list has too many pages`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const parts = (result.content ?? []).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : `[${c.type ?? "unknown"} content omitted]`));
    let content = parts.join("\n");
    if (content.length > this.options.maxResultChars) content = `${content.slice(0, this.options.maxResultChars)}\n[truncated]`;
    return { content, isError: result.isError === true };
  }

  close(): void {
    this.fail(new McpError(`${this.spec.id}: connection closed`));
    this.child.kill();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`${this.spec.id}: ${method} timed out`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string): void {
    this.send({ jsonrpc: "2.0", method });
  }

  private send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
    if (this.buffer.length > this.options.maxMessageBytes) {
      this.fail(new McpError(`${this.spec.id}: message too large`));
      this.child.kill();
    }
  }

  private onLine(line: string): void {
    let msg: { id?: number | string; method?: string; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // some servers print logs to stdout
    }
    if (msg.method !== undefined) {
      // The server is asking us something (ping, sampling, roots). We only answer ping.
      if (msg.id !== undefined) {
        this.send(
          msg.method === "ping"
            ? { jsonrpc: "2.0", id: msg.id, result: {} }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not supported" } },
        );
      }
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new McpError(`${this.spec.id}: ${msg.error.message ?? "request failed"}`));
    else p.resolve(msg.result ?? {});
  }

  private fail(error: Error): void {
    if (this.dead) return;
    this.dead = error;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
      this.pending.delete(id);
    }
  }
}
