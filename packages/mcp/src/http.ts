import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CLIENT_INFO,
  McpError,
  SdkSession,
  describeFailure,
  requireSupportedVersion,
  resolveConnectOptions,
  type McpConnectOptions,
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

/** The body of a response, ending in an error once it would exceed `maxBytes`. */
function limitBody(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) controller.error(new Error("message too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * The only network door the SDK transport gets. It never follows redirects (they could carry the
 * credentials elsewhere: set by the caller), reads no more than `maxBytes` of any reply, and does not
 * open the server-to-client event stream at all: August answers no server requests, so a server
 * has no reason to push anything, and the spec lets a server answer that GET with 405.
 */
export function guardedFetch(fetchFn: typeof fetch, maxBytes: number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "GET") return new Response(null, { status: 405 });
    const response = await fetchFn(input, init);
    if (!response.body) return response;
    return new Response(limitBody(response.body, maxBytes), { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

/**
 * MCP over streamable HTTP through the official SDK transport. Only https (or localhost) is
 * allowed, since headers carry credentials.
 */
export class McpHttpConnection extends SdkSession {
  private expired = false;

  private constructor(private readonly spec: McpHttpSpec, client: Client, options: Required<McpConnectOptions>, private readonly transport: StreamableHTTPClientTransport) {
    super(spec.id, client, options);
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
    const resolved = resolveConnectOptions(options);
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: guardedFetch(fetchFn, resolved.maxMessageBytes),
      requestInit: { headers: { ...spec.headers }, redirect: "error" },
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const conn = new McpHttpConnection(spec, client, resolved, transport);
    try {
      await client.connect(transport, { timeout: resolved.requestTimeoutMs });
      requireSupportedVersion(spec.id, transport.protocolVersion);
    } catch (error) {
      conn.close();
      throw error instanceof McpError && /older than/.test(error.message) ? error : describeFailure(spec.id, "initialize", error);
    }
    return conn;
  }

  get alive(): boolean {
    return !this.closed && !this.expired;
  }

  protected exitCode(): undefined {
    return undefined;
  }

  protected override fail(method: string, error: unknown): McpError {
    if (error instanceof StreamableHTTPError && error.code === 404 && this.transport.sessionId) {
      this.expired = true;
      return new McpError(`${this.spec.id}: session expired`);
    }
    return super.fail(method, error);
  }

  protected shutdown(): void {
    // Ending the session politely is best effort; nothing waits for it.
    void this.transport.terminateSession().catch(() => undefined).finally(() => void this.client.close().catch(() => undefined));
  }
}
