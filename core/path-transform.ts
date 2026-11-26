import type {Point,Box,Camera} from "./geometry.ts";
import {gridPoint} from "./geometry.ts";
import {gridPath} from "./document-grid.ts";
import type {CubicHandles,VectorPath} from "./document.ts";
import {validPathGeometry} from "./document.ts";
import {segmentBetween,vectorBounds} from "./path-geometry.ts";

export type PathFrame=Readonly<{center:Point;width:number;height:number;rotation:number}>;
const frames=new WeakMap<VectorPath,PathFrame>();
const minus=(a:Point,b:Point):Point=>({x:a.x-b.x,y:a.y-b.y});

/** A contour-relative box follows rotations even for asymmetric curves. Its axes
 * come from the first significant directed edge; the bounds include cubic extrema. */
export function pathFrame(path:VectorPath):PathFrame{
  const cached=frames.get(path);
  if(cached)return cached;
  const {vertices,closed,curves}=path,first=vertices[0],count=vertices.length-(closed?0:1);
  const edges=Array.from({length:count},(_,i)=>minus(vertices[(i+1)%vertices.length],vertices[i]));
  const lengths=edges.map(p=>Math.hypot(p.x,p.y));
  const longest=lengths.reduce((a,b)=>Math.max(a,b),0);
  const index=lengths.findIndex(n=>n>0&&n>=longest*1e-8);
  const ux=index<0?1:edges[index].x/lengths[index],uy=index<0?0:edges[index].y/lengths[index];
  const local=(p:Point):Point=>({x:p.x*ux+p.y*uy,y:-p.x*uy+p.y*ux});
  const points=vertices.map(p=>local(minus(p,first)));
  const segments=edges.map((_,i)=>{
    const pair=curves?.[i];
    return segmentBetween(points[i],points[(i+1)%points.length],pair?{out:local(pair.out),in:local(pair.in)}:undefined);
  });
  const {min,max}=vectorBounds(segments),x=(min.x+max.x)/2,y=(min.y+max.y)/2;
  const center={x:(path.at.x+first.x)+(x*ux-y*uy),y:(path.at.y+first.y)+(x*uy+y*ux)};
  const frame={center,width:max.x-min.x,height:max.y-min.y,rotation:Math.atan2(uy,ux)};
  frames.set(path,frame);return frame;
}

/** Make the four corner targets distinct even for a single horizontal segment.
 * Padding belongs to the editing UI and is never part of the contour. */
export function pathHandleBox(frame:PathFrame,camera:Camera):Box{
  const min=48/camera.zoom,width=Math.max(min,frame.width),height=Math.max(min,frame.height);
  return {at:{x:frame.center.x-width/2,y:frame.center.y-height/2},width,height,rotation:frame.rotation};
}

/** Painted round caps and joins extend equally along both local axes. Grips still transform the centerline. */
export function pathStrokeBox(frame:PathFrame,strokeWidth:number):Box{
  const width=frame.width+strokeWidth,height=frame.height+strokeWidth;
  return {at:{x:frame.center.x-width/2,y:frame.center.y-height/2},width,height,rotation:frame.rotation};
}

function handleCoincides(at:Point,vertex:Point,delta:Point):boolean{
  const x=at.x+vertex.x,y=at.y+vertex.y;
  return x+delta.x===x&&y+delta.y===y;
}

/** At the new origin a drawable edge or handle must not vanish through numerical rounding. */
function checkedPlacement(original:VectorPath,next:VectorPath):VectorPath|undefined{
  if(!validPathGeometry(next))return;
  const {vertices,at}=next,old=original.vertices;
  for(let i=0;i<vertices.length-(next.closed?0:1);i++){
    const j=(i+1)%vertices.length,a=vertices[i],b=vertices[j];
    if(at.x+a.x===at.x+b.x&&at.y+a.y===at.y+b.y&&
      (original.at.x+old[i].x!==original.at.x+old[j].x||original.at.y+old[i].y!==original.at.y+old[j].y))return;
    const pair=next.curves?.[i],before=original.curves?.[i];
    if(pair&&before&&(handleCoincides(at,a,pair.out)&&!handleCoincides(original.at,old[i],before.out)||
      handleCoincides(at,b,pair.in)&&!handleCoincides(original.at,old[j],before.in)))return;
  }
  return next;
}

/** Bake a center-based similarity, then place explicitly supplied axes at their final path origin.
 * For translation alone, retain the original relative anchors and cubic handles. */
export function transformPath(path:VectorPath,angle:number,scale:number,frame?:PathFrame,position?:Partial<Point>):VectorPath|undefined{
  if(!Number.isFinite(angle)||!Number.isFinite(scale)||scale<=0)return;
  const turn=angle%(2*Math.PI);
  const quarter=Math.PI/2,k=Math.round(turn/quarter);
  const axis=Math.abs(turn-k*quarter)<=4*Number.EPSILON;
  const i=(k%4+4)%4,c=axis?[1,0,-1,0][i]:Math.cos(turn),s=axis?[0,1,0,-1][i]:Math.sin(turn);
  if(c===1&&s===0&&scale===1){
    const {x,y}=gridPoint({x:position?.x??path.at.x,y:position?.y??path.at.y});
    return x===path.at.x&&y===path.at.y?path:checkedPlacement(path,{...path,at:{x,y}});
  }
  frame??=pathFrame(path);
  const vector=(p:Point):Point=>({x:(p.x*c-p.y*s)*scale,y:(p.x*s+p.y*c)*scale});
  // Older files can place a valid short contour extremely far from its local
  // origin. Rebase only if the origin's rounding error threatens contour detail.
  const first=path.vertices[0];
  const rebase=Math.hypot(first.x,first.y)*Number.EPSILON>Math.max(frame.width,frame.height)*1e-12;
  const origin=rebase?{x:path.at.x+first.x,y:path.at.y+first.y}:path.at;
  const offset=vector(minus(origin,frame.center));
  const at={x:frame.center.x+offset.x,y:frame.center.y+offset.y};
  const vertices=rebase?path.vertices.map(p=>vector(minus(p,first))):path.vertices.map(vector);
  const next={...path,at,vertices};
  if(path.curves){
    const curves:Record<string,CubicHandles>={};
    for(const [edge,handles] of Object.entries(path.curves))curves[edge]={out:vector(handles.out),in:vector(handles.in)};
    next.curves=curves;
  }
  const snapped=gridPath(next);
  const placed=position?{...snapped,at:gridPoint({x:position.x??snapped.at.x,y:position.y??snapped.at.y})}:snapped;
  return checkedPlacement(path,placed);
}
