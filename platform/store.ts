import { parseDocument } from "../core/document.ts";
import { decodeProject, encodeProject } from "./project.ts";
import type { ProjectNames, ProjectPackage } from "./project.ts";
import type { AssetVault } from "../features/image-assets.ts";
import type { BoardDocument } from "../core/document.ts";

export interface DocumentStore {
  write(key: string, encoded: string): Promise<void>;
  read(key: string): Promise<string | undefined>;
}

export interface AtomicDocumentStore extends DocumentStore {
  compareAndSet(key:string,expected:string|undefined,encoded:string):Promise<boolean>;
}

export class SaveConflictError extends Error {
  constructor(){super("另一标签页已保存更新。");this.name="SaveConflictError";}
}

export class MemoryDocumentStore implements DocumentStore {
  private items = new Map<string,string>();
  async write(key: string, encoded: string): Promise<void> { this.items.set(key, encoded); }
  async read(key: string): Promise<string | undefined> { return this.items.get(key); }
}

export class LocalDocumentStore implements DocumentStore {
  private storage: Storage;
  constructor(storage: Storage) { this.storage = storage; }
  async write(key: string, encoded: string): Promise<void> { this.storage.setItem(key, encoded); }
  async read(key: string): Promise<string | undefined> { return this.storage.getItem(key) ?? undefined; }
}

export type SaveSnapshot = Readonly<{ document: BoardDocument; generation: symbol; revision: number; names?:ProjectNames }>;
export type SaveCommit = Readonly<{ generation: symbol; revision: number }>;

/** One coordinator per host store. Equal destination keys share an ordered write boundary. */
export class SaveCoordinator {
  private store: DocumentStore;
  private queues = new Map<string,Promise<unknown>>();
  constructor(store: DocumentStore) { this.store = store; }
  save(key: string, snapshot: SaveSnapshot): Promise<SaveCommit> {
    return this.queue(key,snapshot,JSON.stringify(snapshot.document));
  }
  saveProject(key:string,snapshot:SaveSnapshot,vault:AssetVault):Promise<SaveCommit> {
    // Encode immediately: queued writes retain their own exact bytes even if undo prunes live assets.
    return this.queue(key,snapshot,encodeProject(snapshot.document,vault,snapshot.names));
  }
  saveProtectedProject(key:string,snapshot:SaveSnapshot,vault:AssetVault,expected:()=>string|undefined,
    advanced:(encoded:string)=>void,store:AtomicDocumentStore):Promise<SaveCommit> {
    const encoded=encodeProject(snapshot.document,vault,snapshot.names);
    return this.queue(key,snapshot,encoded,async()=>{
      if(!await store.compareAndSet(key,expected(),encoded))throw new SaveConflictError();
      // Advance to our own committed bytes only, before the next same-tab
      // save is admitted. A foreign write or abort never updates the baseline.
      advanced(encoded);
    });
  }
  private queue(key:string,snapshot:SaveSnapshot,bytes:string,write=()=>this.store.write(key,bytes)):Promise<SaveCommit> {
    const receipt = { generation:snapshot.generation, revision:snapshot.revision };
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await write();
      return receipt;
    });
    this.queues.set(key, next);
    const clean = () => { if (this.queues.get(key) === next) this.queues.delete(key); };
    void next.then(clean, clean);
    return next;
  }
  /** Read byte-exact saved data, after any writes queued to this slot. */
  async readEncoded(key:string):Promise<string|undefined>{
    const previous=this.queues.get(key);
    if(previous)await previous.catch(()=>undefined);
    return this.store.read(key);
  }
  async reopen(key: string): Promise<BoardDocument | undefined> {
    const data=await this.readEncoded(key);
    return data===undefined?undefined:parseDocument(data);
  }
  async reopenProject(key:string):Promise<ProjectPackage|undefined>{
    const data=await this.readEncoded(key);
    return data===undefined?undefined:decodeProject(data);
  }
}

export async function openIndexedStore(factory:IDBFactory):Promise<AtomicDocumentStore&{close():void}>{
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=factory.open("mg-canvas-previews",1);
    request.onupgradeneeded=()=>{request.result.createObjectStore("boards");};
    let blocked=false;
    request.onsuccess=()=>{
      if(blocked)request.result.close();
      else resolve(request.result);
    };
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>{
      blocked=true;
      reject(new Error("本地项目存储被其他页面占用。"));
    };
  });
  return {
    close(){db.close();},
    read(key){return new Promise((resolve,reject)=>{
      const t=db.transaction("boards","readonly"), request=t.objectStore("boards").get(key);
      request.onsuccess=()=>{
        const value=request.result;
        if(value===undefined||typeof value==="string")resolve(value);
        else reject(new Error("本地画板存储格式无效。"));
      };
      request.onerror=()=>reject(request.error);t.onabort=()=>reject(t.error);
    });},
    write(key,encoded){return new Promise((resolve,reject)=>{
      const t=db.transaction("boards","readwrite");
      t.objectStore("boards").put(encoded,key);
      t.oncomplete=()=>resolve();t.onabort=()=>reject(t.error);t.onerror=()=>reject(t.error);
    });},
    compareAndSet(key,expected,encoded){return new Promise((resolve,reject)=>{
      const t=db.transaction("boards","readwrite"),store=t.objectStore("boards"),request=store.get(key);
      let matched=false;
      // Read and conditional write must share this transaction. Issuing put
      // synchronously from success also avoids an inactive transaction.
      request.onsuccess=()=>{
        if(request.result!==expected)return;
        matched=true;
        try{store.put(encoded,key);}catch(error){t.abort();reject(error);}
      };
      t.oncomplete=()=>resolve(matched);
      t.onabort=()=>reject(t.error??new Error("保存事务已取消。"));
      t.onerror=()=>reject(t.error??new Error("保存事务失败。"));
    });},
  };
}
