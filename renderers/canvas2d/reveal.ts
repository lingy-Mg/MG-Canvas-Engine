import {splitSegment} from "../../core/path-geometry.ts";
import type {Point} from "../../core/geometry.ts";
import type {Primitive} from "../../scene/board.ts";
import {connectorArrows} from "../../scene/connector-arrows.ts";

const distances=new WeakMap<readonly Point[],number[]>();
function linePrefix(points:readonly Point[],fraction:number){
  let ends=distances.get(points);
  if(!ends){
    ends=[0];for(let i=1;i<points.length;i++)ends.push(ends[i-1]+Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y));
    distances.set(points,ends);
  }
  const distance=ends.at(-1)!*fraction;
  let i=1;while(i<ends.length-1&&ends[i]<distance)i++;
  const a=points[i-1],b=points[i],t=(distance-ends[i-1])/(ends[i]-ends[i-1]||1);
  return [...points.slice(0,i),{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}];
}
export function revealPrimitive(item:Primitive,t:number):Primitive{
  if(item.kind==="ink"&&item.points.length>1)return {...item,points:item.points.slice(0,Math.max(1,Math.ceil(t*item.points.length)))};
  if(item.kind!=="path")return item;
  if(item.arrow!==undefined&&item.points.length>1){
    const points=linePrefix(item.points,t);
    return {...item,points,arrows:connectorArrows(points,item.width,item.arrow)};
  }
  if(item.segments?.length&&!item.closed){
    const progress=item.segments.length*t,i=Math.min(item.segments.length-1,Math.floor(progress));
    const segments=[...item.segments.slice(0,i),splitSegment(item.segments[i],progress-i)[0]];
    return {...item,segments,points:[segments[0].from,...segments.map(s=>s.to)]};
  }
  return item;
}
