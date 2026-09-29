import { mkdirSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { detectSandbox } from "../packages/mcp/src/sandbox.ts";

// Observed capabilities, not a platform support declaration or sandbox acceptance.
mkdirSync("ci-results", { recursive: true });
writeFileSync("ci-results/platform.json", JSON.stringify({
  os: process.platform,
  release: release(),
  architecture: process.arch,
  bun: Bun.version,
  sandbox: detectSandbox(),
  revision: process.env.GITHUB_SHA ?? null,
}, null, 2));
