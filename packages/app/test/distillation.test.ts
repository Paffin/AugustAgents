import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider } from "@august/brain";
import { makeSessionKey } from "@august/core";
import { FileStore, createApp, defaultConfigPath, main, writeConfig, type App, type CliIo } from "../src/index.ts";
import { defaultConfig } from "./config-fixture.ts";

// Suite category: Product behavior (repeated verified work stops needing the model) and Safety/security invariant (the compiled path is as gated and as evidence-driven as the model path), through the composition root (DEC-0005).
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "august-distill-")); dirs.push(d); return d; };
const session = makeSessionKey({ workspace: "home", channel: "cli", user: "local" });

/** Picks clock.now until a result is in, then answers; counts every call by kind. */
function counting(): LlmProvider & { calls: Record<string, number> } {
  const calls: Record<string, number> = { decision: 0, arguments: 0, answer: 0 };
  return { name: "c", calls, async complete(messages, options) {
    await options?.onUsage?.({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    const all = messages.map((m) => m.content).join("\n");
    if (options?.jsonSchema?.name === "decision") { calls.decision!++; return JSON.stringify({ choice: all.includes("Result of") ? "none" : "clock.now" }); }
    if (options?.jsonSchema?.name === "arguments") { calls.arguments!++; return "{}"; }
    calls.answer!++; return "it is time";
  } };
}
const open = (home: string, llm: LlmProvider): App => createApp(defaultConfig(home), { env: {}, home, llm, secrets: new FileStore(join(home, ".august")), sandboxKind: "none" });

describe("repeated verified work is distilled and then runs without the model choosing", () => {
  test("after enough verified runs the same request runs as a compiled plan: no decision, no argument fill, still recorded and gated", async () => {
    const home = tmp(); const llm = counting(); const app = open(home, llm);
    for (let i = 0; i < 6; i++) await app.handle(session, `what time is it (${i})`.replace(/ \(\d\)/, ""));
    // The same request, six times, each confirmed by the host clock check: a workflow.
    const before = { ...llm.calls };
    const r = await app.handle(session, "what time is it");
    expect(r.compiled).toEqual({ steps: 1, completed: true });
    expect(llm.calls.decision).toBe(before.decision!);
    expect(llm.calls.arguments).toBe(before.arguments!);
    expect(llm.calls.answer).toBe(before.answer! + 1);
    expect(app.distill.report().patterns[0]).toMatchObject({ stage: "workflow", request: "what time is it" });
    // The compiled run is recorded at its stage, and the host still verified it.
    const stages = app.learning.report().map((s) => s.stage);
    expect(stages).toContain("workflow");
    expect(app.learning.report().find((s) => s.stage === "workflow")).toMatchObject({ runs: 1, verifiedRuns: 1 });
    // Compiled steps are not model choices: they never become training examples.
    expect(app.learning.exclusionSummary()["compiled-plan"]).toBe(1);
    app.close();
  });

  test("a compiled pattern reaches reflex and stops asking the model altogether, and the owner can see and remove it", async () => {
    const home = tmp(); const llm = counting(); const app = open(home, llm);
    for (let i = 0; i < 9; i++) await app.handle(session, "what time is it");
    expect(app.distill.report().patterns[0]!.stage).toBe("reflex");
    const before = { ...llm.calls };
    const r = await app.handle(session, "what time is it", undefined, { budget: { maxCostMicros: 0 } });
    expect(r.compiled).toEqual({ steps: 1, completed: true });
    expect(r.reply).toContain("Result of clock.now");
    expect(llm.calls).toEqual(before);
    expect(r.stopReason).toBeUndefined();
    expect(app.getRun(r.runId)?.usage.costMicros).toBe(0);
    app.close();
    const lines: string[] = [];
    const io: CliIo = { print: (l) => void lines.push(l), ask: async () => null, env: {}, home, sandboxKind: "none", secrets: new FileStore(join(home, ".august")), llm: { name: "none", complete: async () => "" } };
    writeConfig(defaultConfigPath(home), defaultConfig(home));
    expect((await main(["patterns"], io)).code).toBe(0);
    expect(lines.join("\n")).toContain("reflex");
    const id = /([0-9a-f]{16})/.exec(lines.join("\n"))![1]!;
    lines.length = 0;
    expect((await main(["patterns", "forget", id], io)).code).toBe(0);
    lines.length = 0; await main(["patterns"], io);
    expect(lines.join("\n")).toContain("0 learned");
  });

  test("a failing verification demotes the pattern; the owner saying it was bad does too", async () => {
    const home = tmp(); const llm = counting(); const app = open(home, llm);
    for (let i = 0; i < 6; i++) await app.handle(session, "what time is it");
    expect(app.distill.report().patterns[0]!.stage).toBe("workflow");
    const r = await app.handle(session, "what time is it");
    app.feedback(session, r.runId, "failure", "wrong");
    expect(app.distill.report().patterns[0]).toMatchObject({ stage: "skill" });
    app.close();
  });
});
