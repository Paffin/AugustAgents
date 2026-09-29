export interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
}

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type: string };
  environmentVariables?: RegistryEnvVar[];
}

export interface RegistryHeader {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  value?: string;
}

export interface RegistryRemote {
  type: string;
  url: string;
  headers?: RegistryHeader[];
}

export interface RegistryServer {
  name: string;
  description: string;
  version: string;
  repository?: { url?: string; source?: string };
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Client for the official MCP registry (registry.modelcontextprotocol.io, API v0). */
export class RegistryClient {
  private readonly base: string;
  constructor(baseUrl: string, private readonly fetchFn: typeof fetch = fetch, private readonly timeoutMs = 10_000) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  async search(query: string, limit = 10): Promise<RegistryServer[]> {
    const q = query.trim().slice(0, 100);
    if (!q) return [];
    const url = `${this.base}/v0/servers?search=${encodeURIComponent(q)}&limit=${Math.min(Math.max(limit, 1), 30)}`;
    const body = await this.get(url);
    const list = (body as { servers?: unknown[] }).servers ?? [];
    const out: RegistryServer[] = [];
    for (const item of list) {
      const entry = item as { server?: unknown; _meta?: Record<string, { status?: string; isLatest?: boolean }> };
      const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
      if (meta && (meta.status !== undefined && meta.status !== "active")) continue;
      if (meta && meta.isLatest === false) continue;
      const s = parseServer(entry.server ?? item);
      if (s) out.push(s);
    }
    return out;
  }

  /** Exact lookup by registry name among search results. */
  async find(name: string): Promise<RegistryServer | undefined> {
    const tail = name.split("/").pop() ?? name;
    const hits = await this.search(tail, 30);
    return hits.find((s) => s.name === name);
  }

  private async get(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new RegistryError(`registry unreachable (${(error as Error).name})`);
    }
    if (!response.ok) throw new RegistryError(`registry HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new RegistryError("registry reply too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new RegistryError("registry reply is not JSON");
    }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function parseServer(raw: unknown): RegistryServer | undefined {
  const s = raw as Partial<RegistryServer> | null;
  if (!s || typeof s !== "object") return undefined;
  const name = str(s.name);
  const version = str(s.version);
  if (!name || !version) return undefined;
  const packages = Array.isArray(s.packages)
    ? s.packages.filter((p): p is RegistryPackage => !!p && typeof p === "object" && !!str(p.registryType) && !!str(p.identifier))
    : undefined;
  const remotes = Array.isArray(s.remotes)
    ? s.remotes.filter((r): r is RegistryRemote => !!r && typeof r === "object" && !!str(r.type) && !!str(r.url))
    : undefined;
  return { name, version, description: str(s.description) ?? "", repository: s.repository, packages, remotes };
}
