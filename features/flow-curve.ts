import type {BoardObject,Endpoint,Id,ShapeObject} from "../core/document.ts";
import {boxBounds,portNormal} from "../core/geometry.ts";
import type {Point} from "../core/geometry.ts";
import {appendFlattenedSegment} from "../core/path-geometry.ts";

type Dock={shape:ShapeObject;out:Point};
const distance=(a:Point,b:Point)=>Math.hypot(b.x-a.x,b.y-a.y);
const advance=(p:Point,dir:Point,n:number):Point=>({x:p.x+n*dir.x,y:p.y+n*dir.y});
/** Limit the forward handles of a lateral turn before the two controls cross. */
export function facingPortGap(from:Point,to:Point,start?:Point,end?:Point){
  if(!start||!end||start.x*end.x+start.y*end.y>-.999999)return Infinity;
  const dx=to.x-from.x,dy=to.y-from.y;
  if(Math.abs(dx*start.y-dy*start.x)<1e-9)return Infinity;
  const forward=dx*start.x+dy*start.y;
  return forward>0?forward:Infinity;
}
function direction(a:Point,b:Point):Point{
  const n=distance(a,b);
  return n?{x:(b.x-a.x)/n,y:(b.y-a.y)/n}:{x:0,y:0};
}

// A port facing away from its peer needs room to turn outside the attached boxes.
function detour(from:Point,to:Point,start?:Dock,end?:Dock):Point[]{
  const d=direction(from,to),dot=(p:Point)=>p.x*d.x+p.y*d.y;
  const turn=start&&(start.shape.id===end?.shape.id||dot(start.out)<-.75)?start:end&&dot(end.out)>.75?end:undefined;
  if(!turn)return [];
  const across=Math.abs(turn.out.x)>=Math.abs(turn.out.y)?"y":"x";
  const gap=Math.max(18,Math.min(48,distance(from,to)/3));
  const a=start?advance(from,start.out,gap):from,b=end?advance(to,end.out,gap):to;
  const boxes=[start,end].flatMap(dock=>dock?[boxBounds(dock.shape)]:[]);
  const low=Math.min(a[across],b[across],...boxes.map(box=>box.min[across]))-gap;
  const high=Math.max(a[across],b[across],...boxes.map(box=>box.max[across]))+gap;
  const lane=a[across]+b[across]<=low+high?low:high;
  return [a,{...a,[across]:lane},{...b,[across]:lane},b];
}

export function portCurvePath(from:Point,to:Point,manual:readonly Point[],fromEnd:Endpoint|undefined,toEnd:Endpoint|undefined,
  lookup:(id:Id)=>BoardObject|undefined):readonly Point[]{
  const dock=(endpoint:Endpoint|undefined):Dock|undefined=>{
    if(endpoint?.kind!=="anchor")return;
    const shape=lookup(endpoint.objectId);
    if(shape?.kind==="shape")return {shape,out:portNormal(shape,endpoint.portId)};
  };
  const start=dock(fromEnd),end=dock(toEnd);
  const via=manual.length?manual:detour(from,to,start,end);
  const knots=[from,...via,to].filter((p,i,all)=>i===0||p.x!==all[i-1].x||p.y!==all[i-1].y);
  if(knots.length<2)return knots;
  const last=knots.length-1;
  const limit=via.length?Infinity:facingPortGap(from,to,start?.out,end?.out)/2;
  const handles=knots.map((p,i)=>{
    const previous=knots[i-1]??p,next=knots[i+1]??p;
    const tangent=i===0&&start?start.out:i===last&&end?{x:-end.out.x,y:-end.out.y}:direction(previous,next);
    const reach=Math.min(limit,.4*Math.min(i?distance(previous,p):Infinity,i<last?distance(p,next):Infinity));
    return {x:tangent.x*reach,y:tangent.y*reach};
  });
  const points=[from];
  for(let i=1;i<knots.length;i++){
    const a=knots[i-1],b=knots[i];
    appendFlattenedSegment(points,{from:a,to:b,controls:{c1:advance(a,handles[i-1],1),c2:advance(b,handles[i],-1)}});
  }
  return points;
}
