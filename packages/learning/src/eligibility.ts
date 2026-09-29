import type { DecisionRow, EvidenceRow, ExampleReport, ExclusionReason, ExecutionRow, TrainingExample, Verdict } from "./types.ts";

export interface RunRows {
  runId: string;
  decisions: readonly DecisionRow[];
  executions: readonly ExecutionRow[];
  evidence: readonly EvidenceRow[];
}

/**
 * The single rule for what becomes a training example (REQ-FUNC-003, DEC-0004). A decision is an example only
 * when all of these hold:
 *  - it was made in a clean context (no untrusted content had been read), so an injection cannot teach a choice;
 *  - it led to the call it chose (or was the answer itself);
 *  - independent evidence classifies the outcome as success or failure, and no evidence contradicts it.
 * Evidence about one call decides that call. The owner's reaction to a whole run is credited only where it is
 * unambiguous: praise credits every call that completed without error and the final answer; blame is assigned
 * only to a run's single decision, because with several it says nothing about which one was wrong.
 */
export function deriveExamples(run: RunRows, now: () => number = Date.now): ExampleReport {
  const examples: TrainingExample[] = [];
  const excluded: ExampleReport["excluded"] = [];
  const last = run.decisions.length - 1;
  for (const d of run.decisions) {
    const id = `${run.runId}:${d.index}`;
    const skip = (reason: ExclusionReason): void => void excluded.push({ id, reason });
    if (d.tainted || d.state === null) { skip("tainted-context"); continue; }
    const exec = run.executions.find((e) => e.decisionIndex === d.index);
    if (d.choice !== "none" && !exec) { skip("not-executed"); continue; }

    const own = run.evidence.filter((e) => e.decisionIndex === d.index);
    const runLevel = run.evidence.filter((e) => e.decisionIndex === null);
    const verdictOf = (list: readonly EvidenceRow[]): Verdict | "conflict" | undefined => {
      if (list.length === 0) return undefined;
      return list.every((e) => e.verdict === list[0]!.verdict) ? list[0]!.verdict : "conflict";
    };
    const stepVerdict = verdictOf(own);
    const runVerdict = verdictOf(runLevel);
    if (stepVerdict === "conflict" || runVerdict === "conflict") { skip("conflicting-evidence"); continue; }

    let verdict: Verdict | undefined; let used: EvidenceRow[] = [];
    if (stepVerdict) {
      // A check on this very call decides it; the owner's reaction may only agree with it.
      if (runVerdict && runVerdict !== stepVerdict && !(runVerdict === "failure" && run.decisions.length > 1)) { skip("conflicting-evidence"); continue; }
      verdict = stepVerdict; used = [...own, ...(runVerdict === stepVerdict ? runLevel : [])];
    } else if (runVerdict === "success") {
      const credited = exec ? !exec.isError : d.index === last;
      if (credited) { verdict = "success"; used = runLevel; }
    } else if (runVerdict === "failure") {
      if (run.decisions.length === 1) { verdict = "failure"; used = runLevel; }
      else { skip("ambiguous-credit"); continue; }
    }
    if (!verdict) { skip("unresolved"); continue; }

    examples.push({
      id, runId: run.runId, decisionIndex: d.index, questionId: d.questionId, instructions: d.instructions, state: d.state,
      options: d.options.map((o) => ({ ...o })), choice: d.choice, choiceSource: d.source,
      ...(d.primary ? { primary: d.primary } : {}),
      ...(exec ? { execution: { tool: exec.tool, argsHash: exec.argsHash, resultHash: exec.resultHash, isError: exec.isError } } : {}),
      label: verdict === "success" ? { kind: "chosen-worked", key: d.choice } : { kind: "chosen-failed", avoid: d.choice },
      reward: verdict === "success" ? 1 : -1,
      evidence: used.map(({ verifier, method, verdict: v, observedAt, detail }) => ({ verifier, method, verdict: v, observedAt, detail })),
      provenance: { tainted: false, sensitivity: d.sensitivity },
      createdAt: now(),
    });
  }
  return { examples, excluded };
}
