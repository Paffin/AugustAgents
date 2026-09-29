import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// A fake npm registry for tests: real tarballs, a real ECDSA registry key, and the endpoints `bun install` and August's resolver use.
const dirs: string[] = []; export const servers: Array<ReturnType<typeof Bun.serve>> = [];
/** Call from afterAll. */
export function cleanupFakeNpm(): void { servers.forEach((s) => s.stop(true)); dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); }
export const tmp = () => { const d = mkdtempSync(join(tmpdir(), "august-art-")); dirs.push(d); return d; };

export const registryKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
export const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
export const spki = (k: typeof registryKey) => k.publicKey.export({ format: "der", type: "spki" }).toString("base64");
export const sign = (k: typeof registryKey, message: string) => { const s = createSign("SHA256"); s.update(message); return s.sign(k.privateKey).toString("base64"); };

export interface PkgSpec { name: string; version: string; files?: Record<string, string>; deps?: Record<string, string>; bin?: string | Record<string, string>; scripts?: Record<string, string> }
export function tarball(spec: PkgSpec): { bytes: Uint8Array; integrity: string } {
  const root = tmp(); const pkg = join(root, "package"); mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: spec.name, version: spec.version, bin: spec.bin ?? "bin.js", dependencies: spec.deps, scripts: spec.scripts }));
  for (const [file, body] of Object.entries({ "bin.js": "#!/usr/bin/env node\nconsole.log('ok');\n", ...spec.files })) { mkdirSync(join(pkg, file, ".."), { recursive: true }); writeFileSync(join(pkg, file), body); }
  chmodSync(join(pkg, "bin.js"), 0o755);
  spawnSync("tar", ["czf", join(root, "p.tgz"), "-C", root, "package"], { env: { PATH: process.env.PATH!, GZIP: "-n" } });
  const bytes = readFileSync(join(root, "p.tgz"));
  return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

export interface Behaviour {
  /** Override what the version document claims (the signed metadata). */
  versionDoc?: (doc: Record<string, unknown>, integrity: string) => Record<string, unknown>;
  /** Override what the packument (what bun reads) says the digest is. */
  packumentIntegrity?: string;
  /** Serve different bytes for the tarball than were published. */
  swapTarball?: Uint8Array;
  signWith?: typeof registryKey;
  keys?: unknown;
  status?: number;
}
export function fakeRegistry(pkgs: PkgSpec[], behaviour: Behaviour = {}) {
  const built = new Map(pkgs.map((p) => [p.name, { spec: p, ...tarball(p) }]));
  const server: ReturnType<typeof Bun.serve> = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req: Request): Response {
    const url = new URL(req.url); const path = decodeURIComponent(url.pathname).replace(/^\//, ""); const base: string = `http://127.0.0.1:${server.port}`;
    if (behaviour.status) return new Response("no", { status: behaviour.status });
    if (path === "-/npm/v1/keys") return Response.json(behaviour.keys ?? { keys: [{ keyid: "SHA256:test", keytype: "ecdsa-sha2-nistp256", key: spki(registryKey), expires: null }] });
    const tgz = /^(.+)\/-\/(.+)-(\d[^/]*)\.tgz$/.exec(path);
    if (tgz) { const b = built.get(tgz[1]!); return b ? new Response(behaviour.swapTarball ?? b.bytes) : new Response("nf", { status: 404 }); }
    const ver = /^(.+)\/(\d[^/]*)$/.exec(path);
    const name = ver ? ver[1]! : path; const b = built.get(name);
    if (!b) return new Response("nf", { status: 404 });
    const dist = (integrity: string): Record<string, unknown> => ({ integrity, tarball: `${base}/${name}/-/${name.split("/").pop()}-${b.spec.version}.tgz`, signatures: [{ keyid: "SHA256:test", sig: sign(behaviour.signWith ?? registryKey, `${name}@${b.spec.version}:${b.integrity}`) }] });
    const doc = (integrity: string): Record<string, unknown> => ({ name, version: b.spec.version, dist: dist(integrity), dependencies: b.spec.deps, scripts: b.spec.scripts, bin: b.spec.bin ?? "bin.js", _npmUser: { name: "alice" }, maintainers: [{ name: "alice" }, { name: "bob" }] });
    if (ver) return Response.json(behaviour.versionDoc ? behaviour.versionDoc(doc(b.integrity), b.integrity) : doc(b.integrity));
    return Response.json({ name, "dist-tags": { latest: b.spec.version }, versions: { [b.spec.version]: { ...doc(behaviour.packumentIntegrity ?? b.integrity), dist: { ...dist(behaviour.packumentIntegrity ?? b.integrity) } } } });
  } });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, integrity: (name: string) => built.get(name)!.integrity };
}

