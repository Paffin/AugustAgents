import { MandateStore } from "./mandate.ts";
import {
  CONTROLLED_EFFECTS,
  NAMESPACED_NAME,
  type Effect,
  type PolicyCall,
  type Verdict,
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
    if (controlled.length === 0) {
      return { decision: "allow", rule: "local-only", reason: "reads or writes local data only" };
    }

    const mandate = this.mandates.match(call, now);
    if (mandate && !(taint.tainted && !mandate.allowTainted)) {
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
          `the request may come from that content, not from you`,
      };
    }
    return {
      decision: "ask",
      rule: "controlled-effect",
      reason: `${describe(controlled)} needs your approval`,
    };
  }
}

function deny(rule: string, reason: string): Verdict {
  return { decision: "deny", rule, reason };
}

function describe(effects: readonly Effect[]): string {
  return effects.join(" + ");
}
