import assert from "node:assert/strict";
import {setImmediate as turn} from "node:timers/promises";
import test from "node:test";
import {AssetVault} from "../features/image-assets.ts";
import {mixed} from "./fixtures/mixed.ts";
import {openLocalBoardCopies} from "../platform/local-board-copies.ts";
import {WorkspaceRecovery} from "../platform/workspace-recovery.ts";
import {checkedHead} from "../platform/workspace-store.ts";
import type {WorkspaceChanges,WorkspaceData,WorkspaceFrame,WorkspaceHead,WorkspaceStore} from "../platform/workspace-store.ts";

function memoryStorage(){
  const values=new Map<string,string>();
  return {get length(){return values.size;},key:(i:number)=>[...values.keys()][i]??null,
    getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},
    removeItem:(k:string)=>{values.delete(k);},clear:()=>values.clear()} satisfies Storage;
}

for(const end of ["unmount","blocked"] as const)test("manual copies close a late IndexedDB connection after "+end,async()=>{
  let closes=0;
  const request:{
    result:{close:()=>void;transaction:()=>never};
    onsuccess?:()=>void;
    onblocked?:()=>void;
  }={result:{close:()=>{closes++;},transaction:()=>assert.fail("late manual probe")}};
  const host={localStorage:memoryStorage(),indexedDB:{open:()=>request} as unknown as IDBFactory};
  const lifetime=new AbortController();
  const copies=openLocalBoardCopies(host,lifetime.signal);
  const ready=copies.inspect();
  await turn();
  if(end==="unmount"){
    lifetime.abort();
    request.onsuccess!();
    await assert.rejects(ready,{name:"AbortError"});
  }else{
    request.onblocked!();
    const result=await ready;
    assert.equal(result.defaultCopy,"fallback");
    assert.equal(copies.target(1,undefined,"fallback"),"fallback");
    assert.equal(copies.target(1,5,"fallback"),undefined);
    request.onsuccess!();
    lifetime.abort();
  }
  assert.equal(closes,1);
});

const frame=():WorkspaceFrame=>({doc:{...mixed,assets:{},order:[],objects:{}},vault:new AssetVault(),camera:{offset:{x:0,y:0},zoom:1}});
function memoryBackend(){
  let data:WorkspaceData|undefined;
  const calls:WorkspaceChanges[]=[];
  const store:WorkspaceStore={read:async()=>data,write:async(base,head,f,changes)=>{
    if((data?.head.token??null)!==base)return false;
    calls.push(changes);data={head,project:{document:f.doc,assets:[]}};return true;
  }};
  return {store,calls};
}

test("unmount releases a delayed backend or read without adopting a checkpoint or scheduling a write",async()=>{
  for(const delayAt of ["open","read"]){
    let closes=0,reads=0,release!:()=>void;
    const blocked=new Promise<void>(done=>{release=done;}),backend=memoryBackend();
    const store:WorkspaceStore={...backend.store,close:()=>{closes++;},read:async()=>{
      reads++;if(delayAt==="read")await blocked;return backend.store.read();
    }};
    const writer=new WorkspaceRecovery("/disposed",undefined,()=>assert.fail("late capture"),()=>assert.fail("late notification"),()=>false);
    const prepare=writer.prepare(delayAt==="open"?blocked.then(()=>store):Promise.resolve(store));
    await turn();writer.dispose();release();assert.equal(await prepare,undefined);
    writer.activate(true,true);writer.changed();writer.flush(true);writer.dispose();
    assert.equal(reads,delayAt==="read"?1:0);assert.equal(closes,1);assert.deepEqual(backend.calls,[]);
  }
});

for(const preceding of ["success","failure"])test("unmount drains the final draft after preceding write "+preceding,async t=>{
  t.mock.timers.enable({apis:["setTimeout","Date"],now:10000});
  const backend=memoryBackend();
  let release!:()=>void,closes=0,first=true,detached=false,f=frame();
  const store:WorkspaceStore={...backend.store,close:()=>{closes++;},write:async(...args)=>{
    if(first){
      first=false;await new Promise<void>(done=>{release=done;});
      if(preceding==="failure")throw new Error("interrupted first write");
    }
    return backend.store.write(...args);
  }};
  // Even when the synchronous storage fallback is unavailable, allow the final IDB write to finish.
  const writer=new WorkspaceRecovery("/draft",undefined,()=>{assert.ok(!detached);return f;},
    ()=>assert.ok(!detached),()=>false);
  await writer.prepare(Promise.resolve(store));writer.activate(false);
  writer.changed();writer.flush();
  f={...f,draft:{target:{kind:"text",id:"draft",at:{x:10,y:20}},value:"重挂载前的草稿",start:2,end:2}};
  writer.changed();writer.dispose();detached=true;writer.dispose();
  writer.changed();writer.activate(false,true);release();await turn();
  t.mock.timers.tick(6000);await turn();
  assert.equal(closes,1);assert.deepEqual((await store.read())?.head.draft,f.draft);
  const full={document:true,assets:true};
  assert.deepEqual(backend.calls,preceding==="success"?[full,{document:false,assets:false}]:[full]);
  assert.equal(writer.pending,false);
});

test("unmount of an untouched or already durable editor closes once without a new save",async()=>{
  for(const edited of [false,true]){
    const backend=memoryBackend();let closes=0;
    const store={...backend.store,close:()=>{closes++;}},f=frame();
    const writer=new WorkspaceRecovery("/idle",memoryStorage(),()=>f,()=>{},()=>false);
    await writer.prepare(Promise.resolve(store));writer.activate(false);
    if(edited){writer.changed();writer.flush();await turn();}
    writer.dispose();writer.dispose();writer.changed();writer.flush(true);
    assert.equal(closes,1);assert.equal(backend.calls.length,edited?1:0);
  }
});
test("coalesced writes keep images, document and metadata independent, and never write an untouched starting board",async t=>{
  t.mock.timers.enable({apis:["setTimeout","Date"],now:10000});
  const {store,calls}=memoryBackend();let f=frame(),busy=true;
  const writer=new WorkspaceRecovery("/editor",memoryStorage(),()=>f,()=>{},()=>busy);
  await writer.prepare(Promise.resolve(store));writer.activate(false);
  t.mock.timers.tick(3000);assert.deepEqual(calls,[]);
  for(let i=0;i<40;i++){f={...f,doc:{...f.doc,theme:"edit-"+i}};writer.changed();t.mock.timers.tick(40);}
  assert.equal(calls.length,0);busy=false;t.mock.timers.tick(400);await turn();
  assert.deepEqual(calls,[{document:true,assets:true}]);
  const original=f.doc;
  f={...f,doc:{...original,theme:"new"}};writer.changed();writer.flush();await turn();
  f={...f,doc:original};writer.changed();writer.flush();await turn();
  f={...f,draft:{target:{kind:"text",id:"new",at:{x:1,y:2}},value:"草稿",start:2,end:2}};writer.changed();
  f={...f,camera:{offset:{x:7.25,y:-30},zoom:.8}};writer.flush();await turn();
  assert.deepEqual(calls.slice(1),[{document:true,assets:false},{document:true,assets:false},{document:false,assets:false}]);
  assert.deepEqual((await store.read())?.head.draft,f.draft);
});
test("an edit keeps its original deadline while the viewport moves and captures the camera at save time",async t=>{
  t.mock.timers.enable({apis:["setTimeout","Date"],now:10000});
  const {store,calls}=memoryBackend(),storage=memoryStorage();let f=frame();
  const w=new WorkspaceRecovery("/edit",storage,()=>f,()=>{},()=>false);
  await w.prepare(Promise.resolve(store));w.activate(false);
  const pan=()=>{f={...f,camera:{offset:{x:f.camera.offset.x+3,y:-4},zoom:f.camera.zoom+.01}};};
  pan();t.mock.timers.tick(2000);assert.equal(w.state,"ready");assert.deepEqual(calls,[]);
  f={...f,doc:{...f.doc,theme:"edited"}};w.changed();
  for(let i=0;i<6;i++){pan();t.mock.timers.tick(40);}
  assert(w.pending);assert.deepEqual(calls,[]);
  pan();const atSave=f.camera;t.mock.timers.tick(40);await turn();
  assert.equal((await store.read())?.project.document,f.doc);assert.deepEqual((await store.read())?.head.camera,atSave);
  pan();t.mock.timers.tick(2000);w.flush(true);assert(w.protectExit());
  assert(!w.pending);assert.equal(calls.length,1);assert.equal(storage.length,0);
  assert.deepEqual((await store.read())?.head.camera,atSave);
});
test("a last-moment undo is recovered even if a previous document write was still in flight when the page closed",async()=>{
  const {store}=memoryBackend(),storage=memoryStorage();let f=frame();
  let hold=false,release!:()=>void;
  const delayed:WorkspaceStore={read:store.read,write:async(...args)=>{
    if(hold)await new Promise<void>(done=>{release=done;});return store.write(...args);
  }};
  const writer=new WorkspaceRecovery("/edit",storage,()=>f,()=>{},()=>false);
  await writer.prepare(Promise.resolve(delayed));writer.activate(false);
  writer.changed();writer.flush();await turn();const original=f.doc;
  hold=true;f={...f,doc:{...original,theme:"intermediate"}};writer.changed();writer.flush();
  f={...f,doc:original,camera:{offset:{x:40.5,y:27.2},zoom:1.25}};writer.changed();
  assert(writer.protectExit());release();await turn();
  assert.equal((await store.read())?.project.document.theme,"intermediate");
  const reload=new WorkspaceRecovery("/edit",storage,()=>f,()=>{},()=>false);
  const restored=await reload.prepare(Promise.resolve(store));writer.conflict();
  assert.deepEqual(restored?.project.document,original);assert.deepEqual(restored?.head.camera,f.camera);
});
test("restoring and focusing an unchanged draft never takes the write token from another tab",async()=>{
  const {store,calls}=memoryBackend();
  let f:WorkspaceFrame={...frame(),draft:{target:{kind:"text",id:"new",at:{x:2,y:9}},value:"继续输入",start:1,end:3}};
  const first=new WorkspaceRecovery("/editor",memoryStorage(),()=>f,()=>{},()=>false);
  await first.prepare(Promise.resolve(store));first.activate(false,true);first.flush();await turn();
  const second=new WorkspaceRecovery("/editor",memoryStorage(),()=>f,()=>{},()=>false);
  await second.prepare(Promise.resolve(store));second.activate(true);
  f={...f,camera:structuredClone(f.camera),draft:structuredClone(f.draft)};
  second.changed();second.flush();await turn();assert.equal(calls.length,1);
  f={...f,draft:{...f.draft!,value:"继续输入字",start:2}};first.changed();first.flush();await turn();
  assert.equal(first.state,"saved");assert.equal((await store.read())?.head.draft?.start,2);
});
test("old tabs and stale exit journals cannot replace a later durable head",async()=>{
  const {store}=memoryBackend(),storage=memoryStorage();let a=frame(),b=a;
  const open=(capture:()=>WorkspaceFrame)=>new WorkspaceRecovery("/canvas",storage,capture,()=>{},()=>false);
  const older=open(()=>a),newer=open(()=>b);
  for(const w of [older,newer]){await w.prepare(Promise.resolve(store));w.activate(false);}
  b={...b,doc:{...b.doc,theme:"winner"}};newer.changed();newer.flush();await turn();
  a={...a,doc:{...a.doc,theme:"stale"}};older.changed();assert(older.protectExit());await turn();
  assert.equal(older.state,"conflict");
  assert.equal((await open(()=>a).prepare(Promise.resolve(store)))?.project.document.theme,"winner");
});
test("malformed workspace metadata never authorizes a write over an unreadable snapshot",async()=>{
  const f=frame(),w=new WorkspaceRecovery("/edit",memoryStorage(),()=>f,()=>{},()=>false);
  const head:WorkspaceHead={version:1,token:"abc",camera:f.camera};
  assert.equal(checkedHead({...head,camera:{...f.camera,zoom:.01}}).camera.zoom,.01);
  for(const zoom of [0,-1,NaN,Infinity])assert.throws(()=>checkedHead({...head,camera:{...f.camera,zoom}}));
  assert.throws(()=>checkedHead({...head,draft:{target:{kind:"text",id:"x"},value:"",start:2,end:3}}));
  let writes=0;
  await assert.rejects(()=>w.prepare(Promise.resolve({read:async()=>{throw Error("corrupt");},write:async()=>{writes++;return true;}})));
  w.activate(false,true);w.flush();assert.equal(writes,0);assert.equal(w.protectExit(),false);
});
