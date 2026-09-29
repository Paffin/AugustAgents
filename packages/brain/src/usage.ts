export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type LlmUsageObserver = (usage: LlmUsage) => void | Promise<void>;

export interface LlmCallControls {
  /** Owner cancellation applies to in-flight generation as well as call admission. */
  signal?: AbortSignal;
  deadlineAt?: number;
  onUsage?: LlmUsageObserver;
  requireUsage?: boolean;
  maxTokens?: number;
  /** Host assertion before generation/retry; provider wrappers may check it more than once. */
  beforeCall?: () => void;
  /** Current remaining run budget, refreshed for retries rather than captured once. */
  remainingTokens?: () => number;
}
