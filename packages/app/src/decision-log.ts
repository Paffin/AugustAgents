import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DecisionLog, DecisionRecord } from "@august/brain";

/** Training pairs for Laya, one JSON object per line. Holds task text: keep it private. */
export class JsonlDecisionLog implements DecisionLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  record(entry: DecisionRecord): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
}
