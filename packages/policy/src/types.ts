export const EFFECTS = ["read", "write", "network", "send", "pay", "delete", "exec"] as const;
export type Effect = (typeof EFFECTS)[number];

/**
 * Effects that leave the machine, spend money, or can't be undone. Under a
 * tainted context these never run without the user's say-so.
 */
export const CONTROLLED_EFFECTS: ReadonlySet<Effect> = new Set<Effect>([
  "network",
  "send",
  "pay",
  "delete",
  "exec",
]);

/** Effects that name a destination (a host, an address, a payee). */
export const DESTINATION_EFFECTS: ReadonlySet<Effect> = new Set<Effect>(["network", "send", "pay"]);

/** Tool names are always `server.tool`, so one server can't impersonate another. */
export const NAMESPACED_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;

export interface ToolSpec {
  name: string;
  effects: readonly Effect[];
  /** True when results may contain text written by someone else (mail, web, files). */
  producesUntrusted?: boolean;
}

export interface TaintSnapshot {
  tainted: boolean;
  sources: readonly string[];
}

export interface PolicyCall {
  tool: ToolSpec;
  taint: TaintSnapshot;
  /** Host, address or payee this call acts on, when the tool has one. */
  destination?: string;
  amount?: number;
  currency?: string;
}

export type Decision = "allow" | "ask" | "deny";

export interface Verdict {
  decision: Decision;
  /** Stable machine-readable rule id. */
  rule: string;
  /** Human-readable reason, safe to show in an approval prompt. */
  reason: string;
  mandateId?: string;
}
