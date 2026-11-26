import {gridPoint,gridSize,localToWorld,worldToScreen} from "../core/geometry.ts";
import type {Box,Camera,Point} from "../core/geometry.ts";
import type {BoardObject,Id} from "../core/document.ts";
import type {TextEdge} from "./text-width.ts";
import type {TableDivider} from "../features/table-geometry.ts";
export type ResizeHandle="nw"|"ne"|"sw"|"se";
export type Resizable=Extract<BoardObject,{kind:"shape"|"image"|"table"}>;
export type ResizeOptions=Readonly<{id:Id;corner:ResizeHandle;lockRatio:boolean}>;
export type BoxHandle=ResizeOptions|Readonly<{id:Id;rotate:true}>|Readonly<{id:Id;textEdge:TextEdge}>|Readonly<{id:Id;divider:TableDivider}>;
export const RESIZE_CORNERS:readonly ResizeHandle[]=["nw","ne","sw","se"];
export const resizable=(item:BoardObject|undefined):item is Resizable=>item?.kind==="shape"||item?.kind==="image"||item?.kind==="table";
function signs(corner:ResizeHandle){return {x:corner.endsWith("e")?1:-1,y:corner.startsWith("s")?1:-1};}
export function cornerPoint(box:Box,corner:ResizeHandle,other=false):Point{
  const sign=signs(corner),step=other? -1:1;
  return localToWorld({x:sign.x*step>0?box.width:0,y:sign.y*step>0?box.height:0},box);
}
export function hitResizeHandle(box:Box,camera:Camera,screen:Point,touch=false):ResizeHandle|undefined{
  let nearest:ResizeHandle|undefined,best=touch?22:8;
  for(const corner of RESIZE_CORNERS){
    const p=worldToScreen(cornerPoint(box,corner),camera),d=Math.hypot(p.x-screen.x,p.y-screen.y);
    if(d<best||(!nearest&&d===best)){nearest=corner;best=d;}
  }
  return nearest;
}
/** The stem and the hit target use CSS pixels at every zoom and device pixel ratio. */
export function rotationHandle(box:Box,camera:Camera){
  const base=worldToScreen(localToWorld({x:box.width/2,y:0},box),camera);
  const knob={x:base.x+42*Math.sin(box.rotation),y:base.y-42*Math.cos(box.rotation)};
  return {base,knob};
}
export function hitRotationHandle(box:Box,camera:Camera,screen:Point,touch=false):boolean{
  const {knob}=rotationHandle(box,camera);
  return Math.hypot(screen.x-knob.x,screen.y-knob.y)<=(touch?18:9);
}
/** Preserve the initial grab offset. A point on the pivot has no direction. */
export function dragRotation(initial:number,pivot:Point,start:Point,current:Point,previous=initial):number|undefined{
  const x=current.x-pivot.x,y=current.y-pivot.y;
  if(Math.hypot(x,y)<1)return;
  const delta=Math.atan2(y,x)-Math.atan2(start.y-pivot.y,start.x-pivot.x);
  // Use the equivalent orientation nearest the previous sample across the ±π seam.
  const wrapped=initial+Math.atan2(Math.sin(delta),Math.cos(delta));
  return wrapped+Math.round((previous-wrapped)/(2*Math.PI))*(2*Math.PI);
}
export function constrainRotation(raw:number,initial:number,snap:boolean):number{
  const step=Math.PI/12,remainder=raw%step;
  const rotation=snap?raw-remainder+Math.round(remainder/step)*step:raw;
  return Math.abs(Math.sin((rotation-initial)/2))<1e-12?initial:rotation;
}
export function resizeAroundOpposite(box:Box,corner:ResizeHandle,delta:Point,lockRatio:boolean,minimum={width:8,height:8}):Box{
  if(!Number.isFinite(delta.x)||!Number.isFinite(delta.y)||(!delta.x&&!delta.y))return box;
  const fixed=cornerPoint(box,corner,true), moving=cornerPoint(box,corner),sign=signs(corner);
  const dx=moving.x+delta.x-fixed.x,dy=moving.y+delta.y-fixed.y;
  const c=Math.cos(box.rotation),s=Math.sin(box.rotation);
  const requestedWidth=sign.x*(dx*c+dy*s),requestedHeight=sign.y*(-dx*s+dy*c);
  const max=1_000_000;
  let width=Math.min(max,Math.max(minimum.width,requestedWidth)),height=Math.min(max,Math.max(minimum.height,requestedHeight));
  if(lockRatio){
    const w=box.width,h=box.height,diagonal=Math.hypot(w,h);
    const ratio=(requestedWidth*(w/diagonal)+requestedHeight*(h/diagonal))/diagonal;
    if(!Number.isFinite(ratio))return box;
    const floor=Math.min(1,Math.max(minimum.width/w,minimum.height/h)),ceil=Math.max(1,Math.min(max/w,max/h));
    const scale=Math.min(ceil,Math.max(floor,ratio));
    width=w*scale;height=h*scale;
  }
  width=gridSize(width);height=gridSize(height);
  const x=sign.x*width/2,y=sign.y*height/2;
  return {at:gridPoint({x:fixed.x+x*c-y*s-width/2,y:fixed.y+x*s+y*c-height/2}),width,height,rotation:box.rotation};
}
