import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { EncryptedFileStore, FileStore, MasterKeyError, SecretError, createApp, defaultConfigPath, deriveKey, keyFromRecoveryCode, loadMasterKey, main, openSecretStore, recoveryCode, writeConfig, type CliIo } from "../src/index.ts";
import { defaultConfig } from "./config-fixture.ts";

// Suite category: Safety/security invariant (REQ-SEC-004): secrets encrypted at rest under a key outside the data folder, recoverable; theft and tamper tests.
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "august-sec-")); dirs.push(d); return d; };
const allBytes = (dir: string): Buffer[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allBytes(join(dir, e.name)) : [readFileSync(join(dir, e.name))]));
// Safety/security invariant (REQ-SEC-004): fixture credentials never reach a host OS store.
const encryptedFixture = (home: string) => openSecretStore(join(home, ".august"), {
  kind: "encrypted-file", env: {}, keyDir: join(home, ".config", "august"),
  run: () => { throw new Error("credential fixture attempted a host process"); },
});

describe("master key", () => {
  test("is created once with owner-only permissions, and found again", () => {
    const keyDir = join(tmp(), "keys");
    const first = loadMasterKey({ env: {}, keyDir, create: true })!;
    expect(first.source).toBe("new");
    expect(statSync(join(keyDir, "master.key")).mode & 0o777).toBe(0o600);
    expect(statSync(keyDir).mode & 0o777).toBe(0o700);
    const again = loadMasterKey({ env: {}, keyDir })!;
    expect(again).toMatchObject({ source: "file", id: first.id });
    expect(again.key.equals(first.key)).toBe(true);
    expect(loadMasterKey({ env: {}, keyDir: join(tmp(), "none") })).toBeUndefined();
  });

  test("the owner's environment key or passphrase wins; a bad one is refused", () => {
    const keyDir = join(tmp(), "keys"); const raw = randomBytes(32);
    expect(loadMasterKey({ env: { AUGUST_MASTER_KEY: raw.toString("hex") }, keyDir })).toMatchObject({ source: "env" });
    expect(loadMasterKey({ env: { AUGUST_MASTER_KEY: raw.toString("base64") }, keyDir })!.key.equals(raw)).toBe(true);
    expect(() => loadMasterKey({ env: { AUGUST_MASTER_KEY: "short" }, keyDir })).toThrow(MasterKeyError);
    const a = loadMasterKey({ env: { AUGUST_MASTER_PASSPHRASE: "correct horse battery staple" }, keyDir })!;
    const b = loadMasterKey({ env: { AUGUST_MASTER_PASSPHRASE: "correct horse battery staple" }, keyDir })!;
    const c = loadMasterKey({ env: { AUGUST_MASTER_PASSPHRASE: "another passphrase entirely" }, keyDir })!;
    expect(a.key.equals(b.key)).toBe(true); expect(a.key.equals(c.key)).toBe(false);
    expect(() => loadMasterKey({ env: { AUGUST_MASTER_PASSPHRASE: "short" }, keyDir })).toThrow(/at least 12/);
  });

  test("a recovery code restores exactly the key, and a mistyped character is caught rather than producing a wrong key", () => {
    const key = randomBytes(32); const code = recoveryCode(key);
    expect(code).toMatch(/^AUG1(-[A-Z2-7]{1,4})+$/);
    expect(keyFromRecoveryCode(code).equals(key)).toBe(true);
    expect(keyFromRecoveryCode(code.toLowerCase()).equals(key)).toBe(true);
    const at = code.indexOf("-") + 2; const typo = `${code.slice(0, at)}${code[at] === "A" ? "B" : "A"}${code.slice(at + 1)}`;
    expect(() => keyFromRecoveryCode(typo)).toThrow(/does not check out/);
    expect(() => keyFromRecoveryCode("nonsense")).toThrow(MasterKeyError);
  });

  test("keys for different jobs are independent", () => {
    const m = randomBytes(32);
    expect(deriveKey(m, "secrets-at-rest").equals(deriveKey(m, "audit-ed25519"))).toBe(false);
    expect(deriveKey(m, "secrets-at-rest").equals(deriveKey(m, "secrets-at-rest"))).toBe(true);
  });
});

describe("EncryptedFileStore", () => {
  test("master keys cannot be created inside data, while similarly named siblings remain valid", () => {
    const home = tmp(); const data = join(home, "data");
    for (const keyDir of [data, join(data, "keys", "nested")]) {
      expect(() => openSecretStore(data, { kind: "encrypted-file", env: {}, keyDir })).toThrow(/outside/);
      expect(existsSync(join(keyDir, "master.key"))).toBe(false);
    }
    expect(existsSync(data)).toBe(false);
    const workspace = join(home, "owner-workspace");
    expect(() => openSecretStore(data, { kind: "encrypted-file", env: {}, keyDir: join(workspace, "keys"), protectedDirectories: [workspace] })).toThrow(/outside/);
    expect(existsSync(workspace)).toBe(false);
    const safe = openSecretStore(data, { kind: "encrypted-file", env: {}, keyDir: join(home, "data-keys") });
    safe.set("OWNER_TOKEN", "fixture-value");
    expect(safe.get("OWNER_TOKEN")).toBe("fixture-value");
  });

  test("directory and individual key-file symlinks into data are rejected without changing existing files", () => {
    const home = tmp(); const data = join(home, "data"); mkdirSync(data);
    const key = randomBytes(32).toString("hex"); const target = join(data, "preserve.key"); writeFileSync(target, key);
    const alias = join(home, "key-folder-alias"); symlinkSync(data, alias);
    expect(() => openSecretStore(data, { kind: "encrypted-file", env: {}, keyDir: join(alias, "nested") })).toThrow(/outside/);
    const keyDir = join(home, "keys"); mkdirSync(keyDir); symlinkSync(target, join(keyDir, "master.key"));
    expect(() => openSecretStore(data, { kind: "encrypted-file", env: {}, keyDir })).toThrow(/outside/);
    expect(readFileSync(target, "utf8")).toBe(key);
    expect(readdirSync(data)).toEqual(["preserve.key"]);
  });

  test("data boundary matches the normalized paths the encrypted store actually writes", () => {
    const home = tmp(); const actual = join(home, "actual"); mkdirSync(join(actual, "child"), { recursive: true });
    const alias = join(home, "alias"); symlinkSync(join(actual, "child"), alias);
    const data = `${alias}/../data`; const keyDir = join(home, "data", "keys");
    expect(() => openSecretStore(data, { kind: "encrypted-file", env: {}, keyDir })).toThrow(/outside/);
    expect(existsSync(keyDir)).toBe(false);
  });

  test("an injected environment key needs no file inside the configured key folder", () => {
    const home = tmp(); const data = join(home, "data"); const keyDir = join(data, "ignored-keys");
    const store = openSecretStore(data, { kind: "encrypted-file", env: { AUGUST_MASTER_KEY: randomBytes(32).toString("hex") }, keyDir });
    store.set("OWNER_TOKEN", "fixture-value");
    expect(existsSync(keyDir)).toBe(false);
    expect(store.get("OWNER_TOKEN")).toBe("fixture-value");
  });

  test("values are sealed on disk, read back exactly, and the file is owner-only", () => {
    const dir = tmp(); const store = new EncryptedFileStore(dir, randomBytes(32));
    store.set("OPENAI_API_KEY", "sk-live-very-secret-value-123");
    store.set("mail.TOKEN", "тайный токен ✓");
    expect(store.get("OPENAI_API_KEY")).toBe("sk-live-very-secret-value-123");
    expect(store.get("mail.TOKEN")).toBe("тайный токен ✓");
    expect(store.list()).toEqual(["OPENAI_API_KEY", "mail.TOKEN"]);
    for (const bytes of allBytes(dir)) { expect(bytes.includes("very-secret")).toBe(false); expect(bytes.includes("тайный")).toBe(false); }
    expect(statSync(join(dir, "secrets.enc.json")).mode & 0o777).toBe(0o600);
    expect(store.delete("OPENAI_API_KEY")).toBe(true);
    expect(store.get("OPENAI_API_KEY")).toBeUndefined();
  });

  test("THEFT: a copy of the data folder without the key opens nothing, and the wrong key says so plainly", () => {
    const home = tmp(); const dataDir = join(home, ".august"); const keyDir = join(home, ".config", "august");
    const store = encryptedFixture(home);
    expect(store.kind).toBe("encrypted-file");
    store.set("OPENAI_API_KEY", "sk-stolen-if-plain-0001");
    const stolen = join(tmp(), "copy"); cpSync(dataDir, stolen, { recursive: true });
    for (const bytes of allBytes(stolen)) expect(bytes.includes("sk-stolen-if-plain")).toBe(false);
    expect(existsSync(join(stolen, "master.key"))).toBe(false);
    const attacker = new EncryptedFileStore(stolen, randomBytes(32));
    expect(() => attacker.get("OPENAI_API_KEY")).toThrow(/sealed with master key/);
    expect(() => attacker.list()).toThrow(SecretError);
  });

  test("TAMPER: a changed value, or one entry moved under another name, fails its integrity check instead of returning something", () => {
    const dir = tmp(); const master = randomBytes(32); const store = new EncryptedFileStore(dir, master);
    store.set("AAA_KEY", "value-a"); store.set("BBB_KEY", "value-b");
    const path = join(dir, "secrets.enc.json"); const file = JSON.parse(readFileSync(path, "utf8"));
    const swapped = { ...file, entries: { AAA_KEY: file.entries.BBB_KEY, BBB_KEY: file.entries.AAA_KEY } };
    writeFileSync(path, JSON.stringify(swapped));
    expect(() => store.get("AAA_KEY")).toThrow(/integrity check/);
    const flipped = JSON.parse(readFileSync(path, "utf8")); const ct = Buffer.from(flipped.entries.AAA_KEY.ct, "base64"); ct[0]! ^= 1; flipped.entries.AAA_KEY.ct = ct.toString("base64");
    writeFileSync(path, JSON.stringify(flipped));
    expect(() => store.get("AAA_KEY")).toThrow(/integrity check/);
  });

  test("MIGRATION: an older plaintext file stays readable, and migrate seals it, verifies it, and destroys the plaintext", () => {
    const dir = tmp(); new FileStore(dir).set("OLD_TOKEN", "plaintext-legacy-value");
    const store = new EncryptedFileStore(dir, randomBytes(32));
    expect(store.get("OLD_TOKEN")).toBe("plaintext-legacy-value");
    expect(store.plaintextNames()).toEqual(["OLD_TOKEN"]);
    expect(store.migrate()).toEqual({ moved: 1 });
    expect(existsSync(join(dir, "secrets.json"))).toBe(false);
    expect(store.get("OLD_TOKEN")).toBe("plaintext-legacy-value");
    for (const bytes of allBytes(dir)) expect(bytes.includes("plaintext-legacy-value")).toBe(false);
    expect(store.migrate()).toEqual({ moved: 0 });
  });

  test("ROTATION re-seals every secret under a new key; the old key no longer opens the file", () => {
    const dir = tmp(); const oldKey = randomBytes(32); const newKey = randomBytes(32);
    const store = new EncryptedFileStore(dir, oldKey); store.set("A_KEY", "one"); store.set("B_KEY", "two");
    const next = store.rotate(newKey);
    expect(next.get("A_KEY")).toBe("one"); expect(next.get("B_KEY")).toBe("two");
    expect(() => new EncryptedFileStore(dir, oldKey).get("A_KEY")).toThrow(/sealed with master key/);
  });

  test("the default fallback encrypts, and an unavailable key fails closed without a plaintext store", () => {
    const ok = openSecretStore(join(tmp(), "d"), { env: {}, keyDir: join(tmp(), "k"), platform: "freebsd" });
    expect(ok.kind).toBe("encrypted-file");
    const blocked = tmp(); writeFileSync(join(blocked, "file"), "");
    const data = join(tmp(), "d");
    expect(() => openSecretStore(data, { env: {}, keyDir: join(blocked, "file", "k"), platform: "freebsd" })).toThrow(SecretError);
    expect(existsSync(join(data, "secrets.json"))).toBe(false);
    expect(existsSync(join(data, "secrets.enc.json"))).toBe(false);
    expect(readFileSync(join(blocked, "file"), "utf8")).toBe("");
  });
});

describe("through the CLI and the app", () => {
  test("App refuses file-backed keys inside the file-tool workspace before inference", () => {
    const home = tmp(); const config = defaultConfig(home); const keyDir = join(config.root, "keys");
    expect(() => createApp(config, { home, env: { AUGUST_KEY_DIR: keyDir }, secrets: new FileStore(join(home, ".august")), llm: { name: "unused", complete: async () => { throw Error("must not infer"); } } })).toThrow(/outside/);
    expect(existsSync(join(keyDir, "master.key"))).toBe(false);
  });

  test("workspace boundary follows the OS meaning of symlink-parent paths", () => {
    const home = tmp(); const actual = join(home, "actual"); mkdirSync(join(actual, "child"), { recursive: true });
    mkdirSync(join(actual, "workspace")); const alias = join(home, "alias"); symlinkSync(join(actual, "child"), alias);
    const config = { ...defaultConfig(home), root: `${alias}/../workspace` };
    const keyDir = join(actual, "workspace", "keys");
    expect(() => createApp(config, { home, env: { AUGUST_KEY_DIR: keyDir }, secrets: new FileStore(join(home, ".august")), llm: { name: "unused", complete: async () => "unused" } })).toThrow(/outside/);
    expect(existsSync(keyDir)).toBe(false);
  });

  test("CLI recovery cannot write a master key into the configured tool workspace", async () => {
    const home = tmp(); const config = defaultConfig(home); writeConfig(defaultConfigPath(home), config);
    const keyDir = join(config.root, "keys"); const raw = randomBytes(32).toString("hex"); const code = recoveryCode(randomBytes(32));
    const out: string[] = []; const env = { AUGUST_KEY_DIR: keyDir, AUGUST_MASTER_KEY: raw };
    const io: CliIo = { home, env, print: line => void out.push(line), ask: async () => null,
      get secrets() { return openSecretStore(join(home, ".august"), { kind: "encrypted-file", env, keyDir }); },
    };
    expect((await main(["secret", "key", "recover", code], io)).code).toBe(1);
    expect(existsSync(keyDir)).toBe(false);
    expect(out.join("\n")).not.toContain(raw);
    expect(out.join("\n")).not.toContain(code);
  });

  test("key storage failure stops before asking for credentials; correcting the folder resumes encrypted storage", async () => {
    const home = tmp(); const data = join(home, ".august"); const blocker = join(home, "not-a-directory");
    writeFileSync(blocker, "preserve-owner-fixture");
    let keyDir = join(blocker, "keys"); let prompts = 0; const out: string[] = [];
    const io: CliIo = {
      home, env: {}, print: line => void out.push(line), ask: async () => { prompts++; return "owned-fixture-secret"; },
      get secrets() { return openSecretStore(data, { kind: "encrypted-file", env: {}, keyDir, run: () => { throw Error("OS credential access forbidden"); } }); },
    };
    expect((await main(["secret", "set", "OWNER_TOKEN"], io)).code).toBe(1);
    expect(prompts).toBe(0);
    expect(out.join("\n")).toContain("Nothing was saved in plaintext");
    expect(existsSync(join(data, "secrets.json"))).toBe(false);
    keyDir = join(home, "keys");
    expect((await main(["secret", "set", "OWNER_TOKEN"], io)).code).toBe(0);
    expect(io.secrets!.kind).toBe("encrypted-file");
    expect(io.secrets!.get("OWNER_TOKEN")).toBe("owned-fixture-secret");
    expect(allBytes(data).some(bytes => bytes.includes("owned-fixture-secret"))).toBe(false);
    expect(out.join("\n")).not.toContain("owned-fixture-secret");
    expect(readFileSync(blocker, "utf8")).toBe("preserve-owner-fixture");
  });

  const cli = (home: string, env: Record<string, string | undefined> = {}) => {
    const out: string[] = []; const answers: string[] = [];
    const io: CliIo = {
      print: (l) => void out.push(l), ask: async () => answers.shift() ?? null, env, home,
      // Commands recovering/rotating a key must reopen under its current identity.
      get secrets() { return encryptedFixture(home); },
      sandboxKind: "none", llm: { name: "none", complete: async () => "" },
    };
    writeConfig(defaultConfigPath(home), defaultConfig(home));
    return { io, out, answers };
  };

  test("secrets set through the CLI are encrypted under a key in the key folder, back-up-able as a recovery code, and restorable on a fresh machine", async () => {
    const home = tmp(); const { io, out, answers } = cli(home);
    answers.push("sk-cli-secret-9911");
    expect((await main(["secret", "set", "OPENAI_API_KEY"], io)).code).toBe(0);
    expect(out.at(-1)).toContain("encrypted-file");
    for (const bytes of allBytes(join(home, ".august"))) expect(bytes.includes("sk-cli-secret-9911")).toBe(false);
    expect(existsSync(join(home, ".config", "august", "master.key"))).toBe(true);
    out.length = 0; await main(["secret", "key", "recovery-code"], io);
    const code = out.join("\n").split("\n").at(-1)!;
    // A new machine with the copied data folder and only the recovery code.
    const fresh = tmp(); cpSync(join(home, ".august"), join(fresh, ".august"), { recursive: true });
    const second = cli(fresh);
    expect(second.io.env).toEqual({});
    expect((await main(["secret", "key", "recover", code], second.io)).code).toBe(0);
    second.out.length = 0; await main(["secret", "list"], second.io);
    expect(second.out).toContain("OPENAI_API_KEY");
    expect(encryptedFixture(fresh).get("OPENAI_API_KEY")).toBe("sk-cli-secret-9911");
    // Rotation changes the recovery code and keeps every secret.
    out.length = 0; expect((await main(["secret", "key", "rotate"], io)).code).toBe(0);
    out.length = 0; await main(["secret", "key", "recovery-code"], io);
    expect(out.join("\n").split("\n").at(-1)).not.toBe(code);
    expect(encryptedFixture(home).get("OPENAI_API_KEY")).toBe("sk-cli-secret-9911");
  });

  test("the app anchors its journal, `august audit verify` passes, and it fails after history is rewritten and the chain recomputed", async () => {
    const home = tmp(); const { io, out } = cli(home);
    const app = createApp(defaultConfig(home), { env: {}, home, llm: { name: "n", complete: async () => "hi" }, secrets: new FileStore(join(home, ".august")), sandboxKind: "none" });
    for (let i = 0; i < 12; i++) app.journal.append({ kind: "test.event", session: "s", data: { i } });
    const anchor = app.audit.anchor();
    expect(anchor).toMatchObject({ n: 1 });
    app.close();
    const first = await main(["audit", "verify"], io);
    expect(out.join("\n")).toContain("Nothing has been altered");
    expect(first.code).toBe(0);
    // The attacker edits an early entry and recomputes the chain.
    const { Database } = await import("bun:sqlite"); const { createHash } = await import("node:crypto");
    const db = new Database(join(home, ".august", "data", "journal.db"));
    const rows = db.query("SELECT * FROM journal ORDER BY seq").all() as Array<{ seq: number; ts: number; kind: string; session: string; data: string }>;
    let prev = "0".repeat(64);
    for (const r of rows) { const data = r.seq === 3 ? "{\"i\":\"forged\"}" : r.data; const hash = createHash("sha256").update(JSON.stringify([prev, r.seq, r.ts, r.kind, r.session, JSON.parse(data)])).digest("hex"); db.query("UPDATE journal SET data=?, prev_hash=?, hash=? WHERE seq=?").run(data, prev, hash, r.seq); prev = hash; }
    db.close();
    out.length = 0;
    expect((await main(["audit", "verify"], io)).code).toBe(1);
    expect(out.join("\n")).toContain("differs from what anchor");
    const exported = join(home, "anchors.json"); out.length = 0;
    expect((await main(["audit", "export", exported], io)).code).toBe(0);
    expect(JSON.parse(readFileSync(exported, "utf8")).anchors.length).toBeGreaterThan(0);
  });
});
