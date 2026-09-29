import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CapabilityManifest } from "@august/capabilities";
import type { ToolExecutor, ToolResult } from "@august/agent";
import type { ContentPart } from "@august/policy";

export const MAX_READ_BYTES = 200 * 1024;

export const builtinManifest: CapabilityManifest = {
  id: "fs",
  kind: "builtin",
  version: "1",
  source: { registry: "builtin" },
  tools: [
    {
      name: "fs.read",
      description: "read a text file from the user's August folder",
      effects: ["read"],
      // File contents can carry text written by someone else.
      producesUntrusted: true,
      inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false },
    },
    {
      name: "fs.list",
      description: "list files and folders in the user's August folder",
      effects: ["read"],
      // File names are written by whoever created the files.
      producesUntrusted: true,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    },
  ],
};

export const clockManifest: CapabilityManifest = {
  id: "clock",
  kind: "builtin",
  version: "1",
  source: { registry: "builtin" },
  tools: [
    {
      name: "clock.now",
      description: "current date and time",
      effects: ["read"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
};

const ours = (tool: string, text: string): ContentPart => ({ text, origin: { kind: "builtin", source: tool }, trust: "trusted", sensitivity: "public" });
/** The owner's files: personal, and written by whoever put them there. */
const fromFile = (tool: string, text: string, locator: string): ContentPart => ({ text, origin: { kind: "file", source: tool, locator }, trust: "untrusted", sensitivity: "personal" });
const result = (part: ContentPart, isError?: boolean): ToolResult => ({ content: part.text, parts: [part], ...(isError ? { isError } : {}) });

export class PathEscapeError extends Error {
  constructor() {
    super("that path is outside the allowed folder");
    this.name = "PathEscapeError";
  }
}

/** Resolve a user path inside `root`. Symlinks are followed first, so a link cannot lead out. */
export function resolveInside(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, path);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    // A file that does not exist yet still must sit lexically inside the root.
    real = target;
  }
  const rel = relative(realRoot, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PathEscapeError();
  return real;
}

export class BuiltinExecutor implements ToolExecutor {
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {}

  async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (tool) {
        case "clock.now":
          return result(ours(tool, this.now().toISOString()));
        case "fs.list": {
          const dir = resolveInside(this.root, typeof args.path === "string" ? args.path : ".");
          const names = readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          return result(fromFile(tool, names.sort().join("\n") || "(empty)", relative(realpathSync(this.root), dir) || "."));
        }
        case "fs.read": {
          const file = resolveInside(this.root, String(args.path));
          const stat = statSync(file);
          if (!stat.isFile()) return result(ours(tool, "not a file"), true);
          if (stat.size > MAX_READ_BYTES) return result(ours(tool, `file is larger than ${MAX_READ_BYTES} bytes`), true);
          return result(fromFile(tool, readFileSync(file, "utf8"), relative(realpathSync(this.root), file)));
        }
        default:
          return result(ours(tool, `unknown tool ${tool}`), true);
      }
    } catch (error) {
      // Never echo absolute paths from the host into the model's context.
      const message = error instanceof PathEscapeError ? error.message : "could not access that path";
      return result(ours(tool, message), true);
    }
  }
}
