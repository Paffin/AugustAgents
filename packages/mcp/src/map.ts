import type { ToolDescriptor, TrustLevel } from "@august/capabilities";
import type { Effect } from "@august/policy";
import { McpError, type McpTool } from "./client.ts";

export const MAX_DESCRIPTION_CHARS = 1000;

const TRUSTED_HINTS: ReadonlySet<TrustLevel> = new Set<TrustLevel>(["verified", "known"]);

/**
 * MCP tools do not declare effects; they only offer optional hints, and a
 * hostile server can lie in them. So hints count only for servers we already
 * trust. Everyone else, and any tool without hints, is assumed able to reach
 * the network and change things, which makes every call ask first.
 */
export function inferEffects(tool: McpTool, trust: TrustLevel): Effect[] {
  const a = tool.annotations;
  if (!a || !TRUSTED_HINTS.has(trust)) return ["read", "write", "network"];
  const effects = new Set<Effect>(["read"]);
  if (a.readOnlyHint !== true) effects.add("write");
  if (a.destructiveHint === true) effects.add("delete");
  if (a.openWorldHint !== false) effects.add("network");
  return [...effects];
}

/** Whether the tool's output can carry text written by someone else. Almost always yes. */
export function producesUntrusted(tool: McpTool, trust: TrustLevel): boolean {
  const a = tool.annotations;
  return !(TRUSTED_HINTS.has(trust) && a?.readOnlyHint === true && a.openWorldHint === false);
}

function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export interface MappedTools {
  descriptors: ToolDescriptor[];
  /** Namespaced name -> the server's own name. */
  originals: Map<string, string>;
}

export function mapTools(serverId: string, tools: readonly McpTool[], trust: TrustLevel, targetArgs: Readonly<Record<string, readonly string[]>> = {}): MappedTools {
  const descriptors: ToolDescriptor[] = [];
  const originals = new Map<string, string>();
  for (const tool of tools) {
    const name = `${serverId}.${safeToolName(tool.name)}`;
    if (originals.has(name)) throw new McpError(`${serverId}: two tools map to the name "${name}"`);
    originals.set(name, tool.name);
    descriptors.push({
      name,
      description: (tool.description ?? tool.name).slice(0, MAX_DESCRIPTION_CHARS),
      effects: inferEffects(tool, trust),
      producesUntrusted: producesUntrusted(tool, trust),
      ...(Object.hasOwn(targetArgs, tool.name) ? { targetArgs: targetArgs[tool.name] } : {}),
      inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
    });
  }
  return { descriptors, originals };
}
