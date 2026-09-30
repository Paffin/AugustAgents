import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import type { MemoryClass, MemoryEntry } from "./types.ts";

export interface FileMemoryRecord { id?: string; class: MemoryClass; text: string; file: string; untrusted?: boolean }
export interface FileMemoryBackend {
  list(scope: string, options: { limit: number }): MemoryEntry[];
  applyFileChanges(scope: string, records: readonly FileMemoryRecord[], deleted: readonly string[]): void;
}
interface Manifest { version: 1; scope: string; published: Array<{ id: string; file: string }> }
export class MemoryFileError extends Error {
  constructor(message: string) { super(message); this.name = "MemoryFileError"; }
}
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_MIRROR_ENTRIES = 5000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FILE = /^(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,100}\.md|profile\.yaml|episodes\.jsonl)$/;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function directory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new MemoryFileError("memory file directory must not be a symlink");
}
function read(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new MemoryFileError("memory file is unsafe or too large");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const text=readFileSync(fd,"utf8");if(Buffer.byteLength(text)>MAX_FILE_BYTES)throw new MemoryFileError("memory file grew beyond its size limit");return text; } finally { closeSync(fd); }
}
function write(path: string, text: string, expected?: string): void {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new MemoryFileError("memory file exceeds the mirror size limit");
  const current = read(path);
  if (current === text) return;
  if (current !== expected) throw new MemoryFileError("memory file changed concurrently; sync before retrying");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    if (read(path) !== expected) throw new MemoryFileError("memory file changed concurrently; sync before retrying");
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function record(value: unknown, file: string, cls: MemoryClass): FileMemoryRecord {
  const r = value as Record<string, unknown>;
  if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.text !== "string" || !r.text.trim() || (r.id !== undefined && (typeof r.id !== "string" || !UUID.test(r.id))) || (r.trust !== undefined && !["trusted", "untrusted"].includes(String(r.trust)))) throw new MemoryFileError("invalid memory file record");
  return { id: r.id as string | undefined, class: cls, text: r.text.trim(), file, ...(r.trust === "untrusted" ? { untrusted: true } : {}) };
}
function parse(file: string, text: string): FileMemoryRecord[] {
  if (!text.trim()) return [];
  if (file === "profile.yaml") {
    let value: unknown; try { value = Bun.YAML.parse(text); } catch { throw new MemoryFileError("invalid profile YAML"); }
    const root = value as { memories?: unknown };
    if (!root || !Array.isArray(root.memories) || root.memories.length > MAX_MIRROR_ENTRIES) throw new MemoryFileError("profile YAML needs a memories list");
    return root.memories.map(item => record(item, file, "semantic"));
  }
  if (file === "episodes.jsonl") {
    try { return text.split(/\r?\n/).filter(line => line.trim()).map(line => record(JSON.parse(line), file, "episodic")); }
    catch { throw new MemoryFileError("invalid episodic memory JSONL"); }
  }
  const cls = file === "procedural.md" ? "procedural" : "semantic";
  const blocks = [...text.matchAll(/^## ([a-f0-9-]{36})(?: \[(trusted|untrusted)\])?\s*$/gm)];
  if (!blocks.length) { if(/^## [a-f0-9-]{36}/m.test(text))throw new MemoryFileError("invalid memory Markdown identity marker");return [{ class: cls, text: text.trim(), file }]; }
  if (text.slice(0, blocks[0]!.index).trim()) throw new MemoryFileError("memory Markdown has text before its first record");
  return blocks.flatMap((block,i)=>{const body=text.slice(block.index!+block[0].length,blocks[i+1]?.index).trim().replace(/^\\(\\*)## /gm,"$1## ");return body?[record({id:block[1],trust:block[2]==="untrusted"?"untrusted":"trusted",text:body},file,cls)]:[];});
}

/** Owner-editable files are an adapter to the same scoped store, not a separate memory authority. */
export class MemoryFiles {
  private busy = false;
  readonly root: string;
  constructor(private readonly backend: FileMemoryBackend, root: string) { this.root = resolve(root); directory(this.root); }
  scopeDirectory(scope: string): string { return join(this.root, digest(scope)); }

  sync(scope: string): void {
    if (this.busy) return;
    this.busy = true;
    try {
      const dir = this.scopeDirectory(scope); directory(dir);
      const path = join(dir, ".scope.json"), raw = read(path);
      let manifest: Manifest = { version: 1, scope, published: [] };
      if (raw !== undefined) {
        try { manifest = JSON.parse(raw); } catch { throw new MemoryFileError("invalid memory file manifest"); }
        if (manifest.version !== 1 || manifest.scope !== scope || !Array.isArray(manifest.published) || manifest.published.some(p => !p || !UUID.test(p.id) || !FILE.test(p.file))) throw new MemoryFileError("memory file manifest does not match its scope");
      }
      const files = new Map<string, string>(), records: FileMemoryRecord[] = [];
      for (const file of readdirSync(dir).filter(name => FILE.test(name))) { const text = read(join(dir, file))!; files.set(file, text); records.push(...parse(file, text)); }
      if (records.length > MAX_MIRROR_ENTRIES) throw new MemoryFileError("too many memory file records");
      const ids = records.flatMap(r => r.id ? [r.id] : []);
      if (new Set(ids).size !== ids.length) throw new MemoryFileError("duplicate memory file identities");
      const present = new Set(ids), deleted = manifest.published.filter(p => !present.has(p.id)).map(p => p.id);
      const oldEntries=new Map(this.backend.list(scope,{limit:MAX_MIRROR_ENTRIES+1}).map(e=>[e.id,e]));
      const taintedFiles=new Set(manifest.published.filter(p=>oldEntries.get(p.id)?.trust==="untrusted").map(p=>p.file));
      for(const r of records)if((!r.id||!oldEntries.has(r.id))&&taintedFiles.has(r.file))r.untrusted=true;
      this.backend.applyFileChanges(scope, records, deleted);
      this.publishScope(scope, dir, files, raw);
    } finally { this.busy = false; }
  }

  publish(scope: string): void {
    if (this.busy) return;
    this.busy = true;
    try {
      const dir = this.scopeDirectory(scope); directory(dir);
      const files = new Map<string, string>();
      for (const name of readdirSync(dir).filter(name => FILE.test(name))) files.set(name, read(join(dir, name))!);
      this.publishScope(scope, dir, files, read(join(dir, ".scope.json")));
    } finally { this.busy = false; }
  }
  private publishScope(scope: string, dir: string, originals: Map<string, string>, oldManifest?: string): void {
    const entries = this.backend.list(scope, { limit: MAX_MIRROR_ENTRIES + 1 });
    if (entries.length > MAX_MIRROR_ENTRIES) throw new MemoryFileError("scope exceeds memory mirror capacity; nothing is truncated");
    const grouped = new Map<string, MemoryEntry[]>([...new Set(["semantic.md","procedural.md","profile.yaml","episodes.jsonl",...originals.keys()])].map(name => [name, []]));
    for (const e of entries) {
      if (e.class === "working") continue;
      const file = e.origin.kind === "file" && e.origin.source === "owner-file" && e.origin.locator && FILE.test(e.origin.locator) ? e.origin.locator : e.class === "episodic" ? "episodes.jsonl" : `${e.class}.md`;
      const list = grouped.get(file) ?? []; list.push(e); grouped.set(file, list);
    }
    const manifest: Manifest = { version: 1, scope, published: [] };
    for (const [file, rows] of grouped) {
      const data = rows.map(e => ({ id: e.id, text: e.text, trust: e.trust }));
      const text = file === "profile.yaml" ? Bun.YAML.stringify({ memories: data }, null, 2) + "\n" : file === "episodes.jsonl" ? data.map(e => JSON.stringify(e)).join("\n") + (data.length ? "\n" : "") : rows.map(e => `## ${e.id}${e.trust === "untrusted" ? " [untrusted]" : ""}\n\n${e.text.replace(/^(\\*)## /gm, "\\$1## ")}\n`).join("\n");
      write(join(dir, file), text, originals.get(file));
      manifest.published.push(...rows.map(e => ({ id: e.id, file })));
    }
    // Only successfully published identities may later be removed by a file deletion.
    write(join(dir, ".scope.json"), JSON.stringify(manifest, null, 2) + "\n", oldManifest);
  }
}
