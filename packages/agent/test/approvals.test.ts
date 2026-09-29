import { describe, expect, test } from "bun:test";
import { makeSessionKey } from "@august/core";
import { ApprovalLedger, actionHash } from "../src/index.ts";

// Suite category: Safety/security invariant (REQ-SEC-002): approvals bind session, tool, action hash, nonce and expiry, and resolve once.
const s1 = makeSessionKey({ workspace: "home", channel: "telegram", user: "42" });
const s2 = makeSessionKey({ workspace: "home", channel: "telegram", user: "7" });
const web = makeSessionKey({ workspace: "home", channel: "web", user: "local" });
const hash = actionHash({ tool: "mail.send", args: { to: "a@b.c" } });
const who = { channel: "telegram", identity: "42" };
const clock = (start = 1000) => { let now = start; return { now: () => now, advance: (ms: number) => { now += ms; } }; };

describe("actionHash", () => {
  test("is canonical over key order and covers tool, arguments, destination and targets", () => {
    const base = { tool: "mail.send", args: { to: "a@b.c", body: "x", nested: { b: 1, a: 2 } } };
    expect(actionHash(base)).toBe(actionHash({ tool: "mail.send", args: { nested: { a: 2, b: 1 }, body: "x", to: "a@b.c" } }));
    const variants = [{ ...base, tool: "mail.draft" }, { ...base, args: { ...base.args, to: "evil@x.c" } }, { ...base, destination: "b.c" }, { ...base, targets: [{ kind: "workspace", label: "a" }] }];
    for (const v of variants) expect(actionHash(v)).not.toBe(actionHash(base));
    expect(actionHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ApprovalLedger", () => {
  test("a ticket names its session, tool, hash and expiry, with an unguessable id and nonce", () => {
    const c = clock(); const ledger = new ApprovalLedger({ ttlMs: 60_000, now: c.now });
    const t = ledger.open({ session: s1, tool: "mail.send", actionHash: hash });
    expect(t).toMatchObject({ session: s1, tool: "mail.send", actionHash: hash, createdAt: 1000, expiresAt: 61_000 });
    const t2 = ledger.open({ session: s2, tool: "mail.send", actionHash: hash });
    expect(new Set([t.id, t.nonce, t2.id, t2.nonce]).size).toBe(4);
    expect(t.id.length).toBeGreaterThanOrEqual(12); expect(t.nonce.length).toBeGreaterThanOrEqual(16);
  });

  test("resolves once: the second answer, even the same one, is refused and changes nothing", async () => {
    const ledger = new ApprovalLedger(); const t = ledger.open({ session: s1, tool: "mail.send", actionHash: hash });
    const waiting = ledger.wait(t.id);
    expect(ledger.resolve({ id: t.id, nonce: t.nonce, session: s1, decision: "approve", resolver: who })).toEqual({ ok: true, status: "approved" });
    expect(await waiting).toBe("approved");
    for (const decision of ["approve", "deny"] as const) expect(ledger.resolve({ id: t.id, nonce: t.nonce, session: s1, decision, resolver: who })).toEqual({ ok: false, reason: "already-resolved" });
    expect(ledger.get(t.id)).toMatchObject({ status: "approved", resolver: who });
  });

  test("confused deputy: wrong session, wrong nonce, unknown id and a resolver that is not the session's own channel and user all fail without touching the record", () => {
    const ledger = new ApprovalLedger(); const t = ledger.open({ session: s1, tool: "mail.send", actionHash: hash });
    const ok = { id: t.id, nonce: t.nonce, session: s1, decision: "approve" as const, resolver: who };
    expect(ledger.resolve({ ...ok, session: s2 })).toEqual({ ok: false, reason: "session" });
    expect(ledger.resolve({ ...ok, nonce: t.nonce.slice(1) + "x" })).toEqual({ ok: false, reason: "nonce" });
    expect(ledger.resolve({ ...ok, nonce: "" })).toEqual({ ok: false, reason: "nonce" });
    expect(ledger.resolve({ ...ok, id: "nope" })).toEqual({ ok: false, reason: "unknown" });
    expect(ledger.resolve({ ...ok, resolver: { channel: "telegram", identity: "7" } })).toEqual({ ok: false, reason: "resolver" });
    expect(ledger.resolve({ ...ok, resolver: { channel: "web", identity: "42" } })).toEqual({ ok: false, reason: "resolver" });
    expect(ledger.get(t.id)?.status).toBe("pending");
    // A different session's own channel cannot answer this one even holding the id and nonce.
    expect(ledger.resolve({ ...ok, session: s2, resolver: { channel: "telegram", identity: "7" } })).toEqual({ ok: false, reason: "session" });
    expect(ledger.resolve(ok)).toEqual({ ok: true, status: "approved" });
  });

  test("expiry: an answer after the deadline is refused and the waiter learns it expired", async () => {
    const c = clock(); const ledger = new ApprovalLedger({ ttlMs: 1000, now: c.now });
    const t = ledger.open({ session: s1, tool: "mail.send", actionHash: hash });
    c.advance(999); expect(ledger.get(t.id)?.status).toBe("pending");
    c.advance(1);
    expect(ledger.resolve({ id: t.id, nonce: t.nonce, session: s1, decision: "approve", resolver: who })).toEqual({ ok: false, reason: "expired" });
    expect(await ledger.wait(t.id)).toBe("expired");
    expect(ledger.consume(t.id, hash)).toBe(false);
  });

  test("expiry also fires on its own timer for a waiter nobody answers", async () => {
    const ledger = new ApprovalLedger({ ttlMs: 25 }); const t = ledger.open({ session: s1, tool: "mail.send", actionHash: hash });
    expect(await ledger.wait(t.id)).toBe("expired");
  });

  test("a newer approval for the same session supersedes the older one, and other sessions are untouched", async () => {
    const ledger = new ApprovalLedger();
    const old = ledger.open({ session: s1, tool: "mail.send", actionHash: hash });
    const other = ledger.open({ session: s2, tool: "mail.send", actionHash: hash });
    const fresh = ledger.open({ session: s1, tool: "mail.delete", actionHash: actionHash({ tool: "mail.delete", args: {} }) });
    expect(await ledger.wait(old.id)).toBe("superseded");
    expect(ledger.resolve({ id: old.id, nonce: old.nonce, session: s1, decision: "approve", resolver: who })).toEqual({ ok: false, reason: "already-resolved" });
    expect(ledger.get(other.id)?.status).toBe("pending");
    expect(ledger.pendingFor(s1)?.id).toBe(fresh.id);
    expect(ledger.consume(old.id, hash)).toBe(false);
  });

  test("consume: only an approved record, only for the exact action hash, exactly once", () => {
    const ledger = new ApprovalLedger();
    const denied = ledger.open({ session: s1, tool: "mail.send", actionHash: hash }); ledger.resolve({ id: denied.id, nonce: denied.nonce, session: s1, decision: "deny", resolver: who });
    expect(ledger.consume(denied.id, hash)).toBe(false);
    const pending = ledger.open({ session: s2, tool: "mail.send", actionHash: hash });
    expect(ledger.consume(pending.id, hash)).toBe(false);
    const t = ledger.open({ session: s1, tool: "mail.send", actionHash: hash });
    ledger.resolve({ id: t.id, nonce: t.nonce, session: s1, decision: "approve", resolver: who });
    expect(ledger.consume(t.id, actionHash({ tool: "mail.send", args: { to: "evil@x.c" } }))).toBe(false);
    expect(ledger.consume(t.id, hash)).toBe(true);
    expect(ledger.consume(t.id, hash)).toBe(false);
    expect(ledger.get(t.id)?.status).toBe("consumed");
    expect(ledger.resolve({ id: t.id, nonce: t.nonce, session: s1, decision: "approve", resolver: who })).toEqual({ ok: false, reason: "already-resolved" });
  });

  test("resolveTrusted is the in-process path: it still answers once and never revives an expired record", () => {
    const c = clock(); const ledger = new ApprovalLedger({ ttlMs: 10, now: c.now });
    const a = ledger.open({ session: web, tool: "mail.send", actionHash: hash });
    expect(ledger.resolveTrusted(a.id, "approve", { channel: "terminal", identity: "approver" })).toEqual({ ok: true, status: "approved" });
    expect(ledger.resolveTrusted(a.id, "deny", { channel: "terminal", identity: "approver" })).toEqual({ ok: false, reason: "already-resolved" });
    const b = ledger.open({ session: web, tool: "mail.send", actionHash: hash }); c.advance(10);
    expect(ledger.resolveTrusted(b.id, "approve", { channel: "terminal", identity: "approver" })).toEqual({ ok: false, reason: "expired" });
    expect(ledger.resolveTrusted("nope", "approve", { channel: "terminal", identity: "approver" })).toEqual({ ok: false, reason: "unknown" });
  });

  test("concurrent answers: exactly one wins", () => {
    const ledger = new ApprovalLedger(); const t = ledger.open({ session: s1, tool: "mail.send", actionHash: hash });
    const results = Array.from({ length: 20 }, (_, i) => ledger.resolve({ id: t.id, nonce: t.nonce, session: s1, decision: i % 2 ? "approve" : "deny", resolver: who }));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "already-resolved")).toBe(true);
  });

  test("bounded memory: settled records are dropped past the limit and their ids become unknown, never resolvable", () => {
    const ledger = new ApprovalLedger({ maxRecords: 5 }); const first = ledger.open({ session: s1, tool: "mail.send", actionHash: hash });
    ledger.resolve({ id: first.id, nonce: first.nonce, session: s1, decision: "approve", resolver: who });
    for (let i = 0; i < 10; i++) { const t = ledger.open({ session: web, tool: "mail.send", actionHash: hash }); ledger.resolveTrusted(t.id, "deny", { channel: "terminal", identity: "a" }); }
    expect(ledger.get(first.id)).toBeUndefined();
    expect(ledger.resolve({ id: first.id, nonce: first.nonce, session: s1, decision: "approve", resolver: who })).toEqual({ ok: false, reason: "unknown" });
    expect(() => new ApprovalLedger({ ttlMs: 0 })).toThrow(/positive integer/);
  });
});
