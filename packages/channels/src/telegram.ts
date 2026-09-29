import { LaneQueue, QueueOverflowError, makeSessionKey, type SessionKey } from "@august/core";
import type { Approver } from "@august/agent";
import { isYes, type PendingApprovals } from "./approvals.ts";

export interface TelegramOptions {
  token: string;
  workspace: string;
  /** Only these Telegram user ids are served; everyone else gets no answer at all. */
  allowedUsers: readonly number[];
  handle(session: SessionKey, text: string, approver: Approver): Promise<{ reply: string }>;
  approvals: PendingApprovals;
  fetch?: typeof fetch;
  queue?: LaneQueue;
  pollTimeoutSec?: number;
  onError?(message: string): void;
}

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number; type: string }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number } } };
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

  async send(chatId: number, text: string, buttons = false): Promise<void> {
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      await this.api("sendMessage", {
        chat_id: chatId,
        text: parts[i],
        ...(buttons && last
          ? { reply_markup: { inline_keyboard: [[{ text: "✅ Allow", callback_data: "approve" }, { text: "❌ Deny", callback_data: "deny" }]] } }
          : {}),
      });
    }
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

  private async dispatch(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      const cq = u.callback_query;
      if (!this.allowed.has(cq.from.id)) return;
      const answered = this.o.approvals.answer(this.session(cq.from.id), cq.data === "approve");
      await this.api("answerCallbackQuery", { callback_query_id: cq.id, text: answered ? (cq.data === "approve" ? "Allowed" : "Denied") : "Nothing to approve" });
      return;
    }
    const m = u.message;
    if (!m || !m.from || typeof m.text !== "string") return;
    // Private chats only, from allowed people only. Silence for everyone else.
    if (m.chat.type !== "private" || !this.allowed.has(m.from.id)) return;
    const session = this.session(m.from.id);
    const chatId = m.chat.id;

    if (this.o.approvals.pending(session)) {
      this.o.approvals.answer(session, isYes(m.text));
      return;
    }
    if (m.text === "/start") {
      await this.send(chatId, "Hi! I am August. Write what you need.");
      return;
    }
    const approver = this.o.approvals.approverFor((text) => this.send(chatId, text, true));
    try {
      const { reply } = await this.queue.enqueue(session, () => this.o.handle(session, m.text!, approver));
      await this.send(chatId, reply);
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
