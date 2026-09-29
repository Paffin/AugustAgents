import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EGRESS_BRIDGE_JS, EgressProxy, detectSandbox, parseEgress, sandboxSpec, type EgressDecision, type SandboxOptions } from "../src/index.ts";

// Suite category: Safety/security invariant, LIVE platform evidence (REQ-SEC-003). These run the real OS sandbox and assert observed
// behavior, not argument construction. On a machine where no sandbox works they are skipped and the run is "cannot verify", never a pass.
const kind = detectSandbox();
const live = test.skipIf(kind !== "bwrap");
const dirs: string[] = []; const closers: Array<() => void | Promise<void>> = [];
afterAll(async () => { for (const c of closers) await c(); dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "august-live-")); dirs.push(d); return d; };
const realHome = homedir();

/** Run `sh -c script` inside the sandbox exactly as the app would wrap an MCP server. */
async function inSandbox(script: string, o: Partial<SandboxOptions> & Pick<SandboxOptions, "network">, env: Record<string, string> = {}) {
  const wrapped = sandboxSpec({ id: "live", command: "/bin/sh", args: ["-c", script], env }, { mode: "required", kind: "bwrap", home: join(tmp(), "home"), realHome, ...o });
  // Asynchronous on purpose: the egress proxy runs in this very process and must keep serving while the sandboxed child runs.
  const child = spawn(wrapped.spec.command, [...(wrapped.spec.args ?? [])], { env: { PATH: process.env.PATH!, ...wrapped.spec.env } });
  let out = ""; let err = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  return { out: out.trim(), err: err.trim(), status, egress: wrapped.egress };
}
async function listener(): Promise<{ port: number; hits: () => number }> {
  let hits = 0; const server: Server = createServer((s) => { hits += 1; s.on("data", (d) => s.write(`echo:${d}`)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); closers.push(() => void server.close());
  return { port: (server.address() as { port: number }).port, hits: () => hits };
}

describe("Linux sandbox (bubblewrap), observed", () => {
  live("the server cannot read the owner's home, cannot write outside its private home, and has private /tmp", async () => {
    const secret = join(realHome, `.august-live-secret-${process.pid}`); writeFileSync(secret, "TOP-SECRET-KEY");
    closers.push(() => rmSync(secret, { force: true }));
    const r = await inSandbox(`cat "${secret}" 2>&1; echo ---; { echo pwned > /etc/august-pwned; } 2>&1; echo ---; echo mine > "$HOME/own.txt" && cat "$HOME/own.txt"; echo ---; ls /tmp | wc -l`, { network: "none" });
    const [read, write, own, tmpCount] = r.out.split("---").map((p) => p.trim());
    expect(read).not.toContain("TOP-SECRET-KEY"); expect(read).toMatch(/No such file|denied/i);
    expect(write).toMatch(/Read-only|denied|cannot/i);
    expect(own).toBe("mine"); expect(tmpCount).toBe("0");
  });

  live("with network none the server cannot reach a listener on the host's loopback, nor anything else", async () => {
    const l = await listener();
    const probe = (host: string, port: number) => `(echo probe > /dev/tcp/${host}/${port}) 2>&1 && echo CONNECTED || echo BLOCKED`;
    const r = await inSandbox(`bash -c '${probe("127.0.0.1", l.port)}'; bash -c '${probe("1.1.1.1", 443)}'; bash -c '${probe("10.0.0.1", 80)}'`, { network: "none" });
    expect(r.out.split("\n").filter((line) => line.endsWith("BLOCKED"))).toHaveLength(3); expect(r.out).not.toContain("CONNECTED");
    expect(l.hits()).toBe(0); expect(r.egress).toBe("none");
  });

  live("with network open the same probe does connect: the difference is the sandbox, not the test", async () => {
    const l = await listener();
    const r = await inSandbox(`bash -c '(echo probe > /dev/tcp/127.0.0.1/${l.port}) 2>&1 && echo CONNECTED || echo BLOCKED'`, { network: "open" });
    expect(r.out).toContain("CONNECTED");
  });

  live("egress allowlist: allowlisted tunnels work, everything else is refused, and going around the proxy has no route", async () => {
    const upstream = await listener(); const decisions: EgressDecision[] = [];
    const work = tmp(); const socket = join(work, "egress.sock"); const bridge = join(work, "bridge.js"); writeFileSync(bridge, EGRESS_BRIDGE_JS);
    const proxy = await EgressProxy.listenUnix(socket, { capability: "live", rules: parseEgress([`allowed.test:${upstream.port}`]), resolve: async () => ["127.0.0.1"], insecureAllowPrivateForTests: true, onDecision: (d) => decisions.push(d) });
    closers.push(() => proxy.close());
    // A client in the sandbox that honours HTTPS_PROXY the way curl, pip or npm do, written for the bound runtime.
    const client = (host: string, port: number) => `/run/august/runtime -e '
      const net = require("node:net"); const u = new URL(process.env.HTTPS_PROXY);
      const s = net.connect(Number(u.port), u.hostname, () => s.write("CONNECT ${host}:${port} HTTP/1.1\\r\\nHost: ${host}:${port}\\r\\n\\r\\n"));
      let got = ""; s.on("data", (d) => { got += d; if (got.includes("200 Connection")) { s.write("hello"); } if (got.includes("echo:hello")) { console.log("TUNNEL-OK"); process.exit(0); } if (/HTTP\\/1.1 (403|502|407)/.test(got)) { console.log("REFUSED " + got.split("\\r\\n")[0]); process.exit(0); } });
      s.on("error", () => { console.log("NO-ROUTE"); process.exit(0); }); setTimeout(() => { console.log("TIMEOUT"); process.exit(0); }, 8000);'`;
    const attach = { kind: "unix" as const, socket, runtime: process.execPath, bridgeScript: bridge };
    const run = (script: string) => inSandbox(script, { network: attach });
    const ok = await run(`sleep 0.4; ${client("allowed.test", upstream.port)}`);
    expect(ok.out).toContain("TUNNEL-OK"); expect(ok.egress).toBe("allowlist");
    const denied = await run(`sleep 0.4; ${client("evil.test", upstream.port)}`);
    expect(denied.out).toContain("REFUSED HTTP/1.1 403");
    const direct = await run(`bash -c '(echo x > /dev/tcp/127.0.0.1/${upstream.port}) 2>&1 && echo CONNECTED || echo BLOCKED'; bash -c '(echo x > /dev/tcp/93.184.216.34/443) 2>&1 && echo CONNECTED || echo BLOCKED'`);
    expect(direct.out.split("\n").filter((l) => l.endsWith("BLOCKED"))).toHaveLength(2);
    expect(decisions.map((d) => [d.host, d.allowed])).toEqual([["allowed.test", true], ["evil.test", false]]);
    // Only the allowlisted tunnel reached the upstream: the direct probes and the refused request never did.
    expect(upstream.hits()).toBe(1);
  });
});
