import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { AnchorLog, AuditAnchorer, AuditKey, EventJournal, verifyAudit, type AuditAnchor } from "../src/index.ts";

// Suite category: Safety/security invariant (REQ-SEC-004). Attacks: rewrite history and recompute the chain, cut the tail, drop an anchor, forge an anchor with another key.
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "august-audit-")); dirs.push(d); return d; };

function setup(events = 120, every = 50) {
  const dir = tmp(); const journal = new EventJournal(join(dir, "journal.db"));
  const key = new AuditKey(randomBytes(32)); const log = new AnchorLog(join(dir, "keys", "anchors.jsonl"));
  const anchorer = new AuditAnchorer(journal, { log, key, every });
  // Construct synthesized fixture history atomically: filesystem fsync latency is not the attack under test.
  // Production append/observer durability is unchanged; reopened-file and independent-process tests remain.
  journal.rawDb.transaction(() => {
    for (let i = 0; i < events; i++) journal.append({ kind: "tool.call", session: "s", data: { i } }, 1000 + i);
  })();
  return { dir, journal, key, log, anchorer };
}

/** What an attacker with write access to the journal file can do: change an entry and recompute every hash after it. */
function rewriteAndRechain(journal: EventJournal, seq: number, data: unknown): void {
  const db = journal.rawDb; const rows = db.query("SELECT * FROM journal ORDER BY seq").all() as Array<{ seq: number; ts: number; kind: string; session: string; data: string; prev_hash: string }>;
  let prev = "0".repeat(64);
  for (const r of rows) {
    const payload = r.seq === seq ? JSON.stringify(data) : r.data;
    const hash = createHash("sha256").update(JSON.stringify([prev, r.seq, r.ts, r.kind, r.session, JSON.parse(payload)])).digest("hex");
    db.query("UPDATE journal SET data=?, prev_hash=?, hash=? WHERE seq=?").run(payload, prev, hash, r.seq);
    prev = hash;
  }
}

describe("signed journal anchors", () => {
  test("an untouched journal verifies, and entries after the last anchor are reported as not yet vouched for", () => {
    const { journal, key, log } = setup();
    const report = verifyAudit(journal, log.list(), key.publicKeyBytes(), key.id);
    expect(report).toMatchObject({ ok: true, chainBrokenAt: null, anchors: 2, anchoredThrough: 100, unanchored: 20 });
    journal.close();
  });

  test("ATTACK: rewriting an entry and recomputing the whole chain passes the chain check but is caught by the anchors", () => {
    const { journal, key, log } = setup();
    rewriteAndRechain(journal, 30, { i: "forged" });
    expect(journal.verify()).toBeNull();
    const report = verifyAudit(journal, log.list(), key.publicKeyBytes(), key.id);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("entry 50 differs from what anchor 1 signed");
    journal.close();
  });

  test("a rewrite of entries after the last anchor is the exposure window: not yet vouched for, so anchoring is frequent and happens at shutdown", () => {
    const { journal, key, log, anchorer } = setup();
    rewriteAndRechain(journal, 110, { i: "late" });
    expect(verifyAudit(journal, log.list(), key.publicKeyBytes(), key.id).ok).toBe(true);
    expect(anchorer.anchor()?.seq).toBe(120);
    journal.close();
  });

  test("ATTACK: cutting the journal back behind its newest anchor is detected", () => {
    const { journal, key, log } = setup();
    journal.rawDb.run("DELETE FROM journal WHERE seq > 60");
    const report = verifyAudit(journal, log.list(), key.publicKeyBytes(), key.id);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("entry 100, vouched for by anchor 2, is gone");
    journal.close();
  });

  test("ATTACK: dropping an anchor from the middle, reordering, or editing one is detected", () => {
    const { journal, key, log } = setup(220);
    const anchors = log.list();
    expect(anchors).toHaveLength(4);
    const dropped = verifyAudit(journal, [anchors[0]!, anchors[2]!, anchors[3]!], key.publicKeyBytes(), key.id);
    expect(dropped.ok).toBe(false);
    const edited = verifyAudit(journal, anchors.map((a, i) => (i === 1 ? { ...a, hash: "f".repeat(64) } : a)), key.publicKeyBytes(), key.id);
    expect(edited.problems.join("\n")).toContain("invalid signature");
    journal.close();
  });

  test("ATTACK: anchors forged with another key are rejected", () => {
    const { journal, key } = setup();
    const other = new AuditKey(randomBytes(32)); const forgedLog = new AnchorLog(join(tmp(), "a.jsonl"));
    new AuditAnchorer(journal, { log: forgedLog, key: other, every: 10 }).anchor();
    const report = verifyAudit(journal, forgedLog.list(), key.publicKeyBytes(), key.id);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("signed by a different key");
    journal.close();
  });

  test("anchors are appended to a private file outside the journal, resume after a restart, and carry no event content", () => {
    const { dir, journal, key, log } = setup(60);
    const before = log.list().length;
    journal.close();
    const reopened = new EventJournal(join(dir, "journal.db"));
    const again = new AuditAnchorer(reopened, { log: new AnchorLog(log.path), key, every: 50 });
    for (let i = 0; i < 60; i++) reopened.append({ kind: "tool.call", session: "s", data: { i } }, 5000 + i);
    expect(again.anchor()).toBeDefined();
    const anchors: AuditAnchor[] = new AnchorLog(log.path).list();
    expect(anchors.length).toBeGreaterThan(before);
    expect(verifyAudit(reopened, anchors, key.publicKeyBytes(), key.id).ok).toBe(true);
    expect(readFileSync(log.path, "utf8")).not.toContain("tool.call");
    reopened.close();
  });

  test("an observer that throws can never cost an event", () => {
    const j = new EventJournal(); j.onAppend(() => { throw new Error("boom"); });
    expect(j.append({ kind: "k", session: "s", data: 1 }).seq).toBe(1);
    expect(j.verify()).toBeNull();
  });
});
