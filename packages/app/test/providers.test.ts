import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FallbackProvider, LlmAttemptObserverError, LlmError, UsageRequiredProvider, type LlmAttemptEvent, type LlmUsage, type ProviderCircuitState } from "@august/brain";
import { Database } from "bun:sqlite";
import { DurableRuntimeStore, makeSessionKey } from "@august/core";
import { createApp } from "../src/bootstrap.ts";
import { createLlm, quoteForModelAttempt } from "../src/providers.ts";
import { parseConfig } from "../src/config.ts";
import { EncryptedFileStore } from "../src/secrets.ts";
import { defaultConfig } from "./config-fixture.ts";

// Product/budget and security regressions over owned HTTP sockets. Synthetic model bytes, NOT live acceptance.
const dirs: string[] = [], servers: Bun.Server<undefined>[] = [];
afterEach(() => { servers.splice(0).forEach(s => s.stop(true)); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "august-provider-regression-")); dirs.push(home);
  const config = defaultConfig(home); config.llm.apiKeyEnv = undefined;
  return { home, config, store: new EncryptedFileStore(join(home,"secrets"),randomBytes(32)) };
}
function endpoint(port = 0) {
  let calls=0;
  const server=Bun.serve({hostname:"127.0.0.1",port,async fetch(request) {
    if(new URL(request.url).pathname!=="/chat/completions") return new Response(null,{status:404}); calls++;
    const body = await request.json() as { response_format?: { json_schema?: { name?: string } } };
    return Response.json({choices:[{message:{content:body.response_format?.json_schema?.name === "decision" ? JSON.stringify({choice:"none"}) : "regression fixture only"}}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}});
  }});servers.push(server);return {url:`http://127.0.0.1:${server.port}`,server,calls:()=>calls};
}

describe("configured primary and backup providers",()=>{
  test("backup models/keys/timeouts/retries/cooldown are validated, never selected or priced by preset",()=>{
    const {config,store}=fixture();
    for(const backup of [{...config.llm,model:""},{...config.llm,apiKeyEnv:"raw-token"},{...config.llm,baseUrl:"http://remote.test"},{...config.llm,timeoutMs:-1},{...config.llm,retries:1.5}])expect(()=>parseConfig({...config,llm:{...config.llm,backup}})).toThrow();
    expect(()=>parseConfig({...config,llm:{...config.llm,cooldownMs:-1}})).toThrow();
    const backup={...config.llm,model:"owner-selected-backup",pricing:undefined};
    expect(()=>createLlm({...config,llm:{...config.llm,backup}}, {env:{}},store)).toThrow("pricing is missing");
    expect(parseConfig({...config,llm:{...config.llm,timeoutMs:180000,retries:0,cooldownMs:60000,backup:{...config.llm,model:"owner-selected-backup"}}}).llm.backup?.model).toBe("owner-selected-backup");
  });

  test("physical unreachable primary runs backup, respects cooldown across calls and binds each attempt to its own quote",async()=>{
    const {config,store}=fixture(),primary=endpoint(),backup=endpoint(); primary.server.stop(true);
    config.llm={...config.llm,baseUrl:primary.url,model:"owner-primary-fixture",retries:0,cooldownMs:60000,backup:{...config.llm,baseUrl:backup.url,model:"owner-backup-fixture",retries:0,pricing:{inputMicrosPerMillion:17,outputMicrosPerMillion:33,source:"explicit regression quote",asOf:"2026-09-30"}}};
    const provider=createLlm(parseConfig(config),{env:{}},store),events:LlmAttemptEvent[]=[];
    for(let i=0;i<2;i++)expect(await provider.complete([],{requireUsage:true,onAttempt:e=>{events.push(e);}})).toBe("regression fixture only");
    const started=events.filter(e=>e.type==="started"); expect(started).toHaveLength(3); expect(started.filter(e=>e.provider.startsWith("primary:"))).toHaveLength(1);
    expect(events.some(e=>e.type==="failed"&&e.outcome==="not_sent")).toBe(true);expect(backup.calls()).toBe(2);expect(primary.calls()).toBe(0);
    for(const event of started)expect(quoteForModelAttempt(config,event.provider,false)).toEqual(event.provider.startsWith("backup:")?config.llm.backup!.pricing!:config.llm.pricing!);
    expect(()=>quoteForModelAttempt(config,"unknown-provider",false)).toThrow("no configured provider quote");
  });

  test("expired cooldown permits a recovery probe and successful recovery clears the failure",async()=>{
    let now=1000,primaryCalls=0,backupCalls=0,down=true;
    const provider=new FallbackProvider([{name:"owned-primary",complete:async()=>{primaryCalls++;if(down)throw new LlmError("unavailable",true);return "primary regression";}},{name:"owned-backup",complete:async()=>{backupCalls++;return "backup regression";}}],{cooldownMs:100,now:()=>now});
    expect(await provider.complete([])).toBe("backup regression");expect(await provider.complete([])).toBe("backup regression");expect(primaryCalls).toBe(1);expect(backupCalls).toBe(2);
    down=false;now=1100;expect(await provider.complete([])).toBe("primary regression");expect(await provider.complete([])).toBe("primary regression");expect(primaryCalls).toBe(3);expect(backupCalls).toBe(2);
  });

  test("both physical endpoints down retains waiting checkpoint; restart and recovery use the same run",async()=>{
    const {home,config,store}=fixture(),primary=endpoint(),backup=endpoint();primary.server.stop(true);backup.server.stop(true);
    config.llm={...config.llm,baseUrl:primary.url,retries:0,cooldownMs:0,backup:{...config.llm,baseUrl:backup.url,retries:0}};
    const deps={home,env:{AUGUST_KEY_DIR:join(home,"keys")},secrets:store,sandboxKind:"none" as const};
    let app=createApp(config,deps);
    const session=makeSessionKey({workspace:config.workspace,channel:"web",user:"fixture"});
    const waiting=await app.handle(session,"owned regression request");
    expect(waiting.stopReason).toBe("provider-unavailable");expect(app.getRun(waiting.runId)?.state).toBe("waiting_external");
    expect(app.getRun(waiting.runId)?.checkpoint).toMatchObject({safeToResume:true,phase:"before_decision",steps:0});expect(app.runs.modelAccounting(waiting.runId).unresolvedCalls).toBe(0);
    expect(app.runs.modelAttempts(waiting.runId).map(a=>a.state)).toEqual(["not_sent","not_sent"]);app.close();
    endpoint(Number(new URL(primary.url).port));endpoint(Number(new URL(backup.url).port));
    app=createApp(config,deps);expect(app.getRun(waiting.runId)?.state).toBe("recovering");
    const done=await app.resumeRun(waiting.runId);expect(done.runId).toBe(waiting.runId);expect(app.getRun(done.runId)?.state).toBe("completed");expect(app.getRun(done.runId)?.error).toBeUndefined();expect(app.listRuns()).toHaveLength(1);app.close();
  });

  test("durable circuits keep exponential cooldown across controller restart and reset after a recovery probe",async()=>{
    let now=1000,down=true,calls=0,saved:Record<string,ProviderCircuitState>={};
    const primary={name:"owned-circuit",complete:async()=>{calls++;if(down)throw new LlmError("down",true);return "recovered regression";}};
    const options={cooldownMs:100,maxCooldownMs:250,now:()=>now,circuits:{load:()=>saved,save:(states:Record<string,ProviderCircuitState>)=>{saved=structuredClone(states);}}};
    let controller=new FallbackProvider([primary],options);
    await expect(controller.complete([])).rejects.toThrow("all providers failed");expect(saved[primary.name]).toEqual({failures:1,retryAt:1100});
    controller=new FallbackProvider([primary],options);await expect(controller.complete([])).rejects.toThrow("cooling down");expect(calls).toBe(1);
    now=1100;await expect(controller.complete([])).rejects.toThrow();expect(saved[primary.name]).toEqual({failures:2,retryAt:1300});
    now=1300;await expect(controller.complete([])).rejects.toThrow();expect(saved[primary.name]).toEqual({failures:3,retryAt:1550});
    now=1550;down=false;expect(controller.health()[0]?.state).toBe("half-open");expect(await controller.complete([])).toBe("recovered regression");expect(saved).toEqual({});expect(controller.health()[0]?.state).toBe("closed");
  });

  test("a half-open circuit has one recovery probe; another caller can only use the backup",async()=>{
    let now=0,calls=0,release!:(reply:string)=>void;
    const primary={name:"owned-probe",complete:async()=>{calls++;if(calls===1)throw new LlmError("down",true);return new Promise<string>(r=>{release=r;});}};
    const backup={name:"owned-backup",complete:async()=>"backup regression"};
    const controller=new FallbackProvider([primary,backup],{cooldownMs:100,now:()=>now});
    expect(await controller.complete([])).toBe("backup regression");now=100;
    const probing=controller.complete([]);expect(await controller.complete([])).toBe("backup regression");expect(calls).toBe(2);
    release("recovery regression");expect(await probing).toBe("recovery regression");expect(controller.health()[0]?.state).toBe("closed");
  });

  test("physical Retry-After suppresses eager retries and is preserved in provider health",async()=>{
    const {config,store}=fixture();let calls=0;
    const unavailable=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>{calls++;return new Response(null,{status:503,headers:{"Retry-After":"120"}});}});servers.push(unavailable);
    const backup=endpoint();config.llm={...config.llm,baseUrl:`http://127.0.0.1:${unavailable.port}`,retries:2,backup:{...config.llm,baseUrl:backup.url}};
    const controller=createLlm(parseConfig(config),{env:{}},store),before=Date.now();
    expect(await controller.complete([])).toBe("regression fixture only");expect(calls).toBe(1);
    expect(controller.health()[0]).toMatchObject({state:"open",failures:1});expect(controller.health()[0]!.retryAt).toBeGreaterThanOrEqual(before+119000);
  });

  test("state persistence failure is fatal, and endpoint path changes never inherit another circuit",async()=>{
    let backupCalls=0;
    const controller=new FallbackProvider([{name:"primary",complete:async()=>"regression"},{name:"backup",complete:async()=>{backupCalls++;return "not allowed";}}],{circuits:{load:()=>({}),save:()=>{throw Error("owned state write failed");}}});
    await expect(controller.complete([])).rejects.toBeInstanceOf(LlmAttemptObserverError);expect(backupCalls).toBe(0);
    const {config,store}=fixture();config.llm.baseUrl="http://127.0.0.1:12345/v1";
    const first=createLlm(config,{env:{}},store).health()[0]!.provider;
    config.llm.baseUrl="http://127.0.0.1:12345/another-api";
    expect(createLlm(config,{env:{}},store).health()[0]!.provider).not.toBe(first);
  });

  test("circuit snapshots survive SQLite restart, reject corruption, and immutable readers cannot change them",()=>{
    const {home}=fixture(),path=join(home,"circuit-runtime.db");let runtime=new DurableRuntimeStore(path);
    expect(runtime.providerCircuits()).toEqual({});runtime.saveProviderCircuits({"owned-endpoint":{failures:2,retryAt:10000}});runtime.close();
    runtime=new DurableRuntimeStore(path,{readOnly:true});expect(runtime.providerCircuits()).toEqual({"owned-endpoint":{failures:2,retryAt:10000}});
    expect(()=>runtime.saveProviderCircuits({})).toThrow();runtime.close();
    runtime=new DurableRuntimeStore(path);expect(()=>runtime.saveProviderCircuits({"owned-endpoint":{failures:0,retryAt:10000}})).toThrow();runtime.close();
    const damaged=new Database(path);damaged.query("UPDATE runtime_meta SET value=? WHERE key='provider_circuits'").run(JSON.stringify({"owned-endpoint":{failures:0,retryAt:10000}}));damaged.close();
    runtime=new DurableRuntimeStore(path);expect(()=>runtime.providerCircuits()).toThrow("invalid retained provider circuits");runtime.close();
  });

  test("a charged empty primary and successful backup retain both distinct receipts without duplicate accounting",async()=>{
    const {config,store}=fixture();
    const primary=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>Response.json({choices:[{message:{content:""}}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}})});servers.push(primary);
    const backup=endpoint();config.llm={...config.llm,baseUrl:`http://127.0.0.1:${primary.port}`,retries:0,backup:{...config.llm,baseUrl:backup.url,retries:0}};
    const events:LlmAttemptEvent[]=[],usage:LlmUsage[]=[];
    expect(await new UsageRequiredProvider(createLlm(config,{env:{}},store)).complete([],{onAttempt:e=>{events.push(e);},onUsage:u=>{usage.push(u);}})).toBe("regression fixture only");
    expect(usage).toEqual([{inputTokens:7,outputTokens:3,totalTokens:10},{inputTokens:7,outputTokens:3,totalTokens:10}]);
    const receiptIds=events.flatMap(e=>e.type==="receipt"?[e.id]:[]);expect(new Set(receiptIds).size).toBe(2);
  });

  test("provider names cannot read inherited object entries as circuit data",async()=>{
    const controller=new FallbackProvider([{name:"__proto__",complete:async()=>"owned regression"}]);
    expect(await controller.complete([])).toBe("owned regression");expect(controller.health()[0]?.state).toBe("closed");
  });

  test("duplicate usage remains immediately fatal before backup, even when a bad adapter swallows it",async()=>{
    for(const swallow of [false,true]) {
      let backupCalls=0,forwarded=0;
      const usage={inputTokens:7,outputTokens:3,totalTokens:10};
      const primary={name:"bad-managed-adapter",managesAttempts:true,complete:async(_messages:unknown,options?:import("@august/brain").CompleteOptions)=>{
        await options?.onAttempt?.({type:"receipt",id:"owned-regression-attempt",usage});await options?.onUsage?.(usage);
        try {await options?.onAttempt?.({type:"receipt",id:"owned-regression-attempt",usage});await options?.onUsage?.(usage);}catch(error){if(!swallow)throw error;}
        throw new LlmError("retryable after invalid usage",true);
      }};
      const fallback=new FallbackProvider([primary,{name:"backup",complete:async()=>{backupCalls++;return "must not run";}}]);
      await expect(new UsageRequiredProvider(fallback).complete([],{onUsage:()=>{forwarded++;}})).rejects.toMatchObject({name:"LlmUsageError"});
      expect(backupCalls).toBe(0);expect(forwarded).toBe(1);
    }
  });
});
