import { describe, expect, test } from "bun:test";
import { DistillationLadder, type RunReport } from "../src/index.ts";

const good: RunReport = { success: true, verified: true, effects: ["read"] };

function climb(ladder: DistillationLadder, task: string, runs: number, report: RunReport = good) {
  let last;
  for (let i = 0; i < runs; i++) last = ladder.record(task, report);
  return last!;
}

describe("DistillationLadder", () => {
  test("a new task starts at the LLM step", () => {
    expect(new DistillationLadder().step("t")).toBe(0);
    expect(new DistillationLadder().nextMode("t")).toBe(0);
  });

  test("three verified successes promote one step", () => {
    const l = new DistillationLadder();
    expect(climb(l, "t", 2).change).toBe("none");
    expect(l.record("t", good)).toEqual({ step: 1, change: "promoted" });
  });

  test("climbs all the way to reflex for local-only work", () => {
    const l = new DistillationLadder();
    climb(l, "t", 9);
    expect(l.step("t")).toBe(3);
  });

  test("unverified successes never promote", () => {
    const l = new DistillationLadder();
    climb(l, "t", 20, { ...good, verified: false });
    expect(l.step("t")).toBe(0);
  });

  test("runs driven by untrusted text do not count", () => {
    const l = new DistillationLadder();
    climb(l, "t", 20, { ...good, tainted: true });
    expect(l.step("t")).toBe(0);
  });

  test("a failure demotes one step and resets the streak", () => {
    const l = new DistillationLadder();
    climb(l, "t", 6);
    expect(l.step("t")).toBe(2);
    expect(l.record("t", { ...good, success: false })).toEqual({ step: 1, change: "demoted" });
    expect(climb(l, "t", 2).step).toBe(1);
    expect(l.record("t", good).step).toBe(2);
  });

  test("a failure at the bottom changes nothing", () => {
    const l = new DistillationLadder();
    expect(l.record("t", { ...good, success: false })).toEqual({ step: 0, change: "none" });
  });

  test("new effects send an earned task back to the LLM", () => {
    const l = new DistillationLadder();
    climb(l, "t", 6);
    const r = l.record("t", { ...good, effects: ["read", "network"] });
    expect(r).toEqual({ step: 0, change: "effects-widened" });
    expect(l.state("t")?.effects).toContain("network");
  });

  test("fewer effects than before is fine", () => {
    const l = new DistillationLadder();
    l.record("t", { ...good, effects: ["read", "write"] });
    climb(l, "t", 2, { ...good, effects: ["read"] });
    expect(l.step("t")).toBe(1);
  });

  test("a reflex with controlled effects waits for approval", () => {
    const l = new DistillationLadder();
    const send: RunReport = { ...good, effects: ["read", "send"] };
    climb(l, "t", 6, send);
    expect(l.step("t")).toBe(2);
    expect(l.record("t", send).change).toBe("none");
    expect(l.record("t", send).change).toBe("none");
    expect(l.record("t", send)).toEqual({ step: 2, change: "pending-approval" });
    expect(l.step("t")).toBe(2);
    expect(l.approve("t")).toEqual({ step: 3, change: "promoted" });
  });

  test("approve does nothing without a pending promotion", () => {
    const l = new DistillationLadder();
    climb(l, "t", 3);
    expect(l.approve("t")).toEqual({ step: 1, change: "none" });
  });

  test("a failure cancels a pending approval", () => {
    const l = new DistillationLadder();
    const send: RunReport = { ...good, effects: ["send"] };
    climb(l, "t", 9, send);
    l.record("t", { ...send, success: false });
    expect(l.state("t")?.pendingApproval).toBe(false);
    expect(l.approve("t").change).toBe("none");
  });

  test("a reflex is audited at the workflow step every N runs", () => {
    const l = new DistillationLadder({ auditEvery: 3 });
    climb(l, "t", 9);
    expect(l.step("t")).toBe(3);
    expect(l.nextMode("t")).toBe(3);
    climb(l, "t", 3);
    expect(l.nextMode("t")).toBe(2);
    l.record("t", { ...good, ranAt: 2 });
    expect(l.nextMode("t")).toBe(3);
  });

  test("a failed audit demotes the reflex", () => {
    const l = new DistillationLadder({ auditEvery: 1 });
    climb(l, "t", 9);
    l.record("t", good);
    expect(l.record("t", { ...good, ranAt: 2, success: false })).toEqual({ step: 2, change: "demoted" });
  });

  test("state survives export and import", () => {
    const a = new DistillationLadder();
    climb(a, "t", 4);
    const b = new DistillationLadder();
    b.import(JSON.parse(JSON.stringify(a.export())));
    expect(b.step("t")).toBe(1);
    expect(b.state("t")?.streak).toBe(1);
  });

  test("reset forgets a task", () => {
    const l = new DistillationLadder();
    climb(l, "t", 3);
    l.reset("t");
    expect(l.step("t")).toBe(0);
  });

  test("rejects a zero promotion threshold", () => {
    expect(() => new DistillationLadder({ repeatsToPromote: 0 })).toThrow();
  });
});
