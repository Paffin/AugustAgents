import { ApprovalLedger, type ApprovalRequest, type Approver, type ApprovalTicket, type ResolveResult, type Resolver } from "@august/agent";
import type { SessionKey } from "@august/core";
import { parseSessionKey } from "@august/core";
import type { ApprovalView, GatewayApprovals } from "@august/gateway";

export const APPROVE_WORDS = new Set(["y", "yes", "да", "д", "ok", "ок", "+", "разрешить", "allow"]);

/** True only for an explicit yes. Anything else, including silence, is a no. */
export function isYes(text: string): boolean {
  return APPROVE_WORDS.has(text.trim().toLowerCase().replace(/[.!]+$/, ""));
}

export function formatApproval(view: ApprovalView): string {
  const lines = [`⚠️ ${view.tool} wants to run: ${view.reason}`];
  if (view.details) lines.push(view.details);
  for (const [k, v] of Object.entries(view.args)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    lines.push(`  ${k}: ${s.length > 120 ? `${s.slice(0, 120)}...` : s}`);
  }
  lines.push(`Request ${view.id}. Allow once? (yes / no)`);
  return lines.join("\n");
}

interface Shown {
  view: ApprovalView;
  /** The chat message that carries the prompt, when the channel has one. */
  promptMessageId?: number;
}

export interface TextAnswerContext {
  /** When the person sent the message, epoch ms as the channel reports it. */
  sentAt: number;
  /** The message this one replies to, when the channel has replies. */
  replyTo?: number;
  resolver: Resolver;
}

/**
 * The chat-facing side of the approval ledger: it shows a ticket to a person and turns their answer
 * back into a ledger resolution. It holds no decision logic of its own; the ledger owns binding,
 * expiry and single use, so no channel can resolve more than the one approval it displayed.
 */
export class PendingApprovals {
  private readonly shown = new Map<string, Shown>();

  constructor(readonly ledger: ApprovalLedger = new ApprovalLedger()) {}

  /**
   * An approver for one session that shows the prompt with `notify`. `notify` may return the id of
   * the chat message it sent, so a later text reply can be tied to that very prompt.
   */
  approverFor(notify: (text: string, view: ApprovalView) => void | number | Promise<void | number>): Approver {
    return {
      approve: (request: ApprovalRequest) => this.ask(request, notify),
    };
  }

  /** The live approval for this session, as the person sees it. */
  pending(session: SessionKey): ApprovalView | null {
    const record = this.ledger.pendingFor(session);
    return record ? this.shown.get(record.id)?.view ?? null : null;
  }

  promptMessageOf(session: SessionKey): number | undefined {
    const record = this.ledger.pendingFor(session);
    return record ? this.shown.get(record.id)?.promptMessageId : undefined;
  }

  /** Answer with the id and nonce that were displayed. Anything that does not match resolves nothing. */
  resolve(input: { session: SessionKey; approvalId: string; nonce: string; allow: boolean; resolver: Resolver }): ResolveResult {
    return this.ledger.resolve({ id: input.approvalId, nonce: input.nonce, session: input.session, decision: input.allow ? "approve" : "deny", resolver: input.resolver });
  }

  /**
   * A typed answer. It counts only for the approval that is pending now, only if it was sent after that
   * prompt appeared, and, when it is a reply, only if it replies to that prompt. Everything typed
   * earlier, or in answer to something else, resolves nothing.
   */
  answerText(session: SessionKey, text: string, context: TextAnswerContext): ResolveResult | "ignored" {
    const record = this.ledger.pendingFor(session);
    const shown = record ? this.shown.get(record.id) : undefined;
    if (!record || !shown) return "ignored";
    if (context.sentAt < record.createdAt) return { ok: false, reason: "expired" };
    if (context.replyTo !== undefined && shown.promptMessageId !== undefined && context.replyTo !== shown.promptMessageId) return { ok: false, reason: "unknown" };
    return this.resolve({ session, approvalId: record.id, nonce: record.nonce, allow: isYes(text), resolver: context.resolver });
  }

  /** An adapter for the gateway. Channels whose own transport answers them (Telegram) are not answerable from it. */
  forGateway(reservedChannels: readonly string[] = []): GatewayApprovals {
    const reserved = new Set(reservedChannels);
    const reservedSession = (session: SessionKey): boolean => { try { return reserved.has(parseSessionKey(session).channel); } catch { return true; } };
    return {
      pending: (session) => (reservedSession(session) ? null : this.pending(session)),
      resolve: (input) => {
        if (reservedSession(input.session)) return { ok: false, reason: "resolver" };
        const { channel, user } = parseSessionKey(input.session);
        return this.resolve({ ...input, resolver: { channel, identity: user } });
      },
    };
  }

  private async ask(request: ApprovalRequest, notify: (text: string, view: ApprovalView) => void | number | Promise<void | number>): Promise<boolean> {
    const view = viewOf(request.ticket, request);
    const entry: Shown = { view };
    this.shown.set(view.id, entry);
    try {
      const messageId = await notify(formatApproval(view), view);
      if (typeof messageId === "number") entry.promptMessageId = messageId;
    } catch {
      // A prompt nobody saw is a refusal, not a wait.
      this.ledger.resolveTrusted(view.id, "deny", { channel: "system", identity: "notify-failed" });
    }
    try {
      return (await this.ledger.wait(view.id)) === "approved";
    } finally {
      this.shown.delete(view.id);
    }
  }
}

function viewOf(ticket: ApprovalTicket, request: ApprovalRequest): ApprovalView {
  return { id: ticket.id, nonce: ticket.nonce, tool: request.tool, reason: request.verdict.reason, details: request.details, args: request.args, createdAt: ticket.createdAt, expiresAt: ticket.expiresAt };
}
