export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type LlmUsageObserver = (usage: LlmUsage) => void | Promise<void>;
export type LlmAttemptEvent =
  | { type: "started"; id: string; provider: string; model: string; requestHash: string }
  | { type: "receipt"; id: string; usage: LlmUsage }
  | { type: "failed"; id: string; outcome: "unknown" | "not_sent"; reason: "aborted" | "timeout" | "unreachable" | "invalid_response" | "provider_error" };

export interface LlmCallControls {
  /** Owner cancellation applies to in-flight generation as well as call admission. */
  signal?: AbortSignal;
  deadlineAt?: number;
  onUsage?: LlmUsageObserver;
  onAttempt?: (event: LlmAttemptEvent) => void | Promise<void>;
  requireUsage?: boolean;
  maxTokens?: number;
  /** Host assertion before generation/retry; provider wrappers may check it more than once. */
  beforeCall?: () => void;
  /** Current remaining run budget, refreshed for retries rather than captured once. */
  remainingTokens?: () => number;
}
