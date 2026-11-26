import type {Connector,ShapeObject} from "../core/document.ts";
import {PORT_IDS,portWorld} from "../core/geometry.ts";
import type {Point,PortId} from "../core/geometry.ts";
import {anchoredFlowPath,flowLabelAnchor,newConnector} from "./flow.ts";
import {captionHitsNode,layoutFlowDrawing} from "./flow-drawing-layout.ts";
import type {LayoutEdge} from "./flow-drawing-layout.ts";
import {drawingEdgeSize,drawingNodeSize,FlowDrawingError} from "./flow-drawing-model.ts";
import type {DrawingGroup,FlowDirection} from "./flow-drawing-model.ts";
import {estimatedTextWidth} from "./text-layout.ts";

export type PlannedFlowGroup={id:string;titleId:string;nodeIds:string[]};
const colors=[
  ["#315F8B","#E8F0FA","#7094BC"],["#236453","#E4F2EB","#76A792"],["#805020","#FFF1DC","#BD9256"],
  ["#634C85","#F1EBF9","#A18AB6"],["#2D6571","#E3F1F2","#77A4AB"],
];
const anchor=(s:ShapeObject,p:PortId)=>({kind:"anchor" as const,objectId:s.id,portId:p});
const translate=(p:Point,x:number,y:number)=>({x:p.x+x,y:p.y+y});
function bounds(nodes:ShapeObject[],lines:Connector[]){
  const points=[...nodes.flatMap(n=>[n.at,translate(n.at,n.width,n.height)]),...lines.flatMap(l=>l.waypoints)];
  return {x:Math.min(...points.map(p=>p.x)),y:Math.min(...points.map(p=>p.y)),
    r:Math.max(...points.map(p=>p.x)),b:Math.max(...points.map(p=>p.y))};
}
function headerId(id:string,used:Set<string>){
  const base="title."+id.slice(0,114);let next=base,n=1;
  while(used.has(next)){n++;next=base+"."+n;}
  used.add(next);return next;
}
const titleWidth=(g:DrawingGroup)=>Math.max(68,2*Math.ceil((estimatedTextWidth(g.label??g.id,drawingNodeSize*1.12)+20)/2));
function hits(a:Point,b:Point,x:number,y:number,r:number,bot:number){
  if(a.x===b.x)return a.x>x&&a.x<r&&Math.max(a.y,b.y)>y&&Math.min(a.y,b.y)<bot;
  if(a.y===b.y)return a.y>y&&a.y<bot&&Math.max(a.x,b.x)>x&&Math.min(a.x,b.x)<r;
  const xs=[(x-a.x)/(b.x-a.x),(r-a.x)/(b.x-a.x)],ys=[(y-a.y)/(b.y-a.y),(bot-a.y)/(b.y-a.y)];
  return Math.max(0,Math.min(...xs),Math.min(...ys))<Math.min(1,Math.max(...xs),Math.max(...ys));
}
type RouteInk={points:readonly Point[];caption?:{x:number;y:number;r:number;b:number}};
function ink(points:readonly Point[],label:string):RouteInk{
  const anchor=label&&flowLabelAnchor(points,false,drawingEdgeSize);
  if(!anchor)return {points};
  const w=estimatedTextWidth(label,drawingEdgeSize*1.1),h=drawingEdgeSize*1.2,x=anchor.point.x-(anchor.align==="center"?w/2:0),y=anchor.point.y-h/2;
  return {points,caption:{x,y,r:x+w,b:y+h}};
}
/** Prefer short native port routes. Try empty side aisles when a group heading or member blocks one. */
function crossRoute(e:LayoutEdge,nodes:ShapeObject[],byId:Map<string,ShapeObject>,horizontal:boolean,previous:RouteInk[]):Connector{
  const a=byId.get(e.from)!,b=byId.get(e.to)!;
  const dx=b.at.x+b.width/2-a.at.x-a.width/2,dy=b.at.y+b.height/2-a.at.y-a.height/2;
  const forward:PortId=horizontal?(dx>=0?"east":"west"):(dy>=0?"south":"north");
  const opposite:Record<PortId,PortId>={east:"west",west:"east",north:"south",south:"north"};
  const preferred=(port:PortId,end:"from"|"to")=>port===(end==="from"?forward:opposite[forward])?0:14;
  let best:Connector|undefined,cost=Infinity;
  const get=(id:string)=>byId.get(id);
  function tryRoute(p:PortId,q:PortId,pins:Point[]=[]){
    const from=anchor(a,p),to=anchor(b,q),f=portWorld(a,a.shape,p),t=portWorld(b,b.shape,q);
    const path=anchoredFlowPath(f,t,"orthogonal",pins,from,to,get);
    let length=0,bends=0,lastX=0,lastY=0;
    for(let i=1;i<path.length;i++){
      const u=path[i-1],v=path[i],x=Math.sign(v.x-u.x),y=Math.sign(v.y-u.y);
      if(!x&&!y)continue;
      if(lastX*x+lastY*y<0)return;
      if(x*lastY||y*lastX)bends++;
      length+=Math.abs(v.x-u.x)+Math.abs(v.y-u.y);lastX=x;lastY=y;
    }
    let score=length+bends*12+preferred(p,"from")+preferred(q,"to");
    if(score>=cost)return;
    const {caption}=ink(path,e.label??"");
    for(const n of nodes){
      const x=n.at.x,y=n.at.y,r=x+n.width,bot=y+n.height,margin=n===a||n===b?0:3;
      if(path.some((v,i)=>i>0&&hits(path[i-1],v,x-margin,y-margin,r+margin,bot+margin)))return;
      if(caption&&captionHitsNode(caption.x,caption.y,caption.r,caption.b,n))return;
    }
    for(const old of previous){
      const c=old.caption;
      if(c&&caption&&caption.x<c.r+2&&caption.r>c.x-2&&caption.y<c.b+2&&caption.b>c.y-2)return;
      for(let i=1;i<path.length;i++){
        const u=path[i-1],v=path[i];
        if(c&&hits(u,v,c.x,c.y,c.r,c.b))score+=150;
        for(let j=1;j<old.points.length;j++){
          const a=old.points[j-1],b=old.points[j];
          const axis=u.x===v.x&&u.x===a.x&&u.x===b.x?"y":u.y===v.y&&u.y===a.y&&u.y===b.y?"x":undefined;
          if(axis)score+=2*Math.max(0,Math.min(Math.max(u[axis],v[axis]),Math.max(a[axis],b[axis]))-Math.max(Math.min(u[axis],v[axis]),Math.min(a[axis],b[axis])));
        }
      }
    }
    if(score>=cost)return;
    cost=score;best={...newConnector(from,to,"orthogonal",e.id),label:e.label??"",labelFontSize:drawingEdgeSize,arrow:e.arrow??"end",strokeWidth:2,
      autoPorts:"both",waypoints:pins};
  }
  for(const p of PORT_IDS)for(const q of PORT_IDS)tryRoute(p,q);
  if(!best){
    const clear=22;
    for(const axis of ["x","y"] as const){
      const vertical=axis==="x",size=vertical?"width":"height",other=vertical?"y":"x",negative=vertical?"west":"north",positive=opposite[negative];
      const lanes=new Set(nodes.flatMap(n=>[n.at[axis]-clear,n.at[axis]+n[size]+clear]));
      for(const lane of lanes){
        const p=lane<a.at[axis]?negative:positive,q=lane<b.at[axis]?negative:positive;
        const f=portWorld(a,a.shape,p),t=portWorld(b,b.shape,q);
        if((lane-f[axis])*(p===negative?-1:1)<18||(lane-t[axis])*(q===negative?-1:1)<18)continue;
        const via=(n:number):Point=>vertical?{x:lane,y:n}:{x:n,y:lane};
        tryRoute(p,q,[via(f[other]),via(t[other])]);
      }
    }
  }
  if(!best)throw new FlowDrawingError("graph.edges","跨组连线 "+e.id+" 找不到避开标题和节点的通道，请调整分区或流程方向");
  return best;
}

export function layoutGroupedFlow(nodes:ShapeObject[],edges:LayoutEdge[],groups:readonly DrawingGroup[],direction:FlowDirection){
  const horizontal=direction==="LR"||direction==="RL";
  const rail=Math.max(...groups.map(titleWidth));
  const byId=new Map(nodes.map(n=>[n.id,n])),owner=new Map<string,string>(),titles:ShapeObject[]=[],planned:PlannedFlowGroup[]=[];
  const used=new Set([...byId.keys(),...groups.map(g=>g.id),...edges.map(e=>e.id)]);
  const blocks:{box:ShapeObject;nodes:ShapeObject[];lines:Connector[]}[]=[],nativeLines=new Map<string,Connector>();
  for(const [i,g] of groups.entries()){
    const members=g.nodeIds.map(id=>byId.get(id)!);
    for(const n of members)owner.set(n.id,g.id);
    const ids=new Set(g.nodeIds),internal=edges.filter(e=>ids.has(e.from)&&ids.has(e.to));
    const lines=layoutFlowDrawing(members,internal,direction),extent=bounds(members,lines);
    const [ink,fill,stroke]=colors[i%colors.length],label=g.label??g.id,titleId=headerId(g.id,used);
    const title:ShapeObject={kind:"shape",id:titleId,label,shape:"rect",cornerRadius:5,at:{x:horizontal?0:rail-titleWidth(g),y:0},rotation:0,
      width:titleWidth(g),height:36,labelFontSize:drawingNodeSize,fill:ink,stroke:ink,strokeWidth:1};
    // Keep the heading beside the direction of travel so the port of the first member remains accessible.
    const bodyX=horizontal?0:rail+18,bodyY=horizontal?46:0,x=bodyX-extent.x,y=bodyY-extent.y;
    const body=members.map(n=>({...n,at:translate(n.at,x,y),fill,stroke}));
    const box={...title,id:g.id,width:2*Math.ceil(Math.max(title.width,extent.r-extent.x+bodyX)/2),
      height:2*Math.ceil(Math.max(title.height,extent.b-extent.y+bodyY)/2)};
    blocks.push({box,nodes:[title,...body],lines:lines.map(l=>({...l,waypoints:l.waypoints.map(p=>translate(p,x,y))}))});
    planned.push({id:g.id,titleId,nodeIds:[...g.nodeIds]});
  }
  for(const n of nodes)if(!owner.has(n.id))blocks.push({box:{...n},nodes:[{...n,at:{x:0,y:0}}],lines:[]});
  const blockId=(id:string)=>owner.get(id)??id;
  const outer=edges.filter(e=>blockId(e.from)!==blockId(e.to)||(!owner.has(e.from)&&e.from===e.to));
  const boxes=blocks.map(b=>b.box);
  const skeleton=layoutFlowDrawing(boxes,outer.map(e=>({...e,from:blockId(e.from),to:blockId(e.to)})),direction);
  const placed=new Map<string,ShapeObject>();
  blocks.forEach((block,i)=>{
    const {x,y}=boxes[i].at;
    for(const n of block.nodes)placed.set(n.id,{...n,at:translate(n.at,x,y)});
    for(const l of block.lines)nativeLines.set(l.id,{...l,waypoints:l.waypoints.map(p=>translate(p,x,y))});
  });
  for(let i=0;i<nodes.length;i++)nodes[i]=placed.get(nodes[i].id)!;
  for(const g of planned)titles.push(placed.get(g.titleId)!);
  const obstacles=[...placed.values()];
  function painted(line:Connector){
    const {from,to}=line;
    if(from.kind!=="anchor"||to.kind!=="anchor")throw new Error("Flow drawing requires bound endpoints");
    const a=placed.get(from.objectId)!,b=placed.get(to.objectId)!;
    return ink(anchoredFlowPath(portWorld(a,a.shape,from.portId),portWorld(b,b.shape,to.portId),line.routing,line.waypoints,from,to,id=>placed.get(id),line),line.label);
  }
  const previous=[...nativeLines.values()].map(painted);
  outer.forEach((e,i)=>{
    const line=e.from===e.to?skeleton[i]:crossRoute(e,obstacles,placed,horizontal,previous);
    nativeLines.set(e.id,line);previous.push(painted(line));
  });
  return {titles,groups:planned,lines:edges.map(e=>nativeLines.get(e.id)!)};
}
