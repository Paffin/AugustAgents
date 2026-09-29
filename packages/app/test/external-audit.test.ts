import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorHash, parseAuditAnchor, type AuditAnchor } from "@august/core";
import { createApp, type App } from "../src/bootstrap.ts";
import { defaultConfigPath, parseConfig, writeConfig } from "../src/config.ts";
import { main, type CliIo } from "../src/cli.ts";
import { loadMasterKey } from "../src/masterkey.ts";
import { EncryptedFileStore } from "../src/secrets.ts";
import { defaultConfig } from "./config-fixture.ts";

// Safety/durable product regressions: owned sockets + owned encrypted credentials, no host OS stores.
const dirs: string[] = []; const apps: App[] = []; const servers: Bun.Server<undefined>[] = [];
afterEach(() => { apps.splice(0).forEach(a => a.close()); servers.splice(0).forEach(s => s.stop(true)); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), "august-audit-adapter-")); dirs.push(d); return d; };
function fixture() {
  const home = temp(), config = defaultConfig(home), keyDir = join(home, ".config", "august");
  config.llm.apiKeyEnv = undefined;
  const master = loadMasterKey({ env: {}, keyDir, create: true })!;
  const store = new EncryptedFileStore(join(home, ".august"), master.key);
  const env = { AUGUST_KEY_DIR: keyDir };
  const out: string[] = [];
  const io: CliIo = { home, env, secrets: store, print: x => out.push(x), ask: async () => null, sandboxKind: "none", llm: { name: "regression-fixture", complete: async () => "not acceptance" } };
  writeConfig(defaultConfigPath(home), config);
  return { home, config, keyDir, store, io, out };
}
function fingerprint(dir: string): unknown {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).sort().map(name => {
    const path = join(dir, name), stat = statSync(path);
    return [name, stat.mtimeMs, stat.isDirectory() ? fingerprint(path) : createHash("sha256").update(readFileSync(path)).digest("hex")];
  });
}
function sink(token: string) {
  const retained: AuditAnchor[] = []; let mode: "up" | "down" | "lost-ack" = "up", requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    if (mode === "down") return new Response(null, { status: 503 });
    if (request.method === "GET") return Response.json({ anchors: retained, nextAfter: null });
    const anchor = parseAuditAnchor(await request.json());
    if (anchor.n <= retained.length) return anchorHash(retained[anchor.n - 1]!) === anchorHash(anchor) ? Response.json({ hash: anchorHash(anchor) }) : new Response(null, { status: 409 });
    if (anchor.n !== retained.length + 1) return new Response(null, { status: 409 });
    retained.push(anchor);
    if (mode === "lost-ack") { mode = "up"; return new Response(null, { status: 503 }); }
    return Response.json({ hash: anchorHash(anchor) }, { status: 201 });
  } });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/anchors`, retained, mode: (value: typeof mode) => { mode = value; }, requests: () => requests };
}

describe("external audit App/CLI adapters", () => {
  test("config holds only a secret reference and validates collection URLs/settings", () => {
    const config = defaultConfig(temp());
    for (const auditExternal of [{ url: "http://remote.test/anchors", tokenEnv: "AUDIT_TOKEN" }, { url: "http://localhost/anchors", tokenEnv: "AUDIT_TOKEN" }, { url: "https://remote.test/?token=secret", tokenEnv: "AUDIT_TOKEN" }, { url: "https://remote.test", tokenEnv: "not-a-key" }, { url: "https://remote.test", tokenEnv: "AUDIT_TOKEN", token: "raw-value" }, { url: "https://remote.test", tokenEnv: "AUDIT_TOKEN", intervalMs: 0 }]) expect(() => parseConfig({ ...config, auditExternal })).toThrow();
    expect(parseConfig({ ...config, auditExternal: { url: "https://owner.example/anchors", tokenEnv: "AUDIT_TOKEN", caFile: "/owner/ca.pem", intervalMs: 1000 } }).auditExternal).toEqual({ url: "https://owner.example/anchors", tokenEnv: "AUDIT_TOKEN", caFile: "/owner/ca.pem", intervalMs: 1000 });
  });

  test("forensic verification/export never starts App, creates keys, signs history or changes files", async () => {
    const f = fixture(), app = createApp(f.config, f.io); apps.push(app);
    app.journal.append({ kind: "owner.task", session: "s", data: { text: "kept private" } }); app.audit.anchor(); app.close(); apps.pop();
    // No model/pricing is required to inspect evidence; no runtime ownership or migration occurs.
    writeConfig(defaultConfigPath(f.home), { ...f.config, llm: { baseUrl: f.config.llm.baseUrl, model: "" } });
    const before = fingerprint(f.home);
    expect((await main(["audit", "verify"], f.io)).code).toBe(0);
    expect(fingerprint(f.home)).toEqual(before);
    const file = join(f.home, "export.json"); expect((await main(["audit", "export", file], f.io)).code).toBe(0);
    const after = readFileSync(file); expect((await main(["audit", "export", file], f.io)).code).toBe(1); expect(readFileSync(file)).toEqual(after);
    const empty = temp(); const config = defaultConfig(empty); writeConfig(defaultConfigPath(empty), config);
    const io = { ...f.io, home: empty, env: { AUGUST_KEY_DIR: join(empty, "keys"), AUGUST_MASTER_PASSPHRASE: "owned fixture passphrase" } };
    const original = fingerprint(empty); expect((await main(["audit", "verify"], io)).code).toBe(1); expect(fingerprint(empty)).toEqual(original);
  });

  test("publisher recovers outage/lost ACK, and external verification catches rehash + removed local anchors without repair", async () => {
    const f = fixture(), token = randomBytes(24).toString("hex"), remote = sink(token); f.store.set("AUDIT_TOKEN", token);
    f.config.auditExternal = { url: remote.url, tokenEnv: "AUDIT_TOKEN", intervalMs: 1000 }; writeConfig(defaultConfigPath(f.home), f.config);
    const app = createApp(f.config, f.io); apps.push(app);
    app.journal.append({ kind: "owner.task", session: "s", data: { text: "kept private" } });
    await app.audit.publish(); expect((await app.audit.publish()).state).toBe("published");
    expect(remote.retained).toHaveLength(1); expect(JSON.stringify(remote.retained)).not.toContain("kept private");
    remote.mode("down"); app.journal.append({ kind: "second.task", session: "s", data: {} });
    expect((await app.audit.publish()).state).toBe("unavailable"); expect(remote.retained).toHaveLength(1);
    remote.mode("lost-ack"); expect((await app.audit.publish()).state).toBe("unavailable"); expect(remote.retained).toHaveLength(2);
    expect((await app.audit.publish()).state).toBe("published"); expect(remote.retained).toHaveLength(2);
    app.close(); apps.pop();
    const before = fingerprint(f.home); expect((await main(["audit", "verify", "--anchors", remote.url], f.io)).code).toBe(0); expect(fingerprint(f.home)).toEqual(before);
    const attackerDestination = sink(token), seen = attackerDestination.requests();
    expect((await main(["audit", "verify", "--anchors", attackerDestination.url], f.io)).code).toBe(1); expect(attackerDestination.requests()).toBe(seen);
    const db = new Database(join(f.config.dataDir, "journal.db"));
    let previous = "0".repeat(64);
    for (const entry of db.query("SELECT * FROM journal ORDER BY seq").all() as Array<{ seq: number; ts: number; kind: string; session: string; data: string }>) {
      const data = { attacker: true }, hash = createHash("sha256").update(JSON.stringify([previous, entry.seq, entry.ts, entry.kind, entry.session, data])).digest("hex");
      db.query("UPDATE journal SET data=?,prev_hash=?,hash=? WHERE seq=?").run(JSON.stringify(data), previous, hash, entry.seq); previous = hash;
    }
    db.close(); rmSync(join(f.keyDir, "audit", "anchors.jsonl"));
    const attacked = fingerprint(f.home); f.out.length = 0;
    expect((await main(["audit", "verify", "--anchors", remote.url], f.io)).code).toBe(1);
    expect(f.out.join("\n")).toContain("differs from what anchor"); expect(fingerprint(f.home)).toEqual(attacked); expect(remote.retained).toHaveLength(2);
    const restarted = createApp(f.config, f.io); apps.push(restarted);
    expect(() => restarted.audit.anchor()).toThrow("before signing");
    // Fixture construction only: production append durability is unchanged.
    restarted.journal.rawDb.transaction(() => { for (let i = 0; i < 51; i++) restarted.journal.append({ kind: "attack.tail", session: "s", data: { i } }); })();
    expect(existsSync(join(f.keyDir, "audit", "anchors.jsonl"))).toBe(false);
    expect((await restarted.audit.publish()).state).toBe("conflict"); restarted.close(); apps.pop();
    expect(existsSync(join(f.keyDir, "audit", "anchors.jsonl"))).toBe(false); expect(remote.retained).toHaveLength(2);
    expect((await main(["audit", "publish"], f.io)).code).toBe(1);
    expect(existsSync(join(f.keyDir, "audit", "anchors.jsonl"))).toBe(false);
  });

  test("tail gaps/empty external custody are explicit, and active WAL inspection fails without mutation", async () => {
    const f = fixture(), remote = sink("owned-fixture-audit-token"); f.store.set("AUDIT_TOKEN", "owned-fixture-audit-token");
    f.config.auditExternal = { url: remote.url, tokenEnv: "AUDIT_TOKEN" }; writeConfig(defaultConfigPath(f.home), f.config);
    const app = createApp(f.config, f.io); apps.push(app); app.journal.append({ kind: "task", session: "s", data: {} });
    await app.audit.publish(); await app.audit.publish(); app.audit.stop();
    app.journal.append({ kind: "not yet published", session: "s", data: {} });
    expect((await main(["audit", "verify", "--anchors", remote.url], f.io)).code).toBe(1); expect(f.out.join("\n")).toContain("Tail gap: 1");
    app.journal.rawDb.run("PRAGMA journal_mode = WAL"); app.journal.append({ kind: "active WAL", session: "s", data: {} });
    const before = fingerprint(f.home); expect((await main(["audit", "verify"], f.io)).code).toBe(1); expect(fingerprint(f.home)).toEqual(before);
  });

  test("doctor warns when custody is not configured; configured unavailable custody is not green", async () => {
    const f = fixture(); expect((await main(["doctor"], f.io)).code).toBe(0); expect(f.out.join("\n")).toContain("External audit sink is not configured");
    f.config.auditExternal = { url: sink("owned-token").url, tokenEnv: "MISSING_AUDIT_TOKEN" }; writeConfig(defaultConfigPath(f.home), f.config); f.out.length = 0;
    expect((await main(["doctor"], f.io)).code).toBe(1); expect(f.out.join("\n")).toContain("External audit unavailable");
  });
});
