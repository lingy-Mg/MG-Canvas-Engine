import type {Connector,ShapeObject} from "../core/document.ts";
import {portWorld} from "../core/geometry.ts";
import type {Point} from "../core/geometry.ts";
import {anchoredFlowPath,flowPresets} from "./flow.ts";
import {layoutFlowDrawing} from "./flow-drawing-layout.ts";
import {layoutGroupedFlow} from "./flow-drawing-groups.ts";
import type {PlannedFlowGroup} from "./flow-drawing-groups.ts";
import {estimatedTextWidth,textRows} from "./text-layout.ts";
import {drawingNodeSize,fields,FlowDrawingError,readGraph} from "./flow-drawing-model.ts";
import type {DrawingEdge,DrawingNode,FlowDrawingInput} from "./flow-drawing-model.ts";
import {parseMermaidFlow} from "./mermaid-flow.ts";

export {FlowDrawingError,drawingShapes,flowDirections} from "./flow-drawing-model.ts";
export type {CompactFlowGraph,DrawingEdge,DrawingNode,DrawingGroup,DrawingShape,FlowDrawingInput} from "./flow-drawing-model.ts";
export {parseMermaidFlow} from "./mermaid-flow.ts";
export type FlowDrawingPlan={operations:{op:"create";value:ShapeObject|Connector}[];nodeIds:string[];edgeIds:string[];groups:PlannedFlowGroup[]};

const even=(n:number)=>Math.ceil(n/2)*2;
function makeShape(node:DrawingNode):ShapeObject{
  const shape=node.shape??"rect",label=node.label??node.id;
  const preset=shape==="diamond"?flowPresets.decision:shape==="triangle"?flowPresets.triangle:flowPresets.process;
  const measureSize=drawingNodeSize*1.12,lines=label.split("\n"),longest=Math.max(...lines.map(s=>estimatedTextWidth(s,measureSize)));
  const factor=shape==="diamond"?.82:shape==="triangle"?.56:shape==="circle"?.70:1;
  let inner=Math.max(72,shape==="diamond"?longest:Math.min(longest,204));
  // Native rectangles can show three rows and diamonds one. Grow before reaching the native ellipsis.
  while(textRows(label,inner,measureSize).length>3)inner*=1.25;
  const rows=textRows(label,inner,measureSize).length;
  let width=even(Math.max(shape==="diamond"?112:96,(inner+20)/factor));
  let height=even(Math.max(shape==="diamond"?(drawingNodeSize*1.28+8)/.34:shape==="triangle"?82:48,(drawingNodeSize*1.35*rows+12)/(shape==="triangle"?.48:1)));
  if(shape==="circle")height=width=Math.max(width,height);
  const cornerRadius=shape==="rounded"?10:shape==="circle"||shape==="stadium"?Math.floor(height/2):0;
  const paint=shape==="circle"||shape==="stadium"?flowPresets.triangle:preset;
  return {kind:"shape",id:node.id,at:{x:0,y:0},rotation:0,shape:preset.shape,width,height,cornerRadius,
    label,labelFontSize:drawingNodeSize,fill:paint.fill,stroke:paint.stroke,strokeWidth:2};
}
function withIds(edges:readonly DrawingEdge[],reserved:readonly string[]){
  const used=new Set([...reserved,...edges.flatMap(e=>e.id?[e.id]:[])]);
  const next=new Map<string,number>();
  return edges.map(edge=>{
    if(edge.id)return {...edge,id:edge.id};
    const key="edge."+edge.from.length+"."+edge.from+"."+edge.to;
    let base=key;
    if(base.length>114){
      let hash=2166136261;
      for(let i=0;i<key.length;i++)hash=Math.imul(hash^key.charCodeAt(i),16777619);
      base=key.slice(0,102)+"."+(hash>>>0).toString(36);
    }
    let n=next.get(base)??1,id:string;
    do{id=n===1?base:base+"."+n;n++;}while(used.has(id));
    used.add(id);next.set(base,n);return {...edge,id};
  });
}
/** Origin is the top-left of the new drawing, including return lanes. No editor or document state is touched. */
export function compileFlowDrawing(input:FlowDrawingInput):FlowDrawingPlan{
  const args=fields(input,"drawing",["graph","mermaid","origin"]);
  if(Object.hasOwn(args,"graph")===Object.hasOwn(args,"mermaid"))throw new FlowDrawingError("drawing","graph 和 mermaid 应恰好提供一个");
  let origin:Point={x:0,y:0};
  if(args.origin!==undefined){
    const p=fields(args.origin,"origin",["x","y"]);
    if(typeof p.x!=="number"||typeof p.y!=="number"||!Number.isSafeInteger(p.x)||!Number.isSafeInteger(p.y))
      throw new FlowDrawingError("origin","世界坐标 x、y 应为安全整数");
    origin={x:p.x,y:p.y};
  }
  const graph=Object.hasOwn(args,"graph")?readGraph(args.graph):parseMermaidFlow(args.mermaid as string);
  const nodes=graph.nodes.map(makeShape),nodeIds=nodes.map(n=>n.id),partitions=graph.groups??[];
  const edges=withIds(graph.edges,[...nodeIds,...partitions.map(g=>g.id)]),direction=graph.direction!;
  const {lines,titles,groups}=partitions.length?layoutGroupedFlow(nodes,edges,partitions,direction):
    {lines:layoutFlowDrawing(nodes,edges,direction),titles:[],groups:[]};
  nodes.push(...titles);
  const lookup=new Map(nodes.map(n=>[n.id,n])),points=nodes.map(n=>n.at);
  for(const l of lines){
    const {from,to}=l;
    if(from.kind!=="anchor"||to.kind!=="anchor")throw new Error("Flow drawing requires bound endpoints");
    const a=lookup.get(from.objectId)!,b=lookup.get(to.objectId)!;
    points.push(...anchoredFlowPath(portWorld(a,a.shape,from.portId),portWorld(b,b.shape,to.portId),l.routing,l.waypoints,from,to,id=>lookup.get(id),l));
  }
  const left=Math.floor(Math.min(...points.map(p=>p.x))),top=Math.floor(Math.min(...points.map(p=>p.y)));
  function translate(p:Point){
    const x=origin.x+(p.x-left),y=origin.y+(p.y-top);
    if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y))throw new FlowDrawingError("origin","图形超出安全整数坐标范围");
    return {x,y};
  }
  for(const n of nodes)translate({x:n.at.x+n.width,y:n.at.y+n.height});
  const values:(ShapeObject|Connector)[]=[
    ...lines.map(l=>({...l,waypoints:l.waypoints.map(translate)})),...nodes.map(n=>({...n,at:translate(n.at)})),
  ];
  return {operations:values.map(value=>({op:"create",value})),nodeIds,edgeIds:edges.map(e=>e.id),groups};
}
