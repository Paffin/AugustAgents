import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Bun loads the user-designated project .env. Never copy its PAT to runner env/argv.
const pat = Bun.env.gh_token;
const revision = process.argv[2];
const name = process.argv[3];
if (!pat || !revision || !name) throw new Error("Private gh_token, approved SHA and owned name are required");
const response = await fetch("https://api.github.com/repos/Paffin/AugustAgents/actions/runners/registration-token", {
  method: "POST", redirect: "error",
  headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
});
console.log(`Repository runner registration API status=${response.status}`);
if (!response.ok) process.exit(1); // Never log a credential-bearing API body/error.
const credential = await response.json() as { token?: string };
if (!credential.token || !/^[A-Za-z0-9_-]{1,2048}$/.test(credential.token)) process.exit(1);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(gh_token|GH_TOKEN|GITHUB_TOKEN)$/i.test(key))) as NodeJS.ProcessEnv;
const child = spawn("python3", [fileURLToPath(new URL("launch.py", import.meta.url)), "--token-stdin",
  "--revision", revision, "--name", name, "--context", "desktop-linux"], {
  env: environment, stdio: ["pipe", "inherit", "inherit"],
});
child.stdin.end(`${credential.token}\n`);
credential.token = "";
child.on("error", () => { console.error("Runner launcher unavailable"); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
