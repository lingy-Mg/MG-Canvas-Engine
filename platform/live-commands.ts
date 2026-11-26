import type { EditorSession } from "../session/editor.ts";
import type { AssetVault } from "../features/image-assets.ts";
import { executeBatch, readBoard, reject } from "../features/board-commands.ts";
import { encodeProject } from "./project.ts";
import type {ProjectNames} from "./project.ts";
import { isRecord, objectById } from "../core/document.ts";

export type BlockReason="REOPENING"|"SAVING"|"IMPORTING"|"POINTER_GESTURE"|"INK_STROKE"|"FLOW_EDIT"|
  "PATH_TOOL"|"PATH_DRAFT"|"TEXT_EDITOR"|"MIND_TOPIC_DRAFT"|"PROPERTY_PREVIEW"|"INSPECTOR_DRAFT"|"INSPECTOR_FOCUS"|"EDITOR_BUSY";
const draftReasons=new Set<BlockReason>(["INK_STROKE","FLOW_EDIT","PATH_DRAFT","TEXT_EDITOR","MIND_TOPIC_DRAFT","PROPERTY_PREVIEW","INSPECTOR_DRAFT"]);
type Options = {
  editor:EditorSession; vault:AssetVault; epoch:string; busy:()=>boolean|readonly BlockReason[];
  names?:ProjectNames;
  focusedTopic?:()=>{mapId:string;topicId:string}|undefined;
  save?:(project:string, revision:string)=>Promise<{diskRevision:string}>;
};
type Receipt = {digest:string; appliedRevision:string; outcome:Record<string,unknown>};
function sorted(value:unknown):unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])]));
  return value;
}
async function fingerprint(value:unknown) {
  const canonical=JSON.stringify(sorted(value));
  // Plain HTTP LAN previews lack SubtleCrypto. Exact canonical equality works there as well.
  if(!globalThis.crypto?.subtle)return canonical;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,"0")).join("");
}
export function createLiveCommands({editor,vault,epoch,busy,focusedTopic,save,names}:Options) {
  const opened = editor.generation, receipts = new Map<string,Receipt>();
  let saving = false;
  const revision = () => epoch + "." + editor.history.revision;
  const stateRevision=()=>revision()+"."+editor.lockRevision+"."+editor.visibilityRevision;
  function blockers(skipSaving=false):BlockReason[]{
    const external=busy();
    const reasons=new Set<BlockReason>(typeof external==="boolean"?(external?["EDITOR_BUSY"]:[]):external);
    if(editor.busy)reasons.add("POINTER_GESTURE");
    if(saving&&!skipSaving)reasons.add("SAVING");
    return [...reasons];
  }
  function status(skipSaving=false) {
    return {source:"session",revision:revision(),dirty:editor.dirty,busy:blockers(skipSaving).length>0,canUndo:editor.canUndo,canRedo:editor.canRedo};
  }
  function snapshot() {
    return {...status(),project:encodeProject(editor.doc,vault,names)};
  }
  function layer(id:string){
    const item=objectById(editor.doc,id);
    if(!item)reject("NOT_FOUND","Unknown layer ID: "+id);
    const locked=editor.isLocked(id),directlyHidden=editor.isDirectlyHidden(id);
    const hiddenBy=item.kind==="connector"?[...new Set([item.from,item.to].flatMap(end=>
      end.kind==="anchor"&&editor.isDirectlyHidden(end.objectId)?[end.objectId]:[]))]:[];
    const reasons=[];
    if(locked)reasons.push("LOCKED");
    if(directlyHidden)reasons.push("HIDDEN");
    if(hiddenBy.length)reasons.push("HIDDEN_ENDPOINT");
    return {id,locked,hidden:editor.isHidden(id),directlyHidden,hiddenBy,reasons};
  }
  function layerId(id:unknown):string{
    if(typeof id!=="string"||!id)reject("INVALID","An explicit layer ID is required");
    if(!objectById(editor.doc,id))reject("NOT_FOUND","Unknown layer ID: "+id);
    return id;
  }
  function editState(args:Record<string,unknown>){
    if(Object.keys(args).some(key=>key!=="id"))reject("INVALID","Unexpected edit-state field");
    const reasons=blockers(),ids=args.id===undefined?editor.doc.order:[layerId(args.id)];
    return {...status(),stateRevision:stateRevision(),selectedIds:[...editor.selectedIds],editingGroup:editor.editingGroup??null,
      focusedTopic:focusedTopic?.()??null,selectedTopics:Array.from(editor.selectedTopics,([mapId,ids])=>({mapId,topicIds:[...ids]})),
      blockingReasons:reasons,activeDraft:reasons.some(reason=>draftReasons.has(reason)),layers:ids.map(layer)};
  }
  function setLayer(args:Record<string,unknown>){
    const lock=Object.hasOwn(args,"locked"),visibility=Object.hasOwn(args,"visible");
    if(lock===visibility||typeof (lock?args.locked:args.visible)!=="boolean"||
       Object.keys(args).some(key=>!["id","stateRevision","locked","visible"].includes(key)))
      reject("INVALID","Set exactly one boolean locked or visible and specify a layer ID");
    const id=layerId(args.id);
    if(args.stateRevision!==stateRevision())reject("STALE","Layer or document state changed. Read edit-state again.");
    if(blockers().length)reject("BUSY","Finish the active page edit first; read edit-state for reasons");
    const ids=args.visible===undefined?[id]:editor.doc.order;
    const before=ids.map(layer);
    const changed=typeof args.locked==="boolean"?editor.setLayerLocks([id],args.locked):editor.setLayerVisibility([id],args.visible as boolean);
    const affectedIds=changed?before.filter(old=>{
      const next=layer(old.id);
      return old.locked!==next.locked||old.directlyHidden!==next.directlyHidden||old.hiddenBy.join("/")!==next.hiddenBy.join("/");
    }).map(row=>row.id):[];
    return {...editState({id}),changed,affectedIds};
  }
  function guard(expected:unknown) {
    if(editor.generation!==opened)reject("STALE","The page has opened a different project");
    if (expected !== revision()) reject("STALE","Revision has changed. Inspect the current session.");
    if (blockers().length) reject("BUSY","Finish the active page edit first");
  }
  function receiptId(value:unknown):string {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) reject("INVALID","Expected an operationId of 1–128 characters");
    return value;
  }
  async function mutate(command:string,args:Record<string,unknown>,apply:()=>Record<string,unknown>,signal?:AbortSignal){
    const operationId=receiptId(args.operationId),digest=await fingerprint({command,args});
    if(editor.generation!==opened)reject("STALE","The page has opened a different project");
    if(signal?.aborted)reject("CANCELLED","The request was cancelled before commit");
    const prior=receipts.get(operationId);
    if(prior){
      if(prior.digest!==digest)reject("ID_CONFLICT","This operationId was used with different content");
      return {...status(),operationId,appliedRevision:prior.appliedRevision,...prior.outcome,replayed:true};
    }
    guard(args.baseRevision);
    if(receipts.size>=4096)reject("BUSY","Session receipt capacity reached. Save and start a new session.");
    // No await between the revision check, the native transaction and its receipt.
    const outcome=apply(),appliedRevision=revision();
    receipts.set(operationId,{digest,appliedRevision,outcome});
    return {...status(),operationId,appliedRevision,...outcome,replayed:false};
  }
  function stepHistory(action:"undo"|"redo"){
    if(!(action==="undo"?editor.canUndo:editor.canRedo))reject("CONFLICT","No accessible history step");
    if(action==="undo")editor.undo();else editor.redo();
    return {changed:true};
  }
  async function request(command:string, args:Record<string,unknown> = {},signal?:AbortSignal):Promise<Record<string,unknown>> {
    if(signal?.aborted)reject("CANCELLED","The request was cancelled");
    if (editor.generation !== opened) reject("STALE","The page has opened a different project");
    switch (command) {
      case "status": return status();
      case "edit-state": return editState(args);
      case "set-layer": return setLayer(args);
      case "inspect": return {...status(),data:readBoard(editor.doc,args)};
      case "snapshot": return snapshot();
      case "receipt": {
        const operationId=receiptId(args.operationId), receipt=receipts.get(operationId);
        return {...status(),operationId,known:Boolean(receipt),appliedRevision:receipt?.appliedRevision,...receipt?.outcome};
      }
      case "apply": {
        if (Object.keys(args).some(k=>!["operationId","baseRevision","operations","label"].includes(k)) ||
          args.label!==undefined && typeof args.label!=="string") reject("INVALID","Invalid batch fields");
        return mutate("apply",args,()=>executeBatch(editor,vault,args.operations,args.label as string|undefined),signal);
      }
      case "undo": case "redo": {
        guard(args.baseRevision);
        stepHistory(command);
        return {...status(),appliedRevision:revision()};
      }
      case "save": {
        if(!save)reject("INVALID","This page uses browser autosave");
        guard(args.baseRevision);
        const captured=editor.history.revision, appliedRevision=revision();
        saving=true;
        try {
          const stored=await save(encodeProject(editor.doc,vault,names),appliedRevision);
          editor.markSaved(opened,captured);
          return {...status(true),appliedRevision,...stored};
        } finally { saving=false; }
      }
      default: return reject("INVALID","Unknown session command");
    }
  }
  return {request,status,snapshot,mutate,stepHistory,blockers};
}
