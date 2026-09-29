import { createHash } from "node:crypto";
import { stableStringify, type Effect } from "@august/policy";

export type CapabilityKind = "mcp" | "skill" | "plugin" | "builtin";

export interface ToolDescriptor {
  /** Always `server.tool`. */
  name: string;
  description: string;
  effects: readonly Effect[];
  producesUntrusted?: boolean;
  inputSchema?: unknown;
  /** Extra search words, e.g. in other languages ("файл", "прочитать"). */
  keywords?: readonly string[];
}

export interface CapabilitySource {
  registry: string;
  url?: string;
  publisher?: string;
}

export interface CapabilityManifest {
  /** Namespace of the capability, e.g. an MCP server name. */
  id: string;
  kind: CapabilityKind;
  version: string;
  source: CapabilitySource;
  tools: readonly ToolDescriptor[];
}

/** Hash of everything the model reads about a tool. Any change breaks the pin. */
export function descriptorsHash(tools: readonly ToolDescriptor[]): string {
  const canonical = [...tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      name: t.name,
      description: t.description,
      effects: [...t.effects].sort(),
      producesUntrusted: t.producesUntrusted ?? false,
      inputSchema: t.inputSchema ?? null,
    }));
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}
