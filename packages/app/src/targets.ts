import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDescriptor } from "@august/capabilities";
import type { WriteTarget } from "@august/policy";

export interface TargetRoots {
  /** The only folder a clean, untainted write may land in. */
  workspace: string;
  /** Places a model-driven call may never change: the agent's own data, config, secrets and skills. */
  protectedPaths: readonly string[];
}

/** The real path of `path`: links are followed for the part that exists, so a link cannot lead out of a root. */
function realish(path: string): string {
  let probe = resolve(path);
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return resolve(path);
    tail.unshift(basename(probe));
    probe = parent;
  }
  return join(realpathSync(probe), ...tail);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Classifies one path argument. Never throws: anything that cannot be resolved is `unknown`. */
export function classifyTarget(roots: TargetRoots, value: unknown, label: string): WriteTarget {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.length > 4096 || value.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    return { kind: "unknown", label };
  }
  try {
    const workspace = realish(roots.workspace);
    const target = realish(resolve(workspace, value));
    if (roots.protectedPaths.some((p) => inside(realish(p), target))) return { kind: "protected", label: "August data, configuration or skills" };
    if (inside(workspace, target)) return { kind: "workspace", label: relative(workspace, target) || "." };
    return { kind: "outside", label: target.length > 120 ? `${target.slice(0, 120)}...` : target };
  } catch {
    return { kind: "unknown", label };
  }
}

/** The host's own tools that change agent-managed stores. They validate what they write and are always controlled effects. */
const MANAGED_TARGETS: Readonly<Record<string, string>> = {
  "august.install_skill": "the agent's skills folder",
  "august.install_tool": "the agent's tool configuration",
  "memory.remember": "the agent's memory",
  "memory.forget": "the agent's memory",
};

/**
 * Targets of a write or delete, from the arguments the owner declared as path-carrying. A tool without
 * `targetArgs`, or with a declared argument that is missing, has no known target and asks every time.
 */
export function targetsFor(roots: TargetRoots, tool: ToolDescriptor, args: Record<string, unknown>): WriteTarget[] | undefined {
  if (Object.hasOwn(MANAGED_TARGETS, tool.name)) return [{ kind: "managed", label: MANAGED_TARGETS[tool.name]! }];
  if (!tool.targetArgs || tool.targetArgs.length === 0) return undefined;
  return tool.targetArgs.map((name) => classifyTarget(roots, args[name], `argument "${name}"`));
}
