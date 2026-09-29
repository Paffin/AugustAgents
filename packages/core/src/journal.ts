import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface JournalEvent {
  /** Free-form event kind, e.g. "tool.call", "approval.granted". */
  kind: string;
  session: string;
  /** JSON-serializable payload. Never put secrets here. */
  data: unknown;
}

export interface JournalEntry extends JournalEvent {
  seq: number;
  ts: number;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function digest(prevHash: string, seq: number, ts: number, event: JournalEvent): string {
  return createHash("sha256")
    .update(JSON.stringify([prevHash, seq, ts, event.kind, event.session, event.data]))
    .digest("hex");
}

/**
 * Append-only event log. Each entry hashes the previous one, so editing or
 * deleting history is detectable with verify().
 */
export class EventJournal {
  private readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.run(
      `CREATE TABLE IF NOT EXISTS journal (
         seq INTEGER PRIMARY KEY,
         ts INTEGER NOT NULL,
         kind TEXT NOT NULL,
         session TEXT NOT NULL,
         data TEXT NOT NULL,
         prev_hash TEXT NOT NULL,
         hash TEXT NOT NULL
       )`,
    );
    this.db.run("CREATE INDEX IF NOT EXISTS journal_session ON journal(session, seq)");
  }

  append(event: JournalEvent, now: number = Date.now()): JournalEntry {
    const last = this.db
      .query("SELECT seq, hash FROM journal ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; hash: string } | null;
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS;
    const hash = digest(prevHash, seq, now, event);
    this.db
      .query(
        "INSERT INTO journal (seq, ts, kind, session, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(seq, now, event.kind, event.session, JSON.stringify(event.data), prevHash, hash);
    return { ...event, seq, ts: now, prevHash, hash };
  }

  list(session?: string): JournalEntry[] {
    const rows = (
      session === undefined
        ? this.db.query("SELECT * FROM journal ORDER BY seq").all()
        : this.db.query("SELECT * FROM journal WHERE session = ? ORDER BY seq").all(session)
    ) as Row[];
    return rows.map(toEntry);
  }

  /** Returns the seq of the first broken entry, or null when the chain is intact. */
  verify(): number | null {
    const rows = this.db.query("SELECT * FROM journal ORDER BY seq").all() as Row[];
    let prev = GENESIS;
    for (const row of rows) {
      const entry = toEntry(row);
      const expected = digest(prev, entry.seq, entry.ts, entry);
      if (entry.prevHash !== prev || entry.hash !== expected) return entry.seq;
      prev = entry.hash;
    }
    return null;
  }

  /** Exposed for tamper tests only. */
  get rawDb(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

interface Row {
  seq: number;
  ts: number;
  kind: string;
  session: string;
  data: string;
  prev_hash: string;
  hash: string;
}

function toEntry(row: Row): JournalEntry {
  return {
    seq: row.seq,
    ts: row.ts,
    kind: row.kind,
    session: row.session,
    data: JSON.parse(row.data) as unknown,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}
