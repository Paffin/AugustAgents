import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnchorLog, AuditAnchorer, AuditKey, EventJournal, anchorHash, externalAnchorHttp, publishExternalAnchors, verifyExternalAudit } from "../src/index.ts";

// Safety/security and durable product regressions. Real independent HTTP process; not production custody acceptance.
const directories: string[] = []; const processes: ChildProcess[] = []; const journals: EventJournal[] = [];
afterAll(async () => {
  for (const process of processes) { process.kill("SIGTERM"); if (process.exitCode === null && process.signalCode === null) await new Promise(resolve => process.once("exit", resolve)); }
  journals.forEach(journal => journal.close());
  directories.forEach(directory => rmSync(directory, { recursive: true, force: true }));
});
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), "august-external-audit-")); directories.push(directory); return directory; };

async function service(key: AuditKey, options: { directory?: string; mode?: string; redirectTo?: string; token?: string; tls?: boolean; certificateIp?: string } = {}) {
  const directory = options.directory ?? temporary();
  const token = options.token ?? randomBytes(24).toString("base64url");
  if (options.tls && !options.directory) {
    const certificate = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=owned-audit-fixture", "-addext", `subjectAltName=IP:${options.certificateIp ?? "127.0.0.1"}`,
      "-keyout", join(directory, "private.pem"), "-out", join(directory, "certificate.pem")], { env: { PATH: process.env.PATH }, stdio: "ignore" });
    if (certificate.status !== 0) throw new Error("owned TLS fixture certificate generation failed");
  }
  writeFileSync(join(directory, "fixture.json"), JSON.stringify({ token, publicKey: key.publicKeyBytes().toString("base64"), ...options }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--no-env-file", join(import.meta.dir, "support/append-only-audit-server.ts"), directory], {
    env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let output = ""; let diagnostics = "";
  child.stderr!.on("data", data => { diagnostics = (diagnostics + String(data)).slice(-2000); });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("owned audit fixture startup failed")); }, 3000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("owned audit fixture could not start")); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`owned audit fixture exited before readiness: ${diagnostics}`)); });
    child.stdout!.on("data", data => {
      output += String(data);
      if (output.includes("\n")) { clearTimeout(timer); resolve((JSON.parse(output.trim()) as { url: string }).url); }
    });
  });
  return { directory, token, child, url, transport: externalAnchorHttp({ url, token, pageSize: 1 }) };
}

function source(entries = 3) {
  const directory = temporary(); const key = new AuditKey(randomBytes(32));
  const journal = new EventJournal(join(directory, "journal.db")); journals.push(journal);
  const log = new AnchorLog(join(directory, "local-anchors.jsonl"));
  new AuditAnchorer(journal, { log, key, every: 1 });
  for (let i = 0; i < entries; i++) journal.append({ kind: "owner.task", session: "fixture", data: { privateText: `private fixture ${i}` } });
  return { directory, key, journal, log };
}

describe("external signed audit transport", () => {
  test("publishes and verifies actual independent metadata, paginates and replays idempotently across server restart", async () => {
    const s = source(); const remote = await service(s.key);
    expect(await publishExternalAnchors(s.journal, s.log, remote.transport, s.key.publicKeyBytes())).toEqual({ published: 3, anchoredThrough: 3 });
    expect((await verifyExternalAudit(s.journal, remote.transport, s.key.publicKeyBytes())).state).toBe("verified");
    await remote.transport.append(s.log.list()[0]!);
    expect(await publishExternalAnchors(s.journal, s.log, remote.transport, s.key.publicKeyBytes())).toEqual({ published: 0, anchoredThrough: 3 });
    expect(readFileSync(join(remote.directory, "external-anchors.jsonl"), "utf8")).not.toContain("private fixture");
    remote.child.kill("SIGKILL"); await new Promise(resolve => remote.child.once("exit", resolve));
    const restarted = await service(s.key, { directory: remote.directory });
    expect((await verifyExternalAudit(s.journal, restarted.transport, s.key.publicKeyBytes())).state).toBe("verified");
    expect((await restarted.transport.list()).map(anchorHash)).toEqual(s.log.list().map(anchorHash));
  });

  test("ATTACK: deleting local anchors and truncating the journal cannot hide an independently held signed head", async () => {
    const s = source(); const remote = await service(s.key);
    await publishExternalAnchors(s.journal, s.log, remote.transport, s.key.publicKeyBytes());
    writeFileSync(s.log.path, "");
    s.journal.rawDb.run("DELETE FROM journal WHERE seq = 3");
    const report = await verifyExternalAudit(s.journal, remote.transport, s.key.publicKeyBytes());
    expect(report.state).toBe("tampered");
    if (report.state !== "unavailable") expect(report.report.problems.some(p => p.includes("gone from the journal"))).toBe(true);
    await expect(publishExternalAnchors(s.journal, s.log, remote.transport, s.key.publicKeyBytes())).rejects.toThrow("conflict");
  });

  test("an unanchored tail and unknown key rotation never become invented truncation or trusted coverage", async () => {
    const s = source(1); const remote = await service(s.key);
    const empty = await verifyExternalAudit(s.journal, remote.transport, s.key.publicKeyBytes());
    expect(empty.state).toBe("unanchored");
    await publishExternalAnchors(s.journal, s.log, remote.transport, s.key.publicKeyBytes());
    s.journal.append({ kind: "unpublished", session: "fixture", data: {} });
    const result = await verifyExternalAudit(s.journal, remote.transport, s.key.publicKeyBytes());
    expect(result.state).toBe("verified");
    if (result.state !== "unavailable") expect(result.report.unanchored).toBe(1);
    expect(await verifyExternalAudit(s.journal, remote.transport, new AuditKey(randomBytes(32)).publicKeyBytes())).toEqual({ state: "unavailable", reason: "unsupported-key" });
  });

  test("a persisted POST with lost acknowledgement is reconciled from readback without duplicating the anchor", async () => {
    const s = source(1); const remote = await service(s.key, { mode: "drop-ack" });
    await expect(publishExternalAnchors(s.journal, s.log, remote.transport, s.key.publicKeyBytes())).rejects.toThrow("unavailable");
    expect(await publishExternalAnchors(s.journal, s.log, remote.transport, s.key.publicKeyBytes())).toEqual({ published: 0, anchoredThrough: 1 });
    expect(new AnchorLog(join(remote.directory, "external-anchors.jsonl")).list()).toHaveLength(1);
  });

  test("ATTACK: concurrent retries keep one append per ordinal, conflicting payloads/prefixes cannot overwrite custody", async () => {
    const s = source(2); const remote = await service(s.key);
    await Promise.all([remote.transport.append(s.log.list()[0]!), remote.transport.append(s.log.list()[0]!)]);
    await expect(remote.transport.append({ ...s.log.list()[0]!, hash: "1".repeat(64) })).rejects.toThrow("conflict");
    expect((await remote.transport.list())).toEqual([s.log.list()[0]!]);
    const altered = new AnchorLog(join(s.directory, "altered.jsonl"));
    altered.append(s.log.list()[1]!);
    await expect(publishExternalAnchors(s.journal, altered, remote.transport, s.key.publicKeyBytes())).rejects.toThrow("conflict");
    await publishExternalAnchors(s.journal, s.log, remote.transport, s.key.publicKeyBytes());
    await expect(externalAnchorHttp({ url: remote.url, token: remote.token, pageSize: 1, maxPages: 1 }).list()).rejects.toThrow("unavailable");
  });

  test("ATTACK: valid-shaped external metadata with an invalid signature is detected, not silently repaired", async () => {
    const s = source(1); const remote = await service(s.key);
    await publishExternalAnchors(s.journal, s.log, remote.transport, s.key.publicKeyBytes());
    const path = join(remote.directory, "external-anchors.jsonl");
    writeFileSync(path, JSON.stringify({ ...s.log.list()[0]!, sig: Buffer.alloc(64).toString("base64") }) + "\n");
    const result = await verifyExternalAudit(s.journal, remote.transport, s.key.publicKeyBytes());
    expect(result.state).toBe("tampered");
    if (result.state !== "unavailable") expect(result.report.problems.some(p => p.includes("invalid signature"))).toBe(true);
    expect(new AnchorLog(path).list()[0]!.sig).toBe(Buffer.alloc(64).toString("base64"));
  });

  test("ATTACK: redirects never forward the bearer or anchor metadata", async () => {
    const s = source(1); const destination = await service(s.key);
    const redirect = await service(s.key, { mode: "redirect", redirectTo: destination.url, token: destination.token });
    await expect(redirect.transport.append(s.log.list()[0]!)).rejects.toThrow("unavailable");
    const stats = await fetch(destination.url.replace("/anchors", "/stats"), { headers: { Authorization: `Bearer ${destination.token}` } }).then(r => r.json()) as { requests: number; posts: number };
    expect(stats).toMatchObject({ requests: 1, posts: 0 }); // This stats read itself is the only destination request.
    expect((await destination.transport.list())).toEqual([]);
  });

  test("ATTACK: rehashing a rewritten journal and deleting local anchors still disagrees with external signatures", async () => {
    const s = source(); const remote = await service(s.key);
    await publishExternalAnchors(s.journal, s.log, remote.transport, s.key.publicKeyBytes());
    let previous = "0".repeat(64);
    for (const entry of s.journal.list()) {
      const data = entry.seq === 1 ? { rewritten: true } : entry.data;
      const hash = createHash("sha256").update(JSON.stringify([previous, entry.seq, entry.ts, entry.kind, entry.session, data])).digest("hex");
      s.journal.rawDb.run("UPDATE journal SET data = ?, prev_hash = ?, hash = ? WHERE seq = ?", [JSON.stringify(data), previous, hash, entry.seq]);
      previous = hash;
    }
    writeFileSync(s.log.path, "");
    expect(s.journal.verify()).toBeNull();
    expect((await verifyExternalAudit(s.journal, remote.transport, s.key.publicKeyBytes())).state).toBe("tampered");
  });

  test("actual HTTPS verifies an explicit owner CA and bound IP, rejects untrusted/wrong-name certificates", async () => {
    const s = source(1); const secure = await service(s.key, { tls: true });
    const ca = readFileSync(join(secure.directory, "certificate.pem"));
    await expect(secure.transport.list()).rejects.toThrow("unavailable");
    const trusted = externalAnchorHttp({ url: secure.url, token: secure.token, certificateAuthority: ca });
    await expect(trusted.list()).resolves.toEqual([]);
    await publishExternalAnchors(s.journal, s.log, trusted, s.key.publicKeyBytes());
    expect((await verifyExternalAudit(s.journal, trusted, s.key.publicKeyBytes())).state).toBe("verified");
    const wrongName = await service(s.key, { tls: true, certificateIp: "127.0.0.2" });
    const wrongCa = readFileSync(join(wrongName.directory, "certificate.pem"));
    await expect(externalAnchorHttp({ url: wrongName.url, token: wrongName.token, certificateAuthority: wrongCa }).list()).rejects.toThrow("unavailable");
  });

  test("real socket cancellation and deadlines stop an unavailable endpoint without leaking response secrets", async () => {
    const s = source(1); const hanging = await service(s.key, { mode: "hang" });
    const controller = new AbortController();
    const remote = externalAnchorHttp({ url: hanging.url, token: hanging.token, signal: controller.signal });
    const request = remote.list(); setTimeout(() => controller.abort(), 30);
    await expect(request).rejects.toThrow("unavailable");
    await expect(externalAnchorHttp({ url: hanging.url, token: hanging.token, timeoutMs: 30 }).list()).rejects.toThrow("unavailable");
    const errorServer = await service(s.key, { mode: "error" });
    try { await errorServer.transport.list(); throw new Error("expected unavailable"); }
    catch (error) { expect(String(error)).not.toContain(errorServer.token); expect(String(error)).toContain("unavailable"); }
  });

  test("bounded responses and cursor cycles are unavailable evidence, not a false tamper verdict", async () => {
    const s = source(1);
    for (const mode of ["large", "cycle"]) {
      const remote = await service(s.key, { mode });
      if (mode === "cycle") new AnchorLog(join(remote.directory, "external-anchors.jsonl")).append(s.log.list()[0]!);
      expect(await verifyExternalAudit(s.journal, remote.transport, s.key.publicKeyBytes())).toEqual({ state: "unavailable", reason: "transport" });
    }
  });

  test("ATTACK: unsafe endpoints, credentials, alias HTTP and private DNS answers are refused without raw secrets in errors", async () => {
    const token = "private-fixture-token";
    for (const url of ["http://localhost/anchors", "http://10.0.0.1/anchors", "https://169.254.169.254/anchors", "https://user:password@example.com/anchors", "https://example.com/anchors?token=x", "https://example.com/#x", "http://[::ffff:127.0.0.1]/anchors", "https://[2001::1]/anchors", "https://[3fff::1]/anchors"]) {
      expect(() => externalAnchorHttp({ url, token })).toThrow("unavailable");
    }
    for (const addresses of [["127.0.0.1"], ["2001::1"], ["1.1.1.1", "192.168.1.1"]]) {
      const remote = externalAnchorHttp({ url: "https://audit.example.invalid/anchors", token, resolve: async () => addresses });
      await expect(remote.list()).rejects.toThrow("unavailable");
    }
  });
});
