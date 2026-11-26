import { assertDocument, DocumentValidationError,isRecord,contentVersion, freezeData, has, isBox,isPoint,objectById,readDocument,resolveEndpoint,zeroLengthConnector } from "./document.ts";
import { hasIntegerGeometry } from "./document-grid.ts";
import { onGrid } from "./geometry.ts";
import { validInkGeometry } from "../features/ink.ts";
import type { BoardDocument, BoardObject,GroupMembers,ImageAsset,Id } from "./document.ts";

export type Patch =
  | Readonly<{ op: "putObject"; value: BoardObject; automaticDetach?: true; automaticRoute?: true }>
  | Readonly<{ op: "removeObject"; id: Id }>
  | Readonly<{ op:"setFlowGroups"; members:GroupMembers }>
  | Readonly<{ op: "setOrder"; ids: readonly Id[] }>
  | Readonly<{ op: "putAsset"; value: ImageAsset }>
  | Readonly<{ op: "removeAsset"; id: Id }>
  | Readonly<{ op: "setTheme"; theme: string }>;
export type Transaction = Readonly<{ label: string; patches: readonly Patch[] }>;
export type ChangeSet = Readonly<{
  added: readonly Id[]; updated: readonly Id[]; removed: readonly Id[];
  invalidatedMaps: readonly Id[]; invalidatedConnectors: readonly Id[];
  assetsChanged: readonly Id[]; groupsChanged?:boolean; orderChanged: boolean; themeChanged: boolean;
}>;
type Frame = Readonly<{ label: string; doc: BoardDocument; forward: ChangeSet }>;
export type History = Readonly<{ doc: BoardDocument; revision: number; past: readonly Frame[]; future: readonly Frame[] }>;
export type HistoryResult = Readonly<{ state: History; changeSet: ChangeSet }>;

const HISTORY_LIMIT = 100;
const checkedDocuments=new WeakSet<BoardDocument>();
const unchanged = freezeData<ChangeSet>({
  added: [], updated: [], removed: [], invalidatedMaps: [], invalidatedConnectors: [],
  assetsChanged: [], orderChanged: false, themeChanged: false,
});
export function createHistory(doc: BoardDocument): History {
  const checked=readDocument(structuredClone(doc));checkedDocuments.add(checked);
  return asState(checked, 0, [], []);
}

function asState(doc: BoardDocument, revision: number, past: Frame[], future: Frame[]): History {
  // Document snapshots share their frozen unchanged objects. Do not re-walk history.
  return Object.freeze({ doc, revision, past: Object.freeze(past), future: Object.freeze(future) });
}
function frame(label: string, doc: BoardDocument, forward:ChangeSet): Frame {
  return Object.freeze({ label, doc, forward });
}
function appendCapped(frames: readonly Frame[], entry: Frame): Frame[] {
  return [...frames.slice(-(HISTORY_LIMIT - 1)), entry];
}

/** A freshly placed object's first edit completes the same undo step. Both revisions remain observable to persistence. */
export function completeInsertion(placed:History,edited:History,id:Id):History{
  const creation=placed.past.at(-1),edit=edited.past.at(-1);
  if(!creation||edit?.doc!==placed.doc||creation.forward.added.length!==1||creation.forward.added[0]!==id)return edited;
  const combined=frame(creation.label,creation.doc,diffDocuments(creation.doc,edited.doc));
  return asState(edited.doc,edited.revision,[...placed.past.slice(0,-1),combined],[]);
}

/** Each sample has a new revision for save/render. Undo returns to the start of the gesture. */
export function groupEdits(start:History,edited:History,label:string):History {
  const changes=diffDocuments(start.doc,edited.doc);
  if(!hasChanges(changes))return asState(start.doc,edited.revision,[...start.past],[...start.future]);
  return asState(edited.doc,edited.revision,appendCapped(start.past,frame(label,start.doc,changes)),[]);
}

export function dispatch(state: History, transaction: Transaction): HistoryResult {
  if (!transaction.patches.length) return { state, changeSet: unchanged };
  const fast=geometryDispatch(state,transaction);
  if(fast)return fast;
  const { doc } = state;
  let objects: Record<Id, BoardObject> | undefined;
  let assets: Record<Id, ImageAsset> | undefined;
  let order = doc.order;
  let theme = doc.theme;
  let members=doc.flowGroups?.members,explicitGroups=false,removed=false;
  // Null-prototype staging cannot reinterpret a malformed key as a setter.
  const objectsForWrite = (): Record<Id, BoardObject> => objects ??= Object.assign(Object.create(null), doc.objects);
  const assetsForWrite = (): Record<Id, ImageAsset> => assets ??= Object.assign(Object.create(null), doc.assets);
  for (const patch of transaction.patches) {
    switch (patch.op) {
      case "putObject": {
        const next = objectsForWrite();
        const id = patch.value.id;
        if (!has(next, id)) order = [...order, id];
        const previous = has(next,id) ? next[id] : undefined;
        let copy = structuredClone(patch.value);
        // A committed edit stays recorded even if a later edit restores all visible properties.
        // Removing an adjacent node can detach a binding without the user editing the line.
        if (copy.kind === "connector" && previous?.kind === "connector") {
          if (previous.unedited && !("unedited" in copy)) copy = { ...copy, unedited:true };
          if (copy.unedited === true && (!previous.unedited || (!patch.automaticDetach && !patch.automaticRoute && !equal(previous, copy)))) {
            const { unedited, ...edited } = copy;
            copy = edited;
          }
        }
        // Preserve immutable tree identity when only its group transform changes.
        next[id] = freezeData(copy.kind === "mindmap" && previous?.kind === "mindmap" &&
          equal(copy.topics,previous.topics) ? { ...copy, topics:previous.topics } : copy);
        break;
      }
      case "removeObject": {
        const next = objectsForWrite();
        if (!has(next, patch.id)) break;
        removed=true;
        delete next[patch.id];
        order = order.filter(id => id !== patch.id);
        break;
      }
      case "putAsset":
        assetsForWrite()[patch.value.id] = freezeData(structuredClone(patch.value));
        break;
      case "removeAsset":
        delete assetsForWrite()[patch.id];
        break;
      case "setFlowGroups":
        if(!isRecord(patch.members))throw new DocumentValidationError([{path:"flowGroups.members",message:"分组成员表无效"}]);
        members=structuredClone(patch.members);explicitGroups=true;break;
      case "setOrder":
        order = [...patch.ids];
        break;
      case "setTheme":
        theme = patch.theme;
        break;
      default:
        throw new Error("unsupported patch");
    }
  }
  let schemaVersion=doc.schemaVersion;
  let flowGroups=doc.flowGroups;
  if(objects||members!==doc.flowGroups?.members){
    const finalObjects=objects??doc.objects;
    if(removed&&members&&!explicitGroups){
      const retained:Record<Id,readonly Id[]>=Object.create(null);
      for(const [group,ids] of Object.entries(members)){
        const keep=ids.filter(id=>has(finalObjects,id)&&finalObjects[id].kind==="shape");
        if(keep.length>=2)retained[group]=keep.length===ids.length?ids:keep;
      }
      members=retained;
    }
    const required=contentVersion(Object.values(finalObjects));
    const previous=doc.flowGroups?.baseVersion??doc.schemaVersion;
    const base=required===1&&previous===2?2:required;
    flowGroups=members&&Object.keys(members).length?freezeData({baseVersion:base,members}):undefined;
    schemaVersion=flowGroups&&base!==6?5:base;
  }
  const {flowGroups:oldGroups,...ordinary}=doc;
  const next = {
    ...ordinary,
    ...(flowGroups?{flowGroups}:{}),
    schemaVersion,
    objects: objects ? Object.freeze(objects) : doc.objects,
    assets: assets ? Object.freeze(assets) : doc.assets,
    order: Object.freeze(order),
    theme,
  };
  assertDocument(next); // Preserve atomicity: publish nothing until the entire result validates.
  checkedDocuments.add(next);
  const changeSet = diffDocuments(doc, next);
  if (!hasChanges(changeSet)) return { state, changeSet: unchanged };
  return {
    state: asState(Object.freeze(next), state.revision + 1, appendCapped(state.past, frame(transaction.label, doc, changeSet)), []),
    changeSet,
  };
}
export function undo(state: History): HistoryResult {
  const target = state.past.at(-1);
  if (!target) return { state, changeSet: unchanged };
  return {
    state: asState(target.doc, state.revision + 1, state.past.slice(0, -1), [...state.future, frame(target.label, state.doc, target.forward)]),
    changeSet: Object.freeze({...target.forward,added:target.forward.removed,removed:target.forward.added}),
  };
}
export function redo(state: History): HistoryResult {
  const target = state.future.at(-1);
  if (!target) return { state, changeSet: unchanged };
  return {
    state: asState(target.doc, state.revision + 1, appendCapped(state.past, frame(target.label, state.doc, target.forward)), state.future.slice(0, -1)),
    changeSet: target.forward,
  };
}
const linked=new WeakMap<BoardDocument,ReadonlyMap<Id,readonly Id[]>>();
function incident(doc:BoardDocument):ReadonlyMap<Id,readonly Id[]>{
  const before=linked.get(doc);if(before)return before;
  const next=new Map<Id,Id[]>();
  for(const object of Object.values(doc.objects))if(object.kind==="connector"){
    for(const end of [object.from,object.to]){
      if(end.kind!=="anchor")continue;
      let ids=next.get(end.objectId);if(!ids){ids=[];next.set(end.objectId,ids);}
      if(ids.at(-1)!==object.id)ids.push(object.id);
    }
  }
  linked.set(doc,next);return next;
}
export function incidentConnectorIds(doc:BoardDocument,shape:Id):readonly Id[]{return incident(doc).get(shape)??[];}
const boxKeys=new Set(["at","width","height","rotation"]),originKeys=new Set(["origin"]),
  inkKeys=new Set(["at","color","baseWidth","samples"]);
function sameExceptGeometry(before:BoardObject,next:BoardObject):boolean{
  if(next.kind!==before.kind||next.kind==="connector")return false;
  const proto=Object.getPrototypeOf(next);
  if(proto!==Object.prototype&&proto!==null)return false;
  const a=before as unknown as Record<string,unknown>,b=next as unknown as Record<string,unknown>;
  const keys=Reflect.ownKeys(b), allowed=next.kind==="mindmap"?originKeys:next.kind==="ink"?inkKeys:boxKeys;
  return keys.length===Reflect.ownKeys(a).length&&keys.every(key=>
    typeof key==="string"&&has(a,key)&&(allowed.has(key)||a[key]===b[key]));
}
/** Narrow transformation of already-validated rows. Geometry fields are revalidated,
 * and all affected bound connectors are checked against the final draft. Identity,
 * assets, ordering, routes, tree internals and structural edits use the full validator. */
function geometryDispatch(state:History,transaction:Transaction):HistoryResult|undefined{
  if(transaction.patches.length>128)return;
  const doc=state.doc;
  if(!checkedDocuments.has(doc))return;
  const seen=new Set<Id>(), updates=new Map<Id,BoardObject>(),shapeIds:Id[]=[];
  for(const patch of transaction.patches){
    if(patch.op!=="putObject"||!patch.value||typeof patch.value!=="object")return;
    const candidate=patch.value,id=candidate.id,old=objectById(doc,id);
    if(!old||seen.has(id)||!sameExceptGeometry(old,candidate))return;
    seen.add(id);
    if(old.kind==="mindmap"&&candidate.kind==="mindmap"){
      if(!isPoint(candidate.origin)||!onGrid(candidate.origin))return;
      const origin={x:candidate.origin.x,y:candidate.origin.y};
      if(equal(origin,old.origin))continue;
      updates.set(id,Object.freeze({...old,origin:Object.freeze(origin)}));
      continue;
    }
    if(old.kind==="ink"&&candidate.kind==="ink"){
      // A completed stroke keeps its sample count, so board-wide resource totals stay valid.
      // Structural edits fall back to the document validator.
      if(!isPoint(candidate.at)||!validInkGeometry(candidate)||!hasIntegerGeometry(candidate)||candidate.samples.length!==old.samples.length)return;
      const at=equal(candidate.at,old.at)?old.at:Object.freeze({x:candidate.at.x,y:candidate.at.y});
      const samples=equal(candidate.samples,old.samples)?old.samples:freezeData(structuredClone(candidate.samples));
      if(at===old.at&&samples===old.samples&&candidate.color===old.color&&candidate.baseWidth===old.baseWidth)continue;
      updates.set(id,Object.freeze({...old,at,samples,color:candidate.color,baseWidth:candidate.baseWidth}));
      continue;
    }
    if(old.kind==="connector"||old.kind==="mindmap"||old.kind==="ink"||old.kind==="path"||!isBox(candidate)||!hasIntegerGeometry(candidate))return;
    if(old.kind==="table"&&candidate.rotation!==0)return;
    const at={x:candidate.at.x,y:candidate.at.y},width=candidate.width,height=candidate.height,rotation=candidate.rotation;
    if(width===old.width&&height===old.height&&rotation===old.rotation&&equal(at,old.at))continue;
    updates.set(id,Object.freeze({...old,at:Object.freeze(at),width,height,rotation}));
    if(old.kind==="shape")shapeIds.push(id);
  }
  if(!updates.size)return {state,changeSet:unchanged};
  const changed=Object.assign(Object.create(null),doc.objects) as Record<Id,BoardObject>;
  for(const [id,value] of updates)changed[id]=value;
  const next:BoardDocument=Object.freeze({...doc,objects:Object.freeze(changed)});
  const lookup=shapeIds.length?incident(doc):linked.get(doc);
  const connectors=new Set<Id>();
  for(const id of shapeIds)for(const other of lookup?.get(id)??[])connectors.add(other);
  for(const id of connectors){
    const item=next.objects[id];
    if(item?.kind!=="connector")return;
    const from=resolveEndpoint(next,item.from),to=resolveEndpoint(next,item.to);
    if(!from||!to||zeroLengthConnector(from,to,item.routing,item.waypoints))return; // authoritative full diagnostics
  }
  if(lookup)linked.set(next,lookup);
  checkedDocuments.add(next);
  const changeSet=freezeData<ChangeSet>({...unchanged,updated:[...updates.keys()],invalidatedConnectors:[...connectors]});
  return {state:asState(next,state.revision+1,appendCapped(state.past,frame(transaction.label,doc,changeSet)),[]),changeSet};
}
function hasChanges(change: ChangeSet): boolean {
  return Boolean(change.added.length || change.updated.length || change.removed.length || change.assetsChanged.length || change.orderChanged || change.themeChanged || change.groupsChanged);
}
/** JSON values only. Key order is not semantic, child-array order is semantic. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => has(right, key) && equal(left[key], right[key]));
}
function dimsChanged(before: BoardObject | undefined, after: BoardObject | undefined): boolean {
  if (before?.kind !== "shape" && after?.kind !== "shape") return false;
  if (before?.kind !== "shape" || after?.kind !== "shape") return true;
  return before.shape !== after.shape || before.width !== after.width || before.height !== after.height || before.rotation !== after.rotation || !equal(before.at, after.at);
}
/** Authoritative general diff for structural and non-geometry commands. */
export function diffDocuments(before: BoardDocument, after: BoardDocument): ChangeSet {
  const added: Id[] = [];
  const updated: Id[] = [];
  const removed: Id[] = [];
  const invalidatedMaps = new Set<Id>();
  const invalidatedConnectors = new Set<Id>();
  const movedShapes = new Set<Id>();
  const allIds = new Set([...before.order, ...after.order]);
  for (const id of allIds) {
    const old = objectById(before, id);
    const next = objectById(after, id);
    if (equal(old, next)) continue;
    if (old && next) updated.push(id);
    else if (old) removed.push(id);
    else added.push(id);
    if (dimsChanged(old, next)) movedShapes.add(id);
    if (old?.kind === "connector" || next?.kind === "connector") invalidatedConnectors.add(id);
    if (old?.kind === "mindmap" || next?.kind === "mindmap") {
      if (old?.kind !== "mindmap" || next?.kind !== "mindmap" || old.layout !== next.layout ||
          old.rootId !== next.rootId || old.theme !== next.theme || old.scale!==next.scale || old.spacing!==next.spacing ||
          old.skin!==next.skin || !equal(old.branchColors,next.branchColors) || !equal(old.topics, next.topics)) invalidatedMaps.add(id);
    }
  }
  if (movedShapes.size) {
    for (const doc of [before, after]) {
      for (const item of Object.values(doc.objects)) {
        if (item.kind === "connector" &&
            ((item.from.kind === "anchor" && movedShapes.has(item.from.objectId)) ||
             (item.to.kind === "anchor" && movedShapes.has(item.to.objectId)))) invalidatedConnectors.add(item.id);
      }
    }
  }
  const assetsChanged = [...new Set([...Object.keys(before.assets), ...Object.keys(after.assets)])].filter(id =>
    !equal(has(before.assets, id) ? before.assets[id] : undefined, has(after.assets, id) ? after.assets[id] : undefined));
  return freezeData({
    added, updated, removed, invalidatedMaps: [...invalidatedMaps], invalidatedConnectors: [...invalidatedConnectors],
    ...(!equal(before.flowGroups,after.flowGroups)?{groupsChanged:true}:{}),
    assetsChanged, orderChanged: !equal(before.order, after.order), themeChanged: before.theme !== after.theme,
  });
}
