import type { Database } from "bun:sqlite";
import { ownerDay, type OwnerDay } from "./budget-period.ts";

export interface BudgetPolicy {
  timeZone: string;
  daily?: { tokens?: number; costMicros?: number };
  tools?: Record<string, { calls?: number; tokens?: number; costMicros?: number; callCostMicros?: number }>;
}
export interface BudgetTotals {
  tokens: number; costMicros: number; heldTokens: number; heldCostMicros: number;
  calls: number; heldCalls: number; unpricedCalls: number;
}
export interface BudgetSnapshot {
  period: OwnerDay;
  daily: BudgetTotals & { limits: NonNullable<BudgetPolicy["daily"]>; remainingTokens?: number; remainingCostMicros?: number;legacyUsage?:boolean };
  tools: Record<string, BudgetTotals & { limits: NonNullable<BudgetPolicy["tools"]>[string]; remainingCalls?: number; remainingTokens?: number; remainingCostMicros?: number }>;
}
export class BudgetAdmissionError extends Error {
  constructor(readonly reason: "daily-budget" | "tool-budget" | "cost-budget", readonly detail: string) { super(`${reason}: ${detail}`); this.name = "BudgetAdmissionError"; }
}
export const TOOL_ATTEMPTS_SQL = `CREATE TABLE tool_attempts (
  id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),tool TEXT NOT NULL,args_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('in_flight','estimated','unknown','not_sent')),
  quote_micros INTEGER CHECK(quote_micros>=0),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  UNIQUE(run_id,id))`;

const empty = (): BudgetTotals => ({tokens:0,costMicros:0,heldTokens:0,heldCostMicros:0,calls:0,heldCalls:0,unpricedCalls:0});
const safe = (value: bigint): number => { const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw Error("budget totals exceed safe integer range");return n; };
const micros = (value: bigint) => safe((value+999_999n)/1_000_000n);
interface Amounts { totals: BudgetTotals; numerator: bigint }
const amount = (): Amounts => ({totals:empty(),numerator:0n});

/** Uses the caller's same SQLite transaction for admission, never an in-memory spend counter. */
export class BudgetLedger {
  constructor(private readonly db: Database) {}

  snapshot(policy: BudgetPolicy, now = Date.now()): BudgetSnapshot {
    const period=ownerDay(policy.timeZone,now),daily=amount(),tools=new Map<string,Amounts>();
    const forTool=(name:string)=>{let value=tools.get(name);if(!value){value=amount();tools.set(name,value);}return value;};
    const models=this.db.query("SELECT tool_id,state,reserved_tokens,reserved_cost_micros,quote_json,usage_json FROM model_attempts WHERE (created_at>=? AND created_at<?) OR state IN ('in_flight','unknown')").all(period.startsAt,period.endsAt) as Array<{tool_id:string|null;state:string;reserved_tokens:number;reserved_cost_micros:number;quote_json:string;usage_json:string|null}>;
    for(const row of models) {
      if(row.state==="not_sent")continue;
      const targets=[daily,...(row.tool_id?[forTool(row.tool_id)]:[])];
      if(row.state==="reported") {
        const u=JSON.parse(row.usage_json!) as {inputTokens:number;outputTokens:number;totalTokens:number},q=JSON.parse(row.quote_json) as {inputMicrosPerMillion:number;outputMicrosPerMillion:number};
        if(![u.inputTokens,u.outputTokens,u.totalTokens,q.inputMicrosPerMillion,q.outputMicrosPerMillion].every(x=>Number.isSafeInteger(x)&&x>=0)||u.totalTokens!==u.inputTokens+u.outputTokens)throw Error("invalid budget usage/quote");
        const cost=BigInt(u.inputTokens)*BigInt(q.inputMicrosPerMillion)+BigInt(u.outputTokens)*BigInt(q.outputMicrosPerMillion);
        for(const target of targets){target.totals.tokens=safe(BigInt(target.totals.tokens)+BigInt(u.totalTokens));target.numerator+=cost;}
      } else for(const target of targets) {
        target.totals.heldTokens=safe(BigInt(target.totals.heldTokens)+BigInt(row.reserved_tokens));
        target.totals.heldCostMicros=safe(BigInt(target.totals.heldCostMicros)+BigInt(row.reserved_cost_micros));
      }
    }
    // Legacy totals have no attempt/tool timestamps. Preserve their received estimate on the run's creation day.
    const legacy=this.db.query("SELECT r.id,r.input_tokens,r.output_tokens,r.cost_numerator FROM runs r JOIN runtime_meta m ON m.key='billing_legacy:'||r.id WHERE r.created_at>=? AND r.created_at<?").all(period.startsAt,period.endsAt) as Array<{id:string;input_tokens:number;output_tokens:number;cost_numerator:string}>;
    for(const row of legacy){
      if(![row.input_tokens,row.output_tokens].every(x=>Number.isSafeInteger(x)&&x>=0)||!/^(0|[1-9][0-9]{0,63})$/.test(row.cost_numerator))throw Error("invalid legacy budget totals");
      let tokens=BigInt(row.input_tokens)+BigInt(row.output_tokens),cost=BigInt(row.cost_numerator);
      for(const received of this.db.query("SELECT usage_json,quote_json FROM model_attempts WHERE run_id=? AND state='reported'").all(row.id) as Array<{usage_json:string;quote_json:string}>){
        const u=JSON.parse(received.usage_json) as {inputTokens:number;outputTokens:number;totalTokens:number},q=JSON.parse(received.quote_json) as {inputMicrosPerMillion:number;outputMicrosPerMillion:number};
        tokens-=BigInt(u.totalTokens);cost-=BigInt(u.inputTokens)*BigInt(q.inputMicrosPerMillion)+BigInt(u.outputTokens)*BigInt(q.outputMicrosPerMillion);
      }
      if(tokens<0n||cost<0n)throw Error("legacy totals conflict with received model attempts");
      daily.totals.tokens=safe(BigInt(daily.totals.tokens)+tokens);daily.numerator+=cost;
    }
    const calls=this.db.query("SELECT tool,state,quote_micros FROM tool_attempts WHERE (created_at>=? AND created_at<?) OR state IN ('in_flight','unknown')").all(period.startsAt,period.endsAt) as Array<{tool:string;state:string;quote_micros:number|null}>;
    for(const row of calls) {
      if(row.state==="not_sent")continue;
      for(const target of [daily,forTool(row.tool)]) {
        if(row.quote_micros===null)target.totals.unpricedCalls++;
        else if(!Number.isSafeInteger(row.quote_micros)||row.quote_micros<0)throw Error("invalid retained tool quote");
        if(row.state==="estimated") {target.totals.calls++;target.numerator+=BigInt(row.quote_micros??0)*1_000_000n;}
        else {target.totals.heldCalls++;target.totals.heldCostMicros=safe(BigInt(target.totals.heldCostMicros)+BigInt(row.quote_micros??0));}
      }
    }
    daily.totals.costMicros=micros(daily.numerator);
    const remaining=(limit:number|undefined,spent:number,held:number)=>limit===undefined?undefined:Math.max(0,limit-spent-held);
    const dailyLimits=policy.daily??{};
    const snapshot:BudgetSnapshot={period,daily:{...daily.totals,limits:{...dailyLimits},remainingTokens:remaining(dailyLimits.tokens,daily.totals.tokens,daily.totals.heldTokens),remainingCostMicros:remaining(dailyLimits.costMicros,daily.totals.costMicros,daily.totals.heldCostMicros),...(legacy.length?{legacyUsage:true}:{})},tools:{}};
    for(const name of new Set([...Object.keys(policy.tools??{}),...tools.keys()])) {
      const a=tools.get(name)??amount();a.totals.costMicros=micros(a.numerator);const limits=policy.tools?.[name]??{};
      Object.defineProperty(snapshot.tools,name,{enumerable:true,value:{...a.totals,limits:{...limits},remainingCalls:remaining(limits.calls,a.totals.calls,a.totals.heldCalls),remainingTokens:remaining(limits.tokens,a.totals.tokens,a.totals.heldTokens),remainingCostMicros:remaining(limits.costMicros,a.totals.costMicros,a.totals.heldCostMicros)}});
    }
    return snapshot;
  }

  admitModel(policy:BudgetPolicy, tokens:number, paid:boolean, completionCostMicros:number, tool?:string, now=Date.now()): {costMicros?:number} {
    const s=this.snapshot(policy,now);
    if(s.daily.remainingTokens!==undefined&&s.daily.remainingTokens<tokens)throw new BudgetAdmissionError("daily-budget","token allowance is exhausted or reserved");
    if(paid&&s.daily.remainingCostMicros!==undefined&&(s.daily.unpricedCalls||s.daily.remainingCostMicros===0))throw new BudgetAdmissionError("daily-budget","cost allowance is exhausted, reserved or unknown");
    if(s.daily.remainingCostMicros!==undefined&&completionCostMicros>s.daily.remainingCostMicros)throw new BudgetAdmissionError("daily-budget","quoted completion exposure exceeds the remaining daily allowance");
    const t=tool?s.tools[tool]:undefined;
    if(t?.remainingCalls===0||t?.remainingTokens!==undefined&&t.remainingTokens<tokens||paid&&t?.remainingCostMicros!==undefined&&(t.unpricedCalls||t.remainingCostMicros===0))throw new BudgetAdmissionError("tool-budget","tool allowance is exhausted, reserved or unknown");
    if(t?.remainingCostMicros!==undefined&&completionCostMicros>t.remainingCostMicros)throw new BudgetAdmissionError("tool-budget","quoted completion exposure exceeds the remaining tool allowance");
    return {costMicros:[s.daily.remainingCostMicros,t?.remainingCostMicros].filter((x):x is number=>x!==undefined).reduce<number|undefined>((a,b)=>a===undefined?b:Math.min(a,b),undefined)};
  }

  beginTool(runId:string,id:string,tool:string,argsHash:string,policy:BudgetPolicy,now=Date.now()): void {
    const prior=this.db.query("SELECT run_id,tool,args_hash FROM tool_attempts WHERE id=?").get(id) as {run_id:string;tool:string;args_hash:string}|null;
    if(prior)throw Error(prior.run_id===runId&&prior.tool===tool&&prior.args_hash===argsHash?"tool attempt already exists; never replay a possibly started effect":"tool reservation conflicts");
    const s=this.snapshot(policy,now),t=s.tools[tool],quote=policy.tools?.[tool]?.callCostMicros;
    if(t?.remainingCalls===0)throw new BudgetAdmissionError("tool-budget","tool call allowance is exhausted or reserved");
    if(quote===undefined&&(policy.daily?.costMicros!==undefined||t?.limits.costMicros!==undefined))throw new BudgetAdmissionError("tool-budget","set an explicit callCostMicros quote, including zero for free tools");
    if(quote!==undefined&&quote>0&&(s.daily.remainingCostMicros!==undefined&&(s.daily.unpricedCalls||quote>s.daily.remainingCostMicros)))throw new BudgetAdmissionError("daily-budget","tool estimate exceeds the remaining daily allowance");
    if(quote!==undefined&&quote>0&&t?.remainingCostMicros!==undefined&&(t.unpricedCalls||quote>t.remainingCostMicros))throw new BudgetAdmissionError("tool-budget","tool estimate exceeds its remaining allowance");
    this.db.query("INSERT INTO tool_attempts VALUES (?,?,?,?,'in_flight',?,?,?)").run(id,runId,tool,argsHash,quote??null,now,now);
  }
  finishTool(id:string,disposition:"estimated"|"unknown"|"not_sent",now=Date.now()):void {
    const row=this.db.query("SELECT state FROM tool_attempts WHERE id=?").get(id) as {state:string}|null;if(!row)throw Error("unknown tool attempt");
    if(row.state!=="in_flight"&&row.state!=="unknown") {if(row.state!==disposition)throw Error("tool disposition conflicts");return;}
    this.db.query("UPDATE tool_attempts SET state=?,updated_at=? WHERE id=?").run(disposition,now,id);
  }
}
