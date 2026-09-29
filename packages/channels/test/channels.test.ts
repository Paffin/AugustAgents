import { describe, expect, test } from "bun:test";
import { makeSessionKey } from "@august/core";
import type { ApprovalRequest } from "@august/agent";
import { PendingApprovals, TelegramChannel, TelegramError, WEB_HTML, WEB_JS, formatApproval, isYes, splitMessage } from "../src/index.ts";

const session = makeSessionKey({ workspace: "home", channel: "telegram", user: "42" });
const request = (s = session): ApprovalRequest => ({
  session: s,
  tool: "mail.send",
  args: { to: "a@b.c", body: "x".repeat(300) },
  verdict: { decision: "ask", rule: "controlled-effect", reason: "send needs your approval" },
  details: "will send one email",
});

describe("PendingApprovals", () => {
  test("shows the prompt and resolves with the answer", async () => {
    const p = new PendingApprovals();
    const shown: string[] = [];
    const result = p.approverFor((t) => void shown.push(t)).approve(request());
    expect(p.pending(session)?.tool).toBe("mail.send");
    expect(shown[0]).toContain("will send one email");
    expect(p.answer(session, true)).toBe(true);
    expect(await result).toBe(true);
    expect(p.pending(session)).toBeNull();
    expect(p.answer(session, true)).toBe(false);
  });

  test("times out as a no", async () => {
    const p = new PendingApprovals(20);
    expect(await p.approverFor(() => {}).approve(request())).toBe(false);
  });

  test("a failed prompt counts as a no", async () => {
    const p = new PendingApprovals();
    expect(await p.approverFor(async () => Promise.reject(new Error("send failed"))).approve(request())).toBe(false);
  });

  test("sessions do not answer each other", async () => {
    const p = new PendingApprovals();
    const other = makeSessionKey({ workspace: "home", channel: "telegram", user: "7" });
    const a = p.approverFor(() => {}).approve(request());
    expect(p.answer(other, true)).toBe(false);
    p.answer(session, false);
    expect(await a).toBe(false);
  });

  test("only explicit yes approves; long values are clipped in the prompt", () => {
    for (const y of ["yes", "Да", "y", "+", "ok."]) expect(isYes(y)).toBe(true);
    for (const n of ["no", "yes please do something else", "", "sure"]) expect(isYes(n)).toBe(false);
    expect(formatApproval({ tool: "t", reason: "r", args: { x: "y".repeat(500) } }).length).toBeLessThan(250);
  });
});

function fakeTelegram(updates: unknown[][]) {
  const calls: Array<{ method: string; body: any }> = [];
  const f = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    if (method === "getUpdates") return new Response(JSON.stringify({ ok: true, result: updates.shift() ?? [] }));
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc";
const msg = (id: number, from: number, text: string, type = "private") => ({ update_id: id, message: { chat: { id: from, type }, from: { id: from }, text } });
const tick = () => Bun.sleep(10);

describe("TelegramChannel", () => {
  test("validates the token and requires an allowlist", () => {
    expect(() => new TelegramChannel({ token: "nope", workspace: "home", allowedUsers: [1], handle: async () => ({ reply: "" }), approvals: new PendingApprovals() })).toThrow(TelegramError);
    expect(() => new TelegramChannel({ token: TOKEN, workspace: "home", allowedUsers: [], handle: async () => ({ reply: "" }), approvals: new PendingApprovals() })).toThrow(/allowed/);
  });

  test("answers allowed users in private chats and ignores everyone else silently", async () => {
    const { f, calls } = fakeTelegram([[msg(1, 42, "hi"), msg(2, 99, "hi"), msg(3, 42, "hi", "group")]]);
    const seen: string[] = [];
    const tg = new TelegramChannel({ token: TOKEN, workspace: "home", allowedUsers: [42], fetch: f, approvals: new PendingApprovals(), handle: async (s, t) => (seen.push(`${s}|${t}`), { reply: "hello" }) });
    await tg.poll();
    await tick();
    expect(seen).toEqual(["home:telegram:42|hi"]);
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body).toMatchObject({ chat_id: 42, text: "hello" });
    await tg.poll();
    expect(calls.filter((c) => c.method === "getUpdates")[1]!.body.offset).toBe(4);
  });

  test("an approval is asked in the chat and answered by the next message, not queued behind the task", async () => {
    const approvals = new PendingApprovals();
    const { f, calls } = fakeTelegram([[msg(1, 42, "send the report")], [msg(2, 42, "да")]]);
    let decided: boolean | undefined;
    const tg = new TelegramChannel({
      token: TOKEN, workspace: "home", allowedUsers: [42], fetch: f, approvals,
      handle: async (s, _t, approver) => {
        decided = await approver.approve(request(s));
        return { reply: decided ? "sent" : "not sent" };
      },
    });
    await tg.poll();
    await tick();
    const prompt = calls.find((c) => c.method === "sendMessage")!;
    expect(prompt.body.text).toContain("mail.send");
    expect(prompt.body.reply_markup.inline_keyboard[0]).toHaveLength(2);
    await tg.poll();
    await tick();
    expect(decided).toBe(true);
    expect(calls.filter((c) => c.method === "sendMessage").at(-1)!.body.text).toBe("sent");
  });

  test("inline buttons answer too, but only for allowed users", async () => {
    const approvals = new PendingApprovals();
    const cb = (id: number, from: number, data: string) => ({ update_id: id, callback_query: { id: `c${id}`, from: { id: from }, data } });
    const { f } = fakeTelegram([[msg(1, 42, "go")], [cb(2, 99, "approve")], [cb(3, 42, "deny")]]);
    let decided: boolean | undefined;
    const tg = new TelegramChannel({ token: TOKEN, workspace: "home", allowedUsers: [42], fetch: f, approvals, handle: async (s, _t, a) => ({ reply: String((decided = await a.approve(request(s)))) }) });
    await tg.poll();
    await tick();
    await tg.poll();
    await tick();
    expect(decided).toBeUndefined();
    await tg.poll();
    await tick();
    expect(decided).toBe(false);
  });

  test("API errors never include the token", async () => {
    const f = (async () => { throw new Error(`connect to api.telegram.org/bot${TOKEN}`); }) as unknown as typeof fetch;
    const tg = new TelegramChannel({ token: TOKEN, workspace: "home", allowedUsers: [42], fetch: f, approvals: new PendingApprovals(), handle: async () => ({ reply: "" }) });
    const e = await tg.poll().catch((x) => x);
    expect(e).toBeInstanceOf(TelegramError);
    expect(e.message).not.toContain(TOKEN);
  });

  test("long replies are split to Telegram's limit", () => {
    expect(splitMessage("a".repeat(9000)).map((p) => p.length)).toEqual([4096, 4096, 808]);
    expect(splitMessage("")).toEqual(["…"]);
  });
});

describe("web page", () => {
  test("takes the token from the fragment, never the query, and renders text safely", () => {
    expect(WEB_JS).toContain("location.hash");
    expect(WEB_JS).toContain("history.replaceState");
    expect(WEB_JS).not.toContain("innerHTML");
    expect(WEB_JS).toContain("authorization");
    expect(WEB_HTML).toContain('<script src="/app.js">');
    expect(WEB_HTML).not.toMatch(/https?:\/\//);
  });
});
