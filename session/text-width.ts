import type { TextObject } from "../core/document.ts";
import { gridPoint,gridSize,localToWorld,worldToScreen } from "../core/geometry.ts";
import type { Box,Camera,Point } from "../core/geometry.ts";
import { MAX_TEXT_WIDTH,MIN_TEXT_WIDTH,textHeight } from "../features/plain-text.ts";

export type TextEdge = "left" | "right";
export const TEXT_EDGES:readonly TextEdge[] = ["left","right"];

type ViewSize=Readonly<{width:number;height:number}>;

/** Use the midpoint of the visible side segment. It changes continuously
 * as the edge enters or leaves the viewport during reflow. */
function visibleOffset(point:Point,axis:Point,halfLength:number,view:ViewSize):number{
  let low=-halfLength,high=halfLength;
  for(const [coord,step,limit] of [[point.x,axis.x,view.width],[point.y,axis.y,view.height]]){
    if(Math.abs(step)<1e-12){
      if(coord<0||coord>limit)return 0;
      continue;
    }
    const a=-coord/step,b=(limit-coord)/step;
    low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));
  }
  return low<=high?low/2+high/2:0;
}

/** Side grips stay apart on screen, leaving the center available for moving and editing. */
export function textWidthGrip(box:Box,camera:Camera,edge:TextEdge,view?:ViewSize){
  const sign=edge==="left"?-1:1;
  const base=worldToScreen(localToWorld({x:edge==="left"?0:box.width,y:box.height/2},box),camera);
  const extension=Math.max(0,26-box.width*camera.zoom/2);
  const center={x:base.x+sign*extension*Math.cos(box.rotation),y:base.y+sign*extension*Math.sin(box.rotation)};
  if(view){
    const axis={x:-Math.sin(box.rotation),y:Math.cos(box.rotation)};
    const shift=visibleOffset(center,axis,box.height*camera.zoom/2,view);
    if(shift){
      const x=axis.x*shift,y=axis.y*shift;
      return {base:{x:base.x+x,y:base.y+y},center:{x:center.x+x,y:center.y+y},extension};
    }
  }
  return {base,center,extension};
}
export function hitTextWidthGrip(box:Box,camera:Camera,screen:Point,touch=false,view?:ViewSize):TextEdge|undefined{
  const cos=Math.cos(box.rotation),sin=Math.sin(box.rotation);
  for(const edge of TEXT_EDGES){
    const {center}=textWidthGrip(box,camera,edge,view),dx=screen.x-center.x,dy=screen.y-center.y;
    const along=dx*cos+dy*sin,across=dy*cos-dx*sin;
    if(Math.hypot(along,Math.max(0,Math.abs(across)-4))<=(touch?17:7))return edge;
  }
}
export function textWidthCursor(rotation:number):string{
  const angle=Math.atan2(Math.sin(rotation),Math.cos(rotation));
  return ["ew-resize","nwse-resize","ns-resize","nesw-resize"][(Math.round(angle/(Math.PI/4))+4)%4];
}

/** Travel along the text's local x axis, in CSS pixels, measured from the original grab. */
export function textWidthTravel(box:Box,start:Point,current:Point):number{
  return (current.x-start.x)*Math.cos(box.rotation)+(current.y-start.y)*Math.sin(box.rotation);
}
/** Keep the opposite upper corner and first line's top fixed in world space.
 * Fitted text grows down its rotated local y axis. Width is already in world units. */
export function resizeTextWidth(item:TextObject,edge:TextEdge,travel:number):TextObject{
  if(!Number.isFinite(travel))return item;
  const sign=edge==="right"?1:-1;
  // An old document can legitimately be narrower or wider than the inspector allows.
  const min=Math.min(item.width,MIN_TEXT_WIDTH),max=Math.max(item.width,MAX_TEXT_WIDTH);
  const width=gridSize(Math.max(min,Math.min(max,item.width+sign*travel)));
  if(width===item.width)return item;
  const height=item.heightMode==="fixed"?item.height:textHeight(item.text,width,item.fontSize,item);
  const dw=(width-item.width)/2,dh=(height-item.height)/2,cos=Math.cos(item.rotation),sin=Math.sin(item.rotation);
  const at=gridPoint({x:item.at.x+(sign*cos-1)*dw-sin*dh,y:item.at.y+sign*sin*dw+(cos-1)*dh});
  if(!Number.isFinite(height)||!Number.isFinite(at.x)||!Number.isFinite(at.y))return item;
  return {...item,at,width,height};
}
