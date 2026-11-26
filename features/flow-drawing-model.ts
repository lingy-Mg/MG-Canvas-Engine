import {isId,isRecord} from "../core/document.ts";
import type {Point} from "../core/geometry.ts";
import {MAX_LABEL_LENGTH} from "./plain-text.ts";

export const flowDirections=["TD","TB","BT","LR","RL"] as const;
export const drawingShapes=["rect","rounded","stadium","circle","diamond","triangle"] as const;
export type FlowDirection=typeof flowDirections[number];
export type DrawingShape=typeof drawingShapes[number];
export type DrawingNode={id:string;label?:string;shape?:DrawingShape};
export type DrawingEdge={from:string;to:string;id?:string;label?:string;arrow?:"end"|"none"|"both"};
export type DrawingGroup={id:string;label?:string;nodeIds:readonly string[]};
export type CompactFlowGraph={direction?:FlowDirection;nodes:readonly DrawingNode[];edges:readonly DrawingEdge[];groups?:readonly DrawingGroup[]};
export type FlowDrawingInput=({graph:CompactFlowGraph;mermaid?:never}|{mermaid:string;graph?:never})&{origin?:Point};

export type SourceLocation={line:number;column:number};
export class FlowDrawingError extends Error{
  code="INVALID";
  path:string;
  line?:number;
  column?:number;
  constructor(path:string,message:string,where?:SourceLocation){
    super((where?"mermaid "+where.line+":"+where.column:path)+" — "+message);
    this.name="FlowDrawingError";this.path=path;this.line=where?.line;this.column=where?.column;
  }
}
export const batchLimit=1000; // executeBatch's native operation limit.
export const drawingNodeSize=17,drawingEdgeSize=16;
export function fields(value:unknown,path:string,accepted:readonly string[]):Record<string,unknown>{
  if(!isRecord(value))throw new FlowDrawingError(path,"应为一个对象");
  for(const key of Object.keys(value))if(!accepted.includes(key))throw new FlowDrawingError(path+"."+key,"不支持此字段");
  return value;
}
export function readGraph(input:unknown,locations?:ReadonlyMap<string,SourceLocation>):CompactFlowGraph{
  // For Mermaid semantic errors, retain the line and column of the corresponding declaration.
  function fail(path:string,message:string):never{
    const where=locations?.get(path)??locations?.get(path.replace(/\.\w+$/,""))??locations?.get("graph");
    throw new FlowDrawingError(where?"mermaid":path,message,where);
  }
  const g=fields(input,"graph",["direction","nodes","edges","groups"]);
  if(g.direction!==undefined&&!flowDirections.some(d=>d===g.direction))fail("graph.direction","方向应为 TD、TB、BT、LR 或 RL");
  if(!Array.isArray(g.nodes)||!g.nodes.length)fail("graph.nodes","至少需要一个节点");
  if(!Array.isArray(g.edges))fail("graph.edges","请提供边数组，无连线时可填 []");
  if(g.groups!==undefined&&!Array.isArray(g.groups))fail("graph.groups","分组应为数组");
  const groupInput=Array.isArray(g.groups)?g.groups:[];
  if(g.nodes.length+g.edges.length+groupInput.length+(groupInput.length?1:0)>batchLimit)fail("graph","一次最多提交 "+batchLimit+" 个原生操作（含标题与分组）");
  const assigned=new Set<string>(),nodeIds=new Set<string>();
  function id(value:unknown,path:string,unique=false):string{
    if(!isId(value))fail(path,"需要有效的 MG 原生 ID（1–128 位，以 ASCII 字母或数字开头）");
    if(unique){
      if(assigned.has(value))fail(path,"ID 已重复："+value);
      assigned.add(value);
    }
    return value;
  }
  function label(value:unknown,path:string,rows:number):string|undefined{
    if(value===undefined)return;
    if(typeof value!=="string"||value.length>MAX_LABEL_LENGTH)fail(path,"文字应为最多 "+MAX_LABEL_LENGTH+" 个 UTF-16 单元的字符串");
    const text=value.replace(/\r\n?/g,"\n");
    if(/[\u0000-\u0009\u000b-\u001f]/.test(text)||text.split("\n").length>rows)fail(path,"该原生标签最多支持 "+rows+" 行，请拆分文字");
    return text;
  }
  const nodes=Array.from(g.nodes,(raw,i):DrawingNode=>{
    const path="graph.nodes["+i+"]",node=fields(raw,path,["id","label","shape"]);
    const name=id(node.id,path+".id",true);
    if(node.shape!==undefined&&!drawingShapes.some(s=>s===node.shape))fail(path+".shape","支持的形状为 "+drawingShapes.join("、"));
    nodeIds.add(name);
    const shape=(node.shape??"rect") as DrawingShape;
    return {id:name,shape,label:label(node.label,path+".label",shape==="diamond"?1:3)??name};
  });
  const edges=Array.from(g.edges,(raw,i):DrawingEdge=>{
    const path="graph.edges["+i+"]",edge=fields(raw,path,["from","to","id","label","arrow"]);
    const from=id(edge.from,path+".from"),to=id(edge.to,path+".to");
    if(!nodeIds.has(from))fail(path+".from","找不到起点 "+from);
    if(!nodeIds.has(to))fail(path+".to","找不到终点 "+to);
    if(edge.arrow!==undefined&&edge.arrow!=="none"&&edge.arrow!=="end"&&edge.arrow!=="both")fail(path+".arrow","箭头应为 end、none 或 both");
    return {from,to,id:edge.id===undefined?undefined:id(edge.id,path+".id",true),label:label(edge.label,path+".label",1),arrow:edge.arrow as DrawingEdge["arrow"]};
  });
  const owners=new Set<string>();
  const groups=Array.from(groupInput,(raw,i):DrawingGroup=>{
    const path="graph.groups["+i+"]",group=fields(raw,path,["id","nodeIds","label"]),name=id(group.id,path+".id",true);
    if(!Array.isArray(group.nodeIds)||!group.nodeIds.length)fail(path+".nodeIds","分组至少需要一个流程节点");
    const members=Array.from(group.nodeIds,(value,j)=>{
      const field=path+".nodeIds["+j+"]",member=id(value,field);
      if(!nodeIds.has(member))fail(field,"分组引用了未知的流程节点 "+member);
      if(owners.has(member))fail(field,"一个节点只能归属一个分组："+member);
      owners.add(member);return member;
    });
    const title=label(group.label,path+".label",1)??name;
    if(!title.trim())fail(path+".label","分组标题不能为空");
    return {id:name,label:title,nodeIds:members};
  });
  return {direction:(g.direction??"TD") as FlowDirection,nodes,edges,...(groups.length?{groups}:{})};
}
