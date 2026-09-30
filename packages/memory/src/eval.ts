import type { MemoryStore } from "./store.ts";
import type { MemoryClass } from "./types.ts";

/** A question with the memories that answer it, named by their text (ids differ between stores). */
export interface RetrievalCase {
  query: string;
  /** Any entry whose text contains one of these counts as a correct hit. */
  expect: readonly string[];
  classes?: readonly MemoryClass[];
}

export interface RetrievalReport {
  cases: number;
  k: number;
  /** Share of cases with a correct entry in the top k. */
  recallAtK: number;
  /** Mean of 1/rank of the first correct entry (0 when none was found). */
  mrr: number;
  misses: string[];
}

/**
 * Measures retrieval on labelled questions without disturbing what it measures: the runs do not count as uses,
 * so evaluating never changes the ranking. Run it on the owner's own memory (`august memory eval FILE`) and in
 * regression tests on a fixed corpus.
 */
export function evaluateRetrieval(store: MemoryStore, scope: string, cases: readonly RetrievalCase[], k = 5): RetrievalReport {
  let found = 0; let reciprocal = 0; const misses: string[] = [];
  for (const c of cases) {
    const hits = store.recall({ scope, query: c.query, classes: c.classes, limit: k, touch: false });
    const at = hits.findIndex((h) => c.expect.some((needle) => h.entry.text.includes(needle)));
    if (at >= 0) { found += 1; reciprocal += 1 / (at + 1); } else misses.push(c.query);
  }
  return { cases: cases.length, k, recallAtK: cases.length ? found / cases.length : 0, mrr: cases.length ? reciprocal / cases.length : 0, misses };
}
/** Same held-out metric over the configured real hybrid path, without touching ranking counters. */
export async function evaluateRetrievalHybrid(store:MemoryStore,scope:string,cases:readonly RetrievalCase[],k=5):Promise<RetrievalReport>{
  let found=0,reciprocal=0;const misses:string[]=[];
  for(const c of cases){const hits=await store.recallHybrid({scope,query:c.query,classes:c.classes,limit:k,touch:false});const at=hits.findIndex(h=>c.expect.some(needle=>h.entry.text.includes(needle)));if(at>=0){found++;reciprocal+=1/(at+1);}else misses.push(c.query);}
  return {cases:cases.length,k,recallAtK:cases.length?found/cases.length:0,mrr:cases.length?reciprocal/cases.length:0,misses};
}
