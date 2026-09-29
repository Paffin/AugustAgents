import { createHash, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

export const MASTER_KEY_BYTES = 32;

export type MasterKeySource = "env" | "passphrase" | "file" | "new";

export interface MasterKey {
  key: Buffer;
  source: MasterKeySource;
  /** Short public name of the key, stored next to what it protects so a wrong key is recognised as such. */
  id: string;
  /** Where the key lives when it is a file the owner may want to back up. */
  path?: string;
}

export interface MasterKeyOptions {
  env: Record<string, string | undefined>;
  /** Outside the data folder and outside anything that is backed up with it. */
  keyDir: string;
  /** Create a random key file when nothing else provides one. Default false. */
  create?: boolean;
  /** Known data/workspace roots that must not contain a file-backed master key. */
  protectedDirectories?: readonly string[];
}

/** Resolve symlinked ancestors even when the final key folder/file does not exist yet. */
function canonicalPath(path: string): string {
  // Preserve `link/..` until realpath resolves it; lexical normalization would
  // inspect a different directory from the OS filesystem operation.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  let parent = parse(absolute).root;
  for (const component of absolute.slice(parent.length).split(sep === "\\" ? /[\\/]+/ : /\/+/)) {
    if (!component || component === ".") continue;
    if (component === "..") { parent = dirname(parent); continue; }
    parent = join(parent, component);
    try { parent = realpathSync(parent); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new MasterKeyError("Cannot resolve the key folder safely. Set AUGUST_KEY_DIR to a writable folder outside data. Nothing was saved in plaintext.");
    }
  }
  return parent;
}

/** No mutation: reject both a nested key folder and a key-file symlink back into data. */
export function assertKeyDirectoryOutside(keyDir: string, directories: readonly string[]): void {
  keyDir = resolve(keyDir);
  const candidates = [canonicalPath(keyDir), canonicalPath(join(keyDir, "master.key"))];
  for (const directory of directories) {
    const root = canonicalPath(directory);
    for (const candidate of candidates) {
      const rel = relative(root, candidate);
      if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new MasterKeyError("Master key folder/file must be outside the data and tool workspace directories. Existing files were not changed.");
    }
  }
}

export const keyIdOf = (key: Buffer): string => createHash("sha256").update("august-key-id").update(key).digest("hex").slice(0, 16);

/** Independent keys for independent jobs, so one leaking never reveals another. */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from("august"), Buffer.from(purpose), MASTER_KEY_BYTES));
}

function parseKeyText(text: string, where: string): Buffer {
  const t = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  if (key.length !== MASTER_KEY_BYTES) throw new MasterKeyError(`${where} must hold ${MASTER_KEY_BYTES} bytes as 64 hex digits or base64`);
  return key;
}

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Finds the key that protects secrets at rest. The owner's own choice wins: `AUGUST_MASTER_KEY` (for servers and
 * containers, injected by whatever orchestrates them), or `AUGUST_MASTER_PASSPHRASE` (stretched with scrypt, so the
 * owner can remember it). Otherwise a random key file in `keyDir`, created on first need. None of these lives in
 * the data folder, so a copy or backup of the data folder does not carry the key with it.
 */
export function loadMasterKey(options: MasterKeyOptions): MasterKey | undefined {
  const { env } = options; const keyDir = resolve(options.keyDir);
  const fromEnv = env.AUGUST_MASTER_KEY;
  if (fromEnv) { const key = parseKeyText(fromEnv, "AUGUST_MASTER_KEY"); return { key, source: "env", id: keyIdOf(key) }; }
  assertKeyDirectoryOutside(keyDir, options.protectedDirectories ?? []);
  const passphrase = env.AUGUST_MASTER_PASSPHRASE;
  if (passphrase) {
    if (passphrase.length < 12) throw new MasterKeyError("AUGUST_MASTER_PASSPHRASE must be at least 12 characters");
    const saltPath = join(keyDir, "master.salt");
    let salt: Buffer;
    if (existsSync(saltPath)) salt = Buffer.from(readFileSync(saltPath, "utf8").trim(), "hex");
    else {
      if (!options.create) return undefined;
      salt = randomBytes(16); privateDir(keyDir); writeFileSync(saltPath, salt.toString("hex"), { mode: 0o600, flag: "wx" });
    }
    const key = scryptSync(passphrase, salt, MASTER_KEY_BYTES, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return { key, source: "passphrase", id: keyIdOf(key), path: saltPath };
  }
  const path = join(keyDir, "master.key");
  if (existsSync(path)) { const key = parseKeyText(readFileSync(path, "utf8"), path); return { key, source: "file", id: keyIdOf(key), path }; }
  if (!options.create) return undefined;
  const key = randomBytes(MASTER_KEY_BYTES);
  privateDir(keyDir);
  // Exclusive create: two processes starting together end up with the same key, never two.
  try { writeFileSync(path, key.toString("hex"), { mode: 0o600, flag: "wx" }); }
  catch { const existing = parseKeyText(readFileSync(path, "utf8"), path); return { key: existing, source: "file", id: keyIdOf(existing), path }; }
  return { key, source: "new", id: keyIdOf(key), path };
}

/** Replaces the key file (recovery or rotation). The old file is kept beside it, so a mistake can be undone. */
export function writeMasterKeyFile(keyDir: string, key: Buffer, protectedDirectories: readonly string[] = []): string {
  if (key.length !== MASTER_KEY_BYTES) throw new MasterKeyError("a master key is 32 bytes");
  keyDir = resolve(keyDir);
  assertKeyDirectoryOutside(keyDir, protectedDirectories);
  privateDir(keyDir);
  const path = join(keyDir, "master.key");
  if (existsSync(path)) renameSync(path, join(keyDir, `master.key.${Date.now()}.old`));
  writeFileSync(path, key.toString("hex"), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

// --- Recovery code: the key as text the owner can write down or print and keep offline. ---

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes: Buffer): string {
  let bits = 0; let value = 0; let out = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Buffer {
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of text) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new MasterKeyError("the recovery code has a character that cannot be part of it");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const checksum = (key: Buffer): string => base32(createHash("sha256").update("august-recovery").update(key).digest().subarray(0, 3)).slice(0, 4);

/** `AUG1-XXXX-XXXX-...`: 32 bytes plus a checksum, so a typing mistake is caught instead of producing a wrong key. */
export function recoveryCode(key: Buffer): string {
  if (key.length !== MASTER_KEY_BYTES) throw new MasterKeyError("a master key is 32 bytes");
  const body = base32(key);
  return `AUG1-${(body.match(/.{1,4}/g) ?? []).join("-")}-${checksum(key)}`;
}

export function keyFromRecoveryCode(code: string): Buffer {
  const parts = code.trim().toUpperCase().split("-");
  if (parts[0] !== "AUG1" || parts.length < 3) throw new MasterKeyError("that is not an August recovery code");
  const check = parts.pop()!; const body = parts.slice(1).join("");
  const key = unbase32(body).subarray(0, MASTER_KEY_BYTES);
  if (key.length !== MASTER_KEY_BYTES || checksum(key) !== check) throw new MasterKeyError("the recovery code does not check out; look for a mistyped character");
  return Buffer.from(key);
}
