import { allocateId } from "../core/id.ts";
import {MAX_PATH_STROKE,MAX_PATH_VERTICES,isHexPaint} from "../core/document.ts";
import type {CubicHandles,VectorPath} from "../core/document.ts";
import {segmentBetween,splitSegment} from "../core/path-geometry.ts";
import type {Point} from "../core/geometry.ts";
import {gridPoint} from "../core/geometry.ts";
import type {EditorSession} from "../session/editor.ts";

export const pathStroke="#335b97",pathFill="#dce9ff";
export function finishPath(editor:EditorSession,generation:symbol,points:readonly Point[],closed:boolean):boolean{
  if(points.length<(closed?3:2))return false;
  points=points.map(gridPoint);
  const at=points[0],id=allocateId("path");
  const item:VectorPath={kind:"path",id,at,vertices:points.map(p=>({x:p.x-at.x,y:p.y-at.y})),
    closed,stroke:pathStroke,strokeWidth:2,...(closed?{fill:pathFill}:{})};
  return editor.commitEdit({label:closed?"绘制闭合路径":"绘制开放路径",patches:[{op:"putObject",value:item}]},generation,[id]);
}
export function withPathVertex(item:VectorPath,index:number,delta:Point):VectorPath{
  if(!Number.isInteger(index)||index<0||index>=item.vertices.length||(!delta.x&&!delta.y))return item;
  const vertices=item.vertices.slice(),old=vertices[index];
  vertices[index]=gridPoint({x:old.x+delta.x,y:old.y+delta.y});
  if(vertices[index].x===old.x&&vertices[index].y===old.y)return item;
  return {...item,vertices};
}
export function withSegmentKind(item:VectorPath,index:number,curved:boolean):VectorPath{
  if(!Number.isInteger(index)||index<0||index>=item.vertices.length-(item.closed?0:1)||Boolean(item.curves?.[index])===curved)return item;
  const {curves,...base}=item,updated={...curves};
  if(curved){
    const a=item.vertices[index],b=item.vertices[(index+1)%item.vertices.length];
    const x=(b.x-a.x)/3,y=(b.y-a.y)/3;
    updated[index]={out:gridPoint({x,y}),in:gridPoint({x:-x,y:-y})};
  }else delete updated[index];
  return Object.keys(updated).length?{...base,curves:updated}:base;
}
export function interiorSplit(t:number):boolean{return Number.isFinite(t)&&t>1e-6&&t<1-1e-6;}
export function withInsertedVertex(item:VectorPath,index:number,t:number):VectorPath{
  const n=item.vertices.length;
  if(n>=MAX_PATH_VERTICES||!Number.isInteger(index)||index<0||index>=n-(item.closed?0:1)||!interiorSplit(t))return item;
  const from=item.vertices[index],to=item.vertices[(index+1)%n];
  const [left,right]=splitSegment(segmentBetween(from,to,item.curves?.[index]),t),point=gridPoint(left.to);
  if(point.x===from.x&&point.y===from.y||point.x===to.x&&point.y===to.y)return item;
  const vertices=[...item.vertices.slice(0,index+1),point,...item.vertices.slice(index+1)];
  if(!item.curves)return {...item,vertices};
  const curves:Record<string,CubicHandles>={};
  for(const [key,pair] of Object.entries(item.curves)){
    const i=Number(key);
    if(i!==index)curves[i<index?i:i+1]=pair;
  }
  if(left.controls&&right.controls){
    const offset=(a:Point,b:Point)=>gridPoint({x:a.x-b.x,y:a.y-b.y});
    curves[index]={out:offset(left.controls.c1,from),in:offset(left.controls.c2,point)};
    curves[index+1]={out:offset(right.controls.c1,point),in:offset(right.controls.c2,to)};
  }
  return {...item,vertices,curves};
}
export function withPathControl(item:VectorPath,index:number,side:"out"|"in",delta:Point):VectorPath{
  const pair=item.curves?.[index];
  if(!pair||(!delta.x&&!delta.y)||!Number.isFinite(delta.x)||!Number.isFinite(delta.y))return item;
  const p=pair[side];
  const next=gridPoint({x:p.x+delta.x,y:p.y+delta.y});
  return next.x===p.x&&next.y===p.y?item:{...item,curves:{...item.curves,[index]:{...pair,[side]:next}}};
}
export function commitPathEdit(editor:EditorSession,original:VectorPath,value:VectorPath,generation:symbol,label="移动路径顶点"):boolean{
  if(value===original||editor.doc.objects[original.id]!==original||editor.selectedIds.length!==1||editor.selection!==original.id)return false;
  return editor.commitEdit({label,patches:[{op:"putObject",value}]},generation);
}
export {commitPathEdit as commitPathVertex};
/** The path formats store opaque hex paints; a closed path without a fill is transparent. */
export function withPathAppearance(original:VectorPath,stroke:string,strokeWidth:number,fill?:string):VectorPath|undefined{
  if(!isHexPaint(stroke)||!Number.isFinite(strokeWidth)||strokeWidth<.25||strokeWidth>MAX_PATH_STROKE||
    fill!==undefined&&(!original.closed||!isHexPaint(fill)))return;
  if(stroke===original.stroke&&strokeWidth===original.strokeWidth&&fill===original.fill)return original;
  if(fill!==undefined)return {...original,stroke,strokeWidth,fill};
  const {fill:previous,...geometry}=original;
  return {...geometry,stroke,strokeWidth};
}
export function stylePath(editor:EditorSession,original:VectorPath,stroke:string,strokeWidth:number,fill?:string):boolean{
  const next=withPathAppearance(original,stroke,strokeWidth,original.closed?fill:undefined);
  return Boolean(next&&commitPathEdit(editor,original,next,editor.generation,"修改路径外观"));
}
