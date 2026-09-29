import { describe, expect, test } from "bun:test";
import type { AgentReply, RunTrace } from "@august/agent";
import type { ToolDescriptor } from "@august/capabilities";
import { DistillationEngine, PatternStore, deriveTemplate, instantiate, matchRequest, type Route } from "../src/index.ts";

const tools: ToolDescriptor[] = [
  { name: "notes.search", description: "search notes", effects: ["read"], inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false } },
  { name: "mail.send", description: "send mail", effects: ["send"], inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] } },
];

function reply(calls: Array<{ tool: string; args: Record<string, unknown>; effects?: string[]; isError?: boolean; trust?: string }>, extra: Partial<AgentReply> = {}): AgentReply {
  const trace: RunTrace = {
    decisions: [],
    executions: calls.map((c, i) => ({
      decisionIndex: i, tool: c.tool, args: c.args, argsHash: "h", policy: { decision: "allow", rule: "r" }, isError: c.isError ?? false, result: "ok", resultHash: "r", resultChars: 2,
      trust: [(c.trust ?? "trusted") as "trusted"], effects: (c.effects ?? ["read"]) as never, startedAt: 0, finishedAt: 1,
    })) as never,
  };
  return { reply: "done", steps: calls.length, tainted: false, trace, ...extra };
}

const LLM: Route = { stage: "llm" };
const search = (q: string) => ({ tool: "notes.search", args: { q } });

/** Runs `n` verified LLM runs of the same task with different subjects. */
function learn(engine: DistillationEngine, subjects: string[], calls = (s: string) => [search(s)]) {
  subjects.forEach((s, i) => {
    const runId = `r${i}-${s}`;
    engine.observe({ runId, request: `find my notes about ${s}`, reply: reply(calls(s)), route: LLM });
    engine.settle(runId, "verified");
  });
}

describe("pattern templates", () => {
  test("argument text that came from the request becomes a slot and the rest stays fixed", () => {
    const t = deriveTemplate("find my notes about apples", [search("apples")])!;
    expect(t.request).toBe("find my notes about {{0}}");
    expect(t.steps[0]!.args).toEqual({ q: { $slot: 0 } });
    expect(instantiate(t, "find my notes about pears")).toEqual([search("pears")]);
    expect(matchRequest(t, "write a poem about pears")).toBeUndefined();
  });

  test("a constant the request did not contain stays a constant, so a different choice is a different pattern", () => {
    const a = deriveTemplate("archive old mail", [{ tool: "mail.send", args: { to: "a@x.y" } }])!;
    expect(a.slots).toBe(0);
    expect(instantiate(a, "archive old mail")).toEqual([{ tool: "mail.send", args: { to: "a@x.y" } }]);
  });

  test("a request with nothing fixed to recognise it by yields no pattern", () => {
    expect(deriveTemplate("apples", [search("apples")])).toBeUndefined();
  });
});

describe("DistillationEngine", () => {
  test("three verified runs of one task turn into a compiled plan for a new subject, replayed before use", () => {
    const store = new PatternStore();
    const engine = new DistillationEngine({ store });
    learn(engine, ["apples", "pears"]);
    expect(engine.route("find my notes about plums", tools).stage).toBe("llm");
    learn(engine, ["figs"]);
    // Three verified runs move it to the skill step: advice only.
    const skill = engine.route("find my notes about plums", tools);
    expect(skill.stage).toBe("skill");
    expect(skill.plan).toBeUndefined();
    expect(skill.guidance).toContain("notes.search");
    learn(engine, ["a1", "a2", "a3"].map((s) => `${s}x`));
    const workflow = engine.route("find my notes about plums", tools);
    expect(workflow).toMatchObject({ stage: "workflow", plan: [{ tool: "notes.search", args: { q: "plums" } }], verbatim: false });
  });

  test("an unverified success never climbs, and a run driven by untrusted content never becomes a pattern's example", () => {
    const engine = new DistillationEngine({ store: new PatternStore() });
    for (let i = 0; i < 6; i++) engine.observe({ runId: `u${i}`, request: `find my notes about t${i}x`, reply: reply([search(`t${i}x`)]), route: LLM });
    expect(engine.route("find my notes about zz", tools).stage).toBe("llm");
    for (let i = 0; i < 6; i++) { engine.observe({ runId: `w${i}`, request: `find my notes about w${i}x`, reply: reply([{ ...search(`w${i}x`), trust: "untrusted" }]), route: LLM }); engine.settle(`w${i}`, "verified"); }
    expect(engine.route("find my notes about zz", tools).stage).toBe("llm");
  });

  test("a failure drops a compiled pattern back a step and is recorded", () => {
    const engine = new DistillationEngine({ store: new PatternStore() });
    learn(engine, ["aa1", "aa2", "aa3", "aa4", "aa5", "aa6"]);
    const route = engine.route("find my notes about qq", tools);
    expect(route.stage).toBe("workflow");
    engine.observe({ runId: "bad", request: "find my notes about qq", reply: reply([search("qq")], { compiled: { steps: 0, completed: false, fellBack: "step-failed" } }), route });
    expect(engine.route("find my notes about qq", tools).stage).toBe("skill");
    expect(engine.report().patterns[0]!.lastChange).toContain("demoted");
  });

  test("a plan whose tool is gone, or whose arguments the tool would refuse, is offered only as advice", () => {
    const engine = new DistillationEngine({ store: new PatternStore() });
    learn(engine, ["aa1", "aa2", "aa3", "aa4", "aa5", "aa6"]);
    expect(engine.route("find my notes about qq", []).stage).toBe("skill");
    const strict: ToolDescriptor[] = [{ ...tools[0]!, inputSchema: { type: "object", properties: { q: { type: "string", maxLength: 2 } }, required: ["q"] } }];
    expect(engine.route("find my notes about qqq", strict).plan).toBeUndefined();
  });

  test("a reflex over a controlled effect waits for the owner, and cannot be approved unless replay passes", () => {
    const engine = new DistillationEngine({ store: new PatternStore() });
    const send = (s: string) => [{ tool: "mail.send", args: { to: `${s}@x.y` }, effects: ["send"] }];
    // The recipient is derived from the request, so it is a slot.
    for (let i = 0; i < 9; i++) { const s = `bob${i}`; engine.observe({ runId: `m${i}`, request: `email ${s}@x.y the report`, reply: reply(send(s)), route: LLM }); engine.settle(`m${i}`, "verified"); }
    const row = engine.report().patterns[0]!;
    expect(row.pendingApproval).toBe(true);
    expect(row.stage).toBe("workflow");
    expect(engine.approve(row.id).ok).toBe(true);
    const route = engine.route("email carol@x.y the report", tools);
    expect(route).toMatchObject({ stage: "reflex", verbatim: true, plan: [{ tool: "mail.send", args: { to: "carol@x.y" } }] });
  });

  test("state survives a restart, and a disabled pattern is never routed", () => {
    const store = new PatternStore();
    const first = new DistillationEngine({ store });
    learn(first, ["aa1", "aa2", "aa3", "aa4", "aa5", "aa6"]);
    const second = new DistillationEngine({ store });
    expect(second.route("find my notes about qq", tools).stage).toBe("workflow");
    second.disable(second.report().patterns[0]!.id);
    expect(second.route("find my notes about qq", tools).stage).toBe("llm");
  });

  test("the value report counts the model work compiled runs avoided", () => {
    const engine = new DistillationEngine({ store: new PatternStore() });
    learn(engine, ["aa1", "aa2", "aa3", "aa4", "aa5", "aa6"]);
    const route = engine.route("find my notes about qq", tools);
    engine.observe({ runId: "c1", request: "find my notes about qq", reply: reply([search("qq")], { compiled: { steps: 1, completed: true } }), route });
    expect(engine.report().totals).toMatchObject({ patterns: 1, compiled: 1, avoidedDecisions: 1, avoidedArgumentFills: 1 });
  });
});
