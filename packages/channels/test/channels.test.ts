import { describe, expect, test } from "bun:test";
import { makeSessionKey } from "@august/core";
import { ApprovalLedger, type ApprovalRequest } from "@august/agent";
import { PendingApprovals, TelegramChannel, TelegramError, WEB_HTML, WEB_JS, formatApproval, isYes, splitMessage } from "../src/index.ts";

// Suite category: Safety/security invariant (REQ-SEC-002 bound, non-replayable approvals) and Product behavior (approval UX).
const session = makeSessionKey({ workspace: "home", channel: "telegram", user: "42" });
const other = makeSessionKey({ workspace: "home", channel: "telegram", user: "7" });
const hash = "a".repeat(64);
/** A request with a real ticket from the ledger, the way the runtime issues it. */
const request = (ledger: ApprovalLedger, s = session): ApprovalRequest => ({
  session: s,
  tool: "mail.send",
  args: { to: "a@b.c", body: "x".repeat(300) },
  verdict: { decision: "ask", rule: "controlled-effect", reason: "send needs your approval" },
  details: "will send one email",
  ticket: ledger.open({ session: s, tool: "mail.send", actionHash: hash }),
});
const tg42 = { channel: "telegram", identity: "42" };
const answerOf = (p: PendingApprovals, s = session) => { const v = p.pending(s)!; return { session: s, approvalId: v.id, nonce: v.nonce, resolver: { channel: "telegram", identity: s.split(":")[2]! } }; };

describe("PendingApprovals", () => {
  test("shows the prompt, resolves once with the displayed id and nonce, and a replay resolves nothing", async () => {
    const p = new PendingApprovals();
    const shown: string[] = [];
    const result = p.approverFor((t) => void shown.push(t)).approve(request(p.ledger));
    const view = p.pending(session)!;
    expect(view).toMatchObject({ tool: "mail.send" });
    expect(shown[0]).toContain("will send one email");
    expect(shown[0]).toContain(view.id);
    expect(p.resolve({ ...answerOf(p), allow: true })).toEqual({ ok: true, status: "approved" });
    expect(await result).toBe(true);
    expect(p.pending(session)).toBeNull();
    expect(p.resolve({ session, approvalId: view.id, nonce: view.nonce, allow: true, resolver: tg42 })).toEqual({ ok: false, reason: "already-resolved" });
  });

  test("an approval expires as a no, and an answer after expiry resolves nothing", async () => {
    let now = 1000; const ledger = new ApprovalLedger({ ttlMs: 50, now: () => now });
    const p = new PendingApprovals(ledger);
    const result = p.approverFor(() => {}).approve(request(ledger));
    const v = p.pending(session)!;
    now += 60;
    expect(p.resolve({ session, approvalId: v.id, nonce: v.nonce, allow: true, resolver: tg42 })).toEqual({ ok: false, reason: "expired" });
    expect(await result).toBe(false);
  });

  test("a failed prompt counts as a no and leaves nothing pending", async () => {
    const p = new PendingApprovals();
    expect(await p.approverFor(async () => Promise.reject(new Error("send failed"))).approve(request(p.ledger))).toBe(false);
    expect(p.pending(session)).toBeNull();
  });

  test("confused deputy: another session, another channel or user, a wrong nonce or a made-up id resolve nothing", async () => {
    const p = new PendingApprovals();
    const a = p.approverFor(() => {}).approve(request(p.ledger));
    const v = p.pending(session)!;
    const base = { approvalId: v.id, nonce: v.nonce, allow: true };
    expect(p.resolve({ ...base, session: other, resolver: { channel: "telegram", identity: "7" } })).toEqual({ ok: false, reason: "session" });
    expect(p.resolve({ ...base, session, resolver: { channel: "telegram", identity: "7" } })).toEqual({ ok: false, reason: "resolver" });
    expect(p.resolve({ ...base, session, resolver: { channel: "web", identity: "42" } })).toEqual({ ok: false, reason: "resolver" });
    expect(p.resolve({ ...base, session, nonce: "wrong", resolver: tg42 })).toEqual({ ok: false, reason: "nonce" });
    expect(p.resolve({ ...base, session, approvalId: "made-up", resolver: tg42 })).toEqual({ ok: false, reason: "unknown" });
    expect(p.pending(session)?.id).toBe(v.id);
    p.resolve({ ...base, session, allow: false, resolver: tg42 });
    expect(await a).toBe(false);
  });

  test("a newer approval supersedes the older one; the old id and nonce can never answer the new action", async () => {
    const p = new PendingApprovals();
    const first = p.approverFor(() => {}).approve(request(p.ledger));
    const old = p.pending(session)!;
    const second = p.approverFor(() => {}).approve(request(p.ledger));
    expect(await first).toBe(false);
    const current = p.pending(session)!;
    expect(current.id).not.toBe(old.id);
    expect(p.resolve({ session, approvalId: old.id, nonce: old.nonce, allow: true, resolver: tg42 })).toEqual({ ok: false, reason: "already-resolved" });
    expect(p.pending(session)?.id).toBe(current.id);
    p.resolve({ ...answerOf(p), allow: true });
    expect(await second).toBe(true);
  });

  test("typed answers count only after the prompt, and only as a reply to that prompt when they are a reply", async () => {
    let now = 5000; const ledger = new ApprovalLedger({ now: () => now });
    const p = new PendingApprovals(ledger);
    const result = p.approverFor(() => 900).approve(request(ledger));
    await Bun.sleep(1);
    expect(p.pending(session)).not.toBeNull();
    const text = (over: { sentAt?: number; replyTo?: number }) => p.answerText(session, "yes", { sentAt: over.sentAt ?? now, replyTo: over.replyTo, resolver: tg42 });
    expect(text({ sentAt: now - 1 })).toEqual({ ok: false, reason: "expired" });
    expect(text({ replyTo: 123 })).toEqual({ ok: false, reason: "unknown" });
    expect(p.pending(session)).not.toBeNull();
    expect(p.answerText(other, "yes", { sentAt: now, resolver: { channel: "telegram", identity: "7" } })).toBe("ignored");
    expect(text({ replyTo: 900 })).toEqual({ ok: true, status: "approved" });
    expect(await result).toBe(true);
    expect(p.answerText(session, "yes", { sentAt: now, resolver: tg42 })).toBe("ignored");
  });

  test("anything but an explicit yes typed in answer denies", async () => {
    const p = new PendingApprovals(); const result = p.approverFor(() => {}).approve(request(p.ledger));
    expect(p.answerText(session, "sure", { sentAt: Date.now() + 1, resolver: tg42 })).toEqual({ ok: true, status: "denied" });
    expect(await result).toBe(false);
  });

  test("the gateway adapter cannot answer channels that have their own transport", async () => {
    const p = new PendingApprovals(); const gw = p.forGateway(["telegram"]);
    const result = p.approverFor(() => {}).approve(request(p.ledger));
    const v = p.pending(session)!;
    expect(gw.pending(session)).toBeNull();
    expect(gw.resolve({ session, approvalId: v.id, nonce: v.nonce, allow: true })).toEqual({ ok: false, reason: "resolver" });
    expect(p.pending(session)?.id).toBe(v.id);
    const web = makeSessionKey({ workspace: "home", channel: "web", user: "local" });
    const webResult = p.approverFor(() => {}).approve(request(p.ledger, web));
    const wv = p.pending(web)!;
    expect(p.forGateway(["telegram"]).pending(web)?.id).toBe(wv.id);
    expect(gw.resolve({ session: web, approvalId: wv.id, nonce: wv.nonce, allow: true })).toEqual({ ok: true, status: "approved" });
    expect(await webResult).toBe(true);
    p.resolve({ ...answerOf(p), allow: false }); expect(await result).toBe(false);
  });

  test("only explicit yes approves; long values are clipped in the prompt", () => {
    for (const y of ["yes", "Да", "y", "+", "ok."]) expect(isYes(y)).toBe(true);
    for (const n of ["no", "yes please do something else", "", "sure"]) expect(isYes(n)).toBe(false);
    expect(formatApproval({ id: "i", nonce: "n", tool: "t", reason: "r", args: { x: "y".repeat(500) }, createdAt: 0, expiresAt: 1 }).length).toBeLessThan(250);
  });
});

function fakeTelegram(updates: unknown[][]) {
  const calls: Array<{ method: string; body: any }> = [];
  const f = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    if (method === "getUpdates") return new Response(JSON.stringify({ ok: true, result: updates.shift() ?? [] }));
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 1000 + calls.length } : {} }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc";
const msg = (id: number, from: number, text: string, type = "private", extra: Record<string, unknown> = {}) => ({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000) + 1, chat: { id: from, type }, from: { id: from }, text, ...extra } });
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
        decided = await approver.approve(request(approvals.ledger, s));
        return { reply: decided ? "sent" : "not sent" };
      },
    });
    await tg.poll();
    await tick();
    const prompt = calls.find((c) => c.method === "sendMessage")!;
    expect(prompt.body.text).toContain("mail.send");
    const buttons = prompt.body.reply_markup.inline_keyboard[0];
    expect(buttons).toHaveLength(2);
    const view = approvals.pending(session)!;
    expect(buttons.map((b: { callback_data: string }) => b.callback_data)).toEqual([`ap:${view.id}:${view.nonce}:y`, `ap:${view.id}:${view.nonce}:n`]);
    for (const b of buttons) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    await tg.poll();
    await tick();
    expect(decided).toBe(true);
    expect(calls.filter((c) => c.method === "sendMessage").at(-1)!.body.text).toBe("sent");
  });

  const cb = (id: number, from: number, data: string) => ({ update_id: id, callback_query: { id: `c${id}`, from: { id: from }, data, message: { message_id: 1001, chat: { id: from } } } });

  test("inline buttons answer only for the person they were issued to, and a replayed press resolves nothing", async () => {
    const approvals = new PendingApprovals();
    const { f, calls } = fakeTelegram([[msg(1, 42, "go")]]);
    let decided: boolean | undefined;
    const tg = new TelegramChannel({ token: TOKEN, workspace: "home", allowedUsers: [42, 7], fetch: f, approvals, handle: async (s, _t, a) => ({ reply: String((decided = await a.approve(request(approvals.ledger, s)))) }) });
    await tg.poll(); await tick();
    const v = approvals.pending(session)!; const data = (yn: string) => `ap:${v.id}:${v.nonce}:${yn}`;
    // A different allowed person presses the buttons they were forwarded: not their session.
    await tg.dispatchForTest(cb(2, 7, data("y"))); await tick();
    // An outsider (ignored without any answer), a malformed payload and a forged nonce.
    await tg.dispatchForTest(cb(3, 99, data("y"))); await tg.dispatchForTest(cb(4, 42, "approve")); await tg.dispatchForTest(cb(5, 42, `ap:${v.id}:forged:y`)); await tick();
    expect(decided).toBeUndefined();
    expect(approvals.pending(session)?.id).toBe(v.id);
    await tg.dispatchForTest(cb(6, 42, data("n"))); await tick();
    expect(decided).toBe(false);
    // The same button again, after the answer: nothing to resolve, and it says so.
    await tg.dispatchForTest(cb(7, 42, data("y"))); await tick();
    const answers = calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);
    expect(answers).toEqual(["Nothing to approve", "Nothing to approve", "Nothing to approve", "Denied", "That request is no longer open"]);
    expect(calls.some((c) => c.method === "editMessageReplyMarkup" && c.body.reply_markup.inline_keyboard.length === 0)).toBe(true);
  });

  test("a button from an older request cannot answer the newer one", async () => {
    const approvals = new PendingApprovals();
    const { f } = fakeTelegram([[msg(1, 42, "go")]]);
    const decisions: boolean[] = [];
    const tg = new TelegramChannel({ token: TOKEN, workspace: "home", allowedUsers: [42], fetch: f, approvals, handle: async (s, _t, a) => {
      const first = a.approve(request(approvals.ledger, s));
      await tick();
      const old = approvals.pending(s)!;
      const second = a.approve(request(approvals.ledger, s));
      decisions.push(await first);
      await tg.dispatchForTest(cb(2, 42, `ap:${old.id}:${old.nonce}:y`)); await tick();
      const current = approvals.pending(s)!;
      expect(current.id).not.toBe(old.id);
      await tg.dispatchForTest(cb(3, 42, `ap:${current.id}:${current.nonce}:y`));
      decisions.push(await second);
      return { reply: "done" };
    } });
    await tg.poll(); await Bun.sleep(80);
    expect(decisions).toEqual([false, true]);
  });

  test("a yes typed before the prompt, or as a reply to something else, does not answer it", async () => {
    const approvals = new PendingApprovals();
    const { f } = fakeTelegram([[msg(1, 42, "go")]]);
    let decided: boolean | undefined;
    const tg = new TelegramChannel({ token: TOKEN, workspace: "home", allowedUsers: [42], fetch: f, approvals, handle: async (s, _t, a) => ({ reply: String((decided = await a.approve(request(approvals.ledger, s)))) }) });
    await tg.poll(); await tick();
    const stale = { ...msg(2, 42, "yes"), message: { ...msg(2, 42, "yes").message, date: 1 } };
    await tg.dispatchForTest(stale);
    await tg.dispatchForTest(msg(3, 42, "yes", "private", { reply_to_message: { message_id: 5 } }));
    await tick();
    expect(decided).toBeUndefined();
    await tg.dispatchForTest(msg(4, 42, "yes")); await tick();
    expect(decided).toBe(true);
  });

  test("answers carry judgement buttons bound to the run; only the person the run belongs to can press them, once", async () => {
    const approvals = new PendingApprovals(); const judged: Array<[string, string, string]> = [];
    const { f, calls } = fakeTelegram([[msg(1, 42, "hello")]]);
    const tg = new TelegramChannel({ token: TOKEN, workspace: "home", allowedUsers: [42, 7], fetch: f, approvals, handle: async () => ({ reply: "hi there", runId: "0b0a3c1e-6f3a-4a0e-9d6a-1f2e3d4c5b6a" }),
      feedback: (session, runId, verdict) => { if (judged.some((j) => j[1] === runId && j[0] === session)) throw new Error("owner already gave a verdict"); if (session !== "home:telegram:42") throw new Error("no such run for this session"); judged.push([session, runId, verdict]); } });
    await tg.poll(); await tick();
    const reply = calls.filter((c) => c.method === "sendMessage").at(-1)!.body;
    const row = reply.reply_markup.inline_keyboard[0] as Array<{ text: string; callback_data: string }>;
    expect(row.map((b) => b.text)).toEqual(["👍", "👎"]);
    for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    const fb = (id: number, from: number, data: string) => ({ update_id: id, callback_query: { id: `c${id}`, from: { id: from }, data, message: { message_id: 5, chat: { id: from } } } });
    await tg.dispatchForTest(fb(2, 7, row[0]!.callback_data)); await tg.dispatchForTest(fb(3, 99, row[0]!.callback_data));
    await tg.dispatchForTest(fb(4, 42, "fb:bad data!:g")); await tg.dispatchForTest(fb(5, 42, row[1]!.callback_data)); await tg.dispatchForTest(fb(6, 42, row[0]!.callback_data)); await tick();
    expect(judged).toEqual([["home:telegram:42", "0b0a3c1e-6f3a-4a0e-9d6a-1f2e3d4c5b6a", "failure"]]);
    expect(calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text)).toEqual(["Nothing to judge", "Nothing to approve", "Thank you", "You already judged this answer"]);
    expect(calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(true);
  });

  test("without a feedback sink no judgement buttons are offered", async () => {
    const { f, calls } = fakeTelegram([[msg(1, 42, "hello")]]);
    const tg = new TelegramChannel({ token: TOKEN, workspace: "home", allowedUsers: [42], fetch: f, approvals: new PendingApprovals(), handle: async () => ({ reply: "hi", runId: "run-1" }) });
    await tg.poll(); await tick();
    expect(calls.filter((c) => c.method === "sendMessage").at(-1)!.body.reply_markup).toBeUndefined();
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

describe("web page accessibility and approval binding (REQ-ACC-001)", () => {
  // The live keyboard-only journey runs in a real browser against `august serve`; these pin the markup and script it relies on.
  test("semantic structure: language, landmarks, labelled input, live log", () => {
    expect(WEB_HTML).toContain('<html lang="en">');
    expect(WEB_HTML).toMatch(/<main>[\s\S]*<\/main>/);
    expect(WEB_HTML).toContain('role="log"');
    expect(WEB_HTML).toContain('aria-live="polite"');
    expect(WEB_HTML).toMatch(/<label class="sr" for="text">[^<]+<\/label>\s*<input id="text"/);
    expect(WEB_HTML).toContain(":focus-visible");
    expect(WEB_HTML).not.toMatch(/outline:\s*none/);
  });

  test("an approval card is an alertdialog with a title, specific button names, keyboard Escape to deny, and stops being a dialog once answered", () => {
    expect(WEB_JS).toContain('"alertdialog"');
    expect(WEB_JS).toContain("aria-labelledby");
    expect(WEB_JS).toContain("aria-label");
    expect(WEB_JS).toContain('"Escape"');
    expect(WEB_JS).toContain('removeAttribute("role")');
    expect(WEB_JS).toContain("card.focus()");
    expect(WEB_JS).not.toContain("innerHTML");
  });

  test("the answer carries the displayed approval id and nonce, not a bare allow", () => {
    expect(WEB_JS).toContain("approvalId: approval.id");
    expect(WEB_JS).toContain("nonce: approval.nonce");
  });

  test("the page offers the owner a keyboard-operable, labelled judgement of each answer and posts it with the run id", () => {
    expect(WEB_JS).toContain('"/v1/feedback"');
    expect(WEB_JS).toContain("Was this answer right?");
    expect(WEB_JS).toContain("Mark this answer as good"); expect(WEB_JS).toContain("Mark this answer as not right");
    expect(WEB_JS).toContain("runId"); expect(WEB_JS).toContain("body.runId");
  });

  test("the script is valid JavaScript", () => {
    expect(() => new Function(WEB_JS)).not.toThrow();
  });

  test("Product behavior: task controls render durable usage and do not treat a paused reply as a verified answer", () => {
    expect(WEB_HTML).toContain('aria-label="Recent task controls"');
    expect(WEB_JS).toContain('"/v1/runs?channel="');
    expect(WEB_JS).toContain('run.usage.totalTokens');
    expect(WEB_JS).toContain('run.canResume');
    expect(WEB_JS).toContain('body.state === "completed"');
    expect(WEB_JS).toContain('"Cancel further work"');
  });

  test("Safety (REQ-SEC-004): credentials use a separate password form, direct endpoint and names-only display", () => {
    expect(WEB_HTML).toContain('id="credential-value" type="password"');
    expect(WEB_HTML).toContain('for="credential-name"');
    expect(WEB_HTML).toContain('for="credential-scope"');
    expect(WEB_HTML).toContain('aria-label="Stored secret names"');
    expect(WEB_JS).toContain('field.value = ""');
    expect(WEB_JS).toContain('method: "PUT"');
    expect(WEB_JS).toContain('method: "DELETE"');
    expect(WEB_JS).toContain('JSON.stringify({ value })');
    expect(WEB_JS).toContain('label.textContent = name');
    expect(WEB_JS).not.toContain("innerHTML");
  });
});
