import { createHash } from "node:crypto";

/** One call as it was made: the tool and the arguments the model filled. */
export interface ObservedCall {
  tool: string;
  args: Record<string, unknown>;
}

/** A value in an argument template: a constant, or the text the request supplied for a slot. */
export type ArgTemplate = { $slot: number } | string | number | boolean | null | ArgTemplate[] | { [key: string]: ArgTemplate };

export interface PatternTemplate {
  /** The request with the variable parts replaced by `{{n}}`. */
  request: string;
  slots: number;
  steps: Array<{ tool: string; args: { [key: string]: ArgTemplate } }>;
}

const MIN_SLOT_CHARS = 2;
const normalize = (text: string): string => text.trim().replace(/\s+/g, " ");
const isSlot = (v: unknown): v is { $slot: number } => typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $slot?: unknown }).$slot === "number";

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === "string") { if (value.length >= MIN_SLOT_CHARS) out.add(value); }
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
}

function templateValue(value: unknown, slotOf: (s: string) => number | undefined): ArgTemplate {
  if (typeof value === "string") { const slot = slotOf(value); return slot === undefined ? value : { $slot: slot }; }
  if (Array.isArray(value)) return value.map((v) => templateValue(v, slotOf));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, templateValue(v, slotOf)]));
  return value as ArgTemplate;
}

/**
 * Generalizes one observed run: any argument text that the user's own request contained becomes a slot, and
 * everything else stays a constant. The request text is what varies between runs, so a constant that did not come
 * from the request (a fixed path, a chosen flag) is part of the pattern, not a guess about it. Returns undefined
 * when the request has nothing fixed left to recognise it by.
 */
export function deriveTemplate(request: string, calls: readonly ObservedCall[]): PatternTemplate | undefined {
  const text = normalize(request);
  if (!text || calls.length === 0) return undefined;
  const candidates = new Set<string>();
  for (const call of calls) collectStrings(call.args, candidates);
  // Longest first, so a slot is never carved out of a longer value; only values the request really contains.
  const inRequest = [...candidates].filter((c) => normalize(c) === c && text.includes(c)).sort((a, b) => b.length - a.length);
  const taken: Array<{ start: number; end: number; value: string }> = [];
  for (const value of inRequest) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(value, from);
      if (at < 0) break;
      from = at + value.length;
      if (!taken.some((t) => at < t.end && at + value.length > t.start)) taken.push({ start: at, end: at + value.length, value });
    }
  }
  taken.sort((a, b) => a.start - b.start);
  const slotValues: string[] = [];
  let request_ = ""; let cursor = 0;
  for (const t of taken) {
    let n = slotValues.indexOf(t.value); if (n < 0) { n = slotValues.length; slotValues.push(t.value); }
    request_ += `${text.slice(cursor, t.start)}{{${n}}}`; cursor = t.end;
  }
  request_ += text.slice(cursor);
  // Something must stay fixed, or the pattern would claim every request.
  if (request_.replace(/\{\{\d+\}\}/g, "").replace(/\s+/g, "").length < 3) return undefined;
  const slotOf = (s: string): number | undefined => { const n = slotValues.indexOf(s); return n < 0 ? undefined : n; };
  return { request: request_, slots: slotValues.length, steps: calls.map((c) => ({ tool: c.tool, args: templateValue(c.args, slotOf) as { [key: string]: ArgTemplate } })) };
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(template: PatternTemplate): RegExp {
  const seen = new Set<number>();
  const source = template.request.split(/(\{\{\d+\}\})/).map((part) => {
    const m = /^\{\{(\d+)\}\}$/.exec(part);
    if (!m) return escape(part).replace(/ /g, "\\s+");
    const n = Number(m[1]);
    // A slot that appears twice must capture the same text both times.
    if (seen.has(n)) return `\\k<s${n}>`;
    seen.add(n);
    return `(?<s${n}>\\S(?:[\\s\\S]*?\\S)?)`;
  }).join("");
  return new RegExp(`^${source}$`, "u");
}

/** The slot values a request supplies, or undefined when the request is not an instance of the template. */
export function matchRequest(template: PatternTemplate, request: string): string[] | undefined {
  const m = compile(template).exec(normalize(request));
  if (!m) return undefined;
  const values: string[] = [];
  for (let n = 0; n < template.slots; n++) { const v = m.groups?.[`s${n}`]; if (v === undefined) return undefined; values.push(v); }
  return values;
}

function fill(value: ArgTemplate, slots: readonly string[]): unknown {
  if (isSlot(value)) return slots[value.$slot];
  if (Array.isArray(value)) return value.map((v) => fill(v, slots));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, slots)]));
  return value;
}

/** The exact calls this template makes for a request, or undefined when the request is not an instance of it. */
export function instantiate(template: PatternTemplate, request: string): ObservedCall[] | undefined {
  const slots = matchRequest(template, request);
  if (!slots) return undefined;
  return template.steps.map((s) => ({ tool: s.tool, args: fill(s.args, slots) as Record<string, unknown> }));
}

/** Stable identity of what a pattern does: the request shape and the calls. Two runs of one task share it. */
export function patternId(template: PatternTemplate): string {
  return createHash("sha256").update(JSON.stringify(template)).digest("hex").slice(0, 16);
}

/** A human-readable procedure: the steps a pattern takes, for guidance and for the owner to read. */
export function describeProcedure(template: PatternTemplate): string {
  const show = (v: ArgTemplate): string => (isSlot(v) ? `<${v.$slot + 1}>` : JSON.stringify(v));
  return template.steps.map((s, i) => `${i + 1}. ${s.tool}(${Object.entries(s.args).map(([k, v]) => `${k}=${show(v)}`).join(", ")})`).join("\n");
}
