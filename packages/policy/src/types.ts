import type { Sensitivity } from "./provenance.ts";

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
  /** Most sensitive content read so far. Absent means public. */
  sensitivity?: Sensitivity;
}

/**
 * Where a write lands, judged by the host from the arguments, never by the model or the server.
 * `workspace` is the only kind that a clean context may write without asking.
 * `managed` is a store the host itself writes through its own validated code (installing a skill or a
 * tool); it is never derived from arguments, only declared by the host for its own tools.
 */
export interface WriteTarget {
  kind: "workspace" | "managed" | "outside" | "protected" | "unknown";
  /** Safe to show the owner, e.g. a workspace-relative path. */
  label: string;
}

export interface PolicyCall {
  tool: ToolSpec;
  taint: TaintSnapshot;
  /** Host, address or payee this call acts on, when the tool has one. */
  destination?: string;
  /** Targets of the call's write/delete effects. Absent or empty for a writing tool means "unknown". */
  targets?: readonly WriteTarget[];
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
