import { createHash } from "node:crypto";
import type { Effect, Verdict } from "./types.ts";

/** Effects present in `next` that `prev` did not have. */
export function widenedEffects(prev: readonly Effect[], next: readonly Effect[]): Effect[] {
  const had = new Set(prev);
  return [...new Set(next)].filter((e) => !had.has(e));
}

/**
 * A new version of a skill may narrow its effects freely, but widening them
 * needs the user's approval. This is what stops a self-"improving" skill from
 * quietly gaining the ability to send data out.
 */
export function checkSkillUpgrade(
  skill: string,
  prev: readonly Effect[],
  next: readonly Effect[],
): Verdict {
  const added = widenedEffects(prev, next);
  if (added.length === 0) {
    return { decision: "allow", rule: "upgrade-same-effects", reason: "effects did not widen" };
  }
  return {
    decision: "ask",
    rule: "upgrade-widens-effects",
    reason: `new version of "${skill}" adds: ${added.join(", ")}`,
  };
}

export interface LoopGuardOptions {
  maxSteps?: number;
  maxRepeats?: number;
}
export interface LoopGuardSnapshot { steps: number; repeats: Array<[string, number]> }

/** Stops runaway tasks: too many steps, or the same call over and over. */
export class LoopGuard {
  private steps = 0;
  private readonly repeats = new Map<string, number>();
  private readonly maxSteps: number;
  private readonly maxRepeats: number;

  constructor(options: LoopGuardOptions = {}) {
    this.maxSteps = options.maxSteps ?? 50;
    this.maxRepeats = options.maxRepeats ?? 3;
  }

  snapshot(): LoopGuardSnapshot { return { steps: this.steps, repeats: [...this.repeats.entries()] }; }

  restore(snapshot: LoopGuardSnapshot): void {
    if (!snapshot || !Number.isInteger(snapshot.steps) || snapshot.steps < 0 || !Array.isArray(snapshot.repeats)) throw new Error("invalid LoopGuard snapshot");
    this.steps = snapshot.steps;
    this.repeats.clear();
    const keys = new Set<string>(); let total = 0;
    for (const [key, count] of snapshot.repeats) {
      if (typeof key !== "string" || keys.has(key) || !Number.isInteger(count) || count < 1) throw new Error("invalid LoopGuard repeat state");
      keys.add(key); total += count;
      this.repeats.set(key, count);
    }
    if (total !== snapshot.steps) throw new Error("inconsistent LoopGuard snapshot");
  }

  record(tool: string, args: unknown): Verdict {
    this.steps += 1;
    if (this.steps > this.maxSteps) {
      return { decision: "deny", rule: "step-limit", reason: `more than ${this.maxSteps} steps in one task` };
    }
    const key = `${tool}:${createHash("sha256").update(stableStringify(args)).digest("hex")}`;
    const count = (this.repeats.get(key) ?? 0) + 1;
    this.repeats.set(key, count);
    if (count > this.maxRepeats) {
      return { decision: "deny", rule: "repeat-limit", reason: `${tool} called ${count} times with the same arguments` };
    }
    return { decision: "allow", rule: "within-limits", reason: "ok" };
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
