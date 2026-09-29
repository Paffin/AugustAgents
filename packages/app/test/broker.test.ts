import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, FileStore, KeychainStore, SecretBroker, SecretDeliveryError, SecretError, SecretServiceStore, defaultConfig, parseConfig, scopedSecretName, type DeliveryContext, type Runner } from "../src/index.ts";

// Suite category: Safety/security invariant (REQ-SEC-003 scoped secret brokering; secrets never reach a capability that is not contained).
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const store = () => { const d = mkdtempSync(join(tmpdir(), "august-broker-")); dirs.push(d); return new FileStore(d); };
const ctx = (over: Partial<DeliveryContext> = {}): DeliveryContext => ({ capability: "notion", trust: "community", artifactVerified: true, sandboxed: true, egress: "allowlist", ...over });

describe("scoped secret names", () => {
  test("a capability id and a NAME form one unambiguous key; ids cannot smuggle a dot", () => {
    expect(scopedSecretName("notion", "API_KEY")).toBe("notion.API_KEY");
    expect(scopedSecretName("my-tool_2", "TOKEN")).toBe("my-tool_2.TOKEN");
    for (const [id, name] of [["a.b", "X"], ["", "X"], ["notion", "lower"], ["notion", "A.B"], ["no tion", "X"]] as const) expect(() => scopedSecretName(id, name)).toThrow(SecretError);
  });

  test("every store accepts scoped names and keeps them apart from global ones", () => {
    const s = store(); s.set("OPENAI_API_KEY", "global"); s.set("notion.OPENAI_API_KEY", "scoped");
    expect(s.get("OPENAI_API_KEY")).toBe("global"); expect(s.get("notion.OPENAI_API_KEY")).toBe("scoped");
    expect(s.list()).toEqual(["OPENAI_API_KEY", "notion.OPENAI_API_KEY"]);
    expect(() => s.set("not valid", "x")).toThrow(SecretError);
    const calls: string[][] = []; const run: Runner = (cmd, args) => (calls.push([cmd, ...args]), { status: 0, stdout: "v\n" });
    const dir = mkdtempSync(join(tmpdir(), "august-broker-")); dirs.push(dir);
    expect(new KeychainStore(dir, run).get("notion.TOKEN")).toBe("v");
    expect(new SecretServiceStore(dir, run).get("notion.TOKEN")).toBe("v");
    expect(calls.flat()).toContain("notion.TOKEN");
    expect(() => new KeychainStore(dir, run).get("bad name")).toThrow(SecretError);
  });
});

describe("SecretBroker", () => {
  test("a community capability must be verified, sandboxed and unable to reach any host, and every unmet condition is named", () => {
    const b = new SecretBroker(store(), {});
    expect(b.blockers(ctx())).toEqual([]);
    expect(b.blockers(ctx({ artifactVerified: false }))).toEqual(["its artifact is not verified"]);
    expect(b.blockers(ctx({ sandboxed: false }))).toEqual(["it does not run in a sandbox"]);
    expect(b.blockers(ctx({ egress: "open" }))).toEqual(["it can reach any host"]);
    expect(b.blockers(ctx({ egress: "none" }))).toEqual([]);
    expect(b.blockers(ctx({ artifactVerified: false, sandboxed: false, egress: "open" }))).toHaveLength(3);
    expect(b.blockers(ctx({ trust: "known", artifactVerified: false, sandboxed: false, egress: "open" }))).toEqual([]);
  });

  test("delivery reads only the capability's own namespace: not the same name globally, not the shell environment", () => {
    const s = store(); s.set("OPENAI_API_KEY", "sk-global"); s.set("GITHUB_TOKEN", "ghp-global"); s.set("notion.API_KEY", "notion-secret");
    const b = new SecretBroker(s, { OPENAI_API_KEY: "sk-shell", AWS_SECRET_ACCESS_KEY: "aws" });
    expect(b.deliver(ctx(), ["API_KEY"])).toEqual({ API_KEY: "notion-secret" });
    for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"]) {
      expect(() => b.deliver(ctx(), [name])).toThrow(new RegExp(`${name} is not set for "notion" \\(august secret set --for notion ${name}\\)`));
      expect(b.missing(ctx(), [name])).toEqual([name]);
    }
    // Another capability cannot see notion's secret.
    expect(b.missing(ctx({ capability: "slack" }), ["API_KEY"])).toEqual(["API_KEY"]);
  });

  test("an uncontained community capability is refused before any secret is read", () => {
    let reads = 0; const spy = { kind: "file" as const, get: () => (reads++, "v"), set() {}, delete: () => true, list: () => [] };
    const b = new SecretBroker(spy, {});
    for (const bad of [ctx({ sandboxed: false }), ctx({ artifactVerified: false }), ctx({ egress: "open" })]) {
      const e = (() => { try { b.deliver(bad, ["API_KEY"]); } catch (error) { return error as SecretDeliveryError; } })();
      expect(e).toBeInstanceOf(SecretDeliveryError); expect(e!.reasons.length).toBeGreaterThan(0); expect(e!.message).toContain('"notion" cannot receive secrets');
    }
    expect(reads).toBe(0);
    expect(b.deliver(ctx({ egress: "none" }), [])).toEqual({}); expect(reads).toBe(0);
  });

  test("a capability the owner configured by hand keeps the owner's decision, including the global secrets it names", () => {
    const s = store(); s.set("GITHUB_TOKEN", "ghp-global");
    const b = new SecretBroker(s, { SHELL_ONLY: "from-shell" });
    const owner = ctx({ capability: "gh", trust: "known", sandboxed: false, egress: "open", artifactVerified: false });
    expect(b.deliver(owner, ["GITHUB_TOKEN", "SHELL_ONLY"])).toEqual({ GITHUB_TOKEN: "ghp-global", SHELL_ONLY: "from-shell" });
    s.set("gh.GITHUB_TOKEN", "scoped-wins"); expect(b.deliver(owner, ["GITHUB_TOKEN"])).toEqual({ GITHUB_TOKEN: "scoped-wins" });
  });

  test("set stores in the capability's namespace, and redaction lists exactly what could be handed out", () => {
    const s = store(); const b = new SecretBroker(s, {});
    b.set("notion", "API_KEY", "n-secret"); expect(s.get("notion.API_KEY")).toBe("n-secret"); expect(s.get("API_KEY")).toBeUndefined();
    expect(b.redactionValues(ctx(), ["API_KEY", "OTHER"])).toEqual(["n-secret"]);
    expect(() => new SecretBroker(undefined, {}).set("notion", "API_KEY", "x")).toThrow(/no secret store/);
  });
});

describe("mcp config: containment fields", () => {
  const base = defaultConfig("/h");
  const parse = (entry: object) => parseConfig({ ...base, mcp: [{ id: "a", command: "x", ...entry }] });
  const pin = { registry: "npm", name: "p", version: "1.0.0", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, treeSha256: "a".repeat(64), signature: "npm-registry-ecdsa", entry: { runtime: "node", file: "node_modules/p/bin.js" }, verifiedAt: "2026-01-01T00:00:00.000Z" };

  test("egress lists hosts, excludes network:true, and a server has exactly one source", () => {
    expect(parse({ egress: ["api.example.com", "*.cdn.example.org", "db.example.net:5432"] }).mcp[0]!.egress).toHaveLength(3);
    for (const bad of [[], ["https://x.com"], ["x.com/path"], ["*x.com"], ["a b"], [1], "api.example.com", ["x.com:notaport"]]) expect(() => parse({ egress: bad })).toThrow(ConfigError);
    expect(() => parse({ egress: ["x.com"], network: true })).toThrow(/exclude each other/);
    expect(() => parse({ egress: ["x.com"], network: false })).not.toThrow();
    expect(() => parseConfig({ ...base, mcp: [{ id: "a" }] })).toThrow(/exactly one of command, url or artifact/);
    expect(() => parseConfig({ ...base, mcp: [{ id: "a", command: "x", url: "https://x.test" }] })).toThrow(/exactly one/);
  });

  test("an artifact pin is validated field by field, and a pinned server needs no command", () => {
    const ok = parseConfig({ ...base, mcp: [{ id: "a", artifact: pin }] }); expect(ok.mcp[0]!.artifact).toEqual(pin as never);
    const bad = (over: object) => () => parseConfig({ ...base, mcp: [{ id: "a", artifact: { ...pin, ...over } }] });
    expect(bad({ registry: "cargo" })).toThrow(/registry/); expect(bad({ integrity: "sha1-abc" })).toThrow(/integrity/); expect(bad({ treeSha256: "xyz" })).toThrow(/treeSha256/);
    expect(bad({ signature: "trust-me" })).toThrow(/signature/); expect(bad({ name: "" })).toThrow(/name/);
    for (const file of ["/etc/passwd", "../x", "a/../../x", ""]) expect(bad({ entry: { runtime: "node", file } })).toThrow(/entry/);
    expect(bad({ entry: { runtime: "perl", file: "x" } })).toThrow(/entry/);
    expect(() => parseConfig({ ...base, mcp: [{ id: "a", artifact: "nope" }] })).toThrow(/artifact/);
  });

  test("the package registry must be https (or localhost)", () => {
    expect(parseConfig({ ...base, npmRegistryUrl: "https://npm.internal.example/" }).npmRegistryUrl).toBe("https://npm.internal.example");
    expect(parseConfig({ ...base, npmRegistryUrl: "http://127.0.0.1:4873" }).npmRegistryUrl).toBe("http://127.0.0.1:4873");
    expect(() => parseConfig({ ...base, npmRegistryUrl: "http://npm.example.com" })).toThrow(ConfigError);
    expect(parseConfig(base)).not.toHaveProperty("npmRegistryUrl");
  });
});
