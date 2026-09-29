import { mkdirSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { spawnSync } from "node:child_process";
import { detectSandbox } from "../packages/mcp/src/sandbox.ts";

// Observed capabilities, not a platform support declaration or sandbox acceptance.
const sandbox = detectSandbox();
const unavailableProbe = process.platform === "linux" && sandbox !== "bwrap"
  ? spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "true"], { encoding: "utf8", timeout: 5000 })
  : undefined;
mkdirSync("ci-results", { recursive: true });
writeFileSync("ci-results/platform.json", JSON.stringify({
  os: process.platform,
  release: release(),
  architecture: process.arch,
  bun: Bun.version,
  sandbox,
  sandboxUnavailableReason: unavailableProbe ? unavailableProbe.error?.message ?? unavailableProbe.stderr.slice(0, 1000) : null,
  revision: process.env.GITHUB_SHA ?? null,
}, null, 2));
