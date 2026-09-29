import { createHash, createPublicKey, createVerify } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export interface PackageRef {
  registry: "npm";
  name: string;
  /** An exact version. Ranges and tags are refused: what the owner approves is what runs. */
  version: string;
}

/** What August learned about a package before installing anything, shown in the approval and checked again after the install. */
export interface ArtifactEvidence {
  ref: PackageRef;
  /** The registry's own digest of the published tarball: `sha512-<base64>`. */
  integrity: string;
  /** `npm-registry-ecdsa`: the registry signed name, version and integrity with a key it publishes. */
  signature: "npm-registry-ecdsa" | "none";
  signatureKeyId?: string;
  publisher?: string;
  maintainers: string[];
  /** Lifecycle scripts the package declares. August never runs them. */
  installScripts: string[];
  dependencyCount: number;
  /** A sigstore provenance attestation is published for this version. Presence only: it is not verified here. */
  attestation: "present" | "absent";
  deprecated?: string;
  bin: Record<string, string>;
}

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

const NPM_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

export interface ResolveOptions {
  fetch?: typeof fetch;
  registryUrl?: string;
  now?: () => number;
  timeoutMs?: number;
  /** Trust only these registry key ids (base64 SPKI keyed by id) instead of asking the registry for its keys. */
  pinnedKeys?: Record<string, string>;
}

async function getJson(fetchFn: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ArtifactError(`package registry unreachable (${(error as Error).name})`);
  }
  if (!response.ok) throw new ArtifactError(`package registry HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_METADATA_BYTES) throw new ArtifactError("package registry reply too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new ArtifactError("package registry reply is not JSON");
  }
}

interface NpmKey { keyid: string; key: string; expires: string | null }

/** ECDSA P-256 over `<name>@<version>:<integrity>`, the message the npm registry signs. */
export function verifyNpmSignature(message: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return createVerify("SHA256").update(message).verify(key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/**
 * Asks the registry what it published for exactly name@version and checks the registry's signature over it.
 * Nothing is downloaded or run here. A signature that does not verify is an error, not a warning.
 */
export async function resolveNpm(ref: PackageRef, options: ResolveOptions = {}): Promise<ArtifactEvidence> {
  const fetchFn = options.fetch ?? fetch;
  const base = (options.registryUrl ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const timeout = options.timeoutMs ?? 15_000;
  if (!NPM_NAME.test(ref.name)) throw new ArtifactError(`"${ref.name}" is not a valid npm package name`);
  if (!EXACT_VERSION.test(ref.version)) throw new ArtifactError(`"${ref.version}" is not an exact version`);
  const meta = (await getJson(fetchFn, `${base}/${ref.name.replace("/", "%2f")}/${encodeURIComponent(ref.version)}`, timeout)) as Record<string, unknown>;
  if (meta.name !== ref.name || meta.version !== ref.version) throw new ArtifactError("the registry answered for a different package or version");
  const dist = (meta.dist ?? {}) as { integrity?: unknown; signatures?: unknown; attestations?: unknown };
  if (typeof dist.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity)) throw new ArtifactError("the registry published no sha512 integrity for this version");
  const message = `${ref.name}@${ref.version}:${dist.integrity}`;

  let signature: ArtifactEvidence["signature"] = "none"; let signatureKeyId: string | undefined;
  const signatures = Array.isArray(dist.signatures) ? (dist.signatures as Array<{ keyid?: unknown; sig?: unknown }>) : [];
  if (signatures.length > 0) {
    const keys: NpmKey[] = options.pinnedKeys
      ? Object.entries(options.pinnedKeys).map(([keyid, key]) => ({ keyid, key, expires: null }))
      : (((await getJson(fetchFn, `${base}/-/npm/v1/keys`, timeout)) as { keys?: NpmKey[] }).keys ?? []);
    const now = (options.now ?? Date.now)();
    for (const s of signatures) {
      const key = keys.find((k) => k.keyid === s.keyid && (!k.expires || Date.parse(k.expires) > now));
      if (key && typeof s.sig === "string" && verifyNpmSignature(message, s.sig, key.key)) { signature = "npm-registry-ecdsa"; signatureKeyId = key.keyid; break; }
    }
    if (signature === "none") throw new ArtifactError("the registry's signature over this package does not verify");
  }

  const scripts = (meta.scripts ?? {}) as Record<string, unknown>;
  const installScripts = ["preinstall", "install", "postinstall"].filter((k) => typeof scripts[k] === "string");
  const npmUser = meta._npmUser as { name?: unknown } | undefined;
  const maintainers = Array.isArray(meta.maintainers) ? (meta.maintainers as Array<{ name?: unknown }>).map((m) => m.name).filter((n): n is string => typeof n === "string") : [];
  const bin: Record<string, string> = typeof meta.bin === "string" ? { [ref.name.split("/").pop()!]: meta.bin } : Object.fromEntries(Object.entries((meta.bin ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string") as Array<[string, string]>);
  return {
    ref, integrity: dist.integrity, signature, signatureKeyId,
    publisher: typeof npmUser?.name === "string" ? npmUser.name : undefined,
    maintainers,
    installScripts,
    dependencyCount: Object.keys((meta.dependencies ?? {}) as object).length,
    attestation: dist.attestations ? "present" : "absent",
    deprecated: typeof meta.deprecated === "string" ? meta.deprecated : undefined,
    bin,
  };
}

/** A compact, honest summary for the approval prompt. */
export function describeEvidence(e: ArtifactEvidence): string {
  const who = e.publisher ? `published by ${e.publisher}` : "publisher unknown";
  const sig = e.signature === "npm-registry-ecdsa" ? "registry signature verified" : "NO registry signature";
  const scripts = e.installScripts.length ? `; declares install scripts (${e.installScripts.join(", ")}) which August will not run` : "";
  return `npm ${e.ref.name}@${e.ref.version}, ${who}, ${sig}, ${e.dependencyCount} direct dependencies, provenance attestation ${e.attestation}${scripts}${e.deprecated ? `; DEPRECATED: ${e.deprecated.slice(0, 120)}` : ""}`;
}

export interface CommandRunner {
  (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<{ status: number | null; stderr: string }>;
}

export const runCommand: CommandRunner = (command, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ status: null, stderr: "could not start" }); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
  });

/** sha256 over every file's path, mode class and content, and every link's target: any change to the installed tree changes it. */
export function treeHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = relative(dir, path).split(sep).join("/");
      if (rel === "bun.lock" || rel === ".august-install.json") continue;
      const st = lstatSync(path);
      if (st.isSymbolicLink()) hash.update(`L\0${rel}\0${readlinkSync(path)}\0`);
      else if (st.isDirectory()) { hash.update(`D\0${rel}\0`); walk(path); }
      else if (st.isFile()) hash.update(`F\0${rel}\0${st.mode & 0o111 ? "x" : "-"}\0${createHash("sha256").update(readFileSync(path)).digest("hex")}\0`);
      else throw new ArtifactError(`unexpected file type at ${rel}`);
    }
  };
  walk(dir);
  return hash.digest("hex");
}

export interface InstalledArtifact {
  registry: "npm";
  name: string;
  version: string;
  integrity: string;
  treeSha256: string;
  signature: ArtifactEvidence["signature"];
  entry: { runtime: "node" | "bun"; file: string };
  verifiedAt: string;
}

export interface InstallOptions {
  /** The bun executable used to install. */
  bun: string;
  registryUrl?: string;
  run?: CommandRunner;
  now?: () => number;
  timeoutMs?: number;
  /** Where the package manager keeps downloads. Outside the installed tree, so the tree hash covers only what will run. Default: next to it. */
  cacheDir?: string;
  /** Whether a `node` binary is available; when not, JavaScript entries run under bun. */
  nodeAvailable?: boolean;
}

const RISKY_LOCK_SOURCE = /^(?:github:|git\+|git:|file:|link:|http:|https:|workspace:)/;

function pickBin(bin: Record<string, string>, name: string): string {
  const preferred = bin[name.split("/").pop()!];
  const file = preferred ?? Object.values(bin)[0];
  if (!file) throw new ArtifactError("the package declares no executable (bin), so August cannot start it");
  const clean = file.replace(/^\.\//, "");
  if (clean.startsWith("/") || clean.split("/").includes("..")) throw new ArtifactError("the package's executable path leaves the package");
  return clean;
}

/**
 * Installs exactly the approved version into its own folder with lifecycle scripts disabled, then
 * proves what landed there: the lockfile's digest for the root package equals the registry-signed
 * one, every dependency came from the registry with an integrity digest (no git, file or URL
 * sources), and the whole tree is hashed so any later change is detected before the server starts.
 */
export async function installNpm(evidence: ArtifactEvidence, dir: string, options: InstallOptions): Promise<InstalledArtifact> {
  const { ref } = evidence;
  const run = options.run ?? runCommand;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "august-capability", private: true, dependencies: { [ref.name]: ref.version } }, null, 2), { mode: 0o600 });
  const args = ["install", "--ignore-scripts", "--no-progress", "--cache-dir", options.cacheDir ?? join(dirname(dir), ".package-cache"), ...(options.registryUrl ? ["--registry", options.registryUrl] : [])];
  // A clean environment: the install must not see the owner's tokens, npmrc credentials or proxy secrets beyond what it needs to reach the registry.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir, ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}), ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}), ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}) };
  const result = await run(options.bun, args, { cwd: dir, env, timeoutMs: options.timeoutMs ?? 300_000 });
  if (result.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new ArtifactError("installing the package failed"); }

  try {
    const lockPath = join(dir, "bun.lock");
    if (!existsSync(lockPath)) throw new ArtifactError("the install produced no lockfile to verify");
    const lock = (Bun as unknown as { JSONC: { parse(text: string): unknown } }).JSONC.parse(readFileSync(lockPath, "utf8")) as { packages?: Record<string, unknown[]> };
    const packages = lock.packages ?? {};
    const root = packages[ref.name];
    if (!root || root[0] !== `${ref.name}@${ref.version}`) throw new ArtifactError("the installed package is not the approved version");
    if (root[3] !== evidence.integrity) throw new ArtifactError("the installed package does not match the digest the registry signed");
    for (const [key, entry] of Object.entries(packages)) {
      const [id, source, , digest] = entry as [string, string, unknown, string?];
      // The lockfile leaves the source empty for the default registry; with a configured one it names that registry and nothing else.
      const fromRegistry = source === "" || (options.registryUrl !== undefined && typeof source === "string" && source.startsWith(`${options.registryUrl.replace(/\/+$/, "")}/`));
      if (typeof id !== "string" || RISKY_LOCK_SOURCE.test(id.slice(key.length + 1)) || !fromRegistry || typeof digest !== "string" || !digest.startsWith("sha512-")) {
        throw new ArtifactError(`dependency "${key}" does not come from the registry with an integrity digest`);
      }
    }
    const file = join("node_modules", ref.name, pickBin(evidence.bin, ref.name)).split(sep).join("/");
    const entryPath = join(dir, file);
    if (!existsSync(entryPath) || !lstatSync(entryPath).isFile()) throw new ArtifactError("the package's executable is missing after install");
    const shebang = readFileSync(entryPath, "utf8").split("\n", 1)[0] ?? "";
    const runtime: "node" | "bun" = /\bbun\b/.test(shebang) || options.nodeAvailable === false ? "bun" : "node";
    chmodSync(dir, 0o700);
    return { registry: "npm", name: ref.name, version: ref.version, integrity: evidence.integrity, treeSha256: treeHash(dir), signature: evidence.signature, entry: { runtime, file }, verifiedAt: new Date((options.now ?? Date.now)()).toISOString() };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Recomputes the installed tree and compares it with what was approved. False means it changed since. */
export function verifyInstalled(pin: { treeSha256: string }, dir: string): boolean {
  try {
    return existsSync(dir) && treeHash(dir) === pin.treeSha256;
  } catch {
    return false;
  }
}
