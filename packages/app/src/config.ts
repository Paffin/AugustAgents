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
}

export interface McpServerConfig {
  id: string;
  command: string;
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
  return { workspace, root, dataDir, mcp, llm: { baseUrl, model, apiKeyEnv: c.llm?.apiKeyEnv }, gateway: { port: port as number, token } };
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
    if (typeof s.command !== "string" || s.command.length === 0) throw new ConfigError(`${where}.command is required`);
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
    return { id: s.id, command: s.command, args: s.args, env: s.env, envFrom: s.envFrom, trust: s.trust };
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
