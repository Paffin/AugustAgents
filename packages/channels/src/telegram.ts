import { LaneQueue, QueueOverflowError, makeSessionKey, type SessionKey } from "@august/core";
import type { Approver } from "@august/agent";
import type { ApprovalView } from "@august/gateway";
import type { PendingApprovals } from "./approvals.ts";

export interface TelegramOptions {
  token: string;
  workspace: string;
  /** Only these Telegram user ids are served; everyone else gets no answer at all. */
  allowedUsers: readonly number[];
  handle(session: SessionKey, text: string, approver: Approver): Promise<{ reply: string; runId?: string; feedbackId?: string }>;
  /** Records the owner's judgement of an answer. Throws when it is not theirs or was already judged. */
  feedback?(session: SessionKey, feedbackId: string, verdict: "success" | "failure"): void;
  approvals: PendingApprovals;
  fetch?: typeof fetch;
  queue?: LaneQueue;
  pollTimeoutSec?: number;
  onError?(message: string): void;
}

interface TgUpdate {
  update_id: number;
  message?: { message_id?: number; date?: number; chat: { id: number; type: string }; from?: { id: number }; text?: string; reply_to_message?: { message_id?: number } };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id?: number; chat: { id: number } } };
}

export const TELEGRAM_MAX_TEXT = 4096;

export function splitMessage(text: string, max = TELEGRAM_MAX_TEXT): string[] {
  if (text.length <= max) return [text || "…"];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}

export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

/** Telegram bot over long polling: no public webhook, nothing listening on the internet. */
export class TelegramChannel {
  private offset = 0;
  private running = false;
  private readonly fetchFn: typeof fetch;
  private readonly queue: LaneQueue;
  private readonly allowed: Set<number>;

  constructor(private readonly o: TelegramOptions) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(o.token)) throw new TelegramError("that does not look like a bot token");
    if (o.allowedUsers.length === 0) throw new TelegramError("list at least one allowed Telegram user id");
    this.fetchFn = o.fetch ?? fetch;
    this.queue = o.queue ?? new LaneQueue({ maxPending: 10 });
    this.allowed = new Set(o.allowedUsers);
  }

  /** Calls the Bot API. Errors never contain the URL: it holds the token. */
  async api<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`https://api.telegram.org/bot${this.o.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TelegramError(`${method}: request failed (${(error as Error).name})`);
    }
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!data.ok) throw new TelegramError(`${method}: ${response.status}`);
    return data.result as T;
  }

  /** Sends the text; returns the id of the last message. Buttons carry the approval's id and nonce, so only that request can be answered with them. */
  async send(chatId: number, text: string, approval?: Pick<ApprovalView, "id" | "nonce">, judge?: string): Promise<number | undefined> {
    const parts = splitMessage(text);
    let last: number | undefined;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const sent = await this.api<{ message_id?: number }>("sendMessage", {
        chat_id: chatId,
        text: parts[i],
        ...(approval && isLast
          ? { reply_markup: { inline_keyboard: [[{ text: "✅ Allow", callback_data: `ap:${approval.id}:${approval.nonce}:y` }, { text: "❌ Deny", callback_data: `ap:${approval.id}:${approval.nonce}:n` }]] } }
          : judge && isLast
            ? { reply_markup: { inline_keyboard: [[{ text: "👍", callback_data: `fb:${judge}:g` }, { text: "👎", callback_data: `fb:${judge}:b` }]] } }
            : {}),
      });
      last = sent?.message_id;
    }
    return last;
  }

  private session(userId: number): SessionKey {
    return makeSessionKey({ workspace: this.o.workspace, channel: "telegram", user: String(userId) });
  }

  /** Process one batch of updates. Exposed for tests; run() loops over it. */
  async poll(): Promise<void> {
    const updates = await this.api<TgUpdate[]>(
      "getUpdates",
      { offset: this.offset, timeout: this.o.pollTimeoutSec ?? 25, allowed_updates: ["message", "callback_query"] },
      ((this.o.pollTimeoutSec ?? 25) + 10) * 1000,
    );
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      void this.dispatch(u).catch((e) => this.o.onError?.((e as Error).message));
    }
  }

  /** Handle one update as if it had arrived from polling. For tests. */
  dispatchForTest(update: unknown): Promise<void> {
    return this.dispatch(update as TgUpdate);
  }

  private async dispatch(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      const cq = u.callback_query;
      if (!this.allowed.has(cq.from.id)) return;
      const session = this.session(cq.from.id);
      const judged = /^fb:([A-Za-z0-9_~-]{1,64}):([gb])$/.exec(cq.data ?? "");
      if (judged && this.o.feedback) {
        let text = "Thank you";
        try { this.o.feedback(session, judged[1]!, judged[2] === "g" ? "success" : "failure"); }
        catch (error) { text = /already/.test((error as Error).message) ? "You already judged this answer" : "Nothing to judge"; }
        await this.api("answerCallbackQuery", { callback_query_id: cq.id, text });
        if (text === "Thank you" && cq.message?.message_id !== undefined) await this.api("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
        return;
      }
      const parsed = /^ap:([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_-]{1,64}):([yn])$/.exec(cq.data ?? "");
      const result = parsed
        ? this.o.approvals.resolve({ session, approvalId: parsed[1]!, nonce: parsed[2]!, allow: parsed[3] === "y", resolver: { channel: "telegram", identity: String(cq.from.id) } })
        : undefined;
      const text = result?.ok ? (result.status === "approved" ? "Allowed" : "Denied") : result && (result.reason === "expired" || result.reason === "already-resolved") ? "That request is no longer open" : "Nothing to approve";
      await this.api("answerCallbackQuery", { callback_query_id: cq.id, text });
      // Whatever the outcome, the old buttons must stop looking usable.
      if (result?.ok && cq.message?.message_id !== undefined) {
        await this.api("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      }
      return;
    }
    const m = u.message;
    if (!m || !m.from || typeof m.text !== "string") return;
    // Private chats only, from allowed people only. Silence for everyone else.
    if (m.chat.type !== "private" || !this.allowed.has(m.from.id)) return;
    const session = this.session(m.from.id);
    const chatId = m.chat.id;

    if (this.o.approvals.pending(session)) {
      // Only a message sent after the prompt, and (if it is a reply) one that replies to it, answers it.
      this.o.approvals.answerText(session, m.text, { sentAt: (m.date ?? 0) * 1000, replyTo: m.reply_to_message?.message_id, resolver: { channel: "telegram", identity: String(m.from.id) } });
      return;
    }
    if (m.text === "/start") {
      await this.send(chatId, "Hi! I am August. Write what you need.");
      return;
    }
    const approver = this.o.approvals.approverFor((text, view) => this.send(chatId, text, view));
    try {
      const { reply, feedbackId } = await this.queue.enqueue(session, () => this.o.handle(session, m.text!, approver));
      await this.send(chatId, reply, undefined, this.o.feedback ? feedbackId : undefined);
    } catch (error) {
      await this.send(chatId, error instanceof QueueOverflowError ? "Too many messages at once, please wait." : "Something went wrong.");
    }
  }

  async run(): Promise<void> {
    this.running = true;
    let backoff = 1000;
    while (this.running) {
      try {
        await this.poll();
        backoff = 1000;
      } catch (error) {
        this.o.onError?.((error as Error).message);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}
