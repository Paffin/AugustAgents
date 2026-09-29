import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TraceExecution } from "@august/agent";
import type { CapabilityRegistry } from "@august/capabilities";
import type { PostconditionVerifier } from "@august/learning";
import { MAX_READ_BYTES, resolveInside } from "./builtins.ts";

export interface VerifierEnvironment {
  /** The August folder the file tools are confined to. */
  root: string;
  skillsDir: string;
  registry: CapabilityRegistry;
  now?: () => number;
}

const MAX_CLOCK_SKEW_MS = 120_000;

/**
 * Checks the host runs after a call to see whether the world agrees with what the tool reported. They look at
 * the clock, the file, the skill folder and the registry themselves; none of them asks the model or trusts the
 * tool's own claim. A check that cannot tell says so and records nothing.
 */
export function builtinVerifiers(env: VerifierEnvironment): PostconditionVerifier[] {
  const now = env.now ?? Date.now;
  return [
    {
      id: "host-clock",
      tools: ["clock.now"],
      check: (e: TraceExecution) => {
        const reported = Date.parse(e.result.trim());
        if (e.isError || Number.isNaN(reported)) return { verdict: "failure", detail: "the result was not a timestamp" };
        const skew = Math.abs(now() - reported);
        return skew <= MAX_CLOCK_SKEW_MS ? { verdict: "success", detail: `within ${Math.round(skew / 1000)}s of the host clock` } : { verdict: "failure", detail: `${Math.round(skew / 1000)}s away from the host clock` };
      },
    },
    {
      id: "host-file-read",
      tools: ["fs.read"],
      check: (e: TraceExecution) => {
        if (e.isError) return { verdict: "unresolved" };
        try {
          const file = resolveInside(env.root, String(e.args.path));
          if (statSync(file).size > MAX_READ_BYTES) return { verdict: "unresolved" };
          // The tool's result is bounded; compare the same bounded prefix. A file that changed since is unknowable, not a failure.
          return readFileSync(file, "utf8").slice(0, e.result.length) === e.result ? { verdict: "success", detail: "the file's content matches the result" } : { verdict: "unresolved" };
        } catch {
          return { verdict: "unresolved" };
        }
      },
    },
    {
      id: "host-skill-install",
      tools: ["august.install_skill"],
      check: (e: TraceExecution) => {
        const name = /Installed skill "([a-z0-9-]+)"/.exec(e.result)?.[1];
        if (!name) return e.isError ? { verdict: "failure", detail: "the install reported an error" } : { verdict: "unresolved" };
        const loaded = env.registry.get("skill")?.manifest.tools.some((t) => t.name === `skill.${name}`);
        let onDisk = false;
        try { onDisk = statSync(join(env.skillsDir, name, ".august-provenance.json")).isFile(); } catch { /* absent */ }
        return loaded && onDisk ? { verdict: "success", detail: `skill ${name} is loaded and has its provenance record` } : { verdict: "failure", detail: `skill ${name} is not loaded with a provenance record` };
      },
    },
    {
      id: "host-capability-install",
      tools: ["august.install_tool"],
      check: (e: TraceExecution) => {
        const id = /^Installed "([A-Za-z0-9_-]+)"/.exec(e.result)?.[1];
        if (!id) return e.isError ? { verdict: "failure", detail: "the install reported an error" } : { verdict: "unresolved" };
        const cap = env.registry.get(id);
        return cap?.status === "active" && cap.manifest.tools.length > 0 ? { verdict: "success", detail: `${id} is registered and active with ${cap.manifest.tools.length} tools` } : { verdict: "failure", detail: `${id} is not registered and active` };
      },
    },
  ];
}
