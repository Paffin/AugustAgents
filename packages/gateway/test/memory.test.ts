import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../memory/src/index.ts";
import { createGatewayHandler, type GatewayMemory, type GatewayMemoryView, type GatewayMemoryTombstone } from "../src/index.ts";
type MemoryResponse={entries:GatewayMemoryView[];tombstones:GatewayMemoryTombstone[];limit:number;truncated:boolean};

// Real SQLite/file adapter contracts and negative HTTP boundaries, not live model/browser acceptance.
const token="owned-memory-regression-credential",roots:string[]=[],stores:MemoryStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const request=(method="GET",path="/v1/memory",body?:unknown,headers:Record<string,string>={})=>new Request("http://127.0.0.1:7777"+path,{method,headers:{host:"127.0.0.1:7777",authorization:"Bearer "+token,"content-type":"application/json",...headers},...(body===undefined?{}:{body:typeof body==="string"?body:JSON.stringify(body)})});
const handler=(memory?:GatewayMemory)=>createGatewayHandler({hostname:"127.0.0.1",port:7777,token,workspace:"owned",onMessage:async()=>({reply:"unused"}),memory});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"august-gateway-memory-"));roots.push(root);
  const path=join(root,"memory.db"),options={filesDir:join(root,"files")};let store=new MemoryStore(path,options);stores.push(store);
  const memory:GatewayMemory={list:()=>store.list("owner",{limit:201}),update:(id,text)=>store.update("owner",id,text),forget:id=>{store.forget("owner",id);},tombstones:()=>store.tombstones("owner")};
  const remember=(text:string,trust:"trusted"|"untrusted"="trusted",scope="owner")=>store.remember({scope,class:"semantic",text,trust,sensitivity:"personal",origin:{kind:trust==="trusted"?"user":"mcp",source:"private/path/not-exposed"}}).entry;
  const reopen=()=>{store.close();stores.splice(stores.indexOf(store),1);store=new MemoryStore(path,options);stores.push(store);};
  return {path,memory,remember,reopen,get store(){return store;},route:handler(memory)};
}

describe("owner-bound memory API",()=>{
  test("Host/Origin/header-only authentication are checked before memory callbacks",async()=>{
    let calls=0;const memory:GatewayMemory={list:()=>{calls++;return[];},update:()=>{throw Error("unused");},forget:()=>{calls++;}};const route=handler(memory);
    expect((await route(request("GET","/v1/memory",undefined,{authorization:"Bearer wrong"}))).status).toBe(401);
    expect((await route(request("GET","/v1/memory",undefined,{host:"attacker.invalid"}))).status).toBe(421);
    expect((await route(request("GET","/v1/memory",undefined,{origin:"https://attacker.invalid"}))).status).toBe(403);
    expect((await route(request("GET","/v1/memory?token=private"))).status).toBe(400);
    expect((await route(request("GET","/v1/memory?scope=other"))).status).toBe(400);expect(calls).toBe(0);
  });

  test("owner note metadata is projected without internal paths/scope/sourceRun/vector contents",async()=>{
    const f=fixture(),entry=f.remember("My cedar preference");f.remember("Other owner's private note","trusted","other");
    const response=await f.route(request()),body=await response.json() as MemoryResponse;expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.entries).toHaveLength(1);expect(body.entries[0]).toMatchObject({id:entry.id,text:entry.text,origin:{kind:"user"},trust:"trusted"});
    expect(Object.keys(body.entries[0]!).sort()).toEqual(["class","createdAt","id","origin","sensitivity","text","trust","updatedAt"].sort());
    expect(JSON.stringify(body)).not.toContain("private/path");expect(body.tombstones).toEqual([]);expect(body.limit).toBe(200);expect(body.truncated).toBe(false);
  });

  test("trusted update retains identity, survives actual restart, and old FTS/file text is gone",async()=>{
    const f=fixture(),entry=f.remember("Earlier juniper preference");
    const response=await f.route(request("PATCH","/v1/memory/"+entry.id,{text:"Current persimmon preference"}));expect(response.status).toBe(200);
    expect((await response.json() as {entry:GatewayMemoryView}).entry).toMatchObject({id:entry.id,createdAt:entry.createdAt,text:"Current persimmon preference",trust:"trusted",origin:{kind:"user"}});
    f.reopen();expect(f.store.recall({scope:"owner",query:"persimmon",touch:false})[0]?.entry.id).toBe(entry.id);expect(f.store.recall({scope:"owner",query:"juniper",touch:false})).toEqual([]);
    expect(readFileSync(join(f.store.filesDirectory("owner")!,"semantic.md"),"utf8")).not.toContain("juniper");
    const db=new Database(f.path,{readonly:true});try{expect(db.query("SELECT COUNT(*) n FROM fts WHERE text LIKE '%juniper%'").get()).toEqual({n:0});}finally{db.close();}
  });

  test("untrusted memory remains read-only; confirmed removal erases actual database/FTS/files and exposes text-free tombstone",async()=>{
    const f=fixture(),entry=f.remember("Imported meadow provenance","untrusted");
    expect((await f.route(request("PATCH","/v1/memory/"+entry.id,{text:"Forged trusted replacement"}))).status).toBe(409);expect(f.store.get("owner",entry.id)?.trust).toBe("untrusted");
    expect((await f.route(request("DELETE","/v1/memory/"+entry.id,{}))).status).toBe(400);expect(f.store.get("owner",entry.id)?.text).toBe(entry.text);
    const response=await f.route(request("DELETE","/v1/memory/"+entry.id,{confirm:true}));expect(response.status).toBe(200);expect(await response.json()).toEqual({deleted:true});
    // Inspect bytes BEFORE closing/checkpointing through restart: SQL invisibility alone is insufficient.
    expect(readFileSync(f.path).includes(Buffer.from("meadow"))).toBe(false);
    f.reopen();expect(f.store.get("owner",entry.id)).toBeUndefined();expect(f.store.recall({scope:"owner",query:"meadow",touch:false})).toEqual([]);
    expect(readFileSync(join(f.store.filesDirectory("owner")!,"semantic.md"),"utf8")).not.toContain("meadow");
    const db=new Database(f.path,{readonly:true});try{expect(db.query("SELECT COUNT(*) n FROM entries WHERE text LIKE '%meadow%'").get()).toEqual({n:0});expect(db.query("SELECT COUNT(*) n FROM fts WHERE text LIKE '%meadow%'").get()).toEqual({n:0});}finally{db.close();}
    const body=await (await f.route(request())).json() as MemoryResponse;expect(body.tombstones[0]).toMatchObject({id:entry.id,class:"semantic"});expect(Object.keys(body.tombstones[0]!).sort()).toEqual(["class","deletedAt","id"]);expect(JSON.stringify(body)).not.toContain("meadow");
  });

  test("strict text-only/confirmation contracts reject forged authority, oversized bodies and malformed ids",async()=>{
    const f=fixture(),entry=f.remember("Original owner note"),path="/v1/memory/"+entry.id;
    for(const body of [{text:"bad",trust:"trusted"},{text:"bad",scope:"other"},{text:"bad",origin:{kind:"user"}},{text:"bad",class:"procedural"},{text:" "},{text:"a".repeat(2001)},[],null])expect((await f.route(request("PATCH",path,body))).status).toBe(400);
    expect((await f.route(request("PATCH",path,{text:"bad"},{"content-type":"text/plain"}))).status).toBe(415);
    expect((await f.route(request("PATCH",path,"a".repeat(65537)))).status).toBe(413);
    expect((await f.route(request("PATCH","/v1/memory/not-a-uuid",{text:"bad"}))).status).toBe(400);
    expect((await f.route(request("DELETE",path,{confirm:true,scope:"other"}))).status).toBe(400);
    expect(f.store.get("owner",entry.id)?.text).toBe("Original owner note");
  });

  test("bounded list states truncation and failing adapters never expose raw diagnostics",async()=>{
    const entry:GatewayMemoryView={id:"00000000-0000-0000-0000-000000000001",class:"semantic",text:"Synthetic bounded-list metadata",trust:"trusted",sensitivity:"personal",origin:{kind:"user"},createdAt:0,updatedAt:0};
    const route=handler({list:()=>Array.from({length:201},()=>entry),update:()=>entry,forget:()=>{throw Error("private filesystem/token diagnostic");}});
    const response=await route(request()),body=await response.json() as MemoryResponse;expect(body.entries).toHaveLength(200);expect(body.truncated).toBe(true);
    const deleted=await route(request("DELETE","/v1/memory/"+entry.id,{confirm:true}));expect(deleted.status).toBe(503);expect(await deleted.text()).not.toContain("private filesystem");
    expect((await handler()(request())).status).toBe(404);
    const failure=await handler({list:()=>{throw Error("private secret backend details");},update:()=>entry,forget:()=>{}})(request());expect(failure.status).toBe(503);expect(await failure.json()).toEqual({error:"memory controls unavailable"});
  });
});
