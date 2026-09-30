import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/index.ts";

// Synthetic adapter invariant tests, not semantic quality/real-model acceptance.
const dirs:string[]=[],stores:MemoryStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"august-hybrid-cache-"));dirs.push(root);return {root,path:join(root,"memory.db"),filesDir:join(root,"files")};}
const note=(scope:string,text:string,trust:"trusted"|"untrusted"="trusted")=>({scope,text,class:"semantic" as const,trust,sensitivity:"personal" as const,origin:{kind:"user" as const,source:"owned-test"}});
const open=(path:string,options:ConstructorParameters<typeof MemoryStore>[1])=>{const m=new MemoryStore(path,options);stores.push(m);return m;};

describe("local hybrid cache safety",()=>{
  test("the final lexical file sync cannot return a removed or newly untrusted semantic candidate",async()=>{
    for(const deletion of [false,true]){
      const f=fixture();class InterleavedFiles extends MemoryStore { change?:()=>void;override recall(options:Parameters<MemoryStore["recall"]>[0]){const change=this.change;this.change=undefined;change?.();return super.recall(options);} }
      const m=new InterleavedFiles(f.path,{filesDir:f.filesDir,embeddings:{client:{identity:"owned-sync-race",embed:async()=>[1,1]}}});stores.push(m);
      const e=m.remember(note("owner","Owned candidate before concurrent file sync")).entry,file=join(m.filesDirectory("owner")!,"semantic.md");
      m.change=()=>writeFileSync(file,deletion?"":readFileSync(file,"utf8").replace(`## ${e.id}`,`## ${e.id} [untrusted]`));
      expect(await m.recallHybrid({scope:"owner",query:"unmatched",trustedOnly:true,touch:false})).toEqual([]);
      expect(m.get("owner",e.id)?.trust).toBe(deletion?undefined:"untrusted");
    }
  });
  test("physical deletion is confirmed before close, not hidden by connection shutdown",()=>{
    const f=fixture(),m=open(f.path,{}),text="owned-erasure-marker-249f1c";const e=m.remember(note("owner",text)).entry;
    expect(m.forget("owner",e.id)).toBe(1);
    expect(readFileSync(f.path).includes(text)).toBe(false);try{expect(readFileSync(f.path+"-wal").includes(text)).toBe(false);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  });
  test("trusted text replacement physically removes its prior value before close",()=>{
    const f=fixture(),m=open(f.path,{}),old="owned-old-edit-marker-a59b",fresh="owned-current-edit-marker-e06d",e=m.remember(note("owner",old)).entry;
    m.update("owner",e.id,fresh);expect(readFileSync(f.path).includes(old)).toBe(false);expect(readFileSync(f.path).includes(fresh)).toBe(true);
  });
  test("busy erasure is not reported as physical success and durable pending work is retryable",()=>{
    const f=fixture(),m=open(f.path,{}),text="owned-busy-erasure-marker-552a";const e=m.remember(note("owner",text)).entry;
    const reader=new Database(f.path);reader.run("BEGIN");reader.query("SELECT id FROM entries").all();
    try{expect(()=>m.forget("owner",e.id)).toThrow("physical erasure is pending");}
    finally{reader.run("ROLLBACK");reader.close();}
    expect(m.forget("owner",e.id)).toBe(0);expect(readFileSync(f.path).includes(text)).toBe(false);
    const raw=new Database(f.path,{readonly:true});expect(raw.query("SELECT value FROM meta WHERE key='erasure_pending'").get()).toBeNull();raw.close();
  });
  test("an incidental lexical match cannot dominate a semantic match to the complete request",async()=>{
    const f=fixture(),target="Nightly copies keep important documents",noise="Bread is delivered from the bakery",query="recover archive from yesterday";
    const m=open(f.path,{embeddings:{client:{identity:"owned-rank-math",embed:async text=>text===noise?[0,1]:[1,0]}}});const good=m.remember(note("owner",target)).entry;m.remember(note("owner",noise));
    expect(m.recall({scope:"owner",query,touch:false})[0]?.entry.text).toBe(noise);
    expect((await m.recallHybrid({scope:"owner",query,touch:false}))[0]?.entry.id).toBe(good.id);
  });
  test("received vectors are reused across restart only under the same weights/preprocessing identity",async()=>{
    const f=fixture(),calls:string[]=[],client={identity:"owned-vector-A",embed:async(text:string)=>(calls.push(text),[1,2,3])};
    let m=open(f.path,{embeddings:{client}});const e=m.remember(note("owner","Owned saved fact")).entry;
    expect((await m.recallHybrid({scope:"owner",query:"unmatched-question",touch:false}))[0]?.entry.id).toBe(e.id);expect(calls).toEqual([e.text,"unmatched-question"]);
    await m.recallHybrid({scope:"owner",query:"different-question",touch:false});expect(calls).toHaveLength(3);m.close();
    m=open(f.path,{embeddings:{client}});await m.recallHybrid({scope:"owner",query:"restart-query",touch:false});expect(calls).toHaveLength(4);m.close();
    m=open(f.path,{embeddings:{client,documentPrefix:"explicit-new-prefix: "}});await m.recallHybrid({scope:"owner",query:"changed-preprocessing",touch:false});expect(calls).toHaveLength(6);expect(calls[4]).toBe("explicit-new-prefix: "+e.text);
    expect(m.get("owner",e.id)?.useCount).toBe(0);
  });
  test("foreign scopes and untrusted-only data never enter trusted semantic recall or its provider request",async()=>{
    const f=fixture(),calls:string[]=[],client={identity:"owned-filter",embed:async(text:string)=>(calls.push(text),[1,1])},m=open(f.path,{embeddings:{client}});
    const good=m.remember(note("owner","Owner approved fact")).entry;m.remember(note("other","Other private fact"));m.remember(note("owner","Untrusted imported claim","untrusted"));
    const hits=await m.recallHybrid({scope:"owner",query:"unmatched",trustedOnly:true,touch:false});expect(hits.map(h=>h.entry.id)).toEqual([good.id]);expect(calls).toEqual([good.text,"unmatched"]);
  });
  test("file edits erase cached vectors even when embeddings are disabled; forgetting cascades all identities",async()=>{
    const f=fixture(),client={identity:"owned-edit",embed:async()=>[1,1]};let m=open(f.path,{filesDir:f.filesDir,embeddings:{client}});const e=m.remember(note("owner","Original pine preference")).entry;
    await m.recallHybrid({scope:"owner",query:"pine",touch:false});const dir=m.filesDirectory("owner")!;m.close();
    m=open(f.path,{filesDir:f.filesDir});const file=join(dir,"semantic.md");writeFileSync(file,readFileSync(file,"utf8").replace(e.text,"Updated cedar preference"));m.syncFiles("owner");
    let raw=new Database(f.path,{readonly:true});expect(raw.query("SELECT entry_id FROM memory_vectors").all()).toEqual([]);raw.close();expect(m.recall({scope:"owner",query:"pine",touch:false})).toHaveLength(0);m.close();
    m=open(f.path,{filesDir:f.filesDir,embeddings:{client}});await m.recallHybrid({scope:"owner",query:"cedar",touch:false});m.close();m=open(f.path,{});expect(m.forget("owner",e.id)).toBe(1);
    raw=new Database(f.path,{readonly:true});expect(raw.query("SELECT entry_id FROM memory_vectors").all()).toEqual([]);expect(raw.query("SELECT id FROM fts").all()).toEqual([]);raw.close();
  });
  test("a deleted document during asynchronous indexing cannot recreate its vector or return stale text",async()=>{
    const f=fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
    const m=open(f.path,{embeddings:{client:{identity:"owned-race",embed:async()=>{entered();await gate;return [1,1];}}}}),e=m.remember(note("owner","Owned pending document")).entry;
    const pending=m.recallHybrid({scope:"owner",query:"unmatched",touch:false});await ready;m.forget("owner",e.id);release();await expect(pending).rejects.toThrow("changed during semantic indexing");
    const raw=new Database(f.path,{readonly:true});expect(raw.query("SELECT entry_id FROM memory_vectors").all()).toEqual([]);raw.close();
  });
});
