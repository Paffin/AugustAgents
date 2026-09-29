import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider } from "@august/brain";
import {
  BuiltinExecutor,
  ConfigError,
  MAX_READ_BYTES,
  PathEscapeError,
  createApp,
  defaultConfig,
  defaultConfigPath,
  loadConfig,
  main,
  parseConfig,
  resolveInside,
  writeConfig,
  type CliIo,
} from "../src/index.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "august-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("config", () => {
  const good = () => defaultConfig("/home/u");

  test("the default config is valid and gets a fresh token each time", () => {
    expect(() => parseConfig(good())).not.toThrow();
    expect(good().gateway.token).not.toBe(good().gateway.token);
  });

  test("refuses a key-looking apiKeyEnv, a short token and a bad port", () => {
    expect(() => parseConfig({ ...good(), llm: { ...good().llm, apiKeyEnv: "sk-abc123" } })).toThrow(/environment variable name/);
    expect(() => parseConfig({ ...good(), gateway: { port: 1, token: "short" } })).toThrow(/16/);
    expect(() => parseConfig({ ...good(), gateway: { port: 70000, token: "x".repeat(20) } })).toThrow(/port/);
  });

  test("refuses plain http to a remote host but allows localhost", () => {
    expect(() => parseConfig({ ...good(), llm: { ...good().llm, baseUrl: "http://llm.example.com/v1" } })).toThrow(/https/);
    expect(() => parseConfig({ ...good(), llm: { ...good().llm, baseUrl: "http://localhost:11434/v1" } })).not.toThrow();
  });

  test("refuses a workspace name that would break session keys", () => {
    expect(() => parseConfig({ ...good(), workspace: "a:b" })).toThrow(ConfigError);
  });

  test("the file is private and round-trips", () => {
    const home = tmp();
    const path = defaultConfigPath(home);
    const cfg = defaultConfig(home);
    writeConfig(path, cfg);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(path)).toEqual({ ...cfg, llm: { ...cfg.llm } });
  });

  test("a missing or broken file gives a helpful error", () => {
    const home = tmp();
    expect(() => loadConfig(join(home, "nope.json"))).toThrow(/august init/);
    writeFileSync(join(home, "bad.json"), "{");
    expect(() => loadConfig(join(home, "bad.json"))).toThrow(/not valid JSON/);
  });
});

describe("built-in file tools", () => {
  function setup() {
    const base = tmp();
    const root = join(base, "root");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "hello");
    writeFileSync(join(base, "outside.txt"), "secret");
    return { base, root, ex: new BuiltinExecutor(root) };
  }

  test("reads and lists inside the root", async () => {
    const { ex } = setup();
    expect(await ex.call("fs.read", { path: "a.txt" })).toEqual({ content: "hello" });
    expect((await ex.call("fs.list", {})).content.split("\n")).toEqual(["a.txt", "sub/"]);
  });

  test("blocks ../ and absolute paths and never leaks the host path", async () => {
    const { base, ex } = setup();
    for (const path of ["../outside.txt", join(base, "outside.txt"), "sub/../../outside.txt"]) {
      const r = await ex.call("fs.read", { path });
      expect(r.isError).toBe(true);
      expect(r.content).not.toContain("secret");
      expect(r.content).not.toContain(base);
    }
  });

  test("a symlink cannot lead out of the root", async () => {
    const { base, root, ex } = setup();
    symlinkSync(join(base, "outside.txt"), join(root, "link.txt"));
    symlinkSync(base, join(root, "linkdir"));
    expect((await ex.call("fs.read", { path: "link.txt" })).isError).toBe(true);
    expect((await ex.call("fs.list", { path: "linkdir" })).isError).toBe(true);
    expect(() => resolveInside(root, "link.txt")).toThrow(PathEscapeError);
  });

  test("a sibling folder with the same prefix is outside", () => {
    const { base, root } = setup();
    mkdirSync(join(base, "root-evil"));
    expect(() => resolveInside(root, "../root-evil")).toThrow(PathEscapeError);
  });

  test("big files and directories are refused, unknown tools error", async () => {
    const { root, ex } = setup();
    writeFileSync(join(root, "big.bin"), "x".repeat(MAX_READ_BYTES + 1));
    expect((await ex.call("fs.read", { path: "big.bin" })).isError).toBe(true);
    expect((await ex.call("fs.read", { path: "sub" })).isError).toBe(true);
    expect((await ex.call("fs.read", { path: "missing.txt" })).isError).toBe(true);
    expect((await ex.call("nope.tool", {})).isError).toBe(true);
  });

  test("clock.now uses the injected clock", async () => {
    const ex = new BuiltinExecutor(tmp(), () => new Date("2026-09-29T12:00:00Z"));
    expect((await ex.call("clock.now", {})).content).toBe("2026-09-29T12:00:00.000Z");
  });
});

/** Answers by schema name: which tool, which arguments, the final text. */
function scriptedLlm(plan: { tool: string; args: Record<string, unknown>; reply: string }): LlmProvider {
  return {
    name: "scripted",
    async complete(messages, options) {
      const name = options?.jsonSchema?.name;
      // Pick the tool until a result is in the state, then say none.
      if (name === "decision") return JSON.stringify({ choice: messages.some((m) => m.content.includes("Result of")) ? "none" : plan.tool });
      if (name === "arguments") return JSON.stringify(plan.args);
      return plan.reply;
    },
  };
}

function makeIo(home: string, answers: Array<string | null> = [], llm?: LlmProvider) {
  const out: string[] = [];
  const prompts: string[] = [];
  const io: CliIo = {
    print: (l) => void out.push(l),
    ask: async (p) => (prompts.push(p), answers.length ? answers.shift()! : null),
    env: { OPENAI_API_KEY: "sk-test" },
    home,
    llm,
  };
  return { io, out, prompts };
}

describe("cli", () => {
  test("help lists the commands; an unknown command fails", async () => {
    const { io, out } = makeIo(tmp());
    expect((await main([], io)).code).toBe(0);
    expect(out.join("\n")).toContain("august chat");
    expect((await main(["bogus"], io)).code).toBe(1);
  });

  test("init creates config, folder and welcome note, and won't overwrite without --force", async () => {
    const home = tmp();
    const { io, out } = makeIo(home);
    expect((await main(["init"], io)).code).toBe(0);
    const cfg = loadConfig(defaultConfigPath(home));
    expect(readFileSync(join(cfg.root, "welcome.md"), "utf8")).toContain("Welcome");
    expect(out.join("\n")).toContain("OPENAI_API_KEY");
    const token = cfg.gateway.token;
    expect((await main(["init"], io)).code).toBe(1);
    expect(loadConfig(defaultConfigPath(home)).gateway.token).toBe(token);
    expect((await main(["init", "--force"], io)).code).toBe(0);
    expect(loadConfig(defaultConfigPath(home)).gateway.token).not.toBe(token);
  });

  test("chat before init explains what to do", async () => {
    const { io, out } = makeIo(tmp());
    expect((await main(["chat"], io)).code).toBe(1);
    expect(out.join("\n")).toContain("august init");
  });

  test("chat answers from a file, end to end, and journals the task", async () => {
    const home = tmp();
    const llm = scriptedLlm({ tool: "fs.read", args: { path: "welcome.md" }, reply: "It says Welcome." });
    const { io, out } = makeIo(home, ["what is in welcome.md? read the file", "exit"], llm);
    await main(["init"], io);
    expect((await main(["chat"], io)).code).toBe(0);
    expect(out).toContain("It says Welcome.");
    const cfg = loadConfig(defaultConfigPath(home));
    const decisions = readFileSync(join(cfg.dataDir, "decisions.jsonl"), "utf8");
    expect(decisions).not.toBe("");
  });

  test("chat ends cleanly when input ends", async () => {
    const home = tmp();
    const { io } = makeIo(home, [null]);
    await main(["init"], io);
    expect((await main(["chat"], io)).code).toBe(0);
  });

  test("serve starts a loopback gateway that needs the token", async () => {
    const home = tmp();
    const { io } = makeIo(home, [], scriptedLlm({ tool: "none", args: {}, reply: "hi from gateway" }));
    await main(["init"], io);
    const cfg = loadConfig(defaultConfigPath(home));
    const port = 21000 + Math.floor(Math.random() * 20000);
    writeConfig(defaultConfigPath(home), { ...cfg, gateway: { ...cfg.gateway, port } });
    const r = await main(["serve"], io);
    try {
      const url = `http://127.0.0.1:${port}/v1/message`;
      const body = JSON.stringify({ channel: "web", user: "dan", text: "hello" });
      const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(denied.status).toBe(401);
      const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.gateway.token}` }, body });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ reply: "hi from gateway" });
    } finally {
      r.gateway?.stop();
    }
  });
});

describe("createApp", () => {
  test("asks for the API key by name when it is missing, without echoing anything else", () => {
    const home = tmp();
    const cfg = defaultConfig(home);
    expect(() => createApp(cfg, { env: {} })).toThrow(/OPENAI_API_KEY/);
  });

  test("a local model needs no key", () => {
    const home = tmp();
    const cfg = { ...defaultConfig(home), llm: { baseUrl: "http://localhost:11434/v1", model: "qwen", apiKeyEnv: "OPENAI_API_KEY" } };
    expect(() => createApp(cfg, { env: {} })).not.toThrow();
  });

  test("starts in shadow mode with the built-in tools installed", () => {
    const home = tmp();
    const app = createApp(defaultConfig(home), { env: { OPENAI_API_KEY: "k" } });
    expect(app.cascade.shadowMode).toBe(true);
    expect(app.registry.enabledTools().map((t) => t.name).sort()).toEqual(["clock.now", "fs.list", "fs.read"]);
  });
});

describe("mcp servers from the config", () => {
  const FAKE = join(import.meta.dir, "../../mcp/test/fake-server.ts");
  const server = (over: object = {}) => ({ id: "fake", command: process.execPath, args: [FAKE], env: { FAKE_MODE: "normal" }, ...over });
  const withMcp = (home: string, mcp: unknown) => ({ ...defaultConfig(home), mcp }) as never;

  test("validates ids, duplicates, env names and trust", () => {
    const base = defaultConfig("/h");
    const bad = (mcp: unknown) => () => parseConfig({ ...base, mcp });
    expect(bad([{ id: "a.b", command: "x" }])).toThrow(/id/);
    expect(bad([{ id: "a", command: "x" }, { id: "a", command: "y" }])).toThrow(/twice/);
    expect(bad([{ id: "a", command: "x", envFrom: ["sk-123"] }])).toThrow(/environment variable names/);
    expect(bad([{ id: "a", command: "x", trust: "verified" }])).toThrow(/trust/);
    expect(bad([{ id: "a" }])).toThrow(/command/);
    expect(bad("nope")).toThrow(/list/);
    expect(() => parseConfig({ ...base, mcp: [{ id: "a", command: "x", trust: "known" }] })).not.toThrow();
  });

  test("a config without mcp still loads", () => {
    const { mcp: _drop, ...old } = defaultConfig("/h");
    expect(parseConfig(old).mcp).toEqual([]);
  });

  test("starts servers, reports failures, and one failure does not stop the rest", async () => {
    const home = tmp();
    const cfg = parseConfig(withMcp(home, [server(), server({ id: "broken", command: "/no/such/binary" }), server({ id: "needs", envFrom: ["MISSING_KEY"] })]));
    const app = createApp(cfg, { env: { OPENAI_API_KEY: "k", PATH: process.env.PATH }, llm: scriptedLlm({ tool: "none", args: {}, reply: "" }) });
    try {
      const r = await app.startServers();
      expect(r.started).toEqual(["fake"]);
      expect(r.failed.map((f) => f.id).sort()).toEqual(["broken", "needs"]);
      expect(r.failed.find((f) => f.id === "needs")!.error).toContain("MISSING_KEY is not set");
      expect(app.registry.enabledTools().map((t) => t.name)).toContain("fake.echo");
    } finally {
      app.mcp.closeAll();
    }
  });

  test("chat uses an MCP tool, but asks first because a community server may reach the network", async () => {
    const home = tmp();
    const llm = scriptedLlm({ tool: "fake.echo", args: { text: "pong" }, reply: "The server said pong." });
    const { io, out, prompts } = makeIo(home, ["echo pong with the fake server", "n", "echo pong with the fake server", "y", "exit"], llm);
    await main(["init"], io);
    const path = defaultConfigPath(home);
    const cfg = loadConfig(path);
    writeConfig(path, parseConfig({ ...cfg, mcp: [server()] }));
    io.env = { ...io.env, PATH: process.env.PATH };
    await main(["chat"], io);
    expect(out).toContain("Tools from: fake");
    expect(prompts.filter((p) => p.includes("Allow once?"))).toHaveLength(2);
    expect(out.some((l) => l.includes("was not approved"))).toBe(true);
    expect(out).toContain("The server said pong.");
  });
});
