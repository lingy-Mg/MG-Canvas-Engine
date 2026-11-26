import {isId,isPoint,isRecord,readDocument} from "../core/document.ts";
import type {BoardDocument} from "../core/document.ts";
import {validCellStyle} from "../core/table.ts";
import type {CellStyle} from "../core/table.ts";
import {validCardStyle} from "../core/card.ts";
import type {CardStyle} from "../core/card.ts";
import type {TextFace,TextPaint} from "../core/text-style.ts";
import {onGrid,ZOOM} from "../core/geometry.ts";
import type {Camera,Point} from "../core/geometry.ts";
import {assertAsset,AssetVault,MAX_TOTAL_ASSET_BYTES} from "../features/image-assets.ts";
import type {AssetPayload} from "../features/image-assets.ts";
import {decodeProject,encodeProject,readProjectNames} from "./project.ts";
import type {ProjectNames,ProjectPackage} from "./project.ts";

export type DraftTarget =
  | {kind:"text";id:string;at?:Point}
  | {kind:"label";id:string}
  | {kind:"card";id:string;at:Point;content:CardStyle;fill:string;sourceMode?:boolean}
  | {kind:"cell";id:string;row:number;col:number;style?:CellStyle}
  | {kind:"topic";mapId:string;id:string}
  | {kind:"child"|"sibling";mapId:string;id:string;relativeTo:string}
  | {kind:"map";mapId:string;id:string;at:Point};
export type DraftStyle=TextFace&TextPaint&Readonly<{fontSize:number;align:"left"|"center"|"right"}>;
export type TextDraft = Readonly<{target:DraftTarget;value:string;start:number;end:number;style?:DraftStyle}>;
export type WorkspaceHead = Readonly<{version:1;token:string;camera:Camera;draft?:TextDraft;lineage?:BoardDocument["schemaVersion"];names?:ProjectNames}>;
export type WorkspaceData = Readonly<{head:WorkspaceHead;project:ProjectPackage}>;
export type WorkspaceFrame = Readonly<{doc:BoardDocument;vault:AssetVault;camera:Camera;draft?:TextDraft;lineage?:BoardDocument["schemaVersion"];names?:ProjectNames}>;
export type WorkspaceChanges = Readonly<{document:boolean;assets:boolean}>;
export interface WorkspaceStore {
  read():Promise<WorkspaceData|undefined>;
  write(base:string|null,head:WorkspaceHead,frame:WorkspaceFrame,changes:WorkspaceChanges):Promise<boolean>;
  close?():void;
}

function validTarget(t:unknown):t is DraftTarget {
  if(!isRecord(t)||!isId(t.id))return false;
  if(t.kind==="label")return true;
  if(t.kind==="card")return isPoint(t.at)&&onGrid(t.at)&&validCardStyle(t.content)&&typeof t.fill==="string"&&
    (t.sourceMode===undefined||typeof t.sourceMode==="boolean");
  if(t.kind==="cell")return Number.isSafeInteger(t.row)&&Number(t.row)>=0&&Number.isSafeInteger(t.col)&&Number(t.col)>=0&&
    (t.style===undefined||validCellStyle(t.style));
  if(t.kind==="text")return t.at===undefined||isPoint(t.at)&&onGrid(t.at);
  if(!isId(t.mapId))return false;
  return t.kind==="topic"||(t.kind==="child"||t.kind==="sibling")&&isId(t.relativeTo)||
    t.kind==="map"&&isPoint(t.at)&&onGrid(t.at);
}
export function checkedHead(value:unknown):WorkspaceHead {
  if(!isRecord(value)||value.version!==1||!isId(value.token)||!isRecord(value.camera)||!isPoint(value.camera.offset)||
    typeof value.camera.zoom!=="number"||!(value.camera.zoom>0&&value.camera.zoom<=ZOOM.max)||
    value.lineage!==undefined&&(typeof value.lineage!=="number"||![1,2,3,4,5,6].includes(value.lineage)))throw new Error("自动保存的现场信息无效。");
  const draft=value.draft;
  if(draft!==undefined&&(!isRecord(draft)||!validTarget(draft.target)||typeof draft.value!=="string"||
    !Number.isSafeInteger(draft.start)||!Number.isSafeInteger(draft.end)||Number(draft.start)<0||
    Number(draft.end)<Number(draft.start)||Number(draft.end)>draft.value.length))throw new Error("文字草稿无效。");
  const head=value as WorkspaceHead;
  return head.names===undefined?head:{...head,names:readProjectNames(head.names)};
}
export function checkedProject(data:unknown,images:unknown):ProjectPackage {
  const document=readDocument(data);
  if(!Array.isArray(images)||images.length!==Object.keys(document.assets).length)throw new Error("现场的图片清单不完整。");
  const seen=new Set<string>();let total=0;
  for(const item of images){
    const meta=document.assets[item?.meta?.id];
    if(!meta||seen.has(meta.id)||!(item.bytes instanceof Uint8Array)||item.meta.mime!==meta.mime||
      item.meta.pixelWidth!==meta.pixelWidth||item.meta.pixelHeight!==meta.pixelHeight)throw new Error("现场的图片资源不匹配。");
    total+=item.bytes.length;
    if(total>MAX_TOTAL_ASSET_BYTES)throw new Error("现场图片超出总容量。");
    assertAsset(meta,item.bytes);seen.add(meta.id);
  }
  return {document,assets:images};
}
function imageRows(frame:WorkspaceFrame):AssetPayload[] {
  return Object.keys(frame.doc.assets).map(id=>{
    const row=frame.vault.get(id);if(!row)throw new Error("缺少图片原始数据。");return row;
  });
}
export function indexedWorkspace(factory:IDBFactory,entry:string):Promise<WorkspaceStore> {
  return new Promise((resolve,reject)=>{
    const open=factory.open("mg-canvas-workspaces",1);
    open.onupgradeneeded=()=>open.result.createObjectStore("sessions");
    open.onerror=()=>reject(open.error);open.onblocked=()=>reject(new Error("现场存储被占用。"));
    open.onsuccess=()=>{
      const db=open.result;db.onversionchange=()=>db.close();
      const key=(part:string)=>[entry,part];
      resolve({
        close:()=>db.close(),
        read:()=>new Promise((done,fail)=>{
          const tx=db.transaction("sessions","readonly"),s=tx.objectStore("sessions");
          const head=s.get(key("head")),doc=s.get(key("document")),assets=s.get(key("assets"));
          tx.onabort=()=>fail(tx.error);
          tx.oncomplete=()=>{try{
            if(head.result===undefined&&doc.result===undefined&&assets.result===undefined){done(undefined);return;}
            done({head:checkedHead(head.result),project:checkedProject(doc.result,assets.result)});
          }catch(error){fail(error);}};
        }),
        write:(base,head,frame,changes)=>new Promise((done,fail)=>{
          const tx=db.transaction("sessions","readwrite",{durability:"strict"}),s=tx.objectStore("sessions"),prior=s.get(key("head"));
          let matched=false;
          prior.onsuccess=()=>{try{
            if((prior.result===undefined?null:checkedHead(prior.result).token)!==base)return;
            if(changes.document)s.put(frame.doc,key("document"));
            if(changes.assets)s.put(imageRows(frame),key("assets"));
            s.put(head,key("head"));matched=true;
          }catch(error){tx.abort();fail(error);}};
          tx.onabort=()=>fail(tx.error??new Error("现场写入中止。"));tx.oncomplete=()=>done(matched);
        }),
      });
    };
  });
}

/** A fallback needs a cross-tab lock. A failed second write leaves the previous head and project usable. */
export function localWorkspace(storage:Storage,locks:LockManager,entry:string):WorkspaceStore {
  const key="mg-canvas:workspace-local:"+entry;
  const load=()=>{
    const raw=storage.getItem(key);
    if(raw===null)return;
    const parsed=JSON.parse(raw),head=checkedHead(parsed.head);
    if(parsed.slot!==0&&parsed.slot!==1||parsed.docSlot!==undefined&&parsed.docSlot!==0&&parsed.docSlot!==1)throw new Error("本地现场指针无效。");
    return {head,slot:parsed.slot as number,docSlot:parsed.docSlot as number|undefined};
  };
  return {
    read:()=>locks.request(key,()=>{
      const record=load();if(!record)return;
      const bytes=storage.getItem(key+":"+record.slot);if(bytes===null)throw new Error("缺少自动保存的工程。");
      let project=decodeProject(bytes);
      if(record.docSlot!==undefined){
        const doc=storage.getItem(key+":doc:"+record.docSlot);if(doc===null)throw new Error("缺少自动保存的画板。");
        project=checkedProject(JSON.parse(doc),project.assets);
      }
      return {head:record.head,project};
    }),
    write:(base,head,frame,changes)=>locks.request(key,()=>{
      const prior=load();if((prior?.head.token??null)!==base)return false;
      let slot=prior?.slot??1,docSlot=prior?.docSlot;
      if(!prior||changes.assets){
        slot=1-slot;docSlot=undefined;storage.setItem(key+":"+slot,encodeProject(frame.doc,frame.vault));
      }else if(changes.document){
        docSlot=1-(docSlot??1);storage.setItem(key+":doc:"+docSlot,JSON.stringify(frame.doc));
      }
      storage.setItem(key,JSON.stringify({head,slot,docSlot}));return true;
    }),
  };
}

export function workspaceBackend(host:Window,entry:string):Promise<WorkspaceStore> {
  const local=()=>{try{return host.localStorage;}catch{return undefined;}};const storage=local();
  const marker="mg-canvas:workspace-backend:"+entry;
  let preferred:string|null=null;try{preferred=storage?.getItem(marker)??null;}catch{}
  const locks=host.navigator?.locks;
  if(preferred==="local")return storage&&locks?Promise.resolve(localWorkspace(storage,locks,entry)):
    Promise.reject(new Error("上次使用的本地现场暂时不可用。"));
  const remember=(kind:string)=>{try{storage?.setItem(marker,kind);}catch{}};
  return Promise.resolve().then(()=>indexedWorkspace(host.indexedDB,entry)).then(store=>{
    remember("indexed");return store;
  },error=>{
    if(!storage||!locks||preferred==="indexed")throw error;
    remember("local");return localWorkspace(storage,locks,entry);
  });
}
