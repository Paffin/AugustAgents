import { CONTROLLED_EFFECTS, type Decision, type Effect } from "@august/policy";
import type { ScanResult } from "./scanner.ts";

export type TrustLevel = "verified" | "known" | "community" | "self-made" | "blocked";

export interface TrustSignals {
  signed: boolean;
  publisherVerified: boolean;
  installs: number;
  ageDays: number;
  scan: ScanResult;
  /** Written by the agent itself. */
  selfMade: boolean;
  /** Listed on the deny list. */
  denylisted: boolean;
}

export function computeTrust(s: TrustSignals): TrustLevel {
  if (s.denylisted || s.scan.blocked) return "blocked";
  if (s.selfMade) return "self-made";
  if (s.signed && s.publisherVerified) return "verified";
  if (s.installs >= 1000 && s.ageDays >= 90 && s.scan.findings.length === 0) return "known";
  return "community";
}

export interface InstallContext {
  effects: readonly Effect[];
  /** True when the capability ships executable code, not just instructions. */
  hasCode: boolean;
  /** For self-made skills: its eval suite passed against independent outcomes. */
  evalPassed?: boolean;
}

export interface InstallDecision {
  decision: Decision;
  reason: string;
}

/** What the installer may do without asking, by trust level. */
export function installDecision(level: TrustLevel, ctx: InstallContext): InstallDecision {
  const controlled = ctx.effects.some((e) => CONTROLLED_EFFECTS.has(e));
  switch (level) {
    case "blocked":
      return { decision: "deny", reason: "flagged by the scanner or the deny list" };
    case "verified":
      return controlled
        ? { decision: "ask", reason: "verified, but it asks for effects that leave the machine" }
        : { decision: "allow", reason: "verified and read/write local only" };
    case "known":
      return { decision: "ask", reason: "popular but unsigned: confirm once" };
    case "community":
      return { decision: "ask", reason: "unverified community package: review its permissions first" };
    case "self-made":
      if (ctx.hasCode || controlled) return { decision: "ask", reason: "self-written code or outward effects need approval" };
      return ctx.evalPassed
        ? { decision: "allow", reason: "text-only skill that passed its eval" }
        : { decision: "ask", reason: "self-written skill has not passed an eval yet" };
  }
}
