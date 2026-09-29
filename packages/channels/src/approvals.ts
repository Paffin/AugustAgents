import type { ApprovalRequest, Approver } from "@august/agent";
import type { ApprovalView } from "@august/gateway";

interface Waiting {
  view: ApprovalView;
  resolve(allow: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

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
  lines.push("Allow once? (yes / no)");
  return lines.join("\n");
}

/**
 * Approvals asked over a chat channel. The agent's task waits in its lane; the
 * person's answer arrives as a new message and must be routed here instead of
 * into that lane, or the two would wait on each other forever.
 */
export class PendingApprovals {
  private readonly waiting = new Map<string, Waiting>();
  constructor(private readonly timeoutMs = 5 * 60_000) {}

  /** An approver for one session that shows the prompt with `notify`. */
  approverFor(notify: (text: string, view: ApprovalView) => void | Promise<void>): Approver {
    return {
      approve: (request: ApprovalRequest) => this.ask(request, notify),
    };
  }

  pending(session: string): ApprovalView | null {
    return this.waiting.get(session)?.view ?? null;
  }

  answer(session: string, allow: boolean): boolean {
    const w = this.waiting.get(session);
    if (!w) return false;
    this.waiting.delete(session);
    clearTimeout(w.timer);
    w.resolve(allow);
    return true;
  }

  private ask(request: ApprovalRequest, notify: (text: string, view: ApprovalView) => void | Promise<void>): Promise<boolean> {
    // A second question for the same session replaces nothing: the old one is refused first.
    this.answer(request.session, false);
    const view: ApprovalView = { tool: request.tool, reason: request.verdict.reason, details: request.details, args: request.args };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.answer(request.session, false), this.timeoutMs);
      this.waiting.set(request.session, { view, resolve, timer });
      Promise.resolve(notify(formatApproval(view), view)).catch(() => this.answer(request.session, false));
    });
  }
}
