import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "../../..");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(env: Record<string, string>, input = "") {
  const home = mkdtempSync(join(tmpdir(), "august-inst-"));
  dirs.push(home);
  const r = spawnSync("bash", [join(repo, "install.sh")], { env: { PATH: process.env.PATH!, HOME: home, ...env }, input, encoding: "utf8", timeout: 60_000 });
  return { ...r, home };
}

describe("install.sh", () => {
  test("installs from a local checkout, adds the command, and points to setup", () => {
    const r = run({ AUGUST_SOURCE: repo });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Next: run "august setup"');
    const launcher = join(r.home, ".local/bin/august");
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    expect(readFileSync(launcher, "utf8")).toContain("packages/app/src/bin.ts");
    expect(statSync(join(r.home, ".august")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(r.home, ".august/app/.git"))).toBe(false);
    const help = spawnSync(launcher, ["help"], { env: { PATH: process.env.PATH!, HOME: r.home }, encoding: "utf8" });
    expect(help.stdout).toContain("august setup");
  });

  test("the installed command runs setup from piped answers", () => {
    const r = run({ AUGUST_SOURCE: repo });
    const launcher = join(r.home, ".local/bin/august");
    const s = spawnSync(launcher, ["setup"], { env: { PATH: process.env.PATH!, HOME: r.home }, input: "3\nllama3.2\n1\n", encoding: "utf8" });
    expect(s.status).toBe(0);
    expect(JSON.parse(readFileSync(join(r.home, ".august/config.json"), "utf8")).llm.model).toBe("llama3.2");
  });

  test("refuses odd refs and a folder that is not August", () => {
    expect(run({ AUGUST_REF: "main;rm -rf ~" }).status).not.toBe(0);
    const bad = run({ AUGUST_SOURCE: tmpdir() });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("does not look like an August checkout");
  });

  test("the script never pipes a download into a shell", () => {
    const text = readFileSync(join(repo, "install.sh"), "utf8");
    expect(text).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });
});
