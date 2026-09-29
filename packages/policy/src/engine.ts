import { MandateStore } from "./mandate.ts";
import { sensitivityAtLeast } from "./provenance.ts";
import {
  CONTROLLED_EFFECTS,
  DESTINATION_EFFECTS,
  NAMESPACED_NAME,
  type Effect,
  type PolicyCall,
  type Verdict,
  type WriteTarget,
} from "./types.ts";

export class PolicyEngine {
  constructor(public readonly mandates: MandateStore = new MandateStore()) {}

  /**
   * Decide whether a call may run. Consumes mandate budget only when a mandate
   * is what allowed the call.
   */
  evaluate(call: PolicyCall, now: number = Date.now()): Verdict {
    const { tool, taint } = call;

    if (!NAMESPACED_NAME.test(tool.name)) {
      return deny("namespace", `tool "${tool.name}" must be named server.tool`);
    }
    if (tool.effects.length === 0) {
      return deny("undeclared-effects", `tool "${tool.name}" does not declare its effects`);
    }

    const controlled = tool.effects.filter((e) => CONTROLLED_EFFECTS.has(e));
    const writes = tool.effects.some((e) => WRITE_EFFECTS.has(e));
    const target = writes ? judgeTargets(call.targets) : undefined;
    // A protected target (the agent's own configuration, secrets, skills) is never writable by a model-driven call, mandate or not.
    if (target?.decision === "deny") return target;

    const sensitive = sensitivityAtLeast(taint.sensitivity ?? "public", "personal");
    if (controlled.length === 0) {
      if (writes && taint.tainted) {
        return {
          decision: "ask",
          rule: "tainted-write",
          reason: `writing ${targetLabels(call)} after reading untrusted content from ${taint.sources.join(", ")}; the request may come from that content, not from you${targetNote(target)}`,
        };
      }
      if (target?.decision === "ask") return target;
      return writes
        ? { decision: "allow", rule: "workspace-write", reason: `writes only inside the workspace (${targetLabels(call)})` }
        : { decision: "allow", rule: "local-only", reason: "reads local data only" };
    }

    // A mandate covers what the owner described; it cannot vouch for a target or for data it did not know the call would carry.
    const mandate = target ? undefined : this.mandates.match(call, now);
    if (mandate && !(taint.tainted && !mandate.allowTainted) && !(sensitive && leavesMachine(controlled) && !mandate.allowSensitive)) {
      this.mandates.consume(mandate.id, call);
      return {
        decision: "allow",
        rule: "mandate",
        reason: `covered by mandate "${mandate.description}"`,
        mandateId: mandate.id,
      };
    }

    if (taint.tainted) {
      return {
        decision: "ask",
        rule: "tainted-context",
        reason:
          `${describe(controlled)} after reading untrusted content from ${taint.sources.join(", ")}; ` +
          `the request may come from that content, not from you${targetNote(target)}`,
      };
    }
    if (target?.decision === "ask") return target;
    if (sensitive && leavesMachine(controlled)) {
      return {
        decision: "ask",
        rule: "sensitive-context",
        reason: `${describe(controlled)} while ${taint.sensitivity} data from earlier results is in the conversation`,
      };
    }
    return {
      decision: "ask",
      rule: "controlled-effect",
      reason: `${describe(controlled)} needs your approval`,
    };
  }
}

const WRITE_EFFECTS: ReadonlySet<Effect> = new Set<Effect>(["write", "delete"]);

function leavesMachine(effects: readonly Effect[]): boolean {
  return effects.some((e) => DESTINATION_EFFECTS.has(e));
}

/** Deny, ask or pass (undefined) from where the write lands; the worst target decides. */
function judgeTargets(targets: readonly WriteTarget[] | undefined): Verdict | undefined {
  if (!targets || targets.length === 0) {
    return { decision: "ask", rule: "write-target-unknown", reason: "it writes, and the place it writes to is not declared" };
  }
  const protectedTarget = targets.find((t) => t.kind === "protected");
  if (protectedTarget) return deny("write-protected-target", `it would change protected ${protectedTarget.label}`);
  const unknown = targets.find((t) => t.kind === "unknown");
  if (unknown) return { decision: "ask", rule: "write-target-unknown", reason: `it writes to a place that cannot be resolved (${unknown.label})` };
  const outside = targets.find((t) => t.kind === "outside");
  if (outside) return { decision: "ask", rule: "write-outside-workspace", reason: `it writes outside your workspace (${outside.label})` };
  return undefined;
}

function targetNote(target: Verdict | undefined): string {
  return target ? `; also, ${target.reason}` : "";
}

function targetLabels(call: PolicyCall): string {
  return (call.targets ?? []).map((t) => t.label).join(", ") || "workspace";
}

function deny(rule: string, reason: string): Verdict {
  return { decision: "deny", rule, reason };
}

function describe(effects: readonly Effect[]): string {
  return effects.join(" + ");
}
