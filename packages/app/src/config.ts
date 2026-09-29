import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateNativeLayaBundle, type NativeLayaBundle } from "@august/brain";

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
    pricing?: LlmPricing;
  };
  gateway: { port: number; token: string };
  /** Where the event journal and the decision log live. */
  dataDir: string;
  /** MCP servers to start. Listing one here is the person's own decision to trust it at the given level. */
  mcp: McpServerConfig[];
  /** Native Laya or a local sidecar. Absent: the heuristic engine stands in. */
  laya?: LayaConfig;
  /** Default isolation for MCP servers started as processes. */
  sandbox: SandboxMode;
  /** Folder with SKILL.md skills, one folder per skill. */
  skillsDir: string;
  /** Registry used to find new MCP servers. */
  registryUrl: string;
  /** Package registry the packages of those servers are resolved and installed from. Default https://registry.npmjs.org. */
  npmRegistryUrl?: string;
  channels: ChannelsConfig;
  /** What August keeps between runs. Nothing about your requests is retained unless you turn it on. */
  memory?: MemoryConfig;
}

export interface MemoryConfig {
  /** Keep a short record of each finished run (your request, the tools used, the outcome) as episodic memory. Default off. */
  episodic?: boolean;
  /** How long episodic records live. Default 90. */
  episodicDays?: number;
  /** Put the memories that match a request in front of the model as trusted notes. Default on. */
  recall?: boolean;
}

export interface LlmPricing { inputMicrosPerMillion: number; outputMicrosPerMillion: number; source: string; asOf: string }

export type SandboxMode = "auto" | "required" | "off";

export interface LayaConfig {
  /** Sidecar URL, always on this machine. */
  url?: string;
  /** Local ONNX bundle; mutually exclusive with url. */
  onnx?: NativeLayaBundle;
  /** From "august calibrate". */
  temperature?: number;
  /** Calibrated confidence Laya needs to decide without the LLM. Default 0.7. */
  threshold?: number;
  /** Default true: the LLM decides and Laya is measured. "august laya activate" turns it off, and only on verified outcomes. */
  shadow?: boolean;
  /** Identity of the model weights, e.g. "laya-multilingual-2026-09". A calibration belongs to one engine; change it when the weights change. Default "laya". */
  engine?: string;
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
  /**
   * Let the server reach any host. Default false for community servers and true for servers the owner
   * configured by hand. A community server that needs the network lists the hosts in `egress` instead.
   */
  network?: boolean;
  /**
   * Hosts (or `*.example.com`, optionally `host:port`) the server may reach, through August's egress
   * proxy. Everything else, including private addresses, is refused. Exclusive with `network: true`.
   */
  egress?: string[];
  /** The exact artifact August fetched and verified for this server; what runs is checked against it at every start. */
  artifact?: ArtifactPin;
  args?: string[];
  /** Plain settings. Never put secrets here; use envFrom. */
  env?: Record<string, string>;
  /** Names of variables copied from our environment into the server. */
  envFrom?: string[];
  /** "verified" cannot be claimed by hand; it is earned by a signature. Default community. */
  trust?: "community" | "known" | "self-made";
  /** How private this server's results are. Default "personal": it may hand back your files or mail. Only the owner can lower it. */
  sensitivity?: "public" | "personal" | "secret";
  /** Per tool (the server's own tool name): the arguments that hold the path a write or delete lands on. Without it, a writing tool asks every time. */
  targetArgs?: Record<string, string[]>;
}

/** Identity of an installed package, recorded when the owner approved it. */
export interface ArtifactPin {
  registry: "npm" | "pypi";
  name: string;
  version: string;
  /** The registry's digest of the published file: `sha512-<base64>` (npm) or `sha256:<hex>` (PyPI). */
  integrity: string;
  /** sha256 over the installed file tree, recomputed and compared before every start. */
  treeSha256: string;
  /** How the identity was established: the registry's own signature over name, version and integrity. */
  signature: "npm-registry-ecdsa" | "none";
  /** The command inside the installed tree that starts the server. */
  entry: { runtime: "node" | "bun" | "python"; file: string };
  verifiedAt: string;
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
    llm: { baseUrl: "https://api.openai.com/v1", model: "", apiKeyEnv: "OPENAI_API_KEY" },
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
  if (typeof c.llm?.model !== "string") throw new ConfigError("llm.model must be a string; choose a model with august setup");
  const model = c.llm.model;

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
  if (url.username || url.password || url.search || url.hash) throw new ConfigError("llm.baseUrl must be a base address without credentials, query or fragment");
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
    ...(c.npmRegistryUrl === undefined ? {} : { npmRegistryUrl: httpsUrl(c.npmRegistryUrl, "npmRegistryUrl").replace(/\/+$/, "") }),
    laya: parseLaya(c.laya),
    ...(c.memory === undefined ? {} : { memory: parseMemory(c.memory) }),
    channels: parseChannels(c.channels),
    llm: { baseUrl, model, apiKeyEnv: c.llm?.apiKeyEnv, pricing: parsePricing(c.llm?.pricing) },
    gateway: { port: port as number, token },
  };
}

function parseMemory(value: unknown): MemoryConfig {
  const m = value as Partial<MemoryConfig> | null;
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new ConfigError("memory must be an object");
  for (const key of Object.keys(m)) if (!["episodic", "episodicDays", "recall"].includes(key)) throw new ConfigError(`memory.${key} is not a known setting`);
  for (const key of ["episodic", "recall"] as const) if (m[key] !== undefined && typeof m[key] !== "boolean") throw new ConfigError(`memory.${key} must be true or false`);
  if (m.episodicDays !== undefined && (!Number.isInteger(m.episodicDays) || m.episodicDays < 1 || m.episodicDays > 3650)) throw new ConfigError("memory.episodicDays must be a whole number of days, 1-3650");
  return { ...m };
}

function parsePricing(value: unknown): LlmPricing | undefined {
  if (value === undefined) return undefined; const p = value as Partial<LlmPricing> | null;
  if (!p || typeof p !== "object" || ![p.inputMicrosPerMillion, p.outputMicrosPerMillion].every((v) => Number.isSafeInteger(v) && (v as number) >= 0) || typeof p.source !== "string" || p.source.length === 0 || typeof p.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.asOf)) throw new ConfigError("llm.pricing needs non-negative integer rates, source, and YYYY-MM-DD asOf");
  const date = new Date(`${p.asOf}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== p.asOf) throw new ConfigError("llm.pricing.asOf must be a real calendar date");
  return p as LlmPricing;
}

export function resolveLlmPricing(config: AugustConfig): LlmPricing {
  const explicit = parsePricing(config.llm.pricing);
  if (explicit) return explicit;
  throw new ConfigError("llm pricing is missing; configure input/output microdollars per million tokens, including an explicit zero for free inference");
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
  if (!l || typeof l !== "object") throw new ConfigError("laya needs a local url or onnx bundle");
  if ((l.url !== undefined) === (l.onnx !== undefined)) throw new ConfigError("configure exactly one of laya.url or laya.onnx");
  let onnx: NativeLayaBundle | undefined;
  if (l.onnx !== undefined) {
    try { onnx = validateNativeLayaBundle(l.onnx); } catch (error) { throw new ConfigError((error as Error).message); }
  } else {
    let url: URL;
    try { if (typeof l.url !== "string") throw new Error(); url = new URL(l.url); }
    catch { throw new ConfigError("laya.url is not a valid URL"); }
    if (!["http:", "https:"].includes(url.protocol) || !isLocalUrl(url)) throw new ConfigError("laya.url must use HTTP(S) on this machine (127.0.0.1)");
    if (url.username || url.password || url.search || url.hash) throw new ConfigError("laya.url must not contain credentials, query or fragment");
  }
  if (l.temperature !== undefined && !(typeof l.temperature === "number" && l.temperature > 0)) throw new ConfigError("laya.temperature must be positive");
  if (l.threshold !== undefined && !(typeof l.threshold === "number" && l.threshold > 0 && l.threshold <= 1)) throw new ConfigError("laya.threshold must be in (0, 1]");
  if (l.shadow !== undefined && typeof l.shadow !== "boolean") throw new ConfigError("laya.shadow must be true or false");
  if (l.engine !== undefined && !(typeof l.engine === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(l.engine))) throw new ConfigError("laya.engine must be a short identifier like laya-2026-09");
  return { ...(onnx ? { onnx } : { url: l.url }), temperature: l.temperature, threshold: l.threshold, shadow: l.shadow, ...(l.engine === undefined ? {} : { engine: l.engine }) };
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
/** A host, `*.suffix`, or either with `:port`. No schemes, paths or wildcards elsewhere. */
export const EGRESS_ENTRY = /^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?::[0-9]{1,5})?$/;

function parseArtifact(value: unknown, where: string): void {
  const a = value as Partial<ArtifactPin> | null;
  const bad = (what: string): never => { throw new ConfigError(`${where}.artifact ${what}`); };
  if (!a || typeof a !== "object") return bad("must be an object");
  if (a.registry !== "npm" && a.registry !== "pypi") bad("registry must be npm or pypi");
  for (const k of ["name", "version", "integrity", "treeSha256", "verifiedAt"] as const) if (typeof a[k] !== "string" || a[k]!.length === 0) bad(`${k} must be a non-empty string`);
  if (a.registry === "npm" && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(a.integrity!)) bad("integrity must be sha512-<base64> for npm");
  if (a.registry === "pypi" && !/^sha256:[0-9a-f]{64}$/.test(a.integrity!)) bad("integrity must be sha256:<hex> for pypi");
  if (!/^[0-9a-f]{64}$/.test(a.treeSha256!)) bad("treeSha256 must be 64 hex characters");
  if (a.signature !== "npm-registry-ecdsa" && a.signature !== "none") bad("signature must be npm-registry-ecdsa or none");
  const entry = a.entry as ArtifactPin["entry"] | undefined;
  if (!entry || !["node", "bun", "python"].includes(entry.runtime) || typeof entry.file !== "string" || entry.file.length === 0 || entry.file.startsWith("/") || entry.file.split("/").includes("..")) bad("entry must name a runtime and a relative file");
}
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
    const hasArtifact = s.artifact !== undefined;
    if ([hasCommand, hasUrl, hasArtifact].filter(Boolean).length !== 1) throw new ConfigError(`${where} needs exactly one of command, url or artifact`);
    if (hasUrl) httpsUrl(s.url, `${where}.url`);
    if (s.headersFrom !== undefined && !(typeof s.headersFrom === "object" && s.headersFrom !== null && Object.values(s.headersFrom).every((n) => typeof n === "string" && ENV_NAME.test(n)))) {
      throw new ConfigError(`${where}.headersFrom must map header names to secret names`);
    }
    if (s.sandbox !== undefined) parseSandbox(s.sandbox, `${where}.sandbox`);
    if (s.network !== undefined && typeof s.network !== "boolean") throw new ConfigError(`${where}.network must be true or false`);
    if (s.egress !== undefined) {
      if (!Array.isArray(s.egress) || s.egress.length === 0 || !s.egress.every((h) => typeof h === "string" && EGRESS_ENTRY.test(h))) {
        throw new ConfigError(`${where}.egress must list hosts like api.example.com, *.example.com or host:port`);
      }
      if (s.network === true) throw new ConfigError(`${where}: egress and network:true exclude each other`);
    }
    if (s.artifact !== undefined) parseArtifact(s.artifact, where);
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
    if (s.sensitivity !== undefined && !["public", "personal", "secret"].includes(s.sensitivity)) throw new ConfigError(`${where}.sensitivity must be public, personal or secret`);
    if (s.targetArgs !== undefined) {
      const ta = s.targetArgs as unknown;
      if (!ta || typeof ta !== "object" || Array.isArray(ta) || !Object.values(ta).every((names) => Array.isArray(names) && names.length > 0 && names.every((n) => typeof n === "string" && n.length > 0))) {
        throw new ConfigError(`${where}.targetArgs must map tool names to non-empty lists of argument names`);
      }
    }
    const out: McpServerConfig = { id: s.id };
    for (const k of ["command", "url", "headersFrom", "sandbox", "network", "args", "env", "envFrom", "trust", "sensitivity", "targetArgs", "egress", "artifact"] as const) {
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
