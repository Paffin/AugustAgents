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
}
