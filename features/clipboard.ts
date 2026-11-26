import { assertDocument, contentVersion, detachEndpoints, freezeData } from "../core/document.ts";
import {groupUnit} from "../core/flow-groups.ts";
import {selectedTopicTrees,withoutSelectedTopics} from "./mindmap.ts";
import type { BoardDocument, BoardObject, Endpoint, Id, ImageAsset, Topic } from "../core/document.ts";
import type { Point } from "../core/geometry.ts";
import { gridPoint } from "../core/geometry.ts";
import type { Patch } from "../core/history.ts";
import { allocateId } from "../core/id.ts";
import { decodeProject, encodeProject, MAX_PROJECT_CHARS } from "../platform/project.ts";
import type { ProjectPackage } from "../platform/project.ts";
import { buildScene, groupBounds } from "../scene/board.ts";
import type { EditorSession } from "../session/editor.ts";
import {movePatches} from "../session/transform.ts";
import type {ObjectCopies} from "../session/transform.ts";
import { AssetVault, assertAsset, MAX_TOTAL_ASSET_BYTES } from "./image-assets.ts";
import type { AssetPayload } from "./image-assets.ts";

// Frozen readers recognize this prefix and can reject the v5 document explicitly.
const CLIP_PREFIX="MG-CANVAS-CLIPBOARD/1\n";
export const isCanvasClipboardText=(text:string):boolean=>text.startsWith("MG-CANVAS-CLIPBOARD/");
const nudge={x:18,y:18};
const shift=(p:Point,d:Point):Point=>({x:p.x+d.x,y:p.y+d.y});
export type ClipboardFragment=ProjectPackage;
export type PastePosition=Readonly<{anchor?:Point;delta?:Point;expected?:symbol}>;

function checkedAssets(fragment:ClipboardFragment):Map<Id,AssetPayload>{
  assertDocument(fragment.document);
  const byId=new Map<Id,AssetPayload>();
  let bytes=0;
  for(const payload of fragment.assets){
    const id=payload.meta.id,expected=Object.hasOwn(fragment.document.assets,id)?fragment.document.assets[id]:undefined;
    if(byId.has(id)||!expected||expected.mime!==payload.meta.mime||expected.pixelWidth!==payload.meta.pixelWidth||
      expected.pixelHeight!==payload.meta.pixelHeight)throw new Error("剪贴板图片清单不一致。");
    if(!(payload.bytes instanceof Uint8Array))throw new Error("剪贴板图片数据无效。");
    assertAsset(payload.meta,payload.bytes);bytes+=payload.bytes.length;
    if(bytes>MAX_TOTAL_ASSET_BYTES)throw new Error("剪贴板图片总容量过大。");
    byId.set(id,payload);
  }
  if(byId.size!==Object.keys(fragment.document.assets).length)throw new Error("剪贴板图片数据缺失。");
  return byId;
}

/** Both in-board duplication and the portable clipboard use this selection in paint order. */
function selectionDocument(doc:BoardDocument,selected:readonly Id[],hidden?:ReadonlySet<Id>,ranges?:ReadonlyMap<Id,ReadonlySet<Id>>):BoardDocument|undefined{
  const ids=new Set(hidden?.size?selected.filter(id=>!hidden.has(id)):selected),members:Record<Id,readonly Id[]>=Object.create(null);
  for(const [group,nodes] of Object.entries(doc.flowGroups?.members??{})){
    if(nodes.every(id=>ids.has(id))&&(!hidden?.size||groupUnit(doc,group).every(id=>!hidden.has(id)))){
      members[group]=nodes;
      for(const child of groupUnit(doc,group))ids.add(child);
    }
  }
  const order:Id[]=[];
  const objects:Record<Id,BoardObject>=Object.create(null);
  const assets:Record<Id,ImageAsset>=Object.create(null);
  for(const id of doc.order){
    if(!ids.has(id))continue;
    const item=doc.objects[id];
    const range=ranges?.get(id);
    if(item.kind==="mindmap"&&range&&range.size<Object.keys(item.topics).length){
      for(const tree of selectedTopicTrees(item,id=>range.has(id))){order.push(tree.id);objects[tree.id]=tree;}
      continue;
    }
    order.push(id);
    objects[id]=item.kind==="connector"?detachEndpoints(doc,item,id=>!ids.has(id)):item;
    if(item.kind==="image")assets[item.assetId]=doc.assets[item.assetId];
  }
  if(!order.length)return;
  const baseVersion=contentVersion(Object.values(objects)),grouped=Object.keys(members).length>0;
  return {
    schemaVersion:grouped&&baseVersion!==6?5:baseVersion,...(grouped?{flowGroups:{baseVersion,members}}:{}),id:"clipboard-fragment",theme:doc.theme,order,objects,assets,
  };
}
export function captureClipboard(doc:BoardDocument,selected:readonly Id[],vault:AssetVault,hidden?:ReadonlySet<Id>,ranges?:ReadonlyMap<Id,ReadonlySet<Id>>):ClipboardFragment|undefined{
  const source=selectionDocument(doc,selected,hidden,ranges);
  if(!source)return;
  const payloads=Object.keys(source.assets).map(id=>{
    const payload=vault.get(id);if(!payload)throw new Error("找不到要复制的图片原始数据。");
    return payload;
  });
  const fragment={document:freezeData(structuredClone(source)),assets:payloads};
  checkedAssets(fragment);
  return fragment;
}

export function encodeClipboard(fragment:ClipboardFragment):string {
  checkedAssets(fragment);
  return CLIP_PREFIX+encodeProject(fragment.document,new AssetVault(fragment.assets));
}
export function decodeClipboard(text:string):ClipboardFragment|undefined{
  if(!text.startsWith(CLIP_PREFIX)){
    if(isCanvasClipboardText(text))throw new Error("不支持此画布剪贴板版本。");
    return;
  }
  if(text.length-CLIP_PREFIX.length>MAX_PROJECT_CHARS)throw new Error("画布剪贴板内容过大。");
  return decodeProject(text.slice(CLIP_PREFIX.length));
}

function pasteDelta(fragment:ClipboardFragment,position:PastePosition):Point|undefined{
  if(position.anchor){
    const bounds=groupBounds(buildScene(fragment.document));
    if(!bounds)return;
    return gridPoint({x:position.anchor.x-(bounds.min.x+bounds.max.x)/2,y:position.anchor.y-(bounds.min.y+bounds.max.y)/2});
  }
  return position.delta?gridPoint(position.delta):nudge;
}
function remapObject(item:BoardObject,id:Id,objects:ReadonlyMap<Id,Id>,assets:ReadonlyMap<Id,Id>,delta:Point):BoardObject{
  if(item.kind==="connector"){
    // The fragment validator guarantees retained anchors target selected shapes.
    const endpoint=(end:Endpoint):Endpoint=>end.kind==="free"?{kind:"free",point:shift(end.point,delta)}:
      {...end,objectId:objects.get(end.objectId)!};
    return {...item,id,from:endpoint(item.from),to:endpoint(item.to),waypoints:item.waypoints.map(point=>shift(point,delta))};
  }
  if(item.kind==="mindmap"){
    const topicIds=new Map(Object.keys(item.topics).map(old=>[old,allocateId("topic")]));
    const topics:Record<Id,Topic>=Object.create(null);
    for(const topic of Object.values(item.topics)){
      const id=topicIds.get(topic.id)!;
      topics[id]={...topic,id,childIds:topic.childIds.map(child=>topicIds.get(child)!)};
    }
    return {...item,id,origin:shift(item.origin,delta),rootId:topicIds.get(item.rootId)!,topics};
  }
  if(item.kind==="image")return {...item,id,assetId:assets.get(item.assetId)!,at:shift(item.at,delta)};
  return {...item,id,at:shift(item.at,delta)};
}
/** Allocate identities once, in source paint order. An in-board drag can then
 * translate the same copies for every frame without staging image data. */
function cloneFragment(before:BoardDocument,source:BoardDocument,assetIds:ReadonlyMap<Id,Id>,delta:Point):ObjectCopies|undefined{
  const ids=new Map<Id,Id>(),objects=new Map<Id,BoardObject>();
  const occupied=new Set([...before.order,...Object.keys(before.flowGroups?.members??{}),...Object.keys(before.assets),...assetIds.values()]);
  for(const old of source.order){
    const id=allocateId(source.objects[old].kind);if(occupied.has(id))return;
    occupied.add(id);ids.set(old,id);
  }
  for(const [old,id] of ids)objects.set(id,remapObject(source.objects[old],id,ids,assetIds,delta));
  const copies={objects,ids:[...ids.values()]};
  if(!source.flowGroups)return copies;
  const members={...before.flowGroups?.members};
  for(const nodes of Object.values(source.flowGroups.members)){
    const group=allocateId("group");if(occupied.has(group))return;
    occupied.add(group);members[group]=nodes.map(id=>ids.get(id)!);
  }
  return {...copies,groupPatch:{op:"setFlowGroups",members}};
}

export function prepareDragCopies(editor:EditorSession,ids:readonly Id[],vault:AssetVault):ObjectCopies|undefined{
  const source=selectionDocument(editor.doc,ids,editor.hiddenIds,editor.selectedTopics);
  if(!source)return;
  const assets=new Map<Id,Id>();
  for(const id of Object.keys(source.assets)){
    if(!vault.metadata(id))throw new Error("找不到要复制的图片原始数据。");
    assets.set(id,id);
  }
  return cloneFragment(editor.doc,source,assets,{x:0,y:0});
}

function paste(editor:EditorSession,vault:AssetVault,fragment:ClipboardFragment,position:PastePosition,label:string):boolean{
  const expected=position.expected??editor.generation;
  if(editor.busy||editor.generation!==expected||!fragment.document.order.length)return false;
  const payloads=checkedAssets(fragment),delta=pasteDelta(fragment,position);
  if(!delta||!Number.isFinite(delta.x)||!Number.isFinite(delta.y))return false;
  const before=editor.doc;
  const assetIds=new Map<Id,Id>(),patches:Patch[]=[],assetPatches=new Set<Id>();
  const beforeAssets=payloads.size?new Set(vault.assetIds()):undefined;
  let staged=false;
  try{
    for(const [id,payload] of payloads){
      const candidate={...payload.meta,id:allocateId("asset")};
      const asset=vault.add({meta:candidate,bytes:payload.bytes},true);
      if(asset.id===candidate.id)staged=true;
      assetIds.set(id,asset.id);
      if(!Object.hasOwn(before.assets,asset.id)&&!assetPatches.has(asset.id)){
        assetPatches.add(asset.id);patches.push({op:"putAsset",value:asset});
      }
    }
    const copies=cloneFragment(before,fragment.document,assetIds,delta);
    if(!copies)return false;
    for(const patch of movePatches(copies.objects))patches.push(patch);
    if(copies.groupPatch)patches.push(copies.groupPatch);
    return editor.commitEdit({label,patches},expected,copies.ids);
  }finally{
    // If the edit never committed, roll back only the assets we staged.
    // A listener that throws *after* commit must not roll back live bytes.
    if(staged&&beforeAssets&&editor.doc===before)vault.retain(beforeAssets);
  }
}

export function pasteClipboard(editor:EditorSession,vault:AssetVault,fragment:ClipboardFragment,position:PastePosition={}):boolean{
  return paste(editor,vault,fragment,position,"粘贴所选对象");
}
export function duplicateClipboardSelection(editor:EditorSession,vault:AssetVault):boolean {
  const fragment=captureClipboard(editor.doc,editor.selectedIds,vault,editor.hiddenIds,editor.selectedTopics);
  return Boolean(fragment&&paste(editor,vault,fragment,{},"复制所选对象"));
}

/** Preflight the entire deletion, including surviving lines, before offering data to a clipboard writer. */
export function prepareClipboardCut(editor:EditorSession,vault:AssetVault){
  if(editor.busy||!editor.selectedIds.length||editor.selectionLocked)return;
  const before=editor.doc,generation=editor.generation,history=editor.history,locks=editor.lockRevision,visibility=editor.visibilityRevision;
  const ranges=editor.selectedTopics,cutRanges=new Map(ranges);
  for(const [id,topics] of ranges){
    const map=before.objects[id];
    if(map.kind==="mindmap"&&topics.has(map.rootId)&&topics.size<Object.keys(map.topics).length){
      const removable=new Set(topics);removable.delete(map.rootId);cutRanges.set(id,removable);
    }
  }
  const selected=[...editor.selectedIds],fragment=captureClipboard(before,selected,vault,editor.hiddenIds,cutRanges);
  if(!fragment)return;
  const removed=new Set<Id>(),patches:Patch[]=[];
  for(const id of fragment.document.order){
    const item=before.objects[id];
    if(!item)continue;
    const range=cutRanges.get(id);
    if(range&&item.kind==="mindmap"){
      const rest=withoutSelectedTopics(item,range);
      if(rest){if(rest!==item)patches.push({op:"putObject",value:rest});continue;}
    }
    removed.add(id);patches.push({op:"removeObject",id});
  }
  const referenced=new Set<Id>(),dropped=new Set<Id>();
  for(const item of Object.values(before.objects)){
    if(item.kind==="image"){
      (removed.has(item.id)?dropped:referenced).add(item.assetId);continue;
    }
    if(item.kind!=="connector"||removed.has(item.id))continue;
    const next=detachEndpoints(before,item,id=>removed.has(id));
    if(next!==item)patches.push({op:"putObject",value:next,automaticDetach:true});
  }
  for(const id of dropped)if(!referenced.has(id))patches.push({op:"removeAsset",id});
  const transaction={label:"剪切所选对象",patches};
  if(!editor.permitsEdit(transaction))return;
  return {payload:encodeClipboard(fragment),remove(){
    if(editor.history!==history||editor.selectedTopics!==ranges||editor.lockRevision!==locks||editor.visibilityRevision!==visibility||selected.length!==editor.selectedIds.length||
      selected.some((id,i)=>id!==editor.selectedIds[i]))return false;
    return editor.commitEdit(transaction,generation,[]);
  }};
}
/** Delete only after an acknowledged write and a matching workspace snapshot. */
export async function cutClipboardSelection(editor:EditorSession,vault:AssetVault,write:(payload:string)=>Promise<void>,canCommit:()=>boolean=()=>true):Promise<boolean>{
  const cut=prepareClipboardCut(editor,vault);if(!cut)return false;
  await write(cut.payload);return canCommit()&&cut.remove();
}
