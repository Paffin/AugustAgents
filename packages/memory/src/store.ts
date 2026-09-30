import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { ORIGIN_KINDS, SENSITIVITIES, type ContentOrigin } from "@august/policy";
import { isMemoryClass, type MemoryClass, type MemoryEntry, type MemoryInput, type RecallHit, type RecallOptions, type Tombstone } from "./types.ts";
import { MemoryFiles, type FileMemoryRecord } from "./files.ts";

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
  /** Explicit owner-editable mirror directory, outside capability-writable roots. */
  filesDir?: string;
  embeddings?: {
    client: { readonly identity: string; embed(text:string,options?:{signal?:AbortSignal}):Promise<number[]> };
    queryPrefix?: string;
    documentPrefix?: string;
  };
}

/** Shapes of credentials that must never become memory, whoever asks: keys, tokens and private key blocks. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
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
  private readonly files?: MemoryFiles;
  private readonly embeddings?: MemoryStoreOptions["embeddings"];
  private readonly vectorIdentity?: string;
  private readonly hasVectors: boolean;

  constructor(path = ":memory:", options: MemoryStoreOptions = {}) {
    this.onDisk = path !== ":memory:";
    const fresh = !this.onDisk || !existsSync(path);
    this.db = new Database(path);
    try {
    this.now = options.now ?? Date.now;
    this.maxPerScope = options.maxPerScope ?? 5000;
    this.maxEpisodic = options.maxEpisodic ?? 500;
    this.containsSecret = options.containsSecret;
    // Deleted content is overwritten in the file, not just unlinked.
    this.db.run("PRAGMA secure_delete = ON");
    this.db.run("PRAGMA foreign_keys = ON");
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
    if(options.filesDir)this.files=new MemoryFiles(this,options.filesDir);
    if(options.embeddings){
      this.embeddings=options.embeddings;
      this.vectorIdentity=sha256(JSON.stringify([options.embeddings.client.identity,options.embeddings.queryPrefix??"",options.embeddings.documentPrefix??""]));
      this.db.run("PRAGMA foreign_keys = ON");
      this.db.run("CREATE TABLE IF NOT EXISTS memory_vectors (entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,identity TEXT NOT NULL,text_sha TEXT NOT NULL,vector_json TEXT NOT NULL,PRIMARY KEY(entry_id,identity))");
      this.db.query("SELECT entry_id,identity,text_sha,vector_json FROM memory_vectors LIMIT 0").all();
    }
    this.hasVectors=Boolean(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vectors'").get());
    if(this.hasVectors)this.db.query("SELECT entry_id,identity,text_sha,vector_json FROM memory_vectors LIMIT 0").all();
    this.flushErasure();
    } catch(error) { this.db.close(); throw error; }
  }

  close(): void {
    this.db.close();
  }
  filesDirectory(scope:string):string|undefined { this.files?.sync(scope); return this.files?.scopeDirectory(scope); }
  syncFiles(scope:string):void { this.files?.sync(scope); }

  /** Atomic owner-file edits preserve existing untrusted provenance and erase removed lineages. */
  applyFileChanges(scope:string,records:readonly FileMemoryRecord[],deleted:readonly string[]):void {
    const prepared=records.map(record=>{
      const existing=record.id?this.db.query("SELECT * FROM entries WHERE id=?").get(record.id) as Row|null:undefined;
      if(existing&&existing.scope!==scope)throw new MemoryError("memory file identity belongs to another scope");
      if(existing&&existing.class!==record.class)throw new MemoryError("memory file cannot change an entry's class");
      const retired=record.id?this.db.query("SELECT id FROM tombstones WHERE id=? AND scope=?").get(record.id,scope):null;
      const sha=sha256(record.text.trim());
      const inherited=this.db.query("SELECT id FROM entries WHERE scope=? AND text_sha=? AND trust='untrusted' LIMIT 1").get(scope,sha);
      const input:MemoryInput={scope,class:record.class,text:record.text,origin:existing?.trust==="untrusted"?toEntry(existing).origin:{kind:"file",source:"owner-file",locator:record.file},trust:record.untrusted||existing?.trust==="untrusted"||inherited?"untrusted":"trusted",sensitivity:existing?toEntry(existing).sensitivity:"personal"};
      this.validate(input);return {record,existing,input,sha,retired};
    });
    this.db.transaction(()=>{
      for(const id of deleted){const row=this.db.query("SELECT lineage FROM entries WHERE id=? AND scope=?").get(id,scope) as {lineage:string}|null;if(row)this.erase(this.db.query("SELECT * FROM entries WHERE lineage=? AND scope=?").all(row.lineage,scope) as Row[],"owner removed memory from file");}
      for(const p of prepared){
        if(p.retired)continue; // A stale file cannot resurrect an explicitly forgotten identity.
        if(p.existing){
          if(!this.db.query("SELECT id FROM entries WHERE id=? AND scope=? AND status='active'").get(p.existing.id,scope))continue;
          if(p.existing.text_sha===p.sha&&p.existing.trust===p.input.trust)continue;
          this.db.query("DELETE FROM fts WHERE id=?").run(p.existing.id);
          this.markErasure();
          if(this.hasVectors)this.db.query("DELETE FROM memory_vectors WHERE entry_id=?").run(p.existing.id);
          this.db.query("UPDATE entries SET text=?,text_sha=?,origin_kind=?,origin_source=?,origin_locator=?,trust=?,updated_at=? WHERE id=? AND scope=?").run(p.input.text.trim(),p.sha,p.input.origin.kind,p.input.origin.source,p.input.origin.locator??null,p.input.trust,this.now(),p.existing.id,scope);
          this.db.query("INSERT INTO fts (id,text) VALUES (?,?)").run(p.existing.id,p.input.text.trim());
        }else this.remember(p.input);
      }
    }).immediate();this.flushErasure();
  }

  /** Stores an entry. The same text in the same scope and class is refreshed, not duplicated. */
  remember(input: MemoryInput): { entry: MemoryEntry; created: boolean } {
    this.files?.sync(input.scope);
    this.validate(input);
    const now = this.now();
    const result=this.db.transaction(() => {
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
    }).immediate();this.flushErasure();this.files?.publish(input.scope);return result;
  }

  /** Best matches first. Superseded, expired and other owners' entries are never returned. */
  recall(options: RecallOptions): RecallHit[] {
    this.files?.sync(options.scope);
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

  /** Configured local vectors plus lexical ranking; unconfigured embeddings retain the exact FTS path. */
  async recallHybrid(options:RecallOptions):Promise<RecallHit[]> {
    if(!this.embeddings)return this.recall(options);
    this.files?.sync(options.scope);options.signal?.throwIfAborted();
    if(!options.query.trim())return [];
    const rows=this.eligible(options),semantic:Array<{entry:MemoryEntry;score:number}>=[];
    if(!rows.length)return [];
    for(const row of rows){
      options.signal?.throwIfAborted();
      const cached=this.db.query("SELECT text_sha,vector_json FROM memory_vectors WHERE entry_id=? AND identity=?").get(row.id,this.vectorIdentity!) as {text_sha:string;vector_json:string}|null;
      if(cached?.text_sha!==row.text_sha){
        const vector=normalized(await this.embeddings.client.embed((this.embeddings.documentPrefix??"")+row.text,{signal:options.signal}));
        const current=this.db.query("SELECT text_sha FROM entries WHERE id=? AND scope=? AND status='active'").get(row.id,options.scope) as {text_sha:string}|null;
        if(current?.text_sha!==row.text_sha)throw new MemoryError("memory changed during semantic indexing; retry the query");
        this.db.query("INSERT INTO memory_vectors VALUES (?,?,?,?) ON CONFLICT(entry_id,identity) DO UPDATE SET text_sha=excluded.text_sha,vector_json=excluded.vector_json").run(row.id,this.vectorIdentity!,row.text_sha,JSON.stringify(vector));
      }
    }
    const query=normalized(await this.embeddings.client.embed((this.embeddings.queryPrefix??"")+options.query,{signal:options.signal}));
    this.files?.sync(options.scope);
    // The lexical path performs its own file sync. Finish that before taking authoritative semantic rows.
    const lexical=this.recall({...options,limit:50,touch:false}),authoritative=new Map(this.eligible(options).map(row=>[row.id,row]));
    for(const row of authoritative.values()){
      const cached=this.db.query("SELECT vector_json FROM memory_vectors WHERE entry_id=? AND identity=? AND text_sha=?").get(row.id,this.vectorIdentity!,row.text_sha) as {vector_json:string}|null;
      if(!cached)throw new MemoryError("memory changed during semantic indexing; retry the query");
      let decoded:unknown;try{decoded=JSON.parse(cached.vector_json);}catch{throw new MemoryError("invalid retained embedding vector");}
      const vector=normalized(decoded);if(vector.length!==query.length)throw new MemoryError("embedding dimensions conflict with the retained identity");
      let cosine=0;for(let i=0;i<vector.length;i++)cosine+=vector[i]!*query[i]!;
      semantic.push({entry:toEntry(row),score:cosine});
    }
    semantic.sort((a,b)=>b.score-a.score||a.entry.id.localeCompare(b.entry.id));
    const fused=new Map<string,RecallHit>();
    const terms=searchTerms(options.query),termMatch=this.db.query("SELECT id FROM fts WHERE fts MATCH ? AND id=? LIMIT 1");
    for(const [kind,ranking] of [lexical,semantic.slice(0,200)].entries())for(const [rank,hit] of ranking.entries()){
      const current=authoritative.get(hit.entry.id);
      if(!current||current.text_sha!==sha256(hit.entry.text))continue;
      // One incidental lexical term must not outweigh a semantic match to the whole request.
      const coverage=kind===0&&terms.length?terms.filter(term=>termMatch.get(term,hit.entry.id)).length/terms.length:1;
      const old=fused.get(hit.entry.id);fused.set(hit.entry.id,{entry:toEntry(current),score:(old?.score??0)+coverage/(rank+1)});
    }
    const hits=[...fused.values()].sort((a,b)=>b.score-a.score||a.entry.id.localeCompare(b.entry.id)).slice(0,Math.max(1,Math.min(options.limit??5,50)));
    if(options.touch!==false&&hits.length){const mark=this.db.query("UPDATE entries SET last_used_at=?,use_count=use_count+1 WHERE id=? AND scope=?");this.db.transaction(()=>{for(const h of hits)mark.run(this.now(),h.entry.id,options.scope);})();}
    return hits;
  }
  private eligible(options:RecallOptions):Row[]{
    const classes=options.classes?.length?options.classes:undefined;
    return this.db.query(`SELECT * FROM entries WHERE scope=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ${classes?`AND class IN (${classes.map(()=>"?").join(",")})`:""} ${options.trustedOnly?"AND trust='trusted'":""}`).all(options.scope,this.now(),...(classes??[])) as Row[];
  }

  get(scope: string, id: string): MemoryEntry | undefined {
    this.files?.sync(scope);
    const row = this.db.query("SELECT * FROM entries WHERE id=? AND scope=?").get(id, scope) as Row | null;
    return row ? toEntry(row) : undefined;
  }

  /** Direct authenticated owner edit. Untrusted entries require separate review, never implicit promotion. */
  update(scope:string,id:string,text:string):MemoryEntry {
    this.files?.sync(scope);
    this.db.transaction(()=>{
      const row=this.db.query("SELECT * FROM entries WHERE id=? AND scope=? AND status='active'").get(id,scope) as Row|null;
      if(!row)throw new MemoryError("no such active memory");
      if(row.trust!=="trusted")throw new MemoryError("untrusted memory is read-only until explicit owner review");
      this.validate({scope,class:row.class as MemoryClass,text,trust:"trusted",sensitivity:row.sensitivity as MemoryEntry["sensitivity"],origin:{kind:"user",source:"owner-controls"}});
      this.db.query("DELETE FROM fts WHERE id=?").run(id);if(this.hasVectors)this.db.query("DELETE FROM memory_vectors WHERE entry_id=?").run(id);
      this.markErasure();
      this.db.query("UPDATE entries SET text=?,text_sha=?,origin_kind='user',origin_source='owner-controls',origin_locator=NULL,source_run=NULL,updated_at=? WHERE id=? AND scope=?").run(text.trim(),sha256(text.trim()),this.now(),id,scope);
      this.db.query("INSERT INTO fts (id,text) VALUES (?,?)").run(id,text.trim());
    }).immediate();this.flushErasure();
    this.files?.publish(scope);return toEntry(this.db.query("SELECT * FROM entries WHERE id=? AND scope=?").get(id,scope) as Row);
  }

  list(scope: string, options: { class?: MemoryClass; includeSuperseded?: boolean; limit?: number } = {}): MemoryEntry[] {
    this.files?.sync(scope);
    const rows = this.db.query(`SELECT * FROM entries WHERE scope=? ${options.class ? "AND class=?" : ""} ${options.includeSuperseded ? "" : "AND status='active'"} ORDER BY created_at DESC, id LIMIT ?`)
      .all(scope, ...(options.class ? [options.class] : []), options.limit ?? 200) as Row[];
    return rows.map(toEntry);
  }

  /** The owner vouches for an entry that was written under untrusted influence. */
  trust(scope: string, id: string): boolean {
    this.files?.sync(scope);const changed=this.db.query("UPDATE entries SET trust='trusted' WHERE id=? AND scope=? AND trust='untrusted'").run(id, scope).changes === 1;this.files?.publish(scope);return changed;
  }

  /** Removes an entry and everything it replaced or was replaced by. Returns how many entries were removed. */
  forget(scope: string, id: string, reason = "owner"): number {
    this.files?.sync(scope);const removed=this.db.transaction(() => {
      const row = this.db.query("SELECT lineage FROM entries WHERE id=? AND scope=?").get(id, scope) as { lineage: string } | null;
      if (!row) return 0;
      return this.erase(this.db.query("SELECT * FROM entries WHERE lineage=? AND scope=?").all(row.lineage, scope) as Row[], reason);
    }).immediate();this.flushErasure();this.files?.publish(scope);return removed;
  }

  /** Everything the scope's owner has stored, all classes. */
  forgetScope(scope: string, reason = "owner erased everything"): number {
    this.files?.sync(scope);const removed=this.db.transaction(() => this.erase(this.db.query("SELECT * FROM entries WHERE scope=?").all(scope) as Row[], reason)).immediate();this.flushErasure();this.files?.publish(scope);return removed;
  }

  /** Everything written by one tool or capability, for when that source is removed or found to be untrustworthy. */
  forgetBySource(scope: string, source: string, reason = "source removed"): number {
    this.files?.sync(scope);const removed=this.db.transaction(() => this.erase(this.db.query("SELECT * FROM entries WHERE scope=? AND origin_source=?").all(scope, source) as Row[], reason)).immediate();this.flushErasure();this.files?.publish(scope);return removed;
  }

  /** Removes entries past their lifetime. Runs before any read the host cares about, and on demand. */
  sweep(): number {
    const scopes=this.db.query("SELECT DISTINCT scope FROM entries WHERE expires_at IS NOT NULL AND expires_at<=?").all(this.now()) as Array<{scope:string}>;
    const removed=this.db.transaction(() => this.erase(this.db.query("SELECT * FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?").all(this.now()) as Row[], "expired")).immediate();this.flushErasure();for(const {scope} of scopes)this.files?.publish(scope);return removed;
  }

  tombstones(scope: string): Tombstone[] {
    return (this.db.query("SELECT * FROM tombstones WHERE scope=? ORDER BY deleted_at DESC, id").all(scope) as Array<Record<string, unknown>>).map((r) => ({ id: r.id as string, scope: r.scope as string, class: r.class as MemoryClass, deletedAt: r.deleted_at as number, reason: r.reason as string }));
  }

  stats(scope: string): Record<MemoryClass, number> & { superseded: number; untrusted: number } {
    this.files?.sync(scope);
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
      this.markErasure();
    }
    return rows.length;
  }
  private markErasure():void {if(this.onDisk)this.db.run("INSERT INTO meta VALUES ('erasure_pending','1') ON CONFLICT(key) DO UPDATE SET value='1'");}
  private flushErasure():void {
    if(!this.onDisk||this.db.inTransaction||!this.db.query("SELECT value FROM meta WHERE key='erasure_pending'").get())return;
    // Merge away deleted FTS posting entries, then checkpoint AFTER the mutation committed.
    this.db.run("INSERT INTO fts(fts) VALUES ('optimize')");
    const result=this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {busy:number;log:number;checkpointed:number};
    if(!result||result.busy!==0||result.log!==result.checkpointed)throw new MemoryError("memory rows were removed but physical erasure is pending a busy checkpoint");
    this.db.run("DELETE FROM meta WHERE key='erasure_pending'");
    const settled=this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {busy:number;log:number;checkpointed:number};
    if(!settled||settled.busy!==0||settled.log!==settled.checkpointed)throw new MemoryError("physical erasure checkpoint could not be confirmed");
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
function normalized(value:unknown):number[]{
  if(!Array.isArray(value)||!value.length||value.some(n=>typeof n!=="number"||!Number.isFinite(n)))throw new MemoryError("invalid retained embedding vector");
  let scale=0;for(const n of value)scale=Math.max(scale,Math.abs(n));if(!scale)throw new MemoryError("embedding vector is zero");
  let squares=0;for(const n of value)squares+=(n/scale)**2;const norm=Math.sqrt(squares);return value.map(n=>n/scale/norm);
}
