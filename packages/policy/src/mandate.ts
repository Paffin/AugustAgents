import {
  CONTROLLED_EFFECTS,
  DESTINATION_EFFECTS,
  type Effect,
  type PolicyCall,
} from "./types.ts";

export interface Mandate {
  id: string;
  description: string;
  /** Effects the user allowed. Tools must be listed explicitly. */
  effects: readonly Effect[];
  /** Exact tool names, or `server.*`. */
  tools: readonly string[];
  /** Required when effects include network, send or pay. Exact hosts or `*.example.com`. */
  destinations?: readonly string[];
  expiresAt: number;
  maxCalls?: number;
  /** Required when effects include pay. */
  maxTotal?: number;
  maxPerCall?: number;
  currency?: string;
  /** Default false: a mandate does not cover calls made from a tainted context. */
  allowTainted?: boolean;
}

interface MandateState {
  mandate: Mandate;
  calls: number;
  total: number;
  revoked: boolean;
}

export class MandateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MandateError";
  }
}

export class MandateStore {
  private readonly items = new Map<string, MandateState>();

  grant(mandate: Mandate): void {
    if (this.items.has(mandate.id)) throw new MandateError(`mandate "${mandate.id}" already exists`);
    if (mandate.tools.length === 0) throw new MandateError("a mandate must list its tools");
    if (mandate.effects.length === 0) throw new MandateError("a mandate must list its effects");
    if (mandate.effects.some((e) => DESTINATION_EFFECTS.has(e)) && !mandate.destinations?.length) {
      throw new MandateError("mandates with network, send or pay need a destination allowlist");
    }
    if (mandate.effects.includes("pay")) {
      if (!(mandate.maxTotal !== undefined && mandate.maxTotal > 0) || !mandate.currency) {
        throw new MandateError("payment mandates need a positive maxTotal and a currency");
      }
    }
    this.items.set(mandate.id, { mandate, calls: 0, total: 0, revoked: false });
  }

  revoke(id: string): void {
    const item = this.items.get(id);
    if (item) item.revoked = true;
  }

  usage(id: string): { calls: number; total: number } | undefined {
    const item = this.items.get(id);
    return item ? { calls: item.calls, total: item.total } : undefined;
  }

  /** First mandate that fully covers the call, or undefined. */
  match(call: PolicyCall, now: number): Mandate | undefined {
    for (const item of this.items.values()) {
      if (covers(item, call, now)) return item.mandate;
    }
    return undefined;
  }

  consume(id: string, call: PolicyCall): void {
    const item = this.items.get(id);
    if (!item) return;
    item.calls += 1;
    if (call.tool.effects.includes("pay") && call.amount !== undefined) item.total += call.amount;
  }
}

function covers(item: MandateState, call: PolicyCall, now: number): boolean {
  const { mandate } = item;
  if (item.revoked || now >= mandate.expiresAt) return false;
  if (mandate.maxCalls !== undefined && item.calls >= mandate.maxCalls) return false;
  if (!mandate.tools.some((pattern) => toolMatches(pattern, call.tool.name))) return false;

  const controlled = call.tool.effects.filter((e) => CONTROLLED_EFFECTS.has(e));
  if (!controlled.every((e) => mandate.effects.includes(e))) return false;

  const needsDestination = controlled.some((e) => DESTINATION_EFFECTS.has(e));
  if (needsDestination) {
    if (!call.destination || !mandate.destinations?.some((d) => hostMatches(d, call.destination!))) {
      return false;
    }
  }

  if (controlled.includes("pay")) {
    const amount = call.amount;
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0) return false;
    if (call.currency !== mandate.currency) return false;
    if (mandate.maxPerCall !== undefined && amount > mandate.maxPerCall) return false;
    if (mandate.maxTotal === undefined || item.total + amount > mandate.maxTotal) return false;
  }
  return true;
}

export function toolMatches(pattern: string, name: string): boolean {
  if (pattern.endsWith(".*")) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}
