import type { ToolExecutor, ToolResult } from "@august/agent";
import {
  CapabilityRegistry,
  type InstalledCapability,
  type ToolDescriptor,
  type TrustLevel,
} from "@august/capabilities";
import { McpConnection, McpError, type McpConnectOptions, type McpServerSpec } from "./client.ts";
import { mapTools } from "./map.ts";

interface Server {
  connection: McpConnection;
  trust: TrustLevel;
  originals: Map<string, string>;
}

export interface McpHostOptions {
  /** Handles tools that are not MCP tools (the built-ins). */
  fallback?: ToolExecutor;
  connect?: (spec: McpServerSpec) => Promise<McpConnection>;
  connectOptions?: McpConnectOptions;
}

/**
 * Owns the MCP servers: starts them, installs their tools in the registry
 * (where the scanner and the hash pin apply), and routes calls to them.
 */
export class McpHost implements ToolExecutor {
  private readonly servers = new Map<string, Server>();

  constructor(private readonly registry: CapabilityRegistry, private readonly options: McpHostOptions = {}) {}

  get serverIds(): string[] {
    return [...this.servers.keys()];
  }

  /** Start a server, list its tools and install them. Nothing stays running if the install fails. */
  async add(spec: McpServerSpec, trust: TrustLevel): Promise<InstalledCapability> {
    if (this.servers.has(spec.id)) throw new McpError(`server "${spec.id}" is already running`);
    const connect = this.options.connect ?? ((s) => McpConnection.connect(s, this.options.connectOptions));
    const connection = await connect(spec);
    try {
      const { descriptors, originals } = mapTools(spec.id, await connection.listTools(), trust);
      const installed = this.registry.install(
        { id: spec.id, kind: "mcp", version: "0", source: { registry: "config" }, tools: descriptors },
        trust,
      );
      this.servers.set(spec.id, { connection, trust, originals });
      return installed;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    this.servers.get(id)?.connection.close();
    this.servers.delete(id);
    this.registry.remove(id);
  }

  closeAll(): void {
    for (const s of this.servers.values()) s.connection.close();
    this.servers.clear();
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const id = tool.split(".")[0]!;
    const server = this.servers.get(id);
    if (!server) {
      if (this.options.fallback) return this.options.fallback.call(tool, args);
      return { content: `unknown tool ${tool}`, isError: true };
    }
    const original = server.originals.get(tool);
    if (!original) return { content: `unknown tool ${tool}`, isError: true };
    if (!server.connection.alive) return { content: `${id} is not running`, isError: true };
    try {
      const r = await server.connection.callTool(original, args);
      return { content: r.content, isError: r.isError };
    } catch (error) {
      // The message names the server and the failure, never the arguments.
      return { content: (error as Error).message, isError: true };
    }
  }

  /** What the server advertises now, mapped the same way as at install time. */
  async liveDescriptors(capabilityId: string): Promise<readonly ToolDescriptor[] | undefined> {
    const server = this.servers.get(capabilityId);
    if (!server) return this.options.fallback?.liveDescriptors?.(capabilityId);
    return mapTools(capabilityId, await server.connection.listTools(), server.trust).descriptors;
  }
}
