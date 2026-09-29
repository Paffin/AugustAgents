import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider } from "@august/brain";
import { CapabilityRegistry } from "@august/capabilities";
import { makeSessionKey } from "@august/core";
import { RegistryClient } from "@august/discovery";
import {
  FileStore,
  KeychainStore,
  MetaExecutor,
  SecretServiceStore,
  createApp,
  defaultConfig,
  defaultConfigPath,
  loadConfig,
  main,
  openSecretStore,
  resolveSecret,
  writeConfig,
  type CliIo,
  type Runner,
} from "../src/index.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "august-f-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeIo(home: string, answers: Array<string | null> = [], extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const io: CliIo = {
    print: (l) => void out.push(l),
    ask: async () => (answers.length ? answers.shift()! : null),
    env: {},
    home,
    sandboxKind: "none",
    secrets: new FileStore(join(home, ".august")),
    ...extra,
  };
  return { io, out };
}

describe("secret stores", () => {
  test("file store: owner-only file, set/get/list/delete, name rules", () => {
    const dir = tmp();
    const s = new FileStore(dir);
    s.set("OPENAI_API_KEY", "sk-1");
    expect(s.get("OPENAI_API_KEY")).toBe("sk-1");
    expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
    expect(s.list()).toEqual(["OPENAI_API_KEY"]);
    expect(s.delete("OPENAI_API_KEY")).toBe(true);
    expect(s.delete("OPENAI_API_KEY")).toBe(false);
    expect(() => s.set("sk-not-a-name", "x")).toThrow(/names look like/);
  });

  test("secret-service passes the value on stdin, never in argv", () => {
    const calls: Array<{ cmd: string; args: readonly string[]; input?: string }> = [];
    const run: Runner = (cmd, args, input) => {
      calls.push({ cmd, args, input });
      return { status: 0, stdout: args[0] === "lookup" ? "tok\n" : "" };
    };
    const s = new SecretServiceStore(tmp(), run);
    s.set("GITHUB_TOKEN", "ghp_secret");
    expect(calls[0]!.args.join(" ")).not.toContain("ghp_secret");
    expect(calls[0]!.input).toBe("ghp_secret");
    expect(s.get("GITHUB_TOKEN")).toBe("tok");
    expect(s.list()).toEqual(["GITHUB_TOKEN"]);
  });

  test("keychain store talks to security and keeps a name index", () => {
    const calls: string[][] = [];
    const run: Runner = (_c, args) => (calls.push([...args]), { status: args[0] === "find-generic-password" ? 44 : 0, stdout: "" });
    const s = new KeychainStore(tmp(), run);
    s.set("A_KEY", "v");
    expect(calls[0]!.slice(0, 5)).toEqual(["add-generic-password", "-U", "-s", "august", "-a"]);
    expect(s.get("A_KEY")).toBeUndefined();
    expect(s.list()).toEqual(["A_KEY"]);
  });

  test("picks the OS store when present, else the file", () => {
    const yes: Runner = () => ({ status: 0, stdout: "" });
    expect(openSecretStore(tmp(), { platform: "darwin", run: yes }).kind).toBe("keychain");
    expect(openSecretStore(tmp(), { platform: "linux", run: yes, env: { DBUS_SESSION_BUS_ADDRESS: "x" } }).kind).toBe("secret-service");
    expect(openSecretStore(tmp(), { platform: "linux", run: yes, env: {} }).kind).toBe("file");
  });

  test("the store wins over the environment", () => {
    const s = new FileStore(tmp());
    s.set("K", "from-store");
    expect(resolveSecret("K", s, { K: "from-env" })).toBe("from-store");
    expect(resolveSecret("OTHER", s, { OTHER: "env" })).toBe("env");
  });
});

describe("august setup (three questions)", () => {
  test("OpenAI: key goes to the store, never into the config file", async () => {
    const home = tmp();
    const { io, out } = makeIo(home, ["1", "", "sk-live-abc", "1"]);
    expect((await main(["setup"], io)).code).toBe(0);
    const raw = readFileSync(defaultConfigPath(home), "utf8");
    expect(raw).not.toContain("sk-live-abc");
    expect(io.secrets!.get("OPENAI_API_KEY")).toBe("sk-live-abc");
    expect(loadConfig(defaultConfigPath(home)).llm.baseUrl).toBe("https://api.openai.com/v1");
    expect(out.join("\n")).toContain("august chat");
  });

  test("Ollama needs no key; Telegram needs token and user id", async () => {
    const home = tmp();
    const { io } = makeIo(home, ["3", "llama3.2", "2", "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc", "777"]);
    expect((await main(["setup"], io)).code).toBe(0);
    const cfg = loadConfig(defaultConfigPath(home));
    expect(cfg.llm).toMatchObject({ baseUrl: "http://localhost:11434/v1", model: "llama3.2", apiKeyEnv: undefined, pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 } });
    expect(cfg.channels.telegram).toEqual({ tokenSecret: "TELEGRAM_BOT_TOKEN", allowedUsers: [777] });
    expect(io.secrets!.get("TELEGRAM_BOT_TOKEN")).toContain("123456:");
  });

  test("custom remote setup records explicit token pricing", async () => {
    const home = tmp(); const { io } = makeIo(home, ["4", "https://llm.example/v1", "100000/400000", "custom-model", "key", "1"]); expect((await main(["setup"], io)).code).toBe(0); expect(loadConfig(defaultConfigPath(home)).llm.pricing).toMatchObject({ inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 400_000, source: "https://llm.example/v1" });
  });

  test("stops cleanly when the person gives up or omits a required key", async () => {
    expect((await main(["setup"], makeIo(tmp(), [null]).io)).code).toBe(1);
    expect((await main(["setup"], makeIo(tmp(), ["1", "", ""]).io)).code).toBe(1);
    expect((await main(["setup"], makeIo(tmp(), ["1", "", "k", "2", "tok", "not-a-number"]).io)).code).toBe(1);
  });
});

describe("secret, mcp, laya, calibrate, doctor commands", () => {
  test("secret set/list/rm", async () => {
    const home = tmp();
    const { io, out } = makeIo(home, ["v1"]);
    expect((await main(["secret", "set", "MY_TOKEN"], io)).code).toBe(0);
    await main(["secret", "list"], io);
    expect(out).toContain("MY_TOKEN");
    expect(out.join("\n")).not.toContain("v1");
    await main(["secret", "rm", "MY_TOKEN"], io);
    expect(io.secrets!.get("MY_TOKEN")).toBeUndefined();
    expect((await main(["secret", "set", "bad-name"], io)).code).toBe(1);
  });

  test("mcp list and rm edit the config", async () => {
    const home = tmp();
    const { io, out } = makeIo(home);
    await main(["init"], io);
    const path = defaultConfigPath(home);
    writeConfig(path, { ...loadConfig(path), mcp: [{ id: "gh", command: "npx", args: ["-y", "x@1"] }] });
    await main(["mcp", "list"], io);
    expect(out.some((l) => l.startsWith("gh  npx -y x@1"))).toBe(true);
    expect((await main(["mcp", "rm", "gh"], io)).code).toBe(0);
    expect(loadConfig(path).mcp).toEqual([]);
    expect((await main(["mcp", "rm", "gh"], io)).code).toBe(1);
  });

  test("laya status/activate follow the shadow statistics", async () => {
    const home = tmp();
    const { io, out } = makeIo(home);
    await main(["init"], io);
    const path = defaultConfigPath(home);
    const cfg = loadConfig(path);
    expect((await main(["laya", "activate"], io)).code).toBe(1);
    writeConfig(path, { ...cfg, laya: { url: "http://127.0.0.1:7788" } });
    expect((await main(["laya", "activate"], io)).code).toBe(1);
    writeFileSync(join(cfg.dataDir, "cascade.json"), JSON.stringify({ shadowSamples: 250, shadowAgreements: 240 }));
    await main(["laya", "status"], io);
    expect(out.join("\n")).toContain("Ready to activate");
    expect((await main(["laya", "activate"], io)).code).toBe(0);
    expect(loadConfig(path).laya?.shadow).toBe(false);
  });

  test("calibrate fits a temperature from the decision log", async () => {
    const home = tmp();
    const { io, out } = makeIo(home);
    await main(["init"], io);
    const path = defaultConfigPath(home);
    const cfg = loadConfig(path);
    expect((await main(["calibrate"], io)).code).toBe(1);
    const options = [{ key: "a", description: "" }, { key: "none", description: "" }];
    const lines = Array.from({ length: 80 }, (_, i) => JSON.stringify({ options, primaryProbs: [0.99, 0.01], fallbackChoice: i < 48 ? "a" : "none" }));
    writeFileSync(join(cfg.dataDir, "decisions.jsonl"), `${lines.join("\n")}\nnot json\n`);
    writeConfig(path, { ...cfg, laya: { url: "http://127.0.0.1:7788" } });
    expect((await main(["calibrate"], io)).code).toBe(0);
    expect(loadConfig(path).laya!.temperature!).toBeGreaterThan(1);
    expect(out.join("\n")).toContain("Samples: 80");
  });

  test("doctor reports missing keys and secrets, and passes when fixed", async () => {
    const home = tmp();
    const { io, out } = makeIo(home);
    expect((await main(["doctor"], io)).code).toBe(1);
    await main(["init"], io);
    const path = defaultConfigPath(home);
    writeConfig(path, { ...loadConfig(path), mcp: [{ id: "gh", command: "npx", envFrom: ["GITHUB_TOKEN"] }] });
    out.length = 0;
    expect((await main(["doctor"], io)).code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("august secret set OPENAI_API_KEY");
    expect(text).toContain('MCP "gh" needs: GITHUB_TOKEN');
    expect(text).toContain("No sandbox");
    io.secrets!.set("OPENAI_API_KEY", "k");
    io.secrets!.set("GITHUB_TOKEN", "t");
    out.length = 0;
    expect((await main(["doctor"], io)).code).toBe(0);
    expect(out.at(-1)).toBe("All good.");
  });
});

/** Picks tools by what the state already contains, then answers. */
function planLlm(steps: Array<{ tool: string; args: Record<string, unknown> }>, reply = "done"): LlmProvider {
  return {
    name: "plan",
    async complete(messages, options) {
      await options?.onUsage?.({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
      const all = messages.map((m) => m.content).join("\n");
      const done = (all.match(/Result of /g) ?? []).length;
      if (options?.jsonSchema?.name === "decision") return JSON.stringify({ choice: steps[done]?.tool ?? "none" });
      if (options?.jsonSchema?.name === "arguments") {
        const tool = /"([a-z_]+\.[a-z_-]+)"/.exec(messages[0]!.content)![1];
        return JSON.stringify(steps.find((s) => s.tool === tool)!.args);
      }
      if (options?.maxTokens === 40) return "search install";
      return reply;
    },
  };
}

const registryReply = {
  servers: [
    {
      server: {
        name: "io.github.acme/weather",
        description: "Weather forecasts",
        version: "2.0.0",
        packages: [{ registryType: "npm", identifier: "@acme/weather-mcp", version: "2.0.0", environmentVariables: [{ name: "WEATHER_KEY", isSecret: true }] }],
      },
    },
  ],
};

function registryFetch(extra: Record<string, string> = {}): typeof fetch {
  return (async (url: string) => {
    for (const [prefix, body] of Object.entries(extra)) if (url.startsWith(prefix)) return new Response(body);
    if (url.includes("/v0/servers")) return new Response(JSON.stringify(registryReply));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("finding and installing capabilities", () => {
  // Product behavior: a Prepared Install Plan is the exact single-use contract
  // shared by search, approval preview, and installation.
  test("MetaExecutor: search shows how each server would run; install persists through addServer", async () => {
    const added: unknown[] = [];
    let registryCalls = 0;
    const fetch = registryFetch();
    const meta = new MetaExecutor({
      registry: new CapabilityRegistry(),
      registryClient: new RegistryClient("https://reg.example", (async (...args) => {
        registryCalls += 1;
        return fetch(...args);
      }) as typeof fetch),
      skillsDir: tmp(),
      takenIds: () => new Set(),
      fallback: { call: async () => ({ content: "fallback" }) },
      addServer: async (entry) => (added.push(entry), "installed"),
    });
    const found = await meta.call("august.find_tools", { query: "weather" });
    expect(found.content).toContain("io.github.acme/weather@2.0.0");
    expect(found.content).toContain("npx -y @acme/weather-mcp@2.0.0");
    expect(found.content).toContain("needs WEATHER_KEY");
    expect(await meta.describeCall("august.install_tool", { name: "io.github.acme/weather" })).toContain("needs secrets: WEATHER_KEY");
    expect((await meta.call("august.install_tool", { name: "io.github.acme/weather" })).content).toBe("installed");
    expect(added).toEqual([{ id: "weather", command: "npx", args: ["-y", "@acme/weather-mcp@2.0.0"], envFrom: ["WEATHER_KEY"], trust: "community" }]);
    expect((await meta.call("august.install_tool", { name: "io.github.x/unknown" })).isError).toBe(true);
    expect(added).toHaveLength(1);
    expect(registryCalls).toBe(1);
    expect((await meta.call("clock.now", {})).content).toBe("fallback");
  });

  test("Safety/reliability invariant: a runtime-installed server secret is redacted from durable scratch", async () => {
    const home = tmp(); const store = new FileStore(join(home, ".august")); const config = { ...defaultConfig(home), registryUrl: "https://reg.example" }; const configPath = defaultConfigPath(home); writeConfig(configPath, config);
    const app = createApp(config, { env: {}, home, secrets: store, fetch: registryFetch(), llm: planLlm([{ tool: "clock.now", args: {} }]), sandboxKind: "none", configPath });
    await app.meta.call("august.find_tools", { query: "weather" }); expect((await app.meta.call("august.install_tool", { name: "io.github.acme/weather" })).content).toContain("WEATHER_KEY");
    const secret = "tiny-secret"; store.set("WEATHER_KEY", secret); app.mcp.call = async () => ({ content: `safe weather ${secret}` });
    const reply = await app.handle(makeSessionKey({ workspace: "home", channel: "test", user: "redaction" }), "what time is it?"); const checkpoint = JSON.stringify(app.getRun(reply.runId)?.checkpoint);
    expect(checkpoint).toContain("safe weather"); expect(checkpoint).toContain("[redacted secret]"); expect(checkpoint).not.toContain(secret); app.close();
  });

  test("two app sessions cannot replace or both consume one prepared install plan", async () => {
    const home = tmp();
    let registryCalls = 0;
    const versions = ["2.0.0", "3.0.0"];
    const fetch = (async () => {
      const version = versions[Math.min(registryCalls++, versions.length - 1)]!;
      return new Response(JSON.stringify({
        servers: [{ server: { ...registryReply.servers[0]!.server, version, packages: [{ registryType: "npm", identifier: "@acme/weather-mcp", version, environmentVariables: [{ name: "WEATHER_KEY", isSecret: true }] }] } }],
      }));
    }) as unknown as typeof globalThis.fetch;
    const llm: LlmProvider = {
      name: "sessions",
      async complete(messages, options) {
        await options?.onUsage?.({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
        const all = messages.map((m) => m.content).join("\n");
        if (options?.jsonSchema?.name === "decision") {
          const tool = /Request: [^\n]*SEARCH/.test(all) ? "august.find_tools" : "august.install_tool";
          return JSON.stringify({ choice: all.includes("Result of ") ? "none" : tool });
        }
        if (options?.jsonSchema?.name === "arguments") {
          const tool = /"([a-z_]+\.[a-z_-]+)"/.exec(messages[0]!.content)![1];
          return JSON.stringify(tool === "august.find_tools" ? { query: "weather" } : { name: "io.github.acme/weather" });
        }
        if (options?.maxTokens === 40) return "weather";
        return "done";
      },
    };
    const config = { ...defaultConfig(home), registryUrl: "https://reg.example" };
    const configPath = defaultConfigPath(home);
    writeConfig(configPath, config);
    const app = createApp(config, { env: {}, home, llm, fetch, sandboxKind: "none", secrets: new FileStore(join(home, ".august")), configPath });
    const a = makeSessionKey({ workspace: "home", channel: "test", user: "a" });
    const b = makeSessionKey({ workspace: "home", channel: "test", user: "b" });
    await app.handle(a, "SEARCH A");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const previews: string[] = [];
    let firstReached!: () => void;
    let secondReached!: () => void;
    const reached = [new Promise<void>((resolve) => (firstReached = resolve)), new Promise<void>((resolve) => (secondReached = resolve))];
    const waitFor = (p: Promise<void>) => Promise.race([p, Bun.sleep(1000).then(() => { throw new Error("approval was not reached"); })]);
    const approver = { approve: async (r: { details?: string }) => { previews.push(r.details ?? ""); (previews.length === 1 ? firstReached : secondReached)(); await gate; return true; } };
    const first = app.handle(a, "INSTALL A", approver);
    await waitFor(reached[0]!);
    await app.handle(b, "SEARCH B");
    const second = app.handle(b, "INSTALL B", approver);
    await waitFor(reached[1]!);
    release();
    await Promise.all([first, second]);
    const installResults = app.journal.list().filter((e) => e.kind === "tool.result" && (e.data as { tool?: string }).tool === "august.install_tool");
    expect(previews.every((p) => p.includes("@2.0.0") && !p.includes("@3.0.0"))).toBe(true);
    expect(installResults.map((e) => (e.data as { failed: boolean }).failed).sort()).toEqual([false, true]);
    expect(loadConfig(configPath).mcp).toEqual([{ id: "weather", command: "npx", args: ["-y", "@acme/weather-mcp@2.0.0"], envFrom: ["WEATHER_KEY"], trust: "community" }]);
    expect(registryCalls).toBe(2);
    app.close();
  });

  test("end to end: the agent searches without asking, then asks before installing, and saves the server", async () => {
    const home = tmp();
    const llm = planLlm([
      { tool: "august.find_tools", args: { query: "weather" } },
      { tool: "august.install_tool", args: { name: "io.github.acme/weather" } },
    ]);
    const prompts: string[] = [];
    const { io, out } = makeIo(home, ["I need weather forecasts, find and install a tool", "y", "exit"], { llm, fetch: registryFetch(), env: { OPENAI_API_KEY: "k" } });
    const ask = io.ask;
    io.ask = async (p) => (prompts.push(p), ask(p));
    await main(["init"], io);
    const cfgPath = defaultConfigPath(home);
    writeConfig(cfgPath, { ...loadConfig(cfgPath), registryUrl: "https://reg.example" });
    await main(["chat"], io);
    expect(prompts.filter((p) => p.includes("Allow once?"))).toHaveLength(1);
    const text = out.join("\n");
    expect(text).toContain("august.install_tool wants to run");
    expect(text).toContain("install io.github.acme/weather@2.0.0: run npx -y @acme/weather-mcp@2.0.0");
    expect(loadConfig(cfgPath).mcp.map((s) => s.id)).toEqual(["weather"]);
  });

  test("installing a skill from GitHub makes a new skill tool", async () => {
    const home = tmp();
    const skill = "---\nname: trip-planner\ndescription: Plan trips step by step\n---\n\nAsk for dates, then budget.";
    const llm = planLlm([
      { tool: "august.install_skill", args: { url: "https://github.com/acme/skills/tree/main/trip-planner" } },
      { tool: "skill.trip-planner", args: {} },
    ], "Let's plan: dates first.");
    const { io, out } = makeIo(home, ["install the skill https://github.com/acme/skills/tree/main/trip-planner and use it", "y", "exit"], {
      llm,
      env: { OPENAI_API_KEY: "k" },
      fetch: registryFetch({ "https://raw.githubusercontent.com/acme/skills/main/trip-planner/SKILL.md": skill }),
    });
    await main(["init"], io);
    await main(["chat"], io);
    const cfg = loadConfig(defaultConfigPath(home));
    expect(existsSync(join(cfg.skillsDir, "trip-planner", "SKILL.md"))).toBe(true);
    expect(out.join("\n")).toContain('install skill "trip-planner"');
    expect(out).toContain("Let's plan: dates first.");
    out.length = 0;
    await main(["skills"], io);
    expect(out[0]).toBe("Skills: trip-planner");
  });
});

describe("august serve", () => {
  test("a busy port gives a clear message instead of a crash", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    try {
      const home = tmp();
      const { io, out } = makeIo(home, [], { env: { OPENAI_API_KEY: "k" } });
      await main(["init"], io);
      const path = defaultConfigPath(home);
      const cfg = loadConfig(path);
      writeConfig(path, { ...cfg, gateway: { ...cfg.gateway, port: blocker.port! } });
      expect((await main(["serve"], io)).code).toBe(1);
      expect(out.at(-1)).toContain("is busy");
    } finally {
      blocker.stop(true);
    }
  });

  test("serves the chat page and lets the browser approve through /v1/pending and /v1/approve", async () => {
    const home = tmp();
    const llm: LlmProvider = {
      name: "x",
      async complete(messages, options) {
        await options?.onUsage?.({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
        const all = messages.map((m) => m.content).join("\n");
        if (options?.jsonSchema?.name === "decision") return JSON.stringify({ choice: all.includes("Result of") ? "none" : "august.install_skill" });
        if (options?.jsonSchema?.name === "arguments") return JSON.stringify({ url: "https://github.com/acme/skills/tree/main/notes" });
        return all.includes("Installed skill") ? "installed" : "not installed";
      },
    };
    const skill = "---\nname: notes\ndescription: Take notes\n---\nWrite it down.";
    const { io } = makeIo(home, [], { llm, env: { OPENAI_API_KEY: "k" }, fetch: registryFetch({ "https://raw.githubusercontent.com/": skill }) });
    await main(["init"], io);
    const path = defaultConfigPath(home);
    const port = 24000 + Math.floor(Math.random() * 20000);
    const cfg = loadConfig(path);
    writeConfig(path, { ...cfg, gateway: { ...cfg.gateway, port } });
    const r = await main(["serve"], io);
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: `Bearer ${cfg.gateway.token}`, "content-type": "application/json" };
    try {
      const page = await fetch(`${base}/`);
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(await page.text()).toContain("August");
      const reply = fetch(`${base}/v1/message`, { method: "POST", headers: auth, body: JSON.stringify({ channel: "web", user: "local", text: "install the notes skill" }) });
      let pending: any = null;
      for (let i = 0; i < 50 && !pending; i++) {
        await Bun.sleep(20);
        pending = ((await (await fetch(`${base}/v1/pending?channel=web&user=local`, { headers: auth })).json()) as any).approval;
      }
      expect(pending.tool).toBe("august.install_skill");
      expect(pending.details).toContain('install skill "notes"');
      const ok = await fetch(`${base}/v1/approve`, { method: "POST", headers: auth, body: JSON.stringify({ channel: "web", user: "local", allow: true }) });
      expect(ok.status).toBe(200);
      expect(await (await reply).json()).toEqual({ reply: "installed" });
      const none = await fetch(`${base}/v1/approve`, { method: "POST", headers: auth, body: JSON.stringify({ channel: "web", user: "local", allow: true }) });
      expect(none.status).toBe(409);
    } finally {
      r.stop?.();
    }
  });
});
