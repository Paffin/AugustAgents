import type { TraceExecution } from "@august/agent";
import type { LearningStore } from "./store.ts";
import type { VerifierEvidence } from "./types.ts";

/** The identity used for the owner's own reactions (a thumbs up or down, a correction). */
export const OWNER_VERIFIER = "owner";

export type PostconditionResult = { verdict: "success" | "failure"; detail: string } | { verdict: "unresolved" };

/**
 * A check run by host code, after a call, that looks at the world rather than at what the model or the tool
 * says about itself: it re-reads the file, compares the clock, confirms the capability really is installed.
 * Returning `unresolved` records nothing; a check that cannot decide must not guess.
 */
export interface PostconditionVerifier {
  /** Stable id, registered with the store. */
  id: string;
  /** Tools it can judge. */
  tools: readonly string[];
  check(execution: TraceExecution): Promise<PostconditionResult> | PostconditionResult;
}

export class VerifierSet {
  private readonly byTool = new Map<string, PostconditionVerifier[]>();

  constructor(readonly verifiers: readonly PostconditionVerifier[], private readonly now: () => number = Date.now) {
    const ids = new Set<string>();
    for (const v of verifiers) {
      if (ids.has(v.id) || v.id === OWNER_VERIFIER) throw new Error(`duplicate or reserved verifier id "${v.id}"`);
      ids.add(v.id);
      for (const tool of v.tools) this.byTool.set(tool, [...(this.byTool.get(tool) ?? []), v]);
    }
  }

  /** Ids to register with the LearningStore, including the owner. */
  ids(): string[] {
    return [OWNER_VERIFIER, ...this.verifiers.map((v) => v.id)];
  }

  /** Runs every applicable check for every execution of a run; a check that throws is unresolved, never a verdict. */
  async verify(executions: readonly TraceExecution[]): Promise<Array<{ decisionIndex: number; evidence: VerifierEvidence }>> {
    const out: Array<{ decisionIndex: number; evidence: VerifierEvidence }> = [];
    for (const exec of executions) {
      for (const verifier of this.byTool.get(exec.tool) ?? []) {
        let result: PostconditionResult;
        try {
          result = await verifier.check(exec);
        } catch {
          continue;
        }
        if (result.verdict === "unresolved") continue;
        out.push({ decisionIndex: exec.decisionIndex, evidence: { verifier: verifier.id, method: "postcondition", verdict: result.verdict, observedAt: this.now(), detail: result.detail } });
      }
    }
    return out;
  }
}

/** The owner's reaction to a run: their word about the outcome, independent of anything the agent produced. */
export function recordOwnerFeedback(store: LearningStore, runId: string, verdict: "success" | "failure", note = "", now: () => number = Date.now): void {
  store.addEvidence(runId, null, { verifier: OWNER_VERIFIER, method: "owner-feedback", verdict, observedAt: now(), detail: note ? `owner: ${note}` : `owner said ${verdict === "success" ? "good" : "bad"}` });
}
