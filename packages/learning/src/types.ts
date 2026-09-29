import type { Sensitivity } from "@august/policy";

/** How an outcome was established. None of these is the acting model's own say-so. */
export type EvidenceMethod = "owner-feedback" | "postcondition" | "external-signal";
export const EVIDENCE_METHODS: readonly EvidenceMethod[] = ["owner-feedback", "postcondition", "external-signal"];

export type Verdict = "success" | "failure";

/**
 * One independent observation about what a decision led to. `verifier` names who observed it (the owner, a
 * host-side check, a connector); it must be registered with the store, so a model cannot invent one.
 */
export interface VerifierEvidence {
  verifier: string;
  method: EvidenceMethod;
  verdict: Verdict;
  observedAt: number;
  /** Short and free of private content: it explains the verdict to the owner, e.g. "file hash matched". */
  detail: string;
}

export interface DecisionRow {
  runId: string;
  index: number;
  questionId: string;
  instructions: string;
  /** Null for a tainted decision: private context that came from untrusted content is never kept as text. */
  state: string | null;
  stateSha256: string;
  options: Array<{ key: string; description: string }>;
  choice: string;
  source: "primary" | "fallback" | "unknown" | "plan";
  reason?: string;
  confidence: number;
  primary?: { choice: string; confidence: number; probs: Record<string, number>; calibration?: { segment: string; level: string; temperature: number; raw: Record<string, number> } };
  tainted: boolean;
  taintSources: string[];
  sensitivity: Sensitivity;
  at: number;
}

export interface ExecutionRow {
  runId: string;
  decisionIndex: number;
  tool: string;
  argsHash: string;
  policyRule: string;
  approved: boolean;
  isError: boolean;
  resultHash: string;
  resultChars: number;
  at: number;
}

export interface EvidenceRow extends VerifierEvidence {
  runId: string;
  /** A decision index, or null when the evidence is about the run as a whole (the owner's reaction to the answer). */
  decisionIndex: number | null;
}

/** Why a decision did not become an example. Reported, never silently dropped. */
export type ExclusionReason =
  | "tainted-context"
  | "not-executed"
  | "unresolved"
  | "conflicting-evidence"
  | "ambiguous-credit"
  /** A compiled plan made this call, not a model: it says nothing about what a model should choose. */
  | "compiled-plan";

export interface TrainingExample {
  /** `<runId>:<decisionIndex>`: the binding to the decision, and through it to the run and execution. */
  id: string;
  runId: string;
  decisionIndex: number;
  questionId: string;
  instructions: string;
  state: string;
  options: Array<{ key: string; description: string }>;
  choice: string;
  choiceSource: DecisionRow["source"];
  /** What Laya said at the time, with the probabilities before calibration (what calibration is fitted on). */
  primary?: DecisionRow["primary"];
  /** Bound execution: the call this decision led to. Absent for a "none" decision (the answer itself was judged). */
  execution?: { tool: string; argsHash: string; resultHash: string; isError: boolean };
  /** `chosen-worked`: the chosen option is a correct label. `chosen-failed`: the chosen option is known to be wrong; the right one is not known. */
  label: { kind: "chosen-worked"; key: string } | { kind: "chosen-failed"; avoid: string };
  reward: 1 | -1;
  /** Every piece of evidence that established the outcome. */
  evidence: Array<Pick<VerifierEvidence, "verifier" | "method" | "verdict" | "observedAt" | "detail">>;
  provenance: { tainted: false; sensitivity: Sensitivity };
  createdAt: number;
}

export interface ExampleReport {
  examples: TrainingExample[];
  excluded: Array<{ id: string; reason: ExclusionReason }>;
}
