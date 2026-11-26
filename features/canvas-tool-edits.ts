import {isId,objectById} from "../core/document.ts";
import type {BoardDocument,Connector,ShapeObject} from "../core/document.ts";
import {flowGroupOf,groupUnit} from "../core/flow-groups.ts";
import type {PortId,ShapeKind} from "../core/geometry.ts";
import type {EditorSession} from "../session/editor.ts";
import {CommandError,executeBatch} from "./board-commands.ts";
import {DEFAULT_FLOW_ROUTE,newConnector,shapePreset,withFlowNodeLabel} from "./flow.ts";
import type {AssetVault} from "./image-assets.ts";

type NodeOp={op:"node";id:string;x:number;y:number;width?:number;height?:number;shape?:ShapeKind;label?:string;labelFontSize?:number;fill?:string;stroke?:string};
type EdgeOp={op:"edge";id:string;from:string;to:string;fromPort?:PortId;toPort?:PortId;label?:string;labelFontSize?:number;routing?:Connector["routing"];arrow?:Connector["arrow"];stroke?:string};
export type CanvasEdit=NodeOp|EdgeOp|{op:"update";id:string;group?:string;fields:Record<string,unknown>}|{op:"remove";id:string;group?:string};
function fail(index:number,id:string,message:string,code="INVALID"):never{
  const error=new CommandError(code,message+" ("+id+")");error.operationIndex=index;error.path="arguments.operations["+index+"]";throw error;
}
function node(op:NodeOp):ShapeObject{
  const shape=shapePreset(op.shape==="diamond"?"decision":op.shape==="triangle"?"triangle":"process",{x:0,y:0},op.id);
  return {...withFlowNodeLabel(shape,op.label??shape.label),at:{x:op.x,y:op.y},width:op.width??shape.width,height:op.height??shape.height,
    fill:op.fill??shape.fill,stroke:op.stroke??shape.stroke,...(op.labelFontSize===undefined?{}:{labelFontSize:op.labelFontSize})};
}
function edge(op:EdgeOp):Connector{
  const line=newConnector({kind:"anchor",objectId:op.from,portId:op.fromPort??"east"},
    {kind:"anchor",objectId:op.to,portId:op.toPort??"west"},op.routing??DEFAULT_FLOW_ROUTE,op.id);
  return {...line,label:op.label??line.label,arrow:op.arrow??"end",stroke:op.stroke??line.stroke,...(op.labelFontSize===undefined?{}:{labelFontSize:op.labelFontSize})};
}
export function applyCanvasEdits(editor:EditorSession,vault:AssetVault,operations:readonly CanvasEdit[],label="AI 画布编辑"){
  const doc:BoardDocument=editor.doc,planned=new Set(operations.filter(op=>op.op==="node").map(op=>op.id));
  const native=operations.map((op,index)=>{
    if(!isId(op.id))fail(index,op.id,"Invalid object ID");
    if(op.op==="node"||op.op==="edge"){
      if(Object.hasOwn(doc.assets,op.id)||Object.hasOwn(doc.flowGroups?.members??{},op.id))fail(index,op.id,"ID is already in use","CONFLICT");
      if(op.op==="edge")for(const id of [op.from,op.to]){
        if(!planned.has(id)&&objectById(doc,id)?.kind!=="shape")fail(index,id,"Expected an existing or newly declared shape endpoint","NOT_FOUND");
      }
      return {op:"create",value:op.op==="node"?node(op):edge(op)};
    }
    if(editor.isLocked(op.id)||editor.isHidden(op.id))fail(index,op.id,"Layer is locked or hidden","CONFLICT");
    if(op.op==="remove"&&objectById(doc,op.id)?.kind==="shape"){
      const group=flowGroupOf(doc,op.id);
      if(group&&groupUnit(doc,group).some(id=>editor.isLocked(id)||editor.isHidden(id)))
        fail(index,op.id,"Removing this member would change a protected group","CONFLICT");
    }
    return op;
  });
  return applyCanvasBatch(editor,vault,native,label);
}
export function applyCanvasBatch(editor:EditorSession,vault:AssetVault,operations:readonly unknown[],label:string){
  const {changed}=executeBatch(editor,vault,operations,label,{detachEdgesOnRemove:true});
  const change=changed?editor.history.past.at(-1)?.forward:undefined;
  return {changed,addedIds:change?.added??[],updatedIds:change?.updated??[],removedIds:change?.removed??[]};
}
