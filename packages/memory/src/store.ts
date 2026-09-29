import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { ORIGIN_KINDS, SENSITIVITIES, type ContentOrigin } from "@august/policy";
import { isMemoryClass, type MemoryClass, type MemoryEntry, type MemoryInput, type RecallHit, type RecallOptions, type Tombstone } from "./types.ts";

const SCHEMA_VERSION = "1";
const DAY = 86_400_000;

/** How long an entry lives when the writer gives no lifetime. Semantic and procedural memory is kept until the owner removes it. */
export const DEFAULT_TTL_MS: Readonly<Record<MemoryClass, number | undefined>> = { working: DAY, episodic: 90 * DAY, semantic: undefined, procedural: undefined };
export const MAX_TEXT_CHARS = 2_000;

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

export interface MemoryStoreOptions {
  now?: () => number;
  /** Entries per scope across all classes (episodic ones are pruned oldest-first instead of refused). Default 5000. */
  maxPerScope?: number;
  /** Episodic entries kept per scope. Default 500. */
  maxEpisodic?: number;
  /** Refuses text containing a credential the host knows (a stored secret's value). */
  containsSecret?: (text: string) => boolean;
}

/** Shapes of credentials that must never become memory, whoever asks: keys, tokens and private key blocks. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Words to search on: lower-cased letters and digits, long words cut to a stem so "prefers" finds "preference". */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length >= 2))].slice(0, 12).map((w) => (w.length >= 6 ? `"${w.slice(0, w.length - 2)}"*` : `"${w}"`));
}

/**
 * What the agent remembers, per owner. Every entry says where it came from and whether to believe it; nothing is
 * readable outside its scope; and forgetting removes the words themselves (the row, the search index and the file
 * pages), leaving only a record that something was removed and why.
 */
export class MemoryStore {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly maxPerScope: number;
  private readonly maxEpisodic: number;
  private readonly containsSecret?: (text: string) => boolean;
  private readonly onDisk: boolean;

  constructor(path = ":memory:", options: MemoryStoreOptions = {}) {
    this.onDisk = path !== ":memory:";
    const fresh = !this.onDisk || !existsSync(path);
    this.db = new Database(path);
    this.now = options.now ?? Date.now;
    this.maxPerScope = options.maxPerScope ?? 5000;
    this.maxEpisodic = options.maxEpisodic ?? 500;
    this.containsSecret = options.containsSecret;
    // Deleted content is overwritten in the file, not just unlinked.
    this.db.run("PRAGMA secure_delete = ON");
    if (fresh) {
      this.db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.db.run("INSERT INTO meta VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
      this.db.run(`CREATE TABLE entries (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, class TEXT NOT NULL, text TEXT NOT NULL, text_sha TEXT NOT NULL,
        origin_kind TEXT NOT NULL, origin_source TEXT NOT NULL, origin_locator TEXT, trust TEXT NOT NULL CHECK(trust IN ('trusted','untrusted')),
        sensitivity TEXT NOT NULL, source_run TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER,
        last_used_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('active','superseded')),
        lineage TEXT NOT NULL, supersedes TEXT)`);
      this.db.run("CREATE INDEX entries_scope ON entries(scope, class, status)");
      this.db.run("CREATE INDEX entries_lineage ON entries(lineage)");
      this.db.run("CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2')");
      this.db.run("CREATE TABLE tombstones (id TEXT PRIMARY KEY, scope TEXT NOT NULL, class TEXT NOT NULL, deleted_at INTEGER NOT NULL, reason TEXT NOT NULL)");
    }
    const version = this.db.query("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | null;
    if (version?.value !== SCHEMA_VERSION) throw new MemoryError(`unsupported memory schema ${version?.value ?? "missing"}`);
    if (this.onDisk) { this.db.run("PRAGMA journal_mode = WAL"); chmodSync(path, 0o600); }
  }

  close(): void {
    this.db.close();
  }

  /** Stores an entry. The same text in the same scope and class is refreshed, not duplicated. */
  remember(input: MemoryInput): { entry: MemoryEntry; created: boolean } {
    this.validate(input);
    const now = this.now();
    return this.db.transaction(() => {
      const sha = sha256(input.text.trim());
      const twin = this.db.query("SELECT * FROM entries WHERE scope=? AND class=? AND text_sha=? AND status='active'").get(input.scope, input.class, sha) as Row | null;
      if (twin) {
        // Seeing it again may not raise its standing: a trusted entry stays trusted only if the new source is trusted too.
        const trust = twin.trust === "trusted" && input.trust === "trusted" ? "trusted" : "untrusted";
        const ttl = input.ttlMs ?? DEFAULT_TTL_MS[input.class];
        this.db.query("UPDATE entries SET updated_at=?, expires_at=?, trust=? WHERE id=?").run(now, ttl === undefined ? null : now + ttl, trust, twin.id);
        return { entry: toEntry(this.db.query("SELECT * FROM entries WHERE id=?").get(twin.id) as Row), created: false };
      }
      let lineage: string | undefined;
      if (input.supersedes) {
        const old = this.db.query("SELECT * FROM entries WHERE id=? AND scope=? AND status='active'").get(input.supersedes, input.scope) as Row | null;
        if (!old) throw new MemoryError("there is no such active memory to replace");
        this.db.query("UPDATE entries SET status='superseded' WHERE id=?").run(old.id);
        lineage = old.lineage;
      }
      this.makeRoom(input.scope, input.class);
      const id = randomUUID();
      const ttl = input.ttlMs ?? DEFAULT_TTL_MS[input.class];
      this.db.query("INSERT INTO entries (id,scope,class,text,text_sha,origin_kind,origin_source,origin_locator,trust,sensitivity,source_run,created_at,updated_at,expires_at,use_count,status,lineage,supersedes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'active',?,?)")
        .run(id, input.scope, input.class, input.text.trim(), sha, input.origin.kind, input.origin.source, input.origin.locator ?? null, input.trust, input.sensitivity, input.sourceRun ?? null, now, now, ttl === undefined ? null : now + ttl, lineage ?? id, input.supersedes ?? null);
      this.db.query("INSERT INTO fts (id, text) VALUES (?,?)").run(id, input.text.trim());
      return { entry: toEntry(this.db.query("SELECT * FROM entries WHERE id=?").get(id) as Row), created: true };
    }).immediate();
  }

  /** Best matches first. Superseded, expired and other owners' entries are never returned. */
  recall(options: RecallOptions): RecallHit[] {
    const terms = searchTerms(options.query);
    if (terms.length === 0) return [];
    const now = this.now();
    const classes = options.classes?.length ? options.classes : undefined;
    const rows = this.db.query(`SELECT e.*, -bm25(fts) AS relevance FROM fts JOIN entries e ON e.id = fts.id
      WHERE fts MATCH ? AND e.scope = ? AND e.status = 'active' AND (e.expires_at IS NULL OR e.expires_at > ?)
      ${classes ? `AND e.class IN (${classes.map(() => "?").join(",")})` : ""} ${options.trustedOnly ? "AND e.trust = 'trusted'" : ""}
      LIMIT 200`).all(terms.join(" OR "), options.scope, now, ...(classes ?? [])) as Array<Row & { relevance: number }>;
    const hits = rows.map((r) => ({ entry: toEntry(r), score: rank(r, now) })).sort((a, b) => b.score - a.score || a.entry.createdAt - b.entry.createdAt).slice(0, Math.max(1, Math.min(options.limit ?? 5, 50)));
    if (options.touch !== false && hits.length) {
      const mark = this.db.query("UPDATE entries SET last_used_at=?, use_count=use_count+1 WHERE id=?");
      this.db.transaction(() => { for (const h of hits) mark.run(now, h.entry.id); })();
    }
    return hits;
  }

  get(scope: string, id: string): MemoryEntry | undefined {
    const row = this.db.query("SELECT * FROM entries WHERE id=? AND scope=?").get(id, scope) as Row | null;
    return row ? toEntry(row) : undefined;
  }

  list(scope: string, options: { class?: MemoryClass; includeSuperseded?: boolean; limit?: number } = {}): MemoryEntry[] {
    const rows = this.db.query(`SELECT * FROM entries WHERE scope=? ${options.class ? "AND class=?" : ""} ${options.includeSuperseded ? "" : "AND status='active'"} ORDER BY created_at DESC, id LIMIT ?`)
      .all(scope, ...(options.class ? [options.class] : []), options.limit ?? 200) as Row[];
    return rows.map(toEntry);
  }

  /** The owner vouches for an entry that was written under untrusted influence. */
  trust(scope: string, id: string): boolean {
    return this.db.query("UPDATE entries SET trust='trusted' WHERE id=? AND scope=? AND trust='untrusted'").run(id, scope).changes === 1;
  }

  /** Removes an entry and everything it replaced or was replaced by. Returns how many entries were removed. */
  forget(scope: string, id: string, reason = "owner"): number {
    return this.db.transaction(() => {
      const row = this.db.query("SELECT lineage FROM entries WHERE id=? AND scope=?").get(id, scope) as { lineage: string } | null;
      if (!row) return 0;
      return this.erase(this.db.query("SELECT * FROM entries WHERE lineage=? AND scope=?").all(row.lineage, scope) as Row[], reason);
    }).immediate();
  }

  /** Everything the scope's owner has stored, all classes. */
  forgetScope(scope: string, reason = "owner erased everything"): number {
    return this.db.transaction(() => this.erase(this.db.query("SELECT * FROM entries WHERE scope=?").all(scope) as Row[], reason)).immediate();
  }

  /** Everything written by one tool or capability, for when that source is removed or found to be untrustworthy. */
  forgetBySource(scope: string, source: string, reason = "source removed"): number {
    return this.db.transaction(() => this.erase(this.db.query("SELECT * FROM entries WHERE scope=? AND origin_source=?").all(scope, source) as Row[], reason)).immediate();
  }

  /** Removes entries past their lifetime. Runs before any read the host cares about, and on demand. */
  sweep(): number {
    return this.db.transaction(() => this.erase(this.db.query("SELECT * FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?").all(this.now()) as Row[], "expired")).immediate();
  }

  tombstones(scope: string): Tombstone[] {
    return (this.db.query("SELECT * FROM tombstones WHERE scope=? ORDER BY deleted_at DESC, id").all(scope) as Array<Record<string, unknown>>).map((r) => ({ id: r.id as string, scope: r.scope as string, class: r.class as MemoryClass, deletedAt: r.deleted_at as number, reason: r.reason as string }));
  }

  stats(scope: string): Record<MemoryClass, number> & { superseded: number; untrusted: number } {
    const out = { working: 0, episodic: 0, semantic: 0, procedural: 0, superseded: 0, untrusted: 0 };
    for (const r of this.db.query("SELECT class, status, trust, COUNT(*) n FROM entries WHERE scope=? GROUP BY class, status, trust").all(scope) as Array<{ class: MemoryClass; status: string; trust: string; n: number }>) {
      if (r.status === "superseded") out.superseded += r.n; else { out[r.class] += r.n; if (r.trust === "untrusted") out.untrusted += r.n; }
    }
    return out;
  }

  private erase(rows: Row[], reason: string): number {
    const now = this.now();
    for (const r of rows) {
      this.db.query("DELETE FROM fts WHERE id=?").run(r.id);
      this.db.query("DELETE FROM entries WHERE id=?").run(r.id);
      this.db.query("INSERT OR REPLACE INTO tombstones VALUES (?,?,?,?,?)").run(r.id, r.scope, r.class, now, reason);
    }
    if (rows.length && this.onDisk) {
      // Fold the write-ahead log into the file, so the removed words are not left in a side file.
      try { this.db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* another connection holds the log; the pages are already overwritten */ }
    }
    return rows.length;
  }

  private makeRoom(scope: string, cls: MemoryClass): void {
    if (cls === "episodic") {
      const rows = this.db.query("SELECT * FROM entries WHERE scope=? AND class='episodic' ORDER BY created_at ASC, id").all(scope) as Row[];
      if (rows.length >= this.maxEpisodic) this.erase(rows.slice(0, rows.length - this.maxEpisodic + 1), "quota");
    }
    const { n } = this.db.query("SELECT COUNT(*) n FROM entries WHERE scope=?").get(scope) as { n: number };
    if (n >= this.maxPerScope) throw new MemoryError(`memory is full (${this.maxPerScope} entries); forget something first`);
  }

  private validate(input: MemoryInput): void {
    if (!input.scope) throw new MemoryError("memory needs an owner scope");
    if (!isMemoryClass(input.class)) throw new MemoryError("unknown memory class");
    const text = input.text?.trim();
    if (!text) throw new MemoryError("nothing to remember");
    if (text.length > MAX_TEXT_CHARS) throw new MemoryError(`a memory is at most ${MAX_TEXT_CHARS} characters`);
    if (input.trust !== "trusted" && input.trust !== "untrusted") throw new MemoryError("memory needs a trust level");
    if (!(SENSITIVITIES as readonly string[]).includes(input.sensitivity)) throw new MemoryError("memory needs a sensitivity");
    // A secret is stored by the secret store, under its own protections, and nowhere else.
    if (input.sensitivity === "secret") throw new MemoryError("secret content is never stored as memory");
    if (!(ORIGIN_KINDS as readonly string[]).includes(input.origin?.kind) || !input.origin.source) throw new MemoryError("memory needs an origin");
    if (CREDENTIAL_SHAPES.some((re) => re.test(text)) || this.containsSecret?.(text)) throw new MemoryError("that looks like a credential, and credentials are never stored as memory");
    if (input.ttlMs !== undefined && !(input.ttlMs > 0)) throw new MemoryError("lifetime must be positive");
  }
}

interface Row { id: string; scope: string; class: MemoryClass; text: string; text_sha: string; origin_kind: string; origin_source: string; origin_locator: string | null; trust: "trusted" | "untrusted"; sensitivity: string; source_run: string | null; created_at: number; updated_at: number; expires_at: number | null; last_used_at: number | null; use_count: number; status: "active" | "superseded"; lineage: string; supersedes: string | null }

function toEntry(r: Row): MemoryEntry {
  const origin: ContentOrigin = { kind: r.origin_kind as ContentOrigin["kind"], source: r.origin_source, ...(r.origin_locator ? { locator: r.origin_locator } : {}) };
  return {
    id: r.id, scope: r.scope, class: r.class, text: r.text, origin, trust: r.trust, sensitivity: r.sensitivity as MemoryEntry["sensitivity"],
    ...(r.source_run ? { sourceRun: r.source_run } : {}), createdAt: r.created_at, updatedAt: r.updated_at, ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
    ...(r.last_used_at !== null ? { lastUsedAt: r.last_used_at } : {}), useCount: r.use_count, status: r.status, lineage: r.lineage, ...(r.supersedes ? { supersedes: r.supersedes } : {}),
  };
}

/** Text relevance, lifted a little by use and, for episodic memory, lowered by age (half-life 30 days). */
function rank(r: Row & { relevance: number }, now: number): number {
  const frequency = 1 + 0.1 * Math.log1p(r.use_count);
  const recency = r.class === "episodic" ? Math.pow(0.5, Math.max(0, now - r.updated_at) / (30 * DAY)) : 1;
  return r.relevance * frequency * recency;
}
