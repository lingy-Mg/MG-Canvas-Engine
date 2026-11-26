import type {Point,Rect} from "../core/geometry.ts";
import {shapeOutlinePoints} from "../core/geometry.ts";
import {DEFAULT_SHAPE_STROKE} from "../core/document.ts";
import {segmentDistance,insideVector} from "../core/path-geometry.ts";
import {estimatedTextWidth} from "../features/text-layout.ts";
import {nodeFont,topicMeasureContext} from "../platform/text-metrics.ts";
import type {DrawGroup,Primitive,Scene} from "./board.ts";
import {SceneGrid} from "./spatial-grid.ts";

type Caption=Extract<Primitive,{kind:"text"}>;
type Route=Extract<Primitive,{kind:"path"}>;
type Anchor=Pick<Caption,"at"|"align">;
type Metrics={advance:number;left:number;right:number;top:number;bottom:number};
type Label={source:DrawGroup;route:Route;text:Caption;ink:Metrics;preferred:Rect;region:Rect};
type Neighbors=(region:Rect)=>DrawGroup[];
const clearance=6;
const labels=new WeakMap<DrawGroup,Label>();
const poses=new WeakMap<DrawGroup,DrawGroup>();
const expand=(r:Rect,x:number,y=x):Rect=>({min:{x:r.min.x-x,y:r.min.y-y},max:{x:r.max.x+x,y:r.max.y+y}});
const overlap=(a:Rect,b:Rect)=>a.min.x<=b.max.x&&a.max.x>=b.min.x&&a.min.y<=b.max.y&&a.max.y>=b.min.y;
const union=(a:Rect,b:Rect):Rect=>({min:{x:Math.min(a.min.x,b.min.x),y:Math.min(a.min.y,b.min.y)},
  max:{x:Math.max(a.max.x,b.max.x),y:Math.max(a.max.y,b.max.y)}});

function measure(text:Caption):Metrics{
  const c=topicMeasureContext();
  if(c){
    c.save();c.font=nodeFont(text.size,text.weight);c.textAlign="left";c.textBaseline="middle";
    const m=c.measureText(text.text);c.restore();
    if([m.width,m.actualBoundingBoxLeft,m.actualBoundingBoxRight,m.actualBoundingBoxAscent,m.actualBoundingBoxDescent].every(Number.isFinite))
      return {advance:m.width,left:-m.actualBoundingBoxLeft,right:m.actualBoundingBoxRight,top:-m.actualBoundingBoxAscent,bottom:m.actualBoundingBoxDescent};
  }
  const width=estimatedTextWidth(text.text,text.size);
  return {advance:width,left:0,right:width,top:-text.size/2,bottom:text.size/2};
}
function inkBox(anchor:Anchor,m:Metrics):Rect{
  const x=anchor.at.x-(anchor.align==="right"?m.advance:anchor.align==="center"?m.advance/2:0);
  return {min:{x:x+m.left,y:anchor.at.y+m.top},max:{x:x+m.right,y:anchor.at.y+m.bottom}};
}
/** Called only for native connector captions. Free-standing annotations keep their document position. */
export function registerConnectorLabel(group:DrawGroup,route:Route,text:Caption):void{
  const ink=measure(text);
  // All candidates stay beside a point on the route. Index this envelope so a
  // nearby line can invalidate a caption even when the two shafts never touch.
  const reach=Math.max(ink.advance,ink.right)-Math.min(ink.left,0)+Math.max(Math.abs(ink.top),Math.abs(ink.bottom))+text.size+clearance+12;
  labels.set(group,{source:group,route,text,ink,preferred:inkBox(text,ink),region:expand(group.bounds,reach)});
}
export const labelIndexBounds=(g:DrawGroup)=>labels.get(g)?.region??g.bounds;
export const hasConnectorLabel=(g:DrawGroup)=>labels.has(g);

function polygonClearance(points:readonly Point[],box:Rect,limit:number):number{
  const sides=points.map((from,i)=>({from,to:points[(i+1)%points.length]}));
  if(insideVector(sides,box.min))return 0;
  return Math.min(...sides.map(side=>segmentDistance(side,box,limit)));
}

function routeClearance(route:Route,box:Rect,margin:number):number{
  const pad=route.width/2,limit=margin+pad;
  const points=route.arrows?.shaft??route.points;
  let gap=margin;
  for(let i=1;i<points.length;i++){
    gap=Math.min(gap,segmentDistance({from:points[i-1],to:points[i]},box,limit)-pad);
    if(gap<=0)return 0;
  }
  for(const head of route.arrows?.heads??[])gap=Math.min(gap,polygonClearance(head,box,margin));
  return gap;
}
function boxClearance(a:Rect,b:Rect):number{
  return Math.hypot(Math.max(0,a.min.x-b.max.x,b.min.x-a.max.x),Math.max(0,a.min.y-b.max.y,b.min.y-a.max.y));
}
function obstacleClearance(other:DrawGroup,box:Rect):number{
  const gap=boxClearance(box,other.bounds);
  if(gap>clearance+1)return gap;
  const item=other.topicCount===undefined?other.items[0]:undefined;
  if(item?.kind==="path"&&item.arrow!==undefined)return routeClearance(item,box,clearance);
  if(item?.kind==="box"){
    const pad=(item.strokeWidth??DEFAULT_SHAPE_STROKE)/2;
    if(item.shape==="rect"&&!item.box.rotation){
      const {at,width,height}=item.box;
      return boxClearance(box,expand({min:at,max:{x:at.x+width,y:at.y+height}},pad));
    }
    return Math.max(0,polygonClearance(shapeOutlinePoints(item.box,item.shape),box,clearance+pad)-pad);
  }
  return gap;
}
function* alternatives({route,text,ink}:Label):Generator<Anchor>{
  const {at,align,size}=text,horizontalPad=size/2+4,verticalPad=Math.max(8,size*.6);
  yield align==="center"?{align,at:{x:at.x,y:at.y+2*horizontalPad}}:
    {align:"right",at:{x:at.x-2*verticalPad,y:at.y}};
  // Sample by arc length, so densely tessellated curves and short port stubs
  // do not take priority over the usable middle of the route.
  const points=route.points,lengths:number[]=[];
  let total=0;
  for(let i=1;i<points.length;i++){
    total+=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);lengths.push(total);
  }
  for(const fraction of [.5,.375,.625,.25,.75,.125,.875]){
    const position=total*fraction,i=lengths.findIndex(length=>length>=position);
    if(i<0)continue;
    const a=points[i],b=points[i+1],start=lengths[i-1]??0,len=lengths[i]-start;
    if(!len)continue;
    const t=(position-start)/len,x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;
    let nx=(b.y-a.y)/len,ny=(a.x-b.x)/len;
    if(Math.abs(nx)>Math.abs(ny)?nx<0:ny>0){nx=-nx;ny=-ny;}
    const halfWidth=(ink.right-ink.left)/2,halfHeight=(ink.bottom-ink.top)/2;
    const offset=halfWidth*Math.abs(nx)+halfHeight*Math.abs(ny)+Math.max(clearance,route.width/2+3);
    for(const side of [1,-1])yield {align:"center",at:{
      x:x+side*nx*offset-(ink.left+ink.right-ink.advance)/2,
      y:y+side*ny*offset-(ink.top+ink.bottom)/2}};
  }
}
function choose(label:Label,neighbors:Scene,placed:ReadonlyMap<string,Rect>){
  const {source,route,text,ink}=label;
  function score(anchor:Anchor){
    const box=inkBox(anchor,ink);
    // Keep the established label-to-route placement (including hand-set bends)
    // unless something else obstructs it. New positions also clear their own shaft.
    let score=anchor===text?1:Math.min(1,routeClearance(route,box,2)/2);
    for(const other of neighbors){
      if(other.id===source.id)continue;
      const caption=placed.get(other.id)??(anchor===text?undefined:labels.get(other)?.preferred);
      if(caption)score=Math.min(score,boxClearance(box,caption)/clearance);
      if(score===0)break;
      score=Math.min(score,obstacleClearance(other,box)/clearance);
    }
    return score;
  }
  let best:Anchor=text,value=score(best);
  if(value<1)for(const candidate of alternatives(label)){
    const next=score(candidate);
    if(next>value){best=candidate;value=next;}
    if(value>=1)break;
  }
  const box=inkBox(best,ink),prior=poses.get(source),old=prior?.items[1];
  if(prior&&old?.kind==="text"&&old.align===best.align&&old.at.x===best.at.x&&old.at.y===best.at.y)return {group:prior,box};
  const group={...source,bounds:union(source.bounds,box),items:[route,best===text?text:{...text,...best}]};
  labels.set(group,label);poses.set(source,group);
  return {group,box};
}

/** Resolve overlapping label neighborhoods in stable ID order, including during
 * a transient rewire. Only the derived text primitive and paint bounds change. */
export function placeConnectorLabels(seeds:Iterable<DrawGroup>,neighbors:Neighbors,findPeers=false):DrawGroup[]{
  const affected=new Set<Label>();
  for(const group of seeds){const label=labels.get(group);if(label)affected.add(label);}
  if(findPeers)for(const label of affected)for(const group of neighbors(label.region)){
    const peer=labels.get(group);if(peer)affected.add(peer);
  }
  const placed=new Map<string,Rect>(),output:DrawGroup[]=[];
  for(const label of [...affected].sort((a,b)=>a.source.id<b.source.id?-1:a.source.id>b.source.id?1:0)){
    const {group,box}=choose(label,neighbors(label.region),placed);
    placed.set(group.id,box);output.push(group);
  }
  return output;
}
export function layoutSceneLabels(scene:Scene):Scene{
  if(!scene.some(hasConnectorLabel))return scene;
  const grid=new SceneGrid(),groups=new Map(scene.map(g=>[g.id,g]));
  for(const g of scene)grid.add(g.id,labelIndexBounds(g));
  const neighbors=(area:Rect)=>{
    const ids=new Set<string>();
    const pool=grid.collect(area,groups.size,ids)?Array.from(ids,id=>groups.get(id)!):scene;
    return pool.filter(g=>overlap(area,labelIndexBounds(g)));
  };
  for(const g of placeConnectorLabels(scene,neighbors))groups.set(g.id,g);
  return scene.map(g=>groups.get(g.id)!);
}
