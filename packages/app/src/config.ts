import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AugustConfig {
  /** Workspace part of session keys. */
  workspace: string;
  /** The only folder the built-in file tools may touch. */
  root: string;
  llm: {
    baseUrl: string;
    model: string;
    /** Name of the environment variable that holds the key. The key itself is never written to disk. */
    apiKeyEnv?: string;
  };
  gateway: { port: number; token: string };
  /** Where the event journal and the decision log live. */
  dataDir: string;
  /** MCP servers to start. Listing one here is the person's own decision to trust it at the given level. */
  mcp: McpServerConfig[];
  /** Laya sidecar. Absent: the heuristic engine stands in. */
  laya?: LayaConfig;
  /** Default isolation for MCP servers started as processes. */
  sandbox: SandboxMode;
  /** Folder with SKILL.md skills, one folder per skill. */
  skillsDir: string;
  /** Registry used to find new MCP servers. */
  registryUrl: string;
  channels: ChannelsConfig;
}

export type SandboxMode = "auto" | "required" | "off";

export interface LayaConfig {
  /** Sidecar URL, always on this machine. */
  url: string;
  /** From "august calibrate". */
  temperature?: number;
  /** Calibrated confidence Laya needs to decide without the LLM. Default 0.7. */
  threshold?: number;
  /** Default true: the LLM decides and Laya is measured. "august laya activate" turns it off. */
  shadow?: boolean;
}

export interface ChannelsConfig {
  /** Serve the chat page at http://127.0.0.1:<port>/. Default true. */
  web: boolean;
  telegram?: {
    /** Name of the secret that holds the bot token. */
    tokenSecret: string;
    /** Telegram user ids that may talk to the agent. Everyone else is ignored. */
    allowedUsers: number[];
  };
}

export interface McpServerConfig {
  id: string;
  /** Start the server as a local process... */
  command?: string;
  /** ...or reach it over streamable HTTP (https only, or localhost). */
  url?: string;
  /** HTTP header name -> secret name, for remote servers. */
  headersFrom?: Record<string, string>;
  /** Overrides the global sandbox mode for this server. */
  sandbox?: SandboxMode;
  /** Let a sandboxed server reach the network. Default true. */
  network?: boolean;
  args?: string[];
  /** Plain settings. Never put secrets here; use envFrom. */
  env?: Record<string, string>;
  /** Names of variables copied from our environment into the server. */
  envFrom?: string[];
  /** "verified" cannot be claimed by hand; it is earned by a signature. Default community. */
  trust?: "community" | "known" | "self-made";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function defaultConfigPath(home: string): string {
  return join(home, ".august", "config.json");
}

export function defaultConfig(home: string): AugustConfig {
  return {
    workspace: "home",
    root: join(home, "August"),
    llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY" },
    gateway: { port: 7777, token: randomBytes(24).toString("hex") },
    dataDir: join(home, ".august", "data"),
    mcp: [],
    sandbox: "auto",
    skillsDir: join(home, ".august", "skills"),
    registryUrl: "https://registry.modelcontextprotocol.io",
    channels: { web: true },
  };
}

function isLocalUrl(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

export function parseConfig(value: unknown): AugustConfig {
  const c = value as Partial<AugustConfig> | null;
  if (!c || typeof c !== "object") throw new ConfigError("config must be an object");
  const str = (v: unknown, name: string): string => {
    if (typeof v !== "string" || v.length === 0) throw new ConfigError(`${name} must be a non-empty string`);
    return v;
  };
  const workspace = str(c.workspace, "workspace");
  if (!/^[A-Za-z0-9_.@-]+$/.test(workspace)) throw new ConfigError("workspace may only use letters, digits and _.@-");
  const root = str(c.root, "root");
  const dataDir = str(c.dataDir, "dataDir");
  const baseUrl = str(c.llm?.baseUrl, "llm.baseUrl");
  const model = str(c.llm?.model, "llm.model");

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError("llm.baseUrl is not a valid URL");
  }
  // A key sent over plain http to a remote host can be read by anyone on the path.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalUrl(url))) {
    throw new ConfigError("llm.baseUrl must use https (http is allowed only for localhost)");
  }
  if (c.llm?.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(c.llm.apiKeyEnv)) {
    throw new ConfigError("llm.apiKeyEnv must be an environment variable name, not the key itself");
  }

  const port = c.gateway?.port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new ConfigError("gateway.port must be 1-65535");
  const token = str(c.gateway?.token, "gateway.token");
  if (token.length < 16) throw new ConfigError("gateway.token must be at least 16 characters");

  const mcp = parseMcp(c.mcp);
  const sandbox = parseSandbox(c.sandbox ?? "auto", "sandbox");
  const skillsDir = c.skillsDir === undefined ? join(dirname(dataDir), "skills") : str(c.skillsDir, "skillsDir");
  const registryUrl = c.registryUrl === undefined ? "https://registry.modelcontextprotocol.io" : httpsUrl(c.registryUrl, "registryUrl");
  return {
    workspace,
    root,
    dataDir,
    mcp,
    sandbox,
    skillsDir,
    registryUrl,
    laya: parseLaya(c.laya),
    channels: parseChannels(c.channels),
    llm: { baseUrl, model, apiKeyEnv: c.llm?.apiKeyEnv },
    gateway: { port: port as number, token },
  };
}

function parseSandbox(v: unknown, where: string): SandboxMode {
  if (v !== "auto" && v !== "required" && v !== "off") throw new ConfigError(`${where} must be auto, required or off`);
  return v;
}

function httpsUrl(v: unknown, where: string): string {
  let url: URL;
  try {
    url = new URL(String(v));
  } catch {
    throw new ConfigError(`${where} is not a valid URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalUrl(url))) {
    throw new ConfigError(`${where} must use https (http is allowed only for localhost)`);
  }
  return String(v);
}

function parseLaya(v: unknown): LayaConfig | undefined {
  if (v === undefined) return undefined;
  const l = v as Partial<LayaConfig> | null;
  if (!l || typeof l !== "object" || typeof l.url !== "string") throw new ConfigError("laya.url is required");
  let url: URL;
  try {
    url = new URL(l.url);
  } catch {
    throw new ConfigError("laya.url is not a valid URL");
  }
  if (!isLocalUrl(url)) throw new ConfigError("laya.url must point to this machine (127.0.0.1)");
  if (l.temperature !== undefined && !(typeof l.temperature === "number" && l.temperature > 0)) throw new ConfigError("laya.temperature must be positive");
  if (l.threshold !== undefined && !(typeof l.threshold === "number" && l.threshold > 0 && l.threshold <= 1)) throw new ConfigError("laya.threshold must be in (0, 1]");
  if (l.shadow !== undefined && typeof l.shadow !== "boolean") throw new ConfigError("laya.shadow must be true or false");
  return { url: l.url, temperature: l.temperature, threshold: l.threshold, shadow: l.shadow };
}

function parseChannels(v: unknown): ChannelsConfig {
  if (v === undefined) return { web: true };
  const c = v as Partial<ChannelsConfig> | null;
  if (!c || typeof c !== "object") throw new ConfigError("channels must be an object");
  const web = c.web ?? true;
  if (typeof web !== "boolean") throw new ConfigError("channels.web must be true or false");
  let telegram: ChannelsConfig["telegram"];
  if (c.telegram !== undefined) {
    const tg = c.telegram;
    if (!tg || typeof tg.tokenSecret !== "string" || !ENV_NAME.test(tg.tokenSecret)) {
      throw new ConfigError("channels.telegram.tokenSecret must be a secret name like TELEGRAM_BOT_TOKEN");
    }
    if (!Array.isArray(tg.allowedUsers) || tg.allowedUsers.length === 0 || !tg.allowedUsers.every((u) => Number.isInteger(u) && u > 0)) {
      // An open bot is a remote shell for anyone who finds it.
      throw new ConfigError("channels.telegram.allowedUsers must list at least one numeric Telegram user id");
    }
    telegram = { tokenSecret: tg.tokenSecret, allowedUsers: [...tg.allowedUsers] };
  }
  return telegram ? { web, telegram } : { web };
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SERVER_ID = /^[A-Za-z0-9_-]+$/;

function parseMcp(value: unknown): McpServerConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError("mcp must be a list");
  const seen = new Set<string>();
  return value.map((raw, i) => {
    const s = raw as Partial<McpServerConfig> | null;
    const where = `mcp[${i}]`;
    if (!s || typeof s !== "object") throw new ConfigError(`${where} must be an object`);
    if (typeof s.id !== "string" || !SERVER_ID.test(s.id)) throw new ConfigError(`${where}.id may only use letters, digits, _ and -`);
    if (seen.has(s.id)) throw new ConfigError(`${where}.id "${s.id}" is used twice`);
    seen.add(s.id);
    const hasCommand = typeof s.command === "string" && s.command.length > 0;
    const hasUrl = typeof s.url === "string" && s.url.length > 0;
    if (hasCommand === hasUrl) throw new ConfigError(`${where} needs either command or url`);
    if (hasUrl) httpsUrl(s.url, `${where}.url`);
    if (s.headersFrom !== undefined && !(typeof s.headersFrom === "object" && s.headersFrom !== null && Object.values(s.headersFrom).every((n) => typeof n === "string" && ENV_NAME.test(n)))) {
      throw new ConfigError(`${where}.headersFrom must map header names to secret names`);
    }
    if (s.sandbox !== undefined) parseSandbox(s.sandbox, `${where}.sandbox`);
    if (s.network !== undefined && typeof s.network !== "boolean") throw new ConfigError(`${where}.network must be true or false`);
    if (s.args !== undefined && !(Array.isArray(s.args) && s.args.every((a) => typeof a === "string"))) throw new ConfigError(`${where}.args must be a list of strings`);
    if (s.envFrom !== undefined && !(Array.isArray(s.envFrom) && s.envFrom.every((n) => typeof n === "string" && ENV_NAME.test(n)))) {
      throw new ConfigError(`${where}.envFrom must list environment variable names`);
    }
    if (s.env !== undefined && !(typeof s.env === "object" && s.env !== null && Object.values(s.env).every((v) => typeof v === "string"))) {
      throw new ConfigError(`${where}.env must map names to strings`);
    }
    if (s.trust !== undefined && !["community", "known", "self-made"].includes(s.trust)) {
      throw new ConfigError(`${where}.trust must be community, known or self-made`);
    }
    const out: McpServerConfig = { id: s.id };
    for (const k of ["command", "url", "headersFrom", "sandbox", "network", "args", "env", "envFrom", "trust"] as const) {
      if (s[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = s[k];
    }
    return out;
  });
}

export function loadConfig(path: string): AugustConfig {
  if (!existsSync(path)) throw new ConfigError(`no config at ${path}; run "august init"`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  return parseConfig(raw);
}

/** The file holds the gateway token, so it is private to the owner. */
export function writeConfig(path: string, config: AugustConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
