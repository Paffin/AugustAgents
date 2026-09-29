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

export interface SandboxOptions {
  mode: SandboxMode;
  /** Let the server reach the network. */
  network: boolean;
  /** Private writable home for the server (keeps npm/uv caches between runs). */
  home: string;
  /** Our real home, hidden from the server. */
  realHome: string;
  kind: SandboxKind;
}

export interface SandboxResult {
  spec: McpServerSpec;
  /** What actually isolates the server; "none" means it runs with your rights. */
  isolation: SandboxKind;
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
export function bwrapArgs(spec: McpServerSpec, o: Pick<SandboxOptions, "network" | "home" | "realHome">): string[] {
  const args = [
    "--ro-bind", "/", "/",
    "--tmpfs", "/home",
    "--tmpfs", "/root",
    "--tmpfs", "/run",
    "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve",
    "--bind", o.home, o.realHome,
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    "--unshare-all",
    ...(o.network ? ["--share-net"] : []),
    "--die-with-parent",
    "--new-session",
    "--setenv", "HOME", o.realHome,
    "--chdir", o.realHome,
    "--",
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
    ...(o.network ? [] : ["(deny network*)"]),
  ].join("");
}

export function sandboxSpec(spec: McpServerSpec, o: SandboxOptions): SandboxResult {
  if (o.mode === "off") return { spec, isolation: "none" };
  if (o.kind === "none") {
    if (o.mode === "required") {
      throw new SandboxError(`"${spec.id}" requires a sandbox, but none works here (install bubblewrap on Linux)`);
    }
    return { spec, isolation: "none" };
  }
  mkdirSync(o.home, { recursive: true, mode: 0o700 });
  if (o.kind === "bwrap") {
    return { spec: { ...spec, command: "bwrap", args: bwrapArgs(spec, o) }, isolation: "bwrap" };
  }
  // Let the server read its own runtime when that lives under the home folder (e.g. ~/.bun, ~/.nvm).
  const allowRead = spec.command.startsWith(o.realHome) ? [dirname(dirname(spec.command))] : [];
  return {
    spec: { ...spec, command: "sandbox-exec", args: ["-p", seatbeltProfile(o, allowRead), spec.command, ...(spec.args ?? [])] },
    isolation: "sandbox-exec",
  };
}

export function sandboxHome(dataDir: string, serverId: string): string {
  return join(dataDir, "sandbox", serverId);
}
