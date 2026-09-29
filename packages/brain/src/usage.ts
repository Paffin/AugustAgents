export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type LlmUsageObserver = (usage: LlmUsage) => void | Promise<void>;

export interface LlmCallControls {
  onUsage?: LlmUsageObserver;
  requireUsage?: boolean;
  maxTokens?: number;
  /** Host assertion before generation/retry; provider wrappers may check it more than once. */
  beforeCall?: () => void;
  /** Current remaining run budget, refreshed for retries rather than captured once. */
  remainingTokens?: () => number;
}
