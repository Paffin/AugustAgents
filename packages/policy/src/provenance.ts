/** How private a piece of content is. Ordered: a context is as sensitive as its most sensitive part. */
export const SENSITIVITIES = ["public", "personal", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === "string" && (SENSITIVITIES as readonly string[]).includes(value);
}
export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITIES.indexOf(a) >= SENSITIVITIES.indexOf(b) ? a : b;
}
export function sensitivityAtLeast(value: Sensitivity, floor: Sensitivity): boolean {
  return SENSITIVITIES.indexOf(value) >= SENSITIVITIES.indexOf(floor);
}

export const ORIGIN_KINDS = ["user", "builtin", "mcp", "skill", "file", "registry", "unknown"] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

/** Where a piece of content came from. `source` is the capability or tool that produced it. */
export interface ContentOrigin {
  kind: OriginKind;
  source: string;
  /** A path or URI inside the source, when the content names one. */
  locator?: string;
}

/**
 * One fragment of a tool result. Trust belongs to the fragment, not to the
 * tool: a tool that mostly returns its own computation can still hand back
 * text somebody else wrote next to it. A server's own metadata (annotations,
 * hints, audience) never raises the trust of a part; only the host that built
 * the part decides, from what it can verify.
 */
export interface ContentPart {
  text: string;
  origin: ContentOrigin;
  trust: "trusted" | "untrusted";
  sensitivity: Sensitivity;
}

const SOURCE_LABEL = /[^A-Za-z0-9_.@:/-]/g;

/** The producing capability or tool, safe to show and to store as a taint source. */
export function sourceLabel(origin: ContentOrigin): string {
  return origin.source.replace(SOURCE_LABEL, "_");
}

/** A prompt-safe name for the part's origin, e.g. `mail.read` or `fs.read:notes/a.txt`. */
export function originLabel(origin: ContentOrigin): string {
  return origin.locator ? `${sourceLabel(origin)}:${origin.locator.replace(SOURCE_LABEL, "_").slice(0, 120)}` : sourceLabel(origin);
}

/** The single part a tool result becomes when the executor reports no parts, judged by the tool alone. */
export function wholeResultPart(text: string, tool: { name: string; producesUntrusted?: boolean }): ContentPart {
  return {
    text,
    origin: { kind: "unknown", source: tool.name },
    trust: tool.producesUntrusted ? "untrusted" : "trusted",
    sensitivity: "public",
  };
}

export function validateContentPart(part: unknown): asserts part is ContentPart {
  const p = part as Partial<ContentPart> | null;
  const o = p?.origin as Partial<ContentOrigin> | undefined;
  if (!p || typeof p.text !== "string" || !o || !(ORIGIN_KINDS as readonly string[]).includes(o.kind as string) || typeof o.source !== "string" || o.source.length === 0 || (o.locator !== undefined && typeof o.locator !== "string") || (p.trust !== "trusted" && p.trust !== "untrusted") || !isSensitivity(p.sensitivity)) {
    throw new Error("invalid ContentPart");
  }
}
