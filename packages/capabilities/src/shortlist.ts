import type { ToolDescriptor } from "./manifest.ts";

export interface ScoredTool {
  tool: ToolDescriptor;
  score: number;
}

const K1 = 1.5;
const B = 0.75;

/**
 * Cut the toolbox down to a shortlist for the decision model (Laya reads at
 * most ~16 options well). BM25 over names and descriptions.
 *
 * Limitation: this is lexical. A query in one language will not find a tool
 * described in another. An embedding stage is planned to close that gap; until
 * then, install tools with descriptions in the languages users speak.
 */
export class ToolIndex {
  private readonly docs: Array<{ tool: ToolDescriptor; tf: Map<string, number>; length: number }>;
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;

  constructor(tools: readonly ToolDescriptor[]) {
    this.docs = tools.map((tool) => {
      const tokens = tokenize(`${tool.name.replace(/[._-]+/g, " ")} ${tool.description} ${(tool.keywords ?? []).join(" ")}`);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { tool, tf, length: tokens.length };
    });
    for (const doc of this.docs) {
      for (const term of doc.tf.keys()) this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }
    const total = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgLength = this.docs.length ? total / this.docs.length : 0;
  }

  search(query: string, k = 16): ScoredTool[] {
    const terms = [...new Set(tokenize(query))];
    const n = this.docs.length;
    const scored: ScoredTool[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = 1 - B + B * (doc.length / (this.avgLength || 1));
        score += idf * ((f * (K1 + 1)) / (f + K1 * norm));
      }
      if (score > 0) scored.push({ tool: doc.tool, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : 1));
    return scored.slice(0, k);
  }
}

/** Lowercase words with a crude prefix stem so "events" and "события/событие" collapse. */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map((w) => (w.length > 5 ? w.slice(0, 5) : w));
}
