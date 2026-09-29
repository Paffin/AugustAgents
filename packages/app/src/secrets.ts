import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  readonly kind: "keychain" | "secret-service" | "file";
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

/**
 * Fallback for machines without an OS keychain (servers, containers): a JSON
 * file readable only by its owner. It is not encrypted; anything running as
 * you can read it, as with an .env file.
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
}

function has(run: Runner, cmd: string): boolean {
  return run("sh", ["-c", `command -v ${cmd}`]).status === 0;
}

/** Best store this machine offers: Keychain on macOS, Secret Service on a Linux desktop, else a private file. */
export function openSecretStore(dir: string, options: OpenStoreOptions = {}): SecretStore {
  const run = options.run ?? defaultRunner;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const kind =
    options.kind ??
    (platform === "darwin" && has(run, "security")
      ? "keychain"
      : platform === "linux" && env.DBUS_SESSION_BUS_ADDRESS && has(run, "secret-tool")
        ? "secret-service"
        : "file");
  if (kind === "keychain") return new KeychainStore(dir, run);
  if (kind === "secret-service") return new SecretServiceStore(dir, run);
  return new FileStore(dir);
}

/** Store first, then the environment, so CI and containers keep working with plain env vars. */
export function resolveSecret(name: string, store: SecretStore | undefined, env: Record<string, string | undefined>): string | undefined {
  return store?.get(name) ?? env[name];
}
