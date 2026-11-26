import { DocumentValidationError, isId, isRecord, objectById } from "../core/document.ts";
import type { BoardDocument, BoardObject, Topic } from "../core/document.ts";
import { expandGroupSelection, flowGroupOf } from "../core/flow-groups.ts";
import { SceneProjection } from "../scene/projector.ts";
import { planFlowLayout } from "./flow-layout.ts";
import { arrangeCommands, isArrangeCommand, planArrange } from "./arrange.ts";
import { planTopicAddition, planTopicDeletion, planTopicMove, topSide, withBranchSide, withMindLayout, withTopicInput } from "./mindmap.ts";
import { planDownstream } from "./flow-keyboard.ts";
import { allocateId } from "../core/id.ts";
import { dispatch } from "../core/history.ts";
import type { Patch } from "../core/history.ts";
import type { EditorSession } from "../session/editor.ts";
import { AssetVault, inspectImage, MAX_IMAGE_BYTES } from "./image-assets.ts";
import type { AssetPayload } from "./image-assets.ts";
import { referencedAssetIds } from "./standalone.ts";
import { removedEndpointPatches } from "./flow.ts";

export class CommandError extends Error {
  code: string;
  operationIndex?:number;
  path?:string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function reject(code: string, message: string): never { throw new CommandError(code, message); }
function operationError(error:unknown,index:number):CommandError{
  const result=error instanceof CommandError?error:new CommandError("INVALID",error instanceof Error?error.message:String(error));
  result.operationIndex??=index;
  if(error instanceof DocumentValidationError)result.path??=error.issues[0]?.path;
  result.path??="arguments.operations["+index+"]";
  return result;
}
function issueOperation(error:DocumentValidationError,operations:readonly unknown[],end=operations.length):number{
  const path=error.issues[0]?.path;
  let best=-1,length=0;
  for(let i=0;i<end;i++){
    const op=operations[i];if(!isRecord(op))continue;
    const id=isRecord(op.value)?op.value.id:op.id;
    if(typeof id==="string"&&id.length>=length&&(path==="objects."+id||path?.startsWith("objects."+id+"."))){
      best=i;length=id.length;
    }
  }
  return best;
}
function record(input: unknown) {
  if (!isRecord(input)) reject("INVALID", "Expected a JSON object");
  return input;
}
function string(input: unknown, name: string): string {
  if (typeof input !== "string" || !input) reject("INVALID", "Expected " + name);
  return input;
}
function keys(input: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) reject("INVALID", "Unexpected field: " + key);
}
const structureFields = {
  addTopic:["id","topicId","relation","newId","text"], deleteTopic:["id","topicId"],
  setMapLayout:["id","layout"], setBranchSide:["id","topicId","side"],
  addDownstream:["id","nodeId","connectorId","group"],
};
type StructureOperation = keyof typeof structureFields;
type OperationResult = {index:number;op:StructureOperation|"arrange"} & Record<string,unknown>;
function newId(value:unknown,prefix:string,exists:(id:string)=>boolean):string {
  if(value!==undefined){
    if(!isId(value))reject("INVALID","Invalid new " + prefix + " ID");
    if(exists(value))reject("CONFLICT","ID already in use: " + value);
    return value;
  }
  let id=allocateId(prefix);
  while(exists(id))id=allocateId(prefix);
  return id;
}
function planStructure(editor:EditorSession,doc:BoardDocument,name:StructureOperation,op:Record<string,unknown>,
    put:(value:BoardObject)=>void):Record<string,unknown> {
  const id=string(op.id,"object ID"),item=objectById(doc,id);
  if(!item)reject("NOT_FOUND","Unknown object: " + id);
  const hidden=editor.hiddenIdsFor(doc);
  if(editor.isLocked(id)||hidden.has(id))reject("CONFLICT","The target is locked or hidden: " + id);
  if(name==="addDownstream"){
    if(item.kind!=="shape")reject("INVALID","Downstream source must be a shape");
    const group=op.group===undefined?undefined:string(op.group,"group ID");
    if(flowGroupOf(doc,id)!==group)reject("CONFLICT","Specify the source node's current group ID");
    const occupiedId=(candidate:string)=>Object.hasOwn(doc.objects,candidate)||Object.hasOwn(doc.assets,candidate)
      ||Object.hasOwn(doc.flowGroups?.members??{},candidate);
    const nodeId=newId(op.nodeId,"node",occupiedId);
    const connectorId=newId(op.connectorId,"line",candidate=>candidate===nodeId||occupiedId(candidate));
    const scene=new SceneProjection(doc);
    scene.setHidden(hidden);
    const plan=planDownstream(doc,item,area=>scene.query(area).some(group=>doc.objects[group.id].kind!=="connector"),nodeId,connectorId);
    if(!plan)reject("CONFLICT","No legal downstream position was found");
    put(plan.node);put(plan.line);
    return {id,nodeId,connectorId,at:plan.node.at,from:plan.line.from,to:plan.line.to};
  }
  if(item.kind!=="mindmap")reject("INVALID","Expected a mind map: " + id);
  if(name==="setMapLayout"){
    const next=withMindLayout(item,op.layout);
    if(!next)reject("INVALID","Expected layout left, right or balanced");
    if(next!==item)put(next);
    return {id,layout:next.layout,changed:next!==item};
  }
  const topicId=string(op.topicId,"topicId");
  if(!Object.hasOwn(item.topics,topicId))reject("NOT_FOUND","Unknown topic in this map: " + topicId);
  if(name==="addTopic"){
    if(op.relation!=="child"&&op.relation!=="sibling")reject("INVALID","Expected relation child or sibling");
    if(op.text!==undefined&&typeof op.text!=="string")reject("INVALID","Expected topic text");
    const addedId=newId(op.newId,"topic",candidate=>Object.hasOwn(item.topics,candidate));
    const plan=planTopicAddition(item,topicId,op.relation,addedId);
    if(!plan)reject("INVALID","The root cannot have a sibling");
    const next=op.text===undefined?plan.map:withTopicInput(plan.map,addedId,op.text,true);
    put(next);
    return {id,topicId:addedId,parentId:plan.parentId,position:plan.position,text:next.topics[addedId].text,side:topSide(next,addedId)};
  }
  if(name==="deleteTopic"){
    const plan=planTopicDeletion(item,topicId);
    if(!plan)reject("INVALID","The root cannot be deleted as a branch");
    put(plan.map);
    return {id,topicId,parentId:plan.parentId,removedIds:plan.removedIds};
  }
  if(op.side!=="left"&&op.side!=="right")reject("INVALID","Expected side left or right");
  if(!item.topics[item.rootId].childIds.includes(topicId))reject("INVALID","Only a direct child of the root can switch sides");
  const next=withBranchSide(item,topicId,op.side)??item;
  if(next!==item)put(next);
  return {id,topicId,layout:next.layout,side:topSide(next,topicId),changed:next!==item};
}
const arrangeArguments={
  command:{type:"string",enum:arrangeCommands},
  ids:{type:"array",minItems:1,uniqueItems:true,items:{type:"string",minLength:1}},
  group:{type:"string",minLength:1},
};
export const arrangeSchema={
  type:"object",additionalProperties:false,required:["op","command","ids"],
  properties:{op:{const:"arrange"},...arrangeArguments},
};
export const operationFields = {
  ...structureFields,
  arrange:Object.keys(arrangeArguments),
  create: ["value"], update: ["id", "fields", "group"], remove: ["id", "group"],
  topic: ["id", "topicId", "fields"], order: ["ids"], groups: ["members"], theme: ["theme"],
  addImage: ["assetId", "base64", "value"],
  layoutFlow: ["ids", "group"], moveTopic: ["id", "topicId", "targetId", "place", "side"],
};
function selectedObjectIds(doc:BoardDocument,op:Record<string,unknown>) {
  if (!Array.isArray(op.ids) || !op.ids.length) reject("INVALID",op.op+" requires object IDs");
  const ids = op.ids.map(id=>string(id,"selected object ID"));
  if (new Set(ids).size !== ids.length) reject("INVALID","Duplicate "+op.op+" object ID");
  const group = op.group === undefined ? undefined : string(op.group,"group");
  for (const id of ids) {
    if (!objectById(doc,id)) reject("NOT_FOUND","Unknown selected object: " + id);
    if (group && flowGroupOf(doc,id) !== group) reject("CONFLICT","Selected object is outside the specified flow group: " + id);
  }
  return {ids,group};
}
function planIdArrangement(editor:EditorSession,doc:BoardDocument,op:Record<string,unknown>) {
  const command=op.command;
  if(!isArrangeCommand(command))reject("INVALID","Unknown arrange command; see capabilities");
  const {ids,group}=selectedObjectIds(doc,op);
  const hiddenIds=editor.hiddenIdsFor(doc);
  for(const id of ids)if(hiddenIds.has(id))reject("CONFLICT","Cannot select a hidden layer: "+id);
  const selectedIds=editor.visibleSelection(ids,group,doc);
  const plan=planArrange({doc,selectedIds,editingGroup:group,hiddenIds,busy:editor.busy,
    selectionLocked:editor.anyLocked(selectedIds),permitsOrder:order=>editor.permitsOrder(order,doc)},command);
  if(plan.kind==="refused")reject("CONFLICT",plan.message);
  let changedIds:string[]=[];
  if(plan.kind==="move"){
    changedIds=[...plan.objects.keys()];
    if(editor.anyLocked(changedIds))reject("CONFLICT","The arrangement would move a locked object or connector waypoint");
  }else if(plan.kind==="order"){
    const selected=new Set(selectedIds);
    changedIds=doc.order.filter((id,index)=>selected.has(id)&&plan.order[index]!==id);
  }
  return {plan,result:{command,selectedIds,changed:changedIds.length>0,changedIds}};
}
function planSelectedFlow(editor:EditorSession, doc:BoardDocument, op:Record<string,unknown>) {
  const {ids,group}=selectedObjectIds(doc,op);
  const selectedIds = expandGroupSelection(doc,ids,group), hidden = editor.hiddenIdsFor(doc);
  const scene = new SceneProjection(doc);
  scene.setHidden(hidden);
  const plan = planFlowLayout({
    doc, selectedIds, editingGroup:group, busy:editor.busy,
    isHidden:id=>hidden.has(id), isLocked:id=>editor.isLocked(id), anyLocked:ids=>editor.anyLocked(ids),
  },scene);
  if (plan.state === "refused") reject("CONFLICT",plan.message);
  return plan.state === "planned" ? plan.nodes : [];
}
function prepare(editor: EditorSession, input: unknown,detachEdgesOnRemove:boolean) {
  const doc = editor.doc;
  if (!Array.isArray(input) || !input.length || input.length > 1000) reject("INVALID", "A batch requires 1–1000 operations");
  const objects = new Map(Object.entries(doc.objects));
  const patches: Patch[] = [], images: AssetPayload[] = [];
  const released = new Set<string>();
  const results:OperationResult[]=[];
  // Derived operations read a validated, private snapshot of all prior operations in this batch.
  let staged = editor.history, stagedCount = 0;
  function stagedDocument() {
    if (stagedCount < patches.length) {
      staged = dispatch(staged,{label:"CLI",patches:patches.slice(stagedCount)}).state;
      stagedCount = patches.length;
    }
    return staged.doc;
  }
  const put = (value: BoardObject) => {
    const old = objects.get(value.id);
    if (old?.kind === "image" && (value.kind !== "image" || old.assetId !== value.assetId)) released.add(old.assetId);
    objects.set(value.id, value); patches.push({op:"putObject", value});
  };
  function planOperation(raw:unknown,index:number){
    const op = record(raw), name = string(op.op, "op") as keyof typeof operationFields;
    if (!Object.hasOwn(operationFields, name)) reject("INVALID", "Unknown operation: " + name);
    keys(op, ["op", ...operationFields[name]]);
    if (Object.hasOwn(structureFields,name)) {
      const opName=name as StructureOperation;
      const result=planStructure(editor,stagedDocument(),opName,op,put);
      results.push({index,op:opName,...result});
      return;
    }
    if (name === "arrange") {
      const {plan,result}=planIdArrangement(editor,stagedDocument(),op);
      if(plan.kind==="order")patches.push({op:"setOrder",ids:plan.order});
      if(plan.kind==="move")for(const item of plan.objects.values())put(item);
      results.push({index,op:name,...result});
      return;
    }
    if (name === "layoutFlow") {
      for (const node of planSelectedFlow(editor,stagedDocument(),op)) put(node);
      return;
    }
    if (name === "moveTopic") {
      const map = objectById(stagedDocument(),string(op.id,"map ID"));
      const topicId = string(op.topicId,"topicId"), target = string(op.targetId,"targetId");
      if (map?.kind !== "mindmap" || !Object.hasOwn(map.topics,topicId) || !Object.hasOwn(map.topics,target))
        reject("NOT_FOUND","Both topic IDs must exist in the specified mind map");
      const {place,side} = op;
      if (place !== "child" && place !== "before" && place !== "after") reject("INVALID","Expected place child, before or after");
      if (side !== undefined && side !== "left" && side !== "right") reject("INVALID","Expected side left or right");
      const next = planTopicMove(map,topicId,{target,place,side});
      if (!next) reject("INVALID","Cannot move the root, target itself or its descendants, or place a sibling of the root");
      if (next !== map) put(next);
      return;
    }
    if (name === "create" || name === "addImage") {
      const value = record(op.value), id = string(value.id, "object ID");
      if (objects.has(id)) reject("INVALID", "Object already exists: " + id);
      if (name === "addImage") {
        const assetId = string(op.assetId, "assetId"), data = string(op.base64, "base64");
        if (value.kind !== "image" || value.assetId !== assetId || data.length > Math.ceil(MAX_IMAGE_BYTES/3)*4)
          reject("INVALID", "Image reference or byte length is invalid");
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        const {width, height, mime} = inspectImage(bytes);
        const meta = {id:assetId, pixelWidth:width, pixelHeight:height, mime};
        images.push({meta, bytes}); patches.push({op:"putAsset", value:meta});
      }
      put(value as BoardObject); return;
    }
    if (name === "order") {
      if (!Array.isArray(op.ids)) reject("INVALID", "Expected order.ids");
      patches.push({op:"setOrder", ids:op.ids}); return;
    }
    if (name === "groups") { patches.push({op:"setFlowGroups", members:record(op.members) as Record<string,string[]>}); return; }
    if (name === "theme") { patches.push({op:"setTheme", theme:string(op.theme,"theme")}); return; }
    const id = string(op.id, "object ID"), current = objects.get(id);
    if (!current) reject("NOT_FOUND", "Unknown object: " + id);
    const group = flowGroupOf(doc, id);
    if (group !== op.group) reject("CONFLICT", "Member edits require the current group ID: " + (group ?? "(none)"));
    if (name === "remove") {
      if(detachEdgesOnRemove&&current.kind==="shape"){
        for(const patch of removedEndpointPatches(stagedDocument(),new Set([id]))){
          const linked=patch.op==="putObject"?patch.value.id:patch.op==="removeObject"?patch.id:undefined;
          if(!linked)continue;
          if(editor.isLocked(linked)||editor.isHidden(linked))reject("CONFLICT","An incident connector is locked or hidden: "+linked);
          if(patch.op==="putObject")objects.set(linked,patch.value);else objects.delete(linked);
          patches.push(patch);
        }
      }
      if (current.kind === "image") released.add(current.assetId);
      objects.delete(id); patches.push({op:"removeObject", id}); return;
    }
    const fields = record(op.fields);
    if (Object.hasOwn(fields,"id") || Object.hasOwn(fields,"kind")) reject("INVALID", "Object identity is immutable");
    if (name === "topic") {
      const topicId = string(op.topicId, "topicId");
      if (current.kind !== "mindmap" || !Object.hasOwn(current.topics, topicId)) reject("NOT_FOUND", "Unknown map/topic");
      const topic: Topic = {...current.topics[topicId], ...fields};
      put({...current, topics:{...current.topics, [topicId]:topic}});
    } else put({...current, ...fields} as BoardObject);
  }
  for(const [index,raw] of input.entries()){
    try{planOperation(raw,index);}catch(error){
      const source=error instanceof DocumentValidationError?issueOperation(error,input,index):-1;
      throw operationError(error,source<0?index:source);
    }
  }
  if (released.size) {
    for (const item of objects.values()) if (item.kind === "image") released.delete(item.assetId);
    for (const id of released) patches.push({op:"removeAsset",id});
  }
  return {patches, images, results};
}

export function readBoard(doc: BoardDocument, query: Record<string, unknown> = {}) {
  keys(query, ["id", "kind", "map"]);
  if (Object.keys(query).length > 1) reject("INVALID", "Choose one inspect filter");
  if (query.id !== undefined) return objectById(doc, string(query.id,"id")) ?? reject("NOT_FOUND","Unknown object");
  if (query.kind !== undefined) {
    if (!["shape","connector","mindmap","text","image","ink","path","table"].includes(string(query.kind,"kind"))) reject("INVALID","Unknown object kind");
    return doc.order.map(id => doc.objects[id]).filter(item => item.kind === query.kind);
  }
  if (query.map === undefined) return doc;
  const map = objectById(doc, string(query.map,"map"));
  if (map?.kind !== "mindmap") reject("NOT_FOUND", "Unknown mind map");
  const rows = [], stack: {id:string; parent:string|null; depth:number}[] = [{id:map.rootId,parent:null,depth:0}];
  while (stack.length) {
    const {id,parent,depth} = stack.pop()!, topic = map.topics[id];
    rows.push({parent,depth,...topic});
    for (let i = topic.childIds.length-1; i >= 0; i--) stack.push({id:topic.childIds[i],parent:id,depth:depth+1});
  }
  return {id:map.id, rootId:map.rootId, topics:rows};
}
export function executeBatch(editor: EditorSession, vault: AssetVault, operations: unknown, label = "CLI 批量编辑",options:{detachEdgesOnRemove?:boolean}={}) {
  const {patches, images, results} = prepare(editor, operations,Boolean(options.detachEdgesOnRemove));
  const tx = {label, patches};
  // Full validation before touching the live asset vault. EditorSession also enforces lock/visibility rules.
  let result;
  try{result=dispatch(editor.history,tx);}catch(error){
    if(error instanceof DocumentValidationError&&Array.isArray(operations)){
      const index=issueOperation(error,operations);
      if(index>=0)throw operationError(error,index);
    }
    throw error;
  }
  if (result.state === editor.history) return {changed:false,results};
  try {
    for (const item of images) vault.add(item);
    if (!editor.commitEdit(tx, editor.generation)) reject("CONFLICT", "The editor is busy or the edit touches protected layers");
  } finally { vault.retain(referencedAssetIds(editor)); }
  return {changed:true,results};
}
export function commitBatch(editor:EditorSession,vault:AssetVault,operations:unknown,label?:string):boolean {
  return executeBatch(editor,vault,operations,label).changed;
}
