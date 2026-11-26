import type {Connector,ShapeObject} from "../core/document.ts";
import {portWorld} from "../core/geometry.ts";
import type {Point,PortId} from "../core/geometry.ts";
import {anchoredFlowPath,flowLabelAnchor,newConnector} from "./flow.ts";
import {columnGap,columnsByComponent,packLanes,rowGap} from "./flow-layout.ts";
import {estimatedTextWidth} from "./text-layout.ts";
import type {DrawingEdge,FlowDirection} from "./flow-drawing-model.ts";
import {drawingEdgeSize} from "./flow-drawing-model.ts";

const even=(n:number)=>Math.ceil(n/2)*2;
export type LayoutEdge=DrawingEdge&{id:string};
type Slot={rank:number;along:number;across:number;start:number;end:number};
/** A diamond's empty corners are usable caption space. All generated nodes are axis-aligned. */
export function captionHitsNode(x:number,y:number,r:number,b:number,n:ShapeObject){
  const cx=n.at.x+n.width/2,cy=n.at.y+n.height/2;
  const dx=Math.max(0,x-cx-2,cx-r-2),dy=Math.max(0,y-cy-2,cy-b-2);
  if(n.shape==="diamond")return dx/(n.width/2)+dy/(n.height/2)<1;
  return dx<n.width/2&&dy<n.height/2;
}
function intersects(path:readonly Point[],node:ShapeObject){
  const x=node.at.x,y=node.at.y,r=x+node.width,b=y+node.height;
  return path.some((q,i)=>{
    if(!i)return false;
    const p=path[i-1];
    return p.x===q.x?p.x>x-2&&p.x<r+2&&Math.min(p.y,q.y)<b+2&&Math.max(p.y,q.y)>y-2:
      p.y===q.y&&p.y>y-2&&p.y<b+2&&Math.min(p.x,q.x)<r+2&&Math.max(p.x,q.x)>x-2;
  });
}
export function layoutFlowDrawing(nodes:ShapeObject[],edges:LayoutEdge[],direction:FlowDirection){
  const horizontal=direction==="LR"||direction==="RL",sign=direction==="RL"||direction==="BT"?-1:1;
  const point=(along:number,across:number):Point=>horizontal?{x:along*sign,y:across}:{x:across,y:along*sign};
  const ahead:PortId=horizontal?(sign>0?"east":"west"):(sign>0?"south":"north");
  const behind:PortId=horizontal?(sign>0?"west":"east"):(sign>0?"north":"south");
  const side=(d:number):PortId=>horizontal?(d<0?"north":"south"):(d<0?"west":"east");
  const along=(n:ShapeObject)=>horizontal?n.width:n.height,across=(n:ShapeObject)=>horizontal?n.height:n.width;
  const index=new Map(nodes.map((n,i)=>[n.id,i])),getNode=(id:string)=>nodes[index.get(id)!];
  const out=nodes.map(()=>[] as number[]),incoming=nodes.map(()=>[] as number[]),lines=new Map<string,Connector>();
  const outgoing=nodes.map(()=>[] as LayoutEdge[]);
  for(const e of edges){
    const a=index.get(e.from)!,b=index.get(e.to)!;outgoing[a].push(e);
    if(!out[a].includes(b)){out[a].push(b);incoming[b].push(a);}
  }
  let bandTop=0;
  for(const ranks of columnsByComponent(out,true)){
    const members=ranks.flat(),links=members.flatMap(i=>outgoing[i]);
    const labelWidth=Math.max(0,...links.map(e=>estimatedTextWidth(e.label??"",drawingEdgeSize*1.1)));
    const gap=even(Math.max(columnGap,horizontal?labelWidth+42:44)),lanes=even(Math.max(rowGap,horizontal?32:Math.min(120,labelWidth+18)));
    const rankSpan=(rank:number[])=>rank.reduce((sum,i)=>sum+across(nodes[i]),(rank.length-1)*lanes);
    const slots=new Map<number,Slot>();
    let start=0;
    for(const [level,rank] of ranks.entries()){
      // Center each fork on its own parent. Joins aim at the mean lane of their incoming branches.
      const ranked=new Set(rank),parents=new Set(rank.flatMap(i=>incoming[i]).filter(j=>slots.has(j)));
      const votes=new Map<number,number[]>();
      for(const j of parents){
        const children=out[j].filter(i=>ranked.has(i));
        let cross=slots.get(j)!.across-rankSpan(children)/2;
        for(const i of children){
          const parent=slots.get(j)!.across,offset=cross+across(nodes[i])/2-parent;
          const reach=children.length>1?Math.max(Math.abs(offset),across(nodes[j])/2+22):Math.abs(offset);
          const scores=votes.get(i)??[];scores.push(parent+Math.sign(offset)*reach);votes.set(i,scores);
          cross+=across(nodes[i])+lanes;
        }
      }
      const preference=(i:number)=>{const v=votes.get(i);return v?v.reduce((a,b)=>a+b,0)/v.length:0;};
      rank.sort((a,b)=>preference(a)-preference(b)||a-b);
      const centers=packLanes(rank.map(i=>({size:across(nodes[i]),preferred:preference(i)})),lanes);
      const depth=Math.max(...rank.map(i=>along(nodes[i]))),end=start+depth;
      rank.forEach((i,j)=>slots.set(i,{rank:level,along:start+depth/2,across:Math.round(centers[j]),start,end}));
      start=end+gap;
    }
    const shift=bandTop-Math.min(...members.map(i=>slots.get(i)!.across-across(nodes[i])/2));
    for(const i of members){
      const s=slots.get(i)!,n=nodes[i];s.across+=shift;
      const center=point(s.along,s.across);
      nodes[i]={...n,at:{x:center.x-n.width/2,y:center.y-n.height/2}};
    }
    let exterior=Math.max(...members.map(i=>slots.get(i)!.across+across(nodes[i])/2));
    const pairs=new Set<string>();
    for(const edge of links){
      const a=index.get(edge.from)!,b=index.get(edge.to)!,from=nodes[a],to=nodes[b],s=slots.get(a)!,t=slots.get(b)!;
      const offset=t.across-s.across;
      const anchor=(node:ShapeObject,portId:PortId)=>({kind:"anchor" as const,objectId:node.id,portId});
      const sourcePort=Math.abs(offset)>across(from)/2+8&&out[a].length>1?side(offset):ahead;
      const targetPort=Math.abs(offset)>across(to)/2+8&&incoming[b].length>1?side(-offset):behind;
      const link=(startPort:PortId,endPort:PortId,waypoints:Point[]=[]):Connector=>({
        ...newConnector(anchor(from,startPort),anchor(to,endPort),"orthogonal",edge.id),
        arrow:edge.arrow??"end",label:edge.label??"",labelFontSize:drawingEdgeSize,autoPorts:"both",strokeWidth:2,waypoints,
      });
      let line=link(sourcePort,targetPort);
      const pathFor=(source:PortId,target:PortId,link:Connector)=>anchoredFlowPath(
        portWorld(from,from.shape,source),portWorld(to,to.shape,target),"orthogonal",link.waypoints,link.from,link.to,getNode,link);
      const blocked=(path:readonly Point[])=>{
        const label=edge.label&&flowLabelAnchor(path,false,drawingEdgeSize);
        const w=estimatedTextWidth(edge.label??"",drawingEdgeSize*1.1),h=drawingEdgeSize*1.2;
        const x=label?label.point.x-(label.align==="center"?w/2:0):0;
        return members.some(i=>{
          const n=nodes[i];
          if(i!==a&&i!==b&&intersects(path,n))return true;
          return label&&captionHitsNode(x,label.point.y-h/2,x+w,label.point.y+h/2,n);
        });
      };
      const pair=a+"/"+b;
      let detour=t.rank<=s.rank||pairs.has(pair);
      if(!detour&&blocked(pathFor(sourcePort,targetPort,line))){
        const mid=Math.round((s.end+t.start)/2);
        line=link(ahead,behind,[point(mid,s.across),point(mid,t.across)]);
        detour=blocked(pathFor(ahead,behind,line));
      }
      if(detour){
        // Route skipped/return edges through the empty gaps between ranks, outside all node rows.
        exterior+=Math.max(rowGap,24);
        const inset=Math.min(24,Math.floor(gap/2)),leave=s.end+inset,enter=t.start-inset;
        line=link(ahead,behind,[point(leave,s.across),point(leave,exterior),point(enter,exterior),point(enter,t.across)]);
      }
      pairs.add(pair);lines.set(edge.id,line);
    }
    bandTop=exterior+64;
  }
  return edges.map(e=>lines.get(e.id)!);
}
