import { describe, expect, test } from "bun:test";
import { LAYA_HEAD_TOKEN_BUDGET, LAYA_MAX_OPTIONS, estimateTokens, fitShortlist, validateQuestion, withNoneOption } from "../src/index.ts";

// Suite category: Reliability invariant. A shortlist that is too long for the decision model is cut, never a reason for a run to fail.
describe("fitShortlist", () => {
  const tool = (i: number, chars = 80) => ({ name: `srv.tool${i}`, description: "d".repeat(chars) });
  const question = (list: ReturnType<typeof tool>[]) => ({ id: "tool-choice", instructions: "Which tool?", options: withNoneOption(list.map((t) => ({ key: t.name, description: t.description.slice(0, 120) }))) });

  test("keeps the best-ranked tools that fit, and what it returns is always a valid question", () => {
    const many = Array.from({ length: 30 }, (_, i) => tool(i, 150));
    const fit = fitShortlist(many, "Which tool?");
    expect(fit.length).toBeGreaterThan(0);
    expect(fit.length).toBeLessThan(many.length);
    expect(fit).toEqual(many.slice(0, fit.length));
    expect(() => validateQuestion({ ...question(fit), instructions: "Which tool?" })).not.toThrow();
    expect(fit.length + 1).toBeLessThanOrEqual(LAYA_MAX_OPTIONS);
    expect(estimateTokens("Which tool?" + fit.map((t) => `${t.name} ${t.description.slice(0, 120)}`).join(" "))).toBeLessThanOrEqual(LAYA_HEAD_TOKEN_BUDGET);
  });

  test("a short list is returned whole", () => {
    const few = [tool(1, 20), tool(2, 20)];
    expect(fitShortlist(few, "Which tool?")).toEqual(few);
  });
});
