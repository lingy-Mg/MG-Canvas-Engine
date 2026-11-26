import type {BoardDocument} from "../core/document.ts";
import type {AssetVault} from "../features/image-assets.ts";
import {LocalDocumentStore,SaveCoordinator,openIndexedStore} from "./store.ts";
import type {SaveSnapshot} from "./store.ts";

const legacyKey="mg-canvas-engine:m1:board";
const keys={
  table:legacyKey+":protected-table-v6",
  group:legacyKey+":protected-group-v5",
  curve:legacyKey+":protected-curve-v4",
  path:legacyKey+":protected-path-v3",
  ink:legacyKey+":protected-ink-v2",
  protected:legacyKey+":protected-v1",
  indexed:legacyKey,
  fallback:legacyKey,
};
const legacySlots=["indexed","fallback"] as const;
const versionedSlots=[[6,"table"],[5,"group"],[4,"curve"],[3,"path"],[2,"ink"]] as const;
const protectedSlots=["table","group","curve","path","ink","protected"] as const;
const copyOrder=[...protectedSlots,...legacySlots];
export type CopySlot=keyof typeof keys;
export type ProtectedSlot=typeof protectedSlots[number];
type SaveSlot=ProtectedSlot|"fallback";
type CopyProbe=Readonly<{kind:"unavailable"|"failed"|"empty"}|{kind:"present";bytes:string}>;
export type Copies=Readonly<Record<CopySlot,CopyProbe>>;

export function isProtected(slot:CopySlot):slot is ProtectedSlot{
  return slot!=="indexed"&&slot!=="fallback";
}

/** Manual Save/Reopen retains the historical keys and uses exact bytes as the CAS baseline. */
export function openLocalBoardCopies(host:Pick<Window,"localStorage"|"indexedDB">,signal:AbortSignal){
  let indexedStore:Awaited<ReturnType<typeof openIndexedStore>>|undefined;
  let indexed:SaveCoordinator|undefined, fallback:SaveCoordinator|undefined;
  const expected:Partial<Record<ProtectedSlot,string>>={};
  const probes:Partial<Record<ProtectedSlot,CopyProbe["kind"]>>={};
  const writes=new Set<Promise<unknown>>();
  try{
    const storage=host.localStorage;
    if(storage)fallback=new SaveCoordinator(new LocalDocumentStore(storage));
  }catch{/* Access to browser storage may be denied. */}
  const ready=Promise.resolve().then(()=>openIndexedStore(host.indexedDB)).then(store=>{
    if(signal.aborted){store.close();return;}
    indexedStore=store;
    indexed=new SaveCoordinator(store);
  },()=>{});
  signal.addEventListener("abort",()=>{
    const store=indexedStore;
    if(!store)return;
    // Already accepted saves keep their ordered writes, even if the viewport leaves.
    void Promise.allSettled(writes).then(()=>store.close());
  },{once:true});

  async function probe(slot:CopySlot):Promise<CopyProbe>{
    const store=slot==="fallback"?fallback:indexed;
    if(!store)return {kind:"unavailable"};
    try{
      const bytes=await store.readEncoded(keys[slot]);
      return bytes===undefined?{kind:"empty"}:{kind:"present",bytes};
    }catch{return {kind:"failed"};}
  }
  async function inspect(){
    await ready;
    signal.throwIfAborted();
    const [table,group,curve,path,ink,current,indexedCopy,fallbackCopy]=await Promise.all(copyOrder.map(probe));
    signal.throwIfAborted();
    const copies:Copies={table,group,curve,path,ink,protected:current,indexed:indexedCopy,fallback:fallbackCopy};
    for(const slot of protectedSlots)probes[slot]=copies[slot].kind;
    const failed=copyOrder.filter(slot=>copies[slot].kind==="failed");
    const unique=new Set<string>();
    const readable=copyOrder.filter(slot=>{
      const copy=copies[slot];
      if(copy.kind!=="present"||unique.has(copy.bytes))return false;
      unique.add(copy.bytes);
      return true;
    });
    const unreadable=failed.length>0;
    const firstEmpty=(["protected",...legacySlots] as const).find(slot=>copies[slot].kind==="empty");
    return {
      copies,
      choices:[...readable,...failed],
      available:copyOrder.some(slot=>copies[slot].kind!=="unavailable"),
      unreadable,
      requireChoice:!protectedSlots.some(slot=>copies[slot].kind==="present")&&readable.length>0&&(readable.length>1||unreadable),
      defaultCopy:readable[0]??failed[0]??firstEmpty,
    };
  }
  function target(version:BoardDocument["schemaVersion"],lineage:BoardDocument["schemaVersion"]|undefined,active:CopySlot|undefined):SaveSlot|undefined{
    const owned=lineage===undefined?active:versionedSlots.find(([version])=>version===lineage)?.[1];
    // A migrated copy keeps its versioned destination until it needs a newer one.
    const slot=versionedSlots.find(([candidate,slot])=>version===candidate||owned===slot)?.[1];
    if(!indexedStore)return slot?undefined:fallback?"fallback":undefined;
    return slot??"protected";
  }
  async function save(slot:SaveSlot,snapshot:SaveSnapshot,vault:AssetVault){
    signal.throwIfAborted();
    const write=slot==="fallback"
      ? fallback!.saveProject(keys[slot],snapshot,vault)
      : indexed!.saveProtectedProject(keys[slot],snapshot,vault,()=>expected[slot],bytes=>{
        expected[slot]=bytes;
        probes[slot]="present";
      },indexedStore!);
    writes.add(write);
    try{return await write;}finally{writes.delete(write);}
  }
  return {
    inspect,target,save,
    hasIndexed:()=>Boolean(indexedStore),
    vacant:(slot:ProtectedSlot)=>probes[slot]==="empty",
    baseline:(slot:ProtectedSlot)=>expected[slot],
    adoptBaseline:(slot:ProtectedSlot,bytes:string)=>{expected[slot]=bytes;},
  };
}
