import type { ToolCallContext, ToolExecutor, ToolResult } from "@august/agent";
import type { CapabilityManifest } from "@august/capabilities";
import { maxSensitivity, type ContentPart } from "@august/policy";
import { MemoryError, type MemoryStore } from "./store.ts";
import { isMemoryClass, type MemoryEntry } from "./types.ts";

export const memoryManifest: CapabilityManifest = {
  id: "memory",
  kind: "builtin",
  version: "1",
  source: { registry: "builtin" },
  tools: [
    {
      name: "memory.recall",
      description: "recall what the owner asked to remember",
      keywords: ["remember", "recall", "memory", "preference", "earlier", "before", "помнить", "вспомнить", "память", "раньше", "предпочтения"],
      effects: ["read"],
      // Trust belongs to each entry: what was written after reading untrusted content comes back untrusted.
      inputSchema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 200 }, kind: { type: "string", enum: ["working", "episodic", "semantic", "procedural"] }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"], additionalProperties: false },
    },
    {
      name: "memory.remember",
      description: "remember a fact, preference or procedure",
      keywords: ["remember", "note", "save", "memorize", "запомни", "запомнить", "сохрани", "заметка"],
      effects: ["write"],
      inputSchema: { type: "object", properties: { text: { type: "string", minLength: 2, maxLength: 2000 }, kind: { type: "string", enum: ["working", "semantic", "procedural"] }, ttlHours: { type: "integer", minimum: 1, maximum: 8760 }, replaces: { type: "string", maxLength: 64 } }, required: ["text", "kind"], additionalProperties: false },
    },
    {
      name: "memory.forget",
      description: "delete one remembered item by id",
      keywords: ["forget", "delete", "remove", "забудь", "удали"],
      effects: ["delete"],
      inputSchema: { type: "object", properties: { id: { type: "string", minLength: 8, maxLength: 64 } }, required: ["id"], additionalProperties: false },
    },
  ],
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fail = (content: string): ToolResult => ({ content, isError: true });

/** The agent's memory tools, bound to the caller's own session: it can never name another owner's scope. */
export class MemoryExecutor implements ToolExecutor {
  constructor(private readonly store: MemoryStore, private readonly fallback: ToolExecutor) {}

  async call(tool: string, args: Record<string, unknown>, context?: ToolCallContext): Promise<ToolResult> {
    if (!tool.startsWith("memory.")) return this.fallback.call(tool, args, context);
    if (!context) return fail("memory is only available inside a session");
    const scope = context.session;
    try {
      switch (tool) {
        case "memory.recall": return this.recall(scope, args);
        case "memory.remember": return this.remember(scope, args, context);
        case "memory.forget": {
          const n = this.store.forget(scope, String(args.id), "forgotten at the owner's request");
          return n > 0 ? { content: `Forgot it${n > 1 ? ` and ${n - 1} earlier version(s) of it` : ""}.` } : { ...fail("no such memory"), outcome: "not_sent" };
        }
      }
    } catch (error) {
      if (error instanceof MemoryError) return fail(error.message);
      throw error;
    }
    return fail(`unknown memory tool ${tool}`);
  }

  describeCall(tool: string, args: Record<string, unknown>): Promise<string | undefined> {
    if (tool === "memory.forget") return Promise.resolve(`permanently delete the remembered item ${String(args.id)}`);
    if (tool === "memory.remember") return Promise.resolve(`remember (${String(args.kind)}): ${String(args.text).slice(0, 200)}`);
    return this.fallback.describeCall?.(tool, args) ?? Promise.resolve(undefined);
  }

  private async recall(scope: string, args: Record<string, unknown>): Promise<ToolResult> {
    const kind = args.kind === undefined ? undefined : String(args.kind);
    if (kind !== undefined && !isMemoryClass(kind)) return fail("unknown kind");
    const hits = await this.store.recallHybrid({ scope, query: String(args.query), classes: kind ? [kind] : undefined, limit: typeof args.limit === "number" ? args.limit : 5 });
    if (hits.length === 0) return { content: "No matching memories.", parts: [{ text: "No matching memories.", origin: { kind: "builtin", source: "memory.recall" }, trust: "trusted", sensitivity: "public" }] };
    const parts: ContentPart[] = hits.map(({ entry }) => ({
      text: describe(entry),
      // The entry's own trust and sensitivity travel with it: this is how a poisoned note keeps its label.
      origin: { kind: entry.origin.kind, source: "memory.recall", locator: entry.origin.locator ?? entry.origin.source },
      trust: entry.trust,
      sensitivity: entry.sensitivity,
    }));
    return { content: parts.map((p) => p.text).join("\n"), parts };
  }

  private remember(scope: string, args: Record<string, unknown>, context: ToolCallContext): ToolResult {
    const kind = String(args.kind);
    if (kind !== "working" && kind !== "semantic" && kind !== "procedural") return fail("kind must be working, semantic or procedural");
    const { taint } = context;
    // What was written under untrusted influence stays labelled untrusted, and taints whoever reads it later.
    const trust = taint.tainted ? "untrusted" : "trusted";
    const sensitivity = maxSensitivity(taint.sensitivity ?? "public", "personal");
    const { entry, created } = this.store.remember({
      scope, class: kind, text: String(args.text), trust, sensitivity,
      origin: { kind: "builtin", source: "memory.remember", ...(taint.tainted ? { locator: taint.sources.join(",").slice(0, 120) } : {}) },
      ...(typeof args.ttlHours === "number" ? { ttlMs: args.ttlHours * 3_600_000 } : {}),
      ...(typeof args.replaces === "string" ? { supersedes: args.replaces } : {}),
    });
    return { content: `${created ? "Remembered" : "Already remembered"} (${kind}, id ${entry.id})${trust === "untrusted" ? "; kept as untrusted because it was written after reading untrusted content" : ""}.` };
  }
}

function describe(e: MemoryEntry): string {
  return `[${e.class} ${day(e.updatedAt)} id ${e.id}${e.trust === "untrusted" ? " untrusted" : ""}] ${e.text}`;
}
