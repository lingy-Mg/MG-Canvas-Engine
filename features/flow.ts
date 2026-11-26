import { DEFAULT_CONNECTOR_STROKE,MAX_CONNECTOR_STROKE,detachEndpoints,isHexPaint,objectById,resolveEndpoint,zeroLengthConnector } from "../core/document.ts";
import {MAX_LABEL_LENGTH} from "./plain-text.ts";
import {withoutSelectedTopics} from "./mindmap.ts";
import {boundedTextEdit,normalizeBreaks} from "./text-layout.ts";
import { allocateId } from "../core/id.ts";
import { PORT_IDS, gridBox, gridPoint, portWorld } from "../core/geometry.ts";
import { gridEndpoint } from "../core/document-grid.ts";
import type { BoardDocument, Connector, Endpoint, Id, ShapeObject } from "../core/document.ts";
import type { Box, Point, PortId } from "../core/geometry.ts";
import type { Patch } from "../core/history.ts";
import type { EditorSession } from "../session/editor.ts";
import type { BoardObject } from "../core/document.ts";
import {facingPortGap,portCurvePath} from "./flow-curve.ts";

export type DropNode="process"|"decision";
export const DEFAULT_FLOW_ROUTE="curve" as const;
export type Preset=DropNode|"triangle";
export const flowPresets={
  process:{shape:"rect",width:136,height:62,cornerRadius:9,fill:"#edf4ff",stroke:"#5d8fed",label:"流程步骤"},
  decision:{shape:"diamond",width:112,height:90,cornerRadius:0,fill:"#fff5e6",stroke:"#d78e33",label:"需要判断？"},
  triangle:{shape:"triangle",width:100,height:82,cornerRadius:0,fill:"#e8f7f2",stroke:"#459983",label:""},
} as const;
export const isFlowPreset=(tool?:string):tool is Preset=>tool==="process"||tool==="decision"||tool==="triangle";
export type Port=Readonly<{end:Extract<Endpoint,{kind:"anchor"}>;point:Point}>;
export type FlowHandle = Readonly<{kind:"endpoint";id:Id;field:"from"|"to";point:Point}|{kind:"waypoint";id:Id;index:number;point:Point}>;
export const free=(point:Point):Endpoint=>({kind:"free",point:gridPoint(point)});
const add=(a:Point,b:Point):Point=>({x:a.x+b.x,y:a.y+b.y});
const midpoint=(a:Point,b:Point):Point=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
const same=(a:Point,b:Point):boolean=>a.x===b.x&&a.y===b.y;
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
export function shapePreset(preset:Preset,center:Point,id:Id=allocateId("node")):ShapeObject{
  const style=flowPresets[preset];
  return {id,kind:"shape",...style,at:gridPoint({x:center.x-style.width/2,y:center.y-style.height/2}),rotation:0};
}
export function createFlowNode(editor:EditorSession,preset:Preset,point:Point,bounds?:Box):ShapeObject|undefined{
  const item={...shapePreset(preset,point),...(bounds&&gridBox(bounds))};
  if(editor.commitEdit({label:"创建图形",patches:[{op:"putObject",value:item}]},editor.generation,[item.id]))return item;
}
function singleLineLabel(value:string,original:string):string{
  const normalized=normalizeBreaks(value);
  return normalized===normalizeBreaks(original)?original:boundedTextEdit(original,normalized.replace(/\n/g," "),Math.max(MAX_LABEL_LENGTH,original.length));
}
export function withFlowNodeLabel(item:ShapeObject,value:string):ShapeObject{
  const label=singleLineLabel(value,item.label);
  return label===item.label?item:{...item,label};
}
export function setFlowNodeLabel(editor:EditorSession,id:Id,value:string):boolean{
  const item=objectById(editor.doc,id);
  if(item?.kind!=="shape")return false;
  return editor.commitEdit({label:"修改节点文字",patches:[{op:"putObject",value:withFlowNodeLabel(item,value)}]},editor.generation);
}
export function shapePorts(shape:ShapeObject):Port[]{
  return PORT_IDS.map(portId=>({end:{kind:"anchor",objectId:shape.id,portId},point:portWorld(shape,shape.shape,portId)}));
}
export function pickPort(doc:BoardDocument,point:Point,tolerance:number,allow?:ReadonlySet<Id>, ordered:readonly Id[]=doc.order):Port|undefined {
  let nearest:Port|undefined, best=tolerance;
  for(let i=ordered.length-1;i>=0;i--){
    const id=ordered[i],item=doc.objects[id];
    if((allow&&!allow.has(id))||item.kind!=="shape")continue;
    for(const port of shapePorts(item)){
      const d=distance(point,port.point);
      if(d<best||(!nearest&&d===best)){best=d;nearest=port;}
    }
  }
  return nearest;
}
function facingPort(shape:ShapeObject,from:Point):Port {
  const ports=shapePorts(shape);
  return ports.reduce((best,port)=>distance(port.point,from)<distance(best.point,from)?port:best);
}
export function newConnector(from:Endpoint,to:Endpoint,route:Connector["routing"],id:Id=allocateId("line")):Connector {
  return {id,kind:"connector",from:gridEndpoint(from),to:gridEndpoint(to),routing:route,...(route==="curve"?{portCurve:true as const}:{}),
    waypoints:[],label:"",arrow:route==="straight"?"none":"end",stroke:"#475a75",unedited:true};
}
export function connectFlow(editor:EditorSession,from:Endpoint,to:Endpoint,route:Connector["routing"]=DEFAULT_FLOW_ROUTE,autoTarget=false):Connector|undefined{
  if(from.kind==="anchor"&&to.kind==="anchor"&&from.objectId===to.objectId&&from.portId===to.portId)return;
  const line={...newConnector(from,to,route),...(autoTarget&&to.kind==="anchor"?{autoPorts:"to" as const}:{})};
  if(editor.commitEdit({label:"创建连接线",patches:[{op:"putObject",value:line}]},editor.generation,[line.id]))return line;
}
export function connectToNewNode(editor:EditorSession,from:Endpoint,center:Point,preset:Preset="process"):Connector|undefined{
  const plan=planConnectedNode(editor.doc,from,center,preset);
  if(plan)return commitConnectedNode(editor,plan);
}
export function planConnectedNode(doc:BoardDocument,from:Endpoint,center:Point,preset:Preset,nodeId?:Id,connectorId?:Id){
  const origin=resolveEndpoint(doc,from);
  if(!origin||distance(origin,center)<24)return;
  return linkToNode(from,origin,shapePreset(preset,center,nodeId),connectorId);
}
function linkToNode(from:Endpoint,origin:Point,node:ShapeObject,connectorId?:Id){
  const target=facingPort(node,origin);
  return {node,line:{...newConnector(from,target.end,DEFAULT_FLOW_ROUTE,connectorId),autoPorts:"to" as const}};
}
export function connectDroppedNode(editor:EditorSession,from:Endpoint,point:Point,preset:DropNode):Connector|undefined{
  const origin=resolveEndpoint(editor.doc,from),center=gridPoint(point);
  if(!origin||same(origin,center))return;
  let node=shapePreset(preset,center);
  const dx=center.x-origin.x,dy=center.y-origin.y;
  // On a short drag the default box would cover the source port. Let the
  // new node begin at the release point so even this link has a visible span.
  if(Math.abs(dx)<=node.width/2&&Math.abs(dy)<=node.height/2){
    const horizontal=Math.abs(dx)*node.height>=Math.abs(dy)*node.width;
    const shift=horizontal?{x:Math.sign(dx)*node.width/2,y:0}:{x:0,y:Math.sign(dy)*node.height/2};
    node={...node,at:add(node.at,shift)};
  }
  return commitConnectedNode(editor,linkToNode(from,origin,node));
}
export function commitConnectedNode(editor:EditorSession,{node,line}:{node:ShapeObject;line:Connector}):Connector|undefined{
  if(editor.commitEdit({label:"创建节点并连接",patches:[{op:"putObject",value:node},{op:"putObject",value:line}]},editor.generation,[node.id]))return line;
}
function editLine(editor:EditorSession,id:Id,label:string,fn:(line:Connector)=>Connector):boolean{
  const line=objectById(editor.doc,id);
  if(line?.kind!=="connector")return false;
  return editor.commitEdit({label,patches:[{op:"putObject",value:fn(line)}]},editor.generation);
}
function explicitEnd(line:Connector,field:"from"|"to",end:Endpoint):Connector{
  const {autoPorts,...base}=line,other=field==="from"?"to":"from";
  return {...base,[field]:end,...(autoPorts==="both"||autoPorts===other?{autoPorts:other}:{})};
}
export function setConnectorEnd(editor:EditorSession,id:Id,field:"from"|"to",end:Endpoint):boolean{
  return editLine(editor,id,"重绑或分离端点",line=>explicitEnd(line,field,gridEndpoint(end)));
}
export function detachConnectorEnd(editor:EditorSession,id:Id,field:"from"|"to"):boolean{
  return editLine(editor,id,"重绑或分离端点",line=>explicitEnd(line,field,detachEndpoints(editor.doc,line,(_,end)=>end===field)[field]));
}
export type ConnectorStyle=Readonly<{label:string;arrow:Connector["arrow"];routing:Connector["routing"];stroke?:string;strokeWidth?:number}>;
/** Style changes preserve stored pins and bindings, and reject routes with zero length. */
export function planConnectorStyle(doc:BoardDocument,line:Connector,style:ConnectorStyle):Connector|undefined{
  const {label,routing,arrow,stroke,strokeWidth}=style;
  if(objectById(doc,line.id)!==line||typeof label!=="string"||!["straight","orthogonal","curve"].includes(routing)||
    !["none","start","end","both"].includes(arrow)||(stroke!==undefined&&!isHexPaint(stroke))||
    (strokeWidth!==undefined&&(!Number.isFinite(strokeWidth)||strokeWidth<.25||strokeWidth>MAX_CONNECTOR_STROKE)))return;
  if(routing!==line.routing){
    const from=resolveEndpoint(doc,line.from),to=resolveEndpoint(doc,line.to);
    if(!from||!to||zeroLengthConnector(from,to,routing,line.waypoints))return;
  }
  const nextLabel=singleLineLabel(label,line.label),nextStroke=stroke??line.stroke;
  const nextWidth=strokeWidth===undefined||(line.strokeWidth===undefined&&strokeWidth===DEFAULT_CONNECTOR_STROKE)?line.strokeWidth:strokeWidth;
  if(routing===line.routing&&arrow===line.arrow&&nextStroke===line.stroke&&nextWidth===line.strokeWidth&&nextLabel===line.label)return line;
  const {portCurve,...base}=line;
  const usePortCurve=routing==="curve"&&(portCurve||line.routing!=="curve");
  return {...base,routing,...(usePortCurve?{portCurve:true as const}:{}),arrow,stroke:nextStroke,label:nextLabel,...(nextWidth===undefined?{}:{strokeWidth:nextWidth})};
}
export function styleConnector(editor:EditorSession,id:Id,style:ConnectorStyle):boolean{
  const line=objectById(editor.doc,id);
  if(line?.kind!=="connector")return false;
  const next=planConnectorStyle(editor.doc,line,style);
  return Boolean(next&&next!==line&&editor.commitEdit({label:"修改连线样式",patches:[{op:"putObject",value:next}]},editor.generation));
}
export function setWaypoint(editor:EditorSession,id:Id,index:number,point:Point):boolean{
  return editLine(editor,id,"移动拐点",line=>{
    if(!Number.isInteger(index)||index<0||index>=line.waypoints.length)return line;
    return {...line,waypoints:line.waypoints.map((p,i)=>i===index?gridPoint(point):p)};
  });
}
export function removeWaypoint(editor:EditorSession,id:Id,index:number):boolean{
  return editLine(editor,id,"删除拐点",line=>({...line,waypoints:line.waypoints.filter((_,i)=>i!==index)}));
}
export function addWaypoint(editor:EditorSession,id:Id,requested?:Point):boolean{
  const line=objectById(editor.doc,id);
  if(line?.kind!=="connector")return false;
  const from=resolveEndpoint(editor.doc,line.from),to=resolveEndpoint(editor.doc,line.to);
  if(!from||!to||line.waypoints.length>=128)return false;
  const skeleton=[from,...line.waypoints,to];
  let index=0, score=Infinity;
  for(let i=0;i<skeleton.length-1;i++){
    const a=skeleton[i],b=skeleton[i+1], m=midpoint(a,b);
    const current=requested?distance(m,requested):-distance(a,b);
    if(current<score){score=current;index=i;}
  }
  const point=gridPoint(requested??midpoint(skeleton[index],skeleton[index+1]));
  if(same(point,skeleton[index])||same(point,skeleton[index+1]))return false;
  return editLine(editor,id,"增加拐点",line=>{
    const waypoints=[...line.waypoints];waypoints.splice(index,0,point);
    return {...line,waypoints,routing:line.routing==="straight"?"orthogonal":line.routing};
  });
}
export function flowHandles(doc:BoardDocument,id?:Id,preview?:Connector):FlowHandle[]{
  if(!id)return [];
  const line=preview?.id===id?preview:objectById(doc,id);
  if(line?.kind!=="connector")return [];
  const controls:FlowHandle[]=[];
  for(const field of ["from","to"] as const){const point=resolveEndpoint(doc,line[field]);if(point)controls.push({kind:"endpoint",id,field,point});}
  if(line.routing!=="straight")line.waypoints.forEach((point,index)=>controls.push({kind:"waypoint",point,id,index}));
  return controls;
}
export function pickFlowHandle(handles:readonly FlowHandle[],point:Point,tolerance:number):FlowHandle|undefined{
  let found:FlowHandle|undefined,best=tolerance;
  for(const h of handles){
    const d=distance(h.point,point);
    if(d<best||(!found&&d===best)){found=h;best=d;}
  }
  return found;
}

/** An automatic orthogonal route can have several collinear segments or a real turn. */
function isUneditedStraightLink(doc:BoardDocument,line:Connector):boolean{
  if(!line.unedited||line.waypoints.length)return false;
  if(line.routing==="straight")return true;
  const from=resolveEndpoint(doc,line.from)!,to=resolveEndpoint(doc,line.to)!;
  const length=distance(from,to);
  if(!Number.isFinite(length)||length===0)return false;
  // A display-only simplification must not make an existing link newly eligible for deletion.
  const path=anchoredFlowPath(from,to,line.routing,line.waypoints,line.from,line.to,id=>objectById(doc,id),{portCurve:line.portCurve,straightenSmallOffsets:false});
  const dx=(to.x-from.x)/length,dy=(to.y-from.y)/length;
  const epsilon=Math.min(1e-6,16*Number.EPSILON*Math.max(1,length,Math.abs(from.x),Math.abs(from.y),Math.abs(to.x),Math.abs(to.y)));
  let previous=0;
  for(const point of path){
    const x=point.x-from.x,y=point.y-from.y,along=x*dx+y*dy;
    if(!(Math.abs(x*dy-y*dx)<=epsilon&&along>=previous-epsilon))return false;
    previous=along;
  }
  return true;
}

export function deleteFlowSelection(editor:EditorSession):boolean{
  const ids=new Set(editor.selectedIds);
  if(!ids.size)return false;
  for(const id of ids){const item=objectById(editor.doc,id);if(item?.kind!=="shape"&&item?.kind!=="connector")return false;}
  return deleteBoardSelection(editor);
}
export function deleteBoardSelection(editor:EditorSession):boolean{
  if(editor.selectionLocked)return false;
  const ids=new Set(editor.selectedIds);
  if(!ids.size)return false;
  const patches:Patch[]=[];
  for(const id of ids){
    const range=editor.selectedTopics.get(id),item=editor.doc.objects[id];
    if(range&&item.kind==="mindmap"){
      const rest=withoutSelectedTopics(item,range);
      if(rest){if(rest!==item)patches.push({op:"putObject",value:rest});continue;}
    }
    patches.push({op:"removeObject",id});
  }
  if(!patches.length)return false;
  patches.push(...removedEndpointPatches(editor.doc,ids));
  return editor.commitEdit({label:"删除所选对象",patches},editor.generation,[]);
}
export function removedEndpointPatches(doc:BoardDocument,ids:ReadonlySet<Id>):Patch[]{
  const patches:Patch[]=[];
  for(const item of Object.values(doc.objects))if(item.kind==="connector"&&!ids.has(item.id)){
    const next=detachEndpoints(doc,item,id=>ids.has(id));
    if(next===item)continue;
    patches.push(isUneditedStraightLink(doc,item)
      ?{op:"removeObject",id:item.id}
      :{op:"putObject",value:next,automaticDetach:true});
  }
  return patches;
}

/** Sample display curves so drawing and hit testing share the same points. */
export function flowPath(from:Point,to:Point,routing:Connector["routing"],manual:readonly Point[]):readonly Point[]{
  if(routing==="straight")return [from,to];
  if(routing==="orthogonal"){
    const points=[from,...manual,to],out:Point[]=[from];
    for(let i=1;i<points.length;i++){
      const a=out[out.length-1],b=points[i];
      if(a.x!==b.x&&a.y!==b.y)out.push({x:b.x,y:a.y});
      if(!same(out[out.length-1],b))out.push(b);
    }
    return out;
  }
  const pins=manual.length ? [from,...manual,to] : [from,add(midpoint(from,to),{x:0,y:42}),to];
  const out:Point[]=[pins[0]];
  for(let i=0;i<pins.length-1;i++){
    const a=pins[Math.max(0,i-1)],b=pins[i],c=pins[i+1],d=pins[Math.min(pins.length-1,i+2)];
    const blend=(v:"x"|"y",t:number)=>{
      return .5*((2*b[v])+(-a[v]+c[v])*t+(2*a[v]-5*b[v]+4*c[v]-d[v])*t*t+(-a[v]+3*b[v]-3*c[v]+d[v])*t*t*t);
    };
    for(let n=1;n<=12;n++)out.push({x:blend("x",n/12),y:blend("y",n/12)});
  }
  return out;
}

// Use world units so zoom, preview and reopening all produce the same route.
const MAX_PORT_OFFSET=4;
const MAX_PORT_SLOPE=1/16;
function canStraightenPortRoute(points:readonly Point[],start?:Point,end?:Point):boolean{
  if(!start||!end||start.x!==-end.x||start.y!==-end.y)return false;
  const along=start.x?"x":"y",across=start.x?"y":"x";
  const from=points[0],to=points[points.length-1];
  const run=(to[along]-from[along])*start[along],rise=to[across]-from[across];
  if(run<=0||Math.abs(rise)>Math.min(MAX_PORT_OFFSET,run*MAX_PORT_SLOPE))return false;
  // A route that doubles back or leaves the strip between the ports needs its detour.
  const acrossSign=rise<0?-1:1;
  return points.every((p,i)=>i===0||((p[along]-points[i-1][along])*start[along]>=0&&
    (p[across]-points[i-1][across])*acrossSign>=0));
}

type FlowPathOptions=Readonly<{portCurve?:boolean;straightenSmallOffsets?:boolean}>;
/** Preview, drawing and hit testing use the same route through the bound ports and pins. */
export function anchoredFlowPath(from:Point,to:Point,routing:Connector["routing"],manual:readonly Point[],
  fromEnd:Endpoint|undefined,toEnd:Endpoint|undefined,lookup:(id:Id)=>BoardObject|undefined,
  options:FlowPathOptions|boolean={}):readonly Point[]{
  const settings:FlowPathOptions=typeof options==="boolean"?{straightenSmallOffsets:options}:options;
  if(routing==="curve"&&settings.portCurve&&(fromEnd?.kind==="anchor"||toEnd?.kind==="anchor"))
    return portCurvePath(from,to,manual,fromEnd,toEnd,lookup);
  if(routing!=="orthogonal")return flowPath(from,to,routing,manual);
  const normal=(end:Endpoint|undefined):Point|undefined=>{
    if(end?.kind!=="anchor")return;
    const shape=lookup(end.objectId);
    if(shape?.kind!=="shape")return;
    const offset={east:0,south:1,west:2,north:3}[end.portId];
    const axis=((Math.round(shape.rotation/(Math.PI/2))+offset)%4+4)%4;
    return [{x:1,y:0},{x:0,y:1},{x:-1,y:0},{x:0,y:-1}][axis];
  };
  const start=normal(fromEnd),end=normal(toEnd);
  if(!start&&!end)return flowPath(from,to,routing,manual);
  const d=Math.min(18,Math.max(1,distance(from,to)*.2),manual.length?Infinity:facingPortGap(from,to,start,end)/2);
  const outside=(p:Point,n:Point|undefined)=>n?{x:p.x+n.x*d,y:p.y+n.y*d}:p;
  const a=outside(from,start),b=outside(to,end);
  const unique=(points:readonly Point[])=>points.filter((p,i)=>i===0||!same(points[i-1],p));
  const via=(pins:readonly Point[])=>unique([from,...flowPath(a,b,routing,pins),to]);
  if(manual.length)return via(manual);
  const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
  const span=Math.max(22,d*2);
  const candidates:readonly (readonly Point[])[]=[[],[{x:a.x,y:b.y}],[{x:mx,y:a.y},{x:mx,y:b.y}],
    [{x:a.x,y:my},{x:b.x,y:my}],...[-1,1].flatMap(sign=>{
      const y=(sign<0?Math.min(a.y,b.y):Math.max(a.y,b.y))+sign*span;
      const x=(sign<0?Math.min(a.x,b.x):Math.max(a.x,b.x))+sign*span;
      return [[{x:a.x,y},{x:b.x,y}],[{x,y:a.y},{x,y:b.y}]];
    })];
  let best:readonly Point[]|undefined,cost=Infinity;
  for(const pins of candidates){
    const points=via(pins);let length=0,bends=0,reversals=0;
    for(let i=1;i<points.length;i++){
      const p=points[i-1],q=points[i];length+=distance(p,q);
      if(i<2)continue;
      const r=points[i-2],u={x:p.x-r.x,y:p.y-r.y},v={x:q.x-p.x,y:q.y-p.y};
      if(u.x*v.x+u.y*v.y<0)reversals++;
      if(u.x*v.y-u.y*v.x!==0)bends++;
    }
    const score=length+4*bends+reversals*1e6;
    if(score<cost){cost=score;best=points;}
  }
  const route=best??via([]);
  return settings.straightenSmallOffsets!==false&&canStraightenPortRoute(route,start,end)?[from,to]:route;
}

function labelBesideSegment(a:Point,b:Point,p:Point,size:number){
  return Math.abs(b.x-a.x)>=Math.abs(b.y-a.y)?{point:{x:p.x,y:p.y-size/2-4},align:"center" as const}:
    {point:{x:p.x+Math.max(8,size*.6),y:p.y},align:"left" as const};
}
export function flowLabelAnchor(path:readonly Point[],centerOnCurve=false,size=10):Readonly<{point:Point;align:"center"|"left"}>|undefined{
  if(centerOnCurve){
    let half=0;
    for(let i=1;i<path.length;i++)half+=distance(path[i-1],path[i])/2;
    for(let i=1;i<path.length;i++){
      const a=path[i-1],b=path[i],length=distance(a,b);
      if(length&&half<=length){
        const t=half/length,p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
        return labelBesideSegment(a,b,p,size);
      }
      half-=length;
    }
  }
  let best:Readonly<{a:Point;b:Point;score:number}>|undefined;
  for(let i=1;i<path.length;i++){
    const a=path[i-1],b=path[i],length=distance(a,b);
    if(length===0)continue;
    const score=length+(a.y===b.y&&length>=28?24:0);
    if(!best||score>best.score)best={a,b,score};
  }
  if(!best)return;
  return labelBesideSegment(best.a,best.b,midpoint(best.a,best.b),size);
}
