import { scanText } from "@august/capabilities";
import type { PackageRef } from "./artifact.ts";
import type { RegistryServer } from "./registry.ts";

/**
 * What will be installed, before anything is fetched. A local server is a registry package, never a
 * command: August resolves and verifies the exact artifact, installs it itself and records its identity.
 */
export interface PlannedServer {
  id: string;
  package?: PackageRef;
  url?: string;
  env?: Record<string, string>;
  envFrom?: string[];
  headersFrom?: Record<string, string>;
  trust: "community";
}

export interface InstallPlan {
  registryName: string;
  version: string;
  server: PlannedServer;
  /** Secrets the person must provide ("august secret set NAME"). */
  secrets: Array<{ name: string; description: string }>;
  /** Required settings with no default: the plan cannot run until they are set. */
  missing: string[];
  /** One line shown in the approval prompt. */
  summary: string;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

const SAFE_ARG = /^[A-Za-z0-9@/._:=+-]+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function serverIdFor(name: string, taken: ReadonlySet<string>): string {
  const tail = (name.split("/").pop() ?? name).toLowerCase();
  const base = tail.replace(/^(mcp-server-|server-|mcp-)/, "").replace(/(-mcp|-server|-mcp-server)$/, "").replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "server";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

function secretName(id: string, header: string): string {
  return `${id}_${header}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/**
 * Turn a registry entry into an install plan, preferring a local npm package pinned to an exact
 * version. Nothing floats to "latest": what the person approves is what runs. Packages August cannot
 * yet verify and contain (PyPI, container images) are refused with a reason rather than run loosely.
 */
export function planInstall(server: RegistryServer, taken: ReadonlySet<string> = new Set()): InstallPlan {
  const scan = scanText(`${server.name}\n${server.description}`);
  if (scan.blocked) throw new PlanError(`"${server.name}" was blocked by the scanner (${scan.findings.find((f) => f.severity === "block")?.rule})`);

  const id = serverIdFor(server.name, taken);
  const secrets: InstallPlan["secrets"] = [];
  const missing: string[] = [];

  const stdio = (server.packages ?? []).filter((p) => (p.transport?.type ?? "stdio") === "stdio");
  const pkg = stdio.find((p) => p.registryType === "npm");
  if (pkg) {
    const version = pkg.version ?? server.version;
    if (!version || version === "latest" || !SAFE_ARG.test(version) || !SAFE_ARG.test(pkg.identifier)) {
      throw new PlanError(`"${server.name}" has no exact version to pin`);
    }
    const env: Record<string, string> = {};
    const envFrom: string[] = [];
    for (const v of pkg.environmentVariables ?? []) {
      if (!ENV_NAME.test(v.name)) continue;
      if (v.isSecret) {
        envFrom.push(v.name);
        secrets.push({ name: v.name, description: v.description ?? "" });
      } else if (v.default !== undefined) {
        env[v.name] = String(v.default);
      } else if (v.isRequired) {
        missing.push(v.name);
      }
    }
    const planned: PlannedServer = { id, package: { registry: "npm", name: pkg.identifier, version }, trust: "community" };
    if (Object.keys(env).length) planned.env = env;
    if (envFrom.length) planned.envFrom = envFrom;
    return {
      registryName: server.name,
      version,
      server: planned,
      secrets,
      missing,
      summary: `install npm package ${pkg.identifier}@${version} as "${id}" (verified, sandboxed, no network until you allow hosts)`,
    };
  }

  const remote = (server.remotes ?? []).find((r) => r.type === "streamable-http" && r.url.startsWith("https://"));
  if (remote) {
    const headersFrom: Record<string, string> = {};
    for (const h of remote.headers ?? []) {
      if (!/^[A-Za-z0-9-]+$/.test(h.name)) continue;
      if (h.isSecret || h.isRequired) {
        const name = secretName(id, h.name);
        headersFrom[h.name] = name;
        secrets.push({ name, description: h.description ?? `${h.name} header` });
      }
    }
    const planned: PlannedServer = { id, url: remote.url, trust: "community" };
    if (Object.keys(headersFrom).length) planned.headersFrom = headersFrom;
    return {
      registryName: server.name,
      version: server.version,
      server: planned,
      secrets,
      missing,
      summary: `connect to ${new URL(remote.url).host} as "${id}"`,
    };
  }

  const unsupported = stdio.map((p) => p.registryType).filter((t) => t !== "npm");
  if (unsupported.length) {
    throw new PlanError(`"${server.name}" ships only as ${[...new Set(unsupported)].join("/")}, which August cannot verify and contain yet`);
  }
  throw new PlanError(`"${server.name}" has no package or remote August can run`);
}
