import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServerSpec } from "./client.ts";

export type SandboxMode = "auto" | "required" | "off";
export type SandboxKind = "bwrap" | "sandbox-exec" | "none";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * How a sandboxed server reaches the network. `none` is the default posture; `open` is the owner's explicit choice;
 * an attachment routes everything through August's egress proxy, which enforces the allowlist.
 */
export type NetworkAccess = "none" | "open" | EgressAttachment;

export type EgressAttachment =
  /** Linux: no network in the sandbox; a bridge inside it forwards its loopback to the proxy's unix socket. */
  | { kind: "unix"; socket: string; /** A runtime that can run the bridge (bun or node), bound read-only into the sandbox. */ runtime: string; /** File with EGRESS_BRIDGE_JS. */ bridgeScript: string }
  /** macOS: the sandbox may connect only to the proxy's loopback port. */
  | { kind: "tcp"; port: number; token: string };

export interface SandboxOptions {
  mode: SandboxMode;
  network: NetworkAccess;
  /** Private writable home for the server (keeps npm/uv caches between runs). */
  home: string;
  /** Our real home, hidden from the server. */
  realHome: string;
  /** Paths the server may read and run, shown read-only even when they sit under the hidden home (its installed package, its runtime). */
  readOnlyPaths?: readonly string[];
  kind: SandboxKind;
}

export interface SandboxResult {
  spec: McpServerSpec;
  /** What actually isolates the server; "none" means it runs with your rights. */
  isolation: SandboxKind;
  /** What the server can reach: nothing, only allowlisted hosts through the proxy, or anything. */
  egress: "none" | "allowlist" | "open";
}

const BRIDGE_PORT = 3128;
const BRIDGE_SOCKET = "/run/august/egress.sock";
const PROXY_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"];

/** Environment that points ordinary HTTP clients at the proxy. Clients that ignore it simply have no route. */
export function proxyEnv(url: string): Record<string, string> {
  return { ...Object.fromEntries(PROXY_NAMES.map((n) => [n, url])), NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "1" };
}

/** Detect a working sandbox. bwrap can be installed yet unusable (user namespaces off), so it is tried once. */
export function detectSandbox(platform: NodeJS.Platform = process.platform): SandboxKind {
  if (platform === "linux") {
    const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "true"], { timeout: 5000 });
    return !r.error && r.status === 0 ? "bwrap" : "none";
  }
  if (platform === "darwin") {
    const r = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "true"], { timeout: 5000 });
    return !r.error && r.status === 0 ? "sandbox-exec" : "none";
  }
  return "none";
}

/**
 * Linux: the whole filesystem read-only, homes and /run hidden (keys, SSH
 * agent, keyring sockets), a private home and /tmp, no access to other
 * processes, network only when allowed.
 */
export function bwrapArgs(spec: McpServerSpec, o: Pick<SandboxOptions, "network" | "home" | "realHome" | "readOnlyPaths">): string[] {
  const egress = typeof o.network === "object" && o.network.kind === "unix" ? o.network : undefined;
  const bridged = egress
    ? [
        "--ro-bind", egress.runtime, "/run/august/runtime",
        "--ro-bind", egress.bridgeScript, "/run/august/bridge.js",
        "--bind", egress.socket, BRIDGE_SOCKET,
        "--setenv", "AUGUST_EGRESS_SOCK", BRIDGE_SOCKET,
        "--setenv", "AUGUST_EGRESS_PORT", String(BRIDGE_PORT),
        ...Object.entries(proxyEnv(`http://127.0.0.1:${BRIDGE_PORT}`)).flatMap(([k, v]) => ["--setenv", k, v]),
      ]
    : [];
  const args = [
    "--ro-bind", "/", "/",
    "--tmpfs", "/home",
    "--tmpfs", "/root",
    "--tmpfs", "/run",
    "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve",
    "--tmpfs", "/tmp",
    "--bind", o.home, o.realHome,
    // Last: after every tmpfs and after the private home, or a path under /tmp, /home, /root or the home itself would be covered again.
    ...(o.readOnlyPaths ?? []).flatMap((p) => ["--ro-bind", p, p]),
    "--dev", "/dev",
    "--proc", "/proc",
    "--unshare-all",
    ...(o.network === "open" ? ["--share-net"] : []),
    "--die-with-parent",
    "--new-session",
    "--setenv", "HOME", o.realHome,
    "--chdir", o.realHome,
    ...bridged,
    "--",
    // The bridge is a child of the server's own process tree: when the server exits it goes with it.
    ...(egress ? ["/bin/sh", "-c", '/run/august/runtime /run/august/bridge.js & exec "$@"', "sh"] : []),
    spec.command,
    ...(spec.args ?? []),
  ];
  return args;
}

function quote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** macOS: deny reading the home folder except the server's own, and the network when not allowed. */
export function seatbeltProfile(o: Pick<SandboxOptions, "network" | "home" | "realHome">, allowRead: readonly string[] = []): string {
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath ${quote(o.realHome)}))`,
    `(allow file-read* file-write* (subpath ${quote(o.home)}))`,
    ...allowRead.map((p) => `(allow file-read* (subpath ${quote(p)}))`),
    ...(o.network === "open" ? [] : ["(deny network*)"]),
    // Later rules win: the only exception to "no network" is the proxy's own loopback port.
    ...(typeof o.network === "object" && o.network.kind === "tcp" ? [`(allow network-outbound (remote tcp "localhost:${o.network.port}"))`] : []),
  ].join("");
}

export function sandboxSpec(spec: McpServerSpec, o: SandboxOptions): SandboxResult {
  const egress = o.network === "none" ? "none" : o.network === "open" ? "open" : "allowlist";
  if (o.mode === "off") return { spec, isolation: "none", egress: "open" };
  if (o.kind === "none") {
    if (o.mode === "required") {
      throw new SandboxError(`"${spec.id}" requires a sandbox, but none works here (install bubblewrap on Linux)`);
    }
    return { spec, isolation: "none", egress: "open" };
  }
  if (typeof o.network === "object" && ((o.network.kind === "unix") !== (o.kind === "bwrap"))) {
    throw new SandboxError(`"${spec.id}": this sandbox cannot enforce an egress allowlist of that kind`);
  }
  mkdirSync(o.home, { recursive: true, mode: 0o700 });
  if (o.kind === "bwrap") {
    return { spec: { ...spec, command: "bwrap", args: bwrapArgs(spec, o) }, isolation: "bwrap", egress };
  }
  // Let the server read its own runtime when that lives under the home folder (e.g. ~/.bun, ~/.nvm).
  const allowRead = [...(spec.command.startsWith(o.realHome) ? [dirname(dirname(spec.command))] : []), ...(o.readOnlyPaths ?? [])];
  const withProxy = typeof o.network === "object" && o.network.kind === "tcp" ? { ...spec, env: { ...spec.env, ...proxyEnv(`http://august:${o.network.token}@localhost:${o.network.port}`) } } : spec;
  return {
    spec: { ...withProxy, command: "sandbox-exec", args: ["-p", seatbeltProfile(o, allowRead), spec.command, ...(spec.args ?? [])] },
    isolation: "sandbox-exec",
    egress,
  };
}

export function sandboxHome(dataDir: string, serverId: string): string {
  return join(dataDir, "sandbox", serverId);
}
