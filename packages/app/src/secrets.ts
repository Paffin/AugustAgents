import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MasterKeyError, deriveKey, keyIdOf, loadMasterKey } from "./masterkey.ts";

/** Secrets August itself uses (model key, bot token) and secrets the owner set for their own tools. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
/**
 * A secret that belongs to one capability: `<capability id>.<NAME>`. Ids cannot contain a dot, so the
 * pair is unambiguous, and a capability can only ever be handed names in its own namespace.
 */
export const SCOPED_SECRET_NAME = /^[A-Za-z0-9_-]+\.[A-Z_][A-Z0-9_]*$/;

export function scopedSecretName(capability: string, name: string): string {
  const scoped = `${capability}.${name}`;
  if (!SCOPED_SECRET_NAME.test(scoped)) throw new SecretError(`invalid secret "${name}" for "${capability}"`);
  return scoped;
}
const SERVICE = "august";

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

export interface SecretStore {
  readonly kind: "keychain" | "secret-service" | "encrypted-file" | "file";
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): boolean;
  /** Names only; values never leave the store in bulk. */
  list(): string[];
}

export type Runner = (cmd: string, args: readonly string[], input?: string) => { status: number | null; stdout: string };

export const defaultRunner: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, [...args], { input, encoding: "utf8", timeout: 10_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
};

function checkName(name: string): void {
  if (!SECRET_NAME.test(name) && !SCOPED_SECRET_NAME.test(name)) throw new SecretError(`secret names look like OPENAI_API_KEY (got "${name}")`);
}

/**
 * Names live in a small index file (no values), because the OS stores cannot
 * list only our entries cheaply.
 */
class NameIndex {
  constructor(private readonly path: string) {}
  read(): string[] {
    try {
      const v = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(v) ? v.filter((n) => typeof n === "string") : [];
    } catch {
      return [];
    }
  }
  write(names: string[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify([...new Set(names)].sort()), { mode: 0o600 });
  }
}

/** macOS Keychain via `security`. The value passes through argv briefly; same-user processes could see it. */
export class KeychainStore implements SecretStore {
  readonly kind = "keychain" as const;
  private readonly index: NameIndex;
  constructor(dir: string, private readonly run: Runner = defaultRunner) {
    this.index = new NameIndex(join(dir, "secret-names.json"));
  }
  get(name: string): string | undefined {
    checkName(name);
    const r = this.run("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
    return r.status === 0 ? r.stdout.replace(/\n$/, "") : undefined;
  }
  set(name: string, value: string): void {
    checkName(name);
    const r = this.run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w", value]);
    if (r.status !== 0) throw new SecretError("could not write to the keychain");
    this.index.write([...this.index.read(), name]);
  }
  delete(name: string): boolean {
    checkName(name);
    const ok = this.run("security", ["delete-generic-password", "-s", SERVICE, "-a", name]).status === 0;
    this.index.write(this.index.read().filter((n) => n !== name));
    return ok;
  }
  list(): string[] {
    return this.index.read();
  }
}

/** Linux Secret Service (GNOME Keyring, KWallet) via `secret-tool`; the value goes through stdin. */
export class SecretServiceStore implements SecretStore {
  readonly kind = "secret-service" as const;
  private readonly index: NameIndex;
  constructor(dir: string, private readonly run: Runner = defaultRunner) {
    this.index = new NameIndex(join(dir, "secret-names.json"));
  }
  get(name: string): string | undefined {
    checkName(name);
    const r = this.run("secret-tool", ["lookup", "service", SERVICE, "account", name]);
    return r.status === 0 && r.stdout.length > 0 ? r.stdout.replace(/\n$/, "") : undefined;
  }
  set(name: string, value: string): void {
    checkName(name);
    const r = this.run("secret-tool", ["store", `--label=August ${name}`, "service", SERVICE, "account", name], value);
    if (r.status !== 0) throw new SecretError("could not write to the secret service");
    this.index.write([...this.index.read(), name]);
  }
  delete(name: string): boolean {
    checkName(name);
    const ok = this.run("secret-tool", ["clear", "service", SERVICE, "account", name]).status === 0;
    this.index.write(this.index.read().filter((n) => n !== name));
    return ok;
  }
  list(): string[] {
    return this.index.read();
  }
}

interface SealedEntry { iv: string; tag: string; ct: string }
interface SealedFile { v: 1; keyId: string; entries: Record<string, SealedEntry> }

/**
 * Fallback for machines without an OS keychain (servers, containers): every secret is sealed with AES-256-GCM
 * under a key derived from a master key that is kept outside the data folder (see masterkey.ts). Each value is
 * bound to its own name, so entries cannot be swapped; a wrong key is reported as a wrong key, never as garbage.
 * A plaintext `secrets.json` left by an older version is still readable, and `migrate()` moves it in.
 */
export class EncryptedFileStore implements SecretStore {
  readonly kind = "encrypted-file" as const;
  private readonly path: string;
  private readonly legacyPath: string;
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(dir: string, master: Buffer) {
    this.path = join(dir, "secrets.enc.json");
    this.legacyPath = join(dir, "secrets.json");
    this.key = deriveKey(master, "secrets-at-rest");
    this.keyId = keyIdOf(master);
  }

  private readSealed(): SealedFile {
    if (!existsSync(this.path)) return { v: 1, keyId: this.keyId, entries: {} };
    let file: SealedFile;
    try { file = JSON.parse(readFileSync(this.path, "utf8")) as SealedFile; } catch { throw new SecretError(`${this.path} is damaged`); }
    if (file.v !== 1 || typeof file.entries !== "object" || file.entries === null) throw new SecretError(`${this.path} is not a secrets file this version understands`);
    if (file.keyId !== this.keyId) throw new SecretError(`the secrets were sealed with master key ${file.keyId}, but this is ${this.keyId}; restore that key (august secret key recover CODE)`);
    return file;
  }

  private writeSealed(file: SealedFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  private seal(name: string, value: string): SealedEntry {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${this.keyId}|${name}`));
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  }

  private open(name: string, e: SealedEntry): string {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(e.iv, "base64"));
      decipher.setAAD(Buffer.from(`${this.keyId}|${name}`));
      decipher.setAuthTag(Buffer.from(e.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(e.ct, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretError(`the secret ${name} failed its integrity check; the file was changed or damaged`);
    }
  }

  private legacy(): Record<string, string> {
    if (!existsSync(this.legacyPath)) return {};
    try { const v = JSON.parse(readFileSync(this.legacyPath, "utf8")); return v && typeof v === "object" ? v : {}; } catch { return {}; }
  }

  get(name: string): string | undefined {
    checkName(name);
    const e = this.readSealed().entries[name];
    return e ? this.open(name, e) : this.legacy()[name];
  }

  set(name: string, value: string): void {
    checkName(name);
    const file = this.readSealed();
    file.entries[name] = this.seal(name, value);
    this.writeSealed(file);
  }

  delete(name: string): boolean {
    checkName(name);
    const file = this.readSealed();
    const had = name in file.entries;
    if (had) { delete file.entries[name]; this.writeSealed(file); }
    const old = this.legacy();
    if (name in old) { delete old[name]; writeFileSync(this.legacyPath, JSON.stringify(old, null, 2), { mode: 0o600 }); return true; }
    return had;
  }

  list(): string[] {
    return [...new Set([...Object.keys(this.readSealed().entries), ...Object.keys(this.legacy())])].sort();
  }

  /** Names still held in a plaintext file from an older version. */
  plaintextNames(): string[] {
    return Object.keys(this.legacy()).sort();
  }

  /** Seals what the old plaintext file holds, checks each value reads back, then destroys the plaintext file. */
  migrate(): { moved: number } {
    const old = this.legacy();
    const names = Object.keys(old);
    if (names.length === 0) return { moved: 0 };
    const file = this.readSealed();
    for (const name of names) { checkName(name); if (!(name in file.entries)) file.entries[name] = this.seal(name, old[name]!); }
    this.writeSealed(file);
    for (const name of names) if (this.get(name) !== old[name]) throw new SecretError(`could not read ${name} back after sealing it; the plaintext file was kept`);
    // Overwrite before unlinking, so the plaintext is not left in the freed blocks of the file.
    writeFileSync(this.legacyPath, Buffer.alloc(Math.max(1, statSync(this.legacyPath).size)), { mode: 0o600 });
    unlinkSync(this.legacyPath);
    return { moved: names.length };
  }

  /** Re-seals everything under another master key. Nothing changes unless every value could be read and re-sealed. */
  rotate(next: Buffer): EncryptedFileStore {
    const target = new EncryptedFileStore(dirname(this.path), next);
    const current = this.readSealed();
    const fresh: SealedFile = { v: 1, keyId: target.keyId, entries: {} };
    for (const [name, e] of Object.entries(current.entries)) fresh.entries[name] = target.seal(name, this.open(name, e));
    target.writeSealed(fresh);
    return target;
  }
}

/**
 * The old fallback: a JSON file readable only by its owner and not encrypted; anything running as you can read
 * it, as with an .env file. Kept for machines where no master key can be stored, and to read older files.
 */
export class FileStore implements SecretStore {
  readonly kind = "file" as const;
  private readonly path: string;
  constructor(dir: string) {
    this.path = join(dir, "secrets.json");
  }
  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      const v = JSON.parse(readFileSync(this.path, "utf8"));
      return v && typeof v === "object" ? v : {};
    } catch {
      throw new SecretError(`${this.path} is damaged`);
    }
  }
  private write(data: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
  get(name: string): string | undefined {
    checkName(name);
    return this.read()[name];
  }
  set(name: string, value: string): void {
    checkName(name);
    this.write({ ...this.read(), [name]: value });
  }
  delete(name: string): boolean {
    checkName(name);
    const data = this.read();
    if (!(name in data)) return false;
    delete data[name];
    this.write(data);
    return true;
  }
  list(): string[] {
    return Object.keys(this.read()).sort();
  }
}

export interface OpenStoreOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  run?: Runner;
  /** Force a backend. */
  kind?: SecretStore["kind"];
  /** Where the master key for the encrypted file lives: outside the data folder. Default `~/.config/august`. */
  keyDir?: string;
}

function has(run: Runner, cmd: string): boolean {
  return run("sh", ["-c", `command -v ${cmd}`]).status === 0;
}

/** Best store this machine offers: Keychain on macOS, Secret Service on a Linux desktop, else a private file. */
export function openSecretStore(dir: string, options: OpenStoreOptions = {}): SecretStore {
  const run = options.run ?? defaultRunner;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const kind: SecretStore["kind"] | undefined =
    options.kind ??
    (platform === "darwin" && has(run, "security")
      ? "keychain"
      : platform === "linux" && env.DBUS_SESSION_BUS_ADDRESS && has(run, "secret-tool")
        ? "secret-service"
        : "encrypted-file");
  if (kind === "keychain") return new KeychainStore(dir, run);
  if (kind === "secret-service") return new SecretServiceStore(dir, run);
  if (kind === "file") return new FileStore(dir);
  // The file fallback is encrypted whenever a master key can be found or created outside the data folder.
  try {
    const master = loadMasterKey({ env, keyDir: options.keyDir ?? env.AUGUST_KEY_DIR ?? join(process.env.HOME ?? "/", ".config", "august"), create: true });
    if (master) return new EncryptedFileStore(dir, master.key);
  } catch (error) {
    if (error instanceof MasterKeyError) throw new SecretError(error.message);
    // A key that cannot be stored (read-only home, no permission) leaves only the plaintext fallback; doctor says so.
  }
  return new FileStore(dir);
}

/** Store first, then the environment, so CI and containers keep working with plain env vars. */
export function resolveSecret(name: string, store: SecretStore | undefined, env: Record<string, string | undefined>): string | undefined {
  return store?.get(name) ?? env[name];
}
