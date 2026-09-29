import { createHash, randomBytes } from "node:crypto";
import { parseSessionKey, type SessionKey } from "@august/core";
import { stableStringify } from "@august/policy";

/** Canonical identity of an action: what would run, with what, against which destination and targets. */
export function actionHash(action: { tool: string; args: Record<string, unknown>; destination?: string; targets?: readonly unknown[] }): string {
  return createHash("sha256").update(stableStringify({ tool: action.tool, args: action.args, destination: action.destination ?? null, targets: action.targets ?? null })).digest("hex");
}

/** What a channel shows and later hands back. The nonce is the secret half: an old button or message cannot guess it. */
export interface ApprovalTicket {
  id: string;
  nonce: string;
  session: SessionKey;
  tool: string;
  actionHash: string;
  createdAt: number;
  expiresAt: number;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "superseded" | "consumed";

/** Who answered, through which channel. Recorded with the decision. */
export interface Resolver {
  channel: string;
  identity: string;
}

export interface ApprovalRecord extends ApprovalTicket {
  status: ApprovalStatus;
  resolver?: Resolver;
  resolvedAt?: number;
}

export type ResolveFailure = "unknown" | "nonce" | "session" | "resolver" | "expired" | "already-resolved";
export type ResolveResult = { ok: true; status: "approved" | "denied" } | { ok: false; reason: ResolveFailure };
export type ApprovalOutcome = "approved" | "denied" | "expired" | "superseded";

export interface ApprovalLedgerOptions {
  /** How long an approval stays answerable. Default 5 minutes. */
  ttlMs?: number;
  now?: () => number;
  /** Bound on records kept for audit and replay detection. Default 1000. */
  maxRecords?: number;
}

interface Entry {
  record: ApprovalRecord;
  settle(outcome: ApprovalOutcome): void;
  done: Promise<ApprovalOutcome>;
  timer?: ReturnType<typeof setTimeout>;
}

const same = (a: string, b: string): boolean => a.length === b.length && createHash("sha256").update(a).digest().equals(createHash("sha256").update(b).digest());

/**
 * Every approval is one record with one answer. It names its session, tool and
 * action hash, carries an unguessable nonce and an expiry, and leaves `pending`
 * exactly once. A different session, a stale button (unknown or superseded id),
 * a wrong nonce, a second answer, or an answer after expiry never resolves
 * anything and never affects another pending approval.
 */
export class ApprovalLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxRecords: number;

  constructor(options: ApprovalLedgerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? 1000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) throw new Error("approval ttl must be a positive integer");
  }

  /** Opens an approval for the session. An older pending one for the same session is superseded (refused). */
  open(input: { session: SessionKey; tool: string; actionHash: string; ttlMs?: number }): ApprovalTicket {
    for (const entry of this.entries.values()) {
      if (entry.record.session === input.session && entry.record.status === "pending") this.finish(entry, "superseded");
    }
    const createdAt = this.now();
    const ticket: ApprovalTicket = {
      id: randomBytes(9).toString("base64url"),
      nonce: randomBytes(12).toString("base64url"),
      session: input.session,
      tool: input.tool,
      actionHash: input.actionHash,
      createdAt,
      expiresAt: createdAt + (input.ttlMs ?? this.ttlMs),
    };
    let settle!: (outcome: ApprovalOutcome) => void;
    const done = new Promise<ApprovalOutcome>((resolve) => { settle = resolve; });
    const entry: Entry = { record: { ...ticket, status: "pending" }, settle, done };
    const delay = ticket.expiresAt - createdAt;
    entry.timer = setTimeout(() => this.expireDue(), delay);
    (entry.timer as { unref?: () => void }).unref?.();
    this.entries.set(ticket.id, entry);
    this.trim();
    return ticket;
  }

  /**
   * Answer from a channel. The caller supplies what the channel actually saw: the id and nonce
   * it displayed, the session it serves, and who answered. The resolver must be the session's
   * own channel and user, so one person's channel cannot answer for another's session.
   */
  resolve(input: { id: string; nonce: string; session: SessionKey; decision: "approve" | "deny"; resolver: Resolver }): ResolveResult {
    const entry = this.entries.get(input.id);
    if (!entry) return { ok: false, reason: "unknown" };
    const { record } = entry;
    if (record.session !== input.session) return { ok: false, reason: "session" };
    if (!same(record.nonce, input.nonce)) return { ok: false, reason: "nonce" };
    if (!this.channelOwnsSession(record.session, input.resolver)) return { ok: false, reason: "resolver" };
    return this.settle(entry, input.decision, input.resolver);
  }

  /** For code paths that are not channel input (a terminal prompt in this process, tests). Still one answer, still expiring. */
  resolveTrusted(id: string, decision: "approve" | "deny", resolver: Resolver): ResolveResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: "unknown" };
    return this.settle(entry, decision, resolver);
  }

  private settle(entry: Entry, decision: "approve" | "deny", resolver: Resolver): ResolveResult {
    this.expireDue();
    const { record } = entry;
    if (record.status === "expired") return { ok: false, reason: "expired" };
    if (record.status !== "pending") return { ok: false, reason: "already-resolved" };
    record.resolver = resolver;
    this.finish(entry, decision === "approve" ? "approved" : "denied");
    return { ok: true, status: record.status as "approved" | "denied" };
  }

  /** Resolves when the approval leaves `pending`. */
  wait(id: string): Promise<ApprovalOutcome> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve("denied");
    return entry.done;
  }

  get(id: string): ApprovalRecord | undefined {
    this.expireDue();
    const entry = this.entries.get(id);
    return entry ? { ...entry.record, ...(entry.record.resolver ? { resolver: { ...entry.record.resolver } } : {}) } : undefined;
  }

  pendingFor(session: SessionKey): ApprovalRecord | undefined {
    this.expireDue();
    for (const entry of this.entries.values()) if (entry.record.session === session && entry.record.status === "pending") return this.get(entry.record.id);
    return undefined;
  }

  /**
   * Use an approval to run the action. True once, and only for an approved, unexpired record
   * whose action hash equals the one that was shown. Anything else, including a second use, is false.
   */
  consume(id: string, currentActionHash: string): boolean {
    this.expireDue();
    const entry = this.entries.get(id);
    if (!entry || entry.record.status !== "approved" || !same(entry.record.actionHash, currentActionHash)) return false;
    entry.record.status = "consumed";
    return true;
  }

  /** Marks every pending approval past its expiry as expired. Runs on every read; also on a timer. */
  expireDue(): void {
    const now = this.now();
    for (const entry of this.entries.values()) if (entry.record.status === "pending" && now >= entry.record.expiresAt) this.finish(entry, "expired");
  }

  private finish(entry: Entry, status: "approved" | "denied" | "expired" | "superseded"): void {
    entry.record.status = status;
    entry.record.resolvedAt = this.now();
    if (entry.timer) clearTimeout(entry.timer);
    entry.settle(status);
  }

  private channelOwnsSession(session: SessionKey, resolver: Resolver): boolean {
    try {
      const parts = parseSessionKey(session);
      return parts.channel === resolver.channel && parts.user === resolver.identity;
    } catch {
      return false;
    }
  }

  private trim(): void {
    if (this.entries.size <= this.maxRecords) return;
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxRecords) return;
      if (entry.record.status !== "pending") this.entries.delete(id);
    }
  }
}
