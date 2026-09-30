import { afterEach,describe,expect,test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetAdmissionError,DurableRuntimeStore,makeSessionKey,type BudgetPolicy } from "../src/index.ts";

// Budget safety/product regressions. Owned durable fixtures, not model/frontend acceptance.
const dirs:string[]=[],stores:DurableRuntimeStore[]=[];
afterEach(()=>{stores.splice(0).forEach(s=>s.close());dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
const now=Date.parse("2026-09-30T12:00:00Z"),session=makeSessionKey({workspace:"owned",channel:"test",user:"quota"});
const quote={inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000,source:"explicit regression quote",asOf:"2026-09-30"};
function store(policy:BudgetPolicy,path=":memory:"){const s=new DurableRuntimeStore(path,{budgetPolicy:policy});stores.push(s);return s;}
function run(s:DurableRuntimeStore){const r=s.startRun({session,request:randomUUID(),budget:{maxTokens:100,maxCostMicros:100},now}).run;s.transition(r.id,"running");return r.id;}
const attempt=(tool?:string,completionTokens=10)=>({id:randomUUID(),provider:"owned",model:"fixture",requestHash:"a".repeat(64),tool,completionTokens});

describe("durable owner budget ledger",()=>{
  test("a clipped hold cannot admit known completion exposure above run, day or tool money",()=>{
    for(const [policy,reason] of [
      [{timeZone:"UTC",daily:{costMicros:1}},"daily-budget"],
      [{timeZone:"UTC",tools:{"writer.create":{costMicros:1}}},"tool-budget"],
    ] as const) {
      const s=store(policy),id=run(s);
      expect(()=>s.beginModelAttempt(id,attempt("writer.create",10),quote,now)).toThrow(reason);
      expect(s.modelAttempts(id)).toHaveLength(0);
      s.beginModelAttempt(id,attempt("writer.create",1),quote,now);
      expect(s.budgetSnapshot(now).daily.heldCostMicros).toBe(1);
    }
    const s=store({timeZone:"UTC"}),r=s.startRun({session,request:randomUUID(),budget:{maxCostMicros:1},now}).run;s.transition(r.id,"running");
    expect(()=>s.beginModelAttempt(r.id,attempt(undefined,10),quote,now)).toThrow("cost-budget");
    expect(s.modelAttempts(r.id)).toHaveLength(0);
  });
  test("fractional output quotes round up before money admission",()=>{
    const s=store({timeZone:"UTC",daily:{costMicros:1}}),id=run(s),q={...quote,outputMicrosPerMillion:600_000};
    expect(()=>s.beginModelAttempt(id,attempt(undefined,2),q,now)).toThrow("daily-budget");
    expect(s.modelAttempts(id)).toHaveLength(0);
  });
  test("shared daily token/cost admission includes reservations and atomically refuses another run",()=>{
    const s=store({timeZone:"UTC",daily:{tokens:10,costMicros:20}}),first=run(s),second=run(s),a=attempt();
    s.beginModelAttempt(first,a,quote,now);expect(s.budgetSnapshot(now).daily).toMatchObject({tokens:0,heldTokens:10,heldCostMicros:20,remainingTokens:0});
    expect(()=>s.beginModelAttempt(second,attempt(),quote,now)).toThrow(BudgetAdmissionError);
    expect(s.modelAttempts(second)).toHaveLength(0);
    s.reportModelAttempt(a.id,{inputTokens:2,outputTokens:3,totalTokens:5},"provider",now);
    expect(s.budgetSnapshot(now).daily).toMatchObject({tokens:5,costMicros:5,heldTokens:0,heldCostMicros:0,remainingTokens:5,remainingCostMicros:15});
    s.beginModelAttempt(second,attempt(undefined,5),quote,now);expect(s.budgetSnapshot(now).daily.remainingTokens).toBe(0);
  });
  test("unknown holds survive restart and owner midnight; received usage stays on its request day",()=>{
    const dir=mkdtempSync(join(tmpdir(),"august-owner-ledger-"));dirs.push(dir);const path=join(dir,"runtime.db"),policy={timeZone:"Europe/Moscow",daily:{tokens:10,costMicros:20}};
    let s=store(policy,path);const id=run(s),a=attempt(),before=Date.parse("2026-09-30T20:59:59.999Z"),after=before+1;
    s.beginModelAttempt(id,a,quote,before);s.finishModelAttempt(a.id,"unknown","timeout",before);s.close();
    s=store(policy,path);expect(s.budgetSnapshot(after).period.key).toBe("2026-10-01");expect(s.budgetSnapshot(after).daily).toMatchObject({tokens:0,heldTokens:10,remainingTokens:0});
    s.reportModelAttempt(a.id,{inputTokens:2,outputTokens:3,totalTokens:5},"owner",after);
    expect(s.budgetSnapshot(after).daily).toMatchObject({tokens:0,costMicros:0,heldTokens:0,remainingTokens:10});
    expect(s.budgetSnapshot(before).daily).toMatchObject({tokens:5,costMicros:5});
  });
  test("host tool identity attributes only its declared model attempts and each frozen quote",()=>{
    const s=store({timeZone:"UTC",tools:{"writer.create":{tokens:10,costMicros:20,calls:2,callCostMicros:0}}}),id=run(s),a=attempt("writer.create");
    s.beginModelAttempt(id,a,quote,now);s.reportModelAttempt(a.id,{inputTokens:3,outputTokens:2,totalTokens:5},"provider",now);
    expect(s.budgetSnapshot(now).tools["writer.create"]).toMatchObject({tokens:5,costMicros:5,remainingTokens:5,remainingCalls:2});
    expect(()=>s.beginModelAttempt(id,attempt("writer.create",6),quote,now)).toThrow("tool-budget");
    expect(s.modelAttempts(id)).toHaveLength(1);
  });
  test("tool call reservation rejects races/replay and separates owner estimates from unknown fees",()=>{
    const s=store({timeZone:"UTC",daily:{costMicros:10},tools:{"writer.create":{calls:1,costMicros:10,callCostMicros:7}}}),id=run(s),a=randomUUID();
    s.beginToolAttempt(id,a,"writer.create","b".repeat(64),now);expect(s.budgetSnapshot(now).tools["writer.create"]).toMatchObject({heldCalls:1,heldCostMicros:7,remainingCalls:0});
    expect(()=>s.beginToolAttempt(run(s),randomUUID(),"writer.create","b".repeat(64),now)).toThrow("tool-budget");expect(()=>s.beginToolAttempt(id,a,"writer.create","b".repeat(64),now)).toThrow("never replay");
    s.finishToolAttempt(a,"estimated",now);expect(s.budgetSnapshot(now).daily).toMatchObject({costMicros:7,heldCostMicros:0,calls:1});
    expect(()=>s.beginToolAttempt(id,randomUUID(),"unquoted.api","c".repeat(64),now)).toThrow("explicit callCostMicros");
  });
  test("explicit free tool execution remains admissible after daily model allowance is exhausted",()=>{
    const s=store({timeZone:"UTC",daily:{tokens:0,costMicros:0},tools:{"fs.read":{calls:2,callCostMicros:0}}}),id=run(s);
    expect(()=>s.beginModelAttempt(id,attempt(),quote,now)).toThrow("daily-budget");
    const a=randomUUID();s.beginToolAttempt(id,a,"fs.read","c".repeat(64),now);s.finishToolAttempt(a,"estimated",now);
    expect(s.budgetSnapshot(now).daily).toMatchObject({tokens:0,costMicros:0,calls:1});
    expect(s.budgetSnapshot(now).tools["fs.read"]!.remainingCalls).toBe(1);
  });
  test("historical unpriced calls do not make a new explicitly free call billable",()=>{
    const dir=mkdtempSync(join(tmpdir(),"august-unpriced-history-"));dirs.push(dir);const path=join(dir,"runtime.db");
    let s=store({timeZone:"UTC"},path);const id=run(s),a=randomUUID();s.beginToolAttempt(id,a,"unpriced.api","a".repeat(64),now);s.finishToolAttempt(a,"estimated",now);s.close();
    s=store({timeZone:"UTC",daily:{costMicros:0},tools:{"fs.read":{calls:1,callCostMicros:0}}},path);
    const next=run(s),b=randomUUID();s.beginToolAttempt(next,b,"fs.read","b".repeat(64),now);s.finishToolAttempt(b,"estimated",now);
    expect(s.budgetSnapshot(now).daily).toMatchObject({unpricedCalls:1,costMicros:0,calls:2});
  });
});
