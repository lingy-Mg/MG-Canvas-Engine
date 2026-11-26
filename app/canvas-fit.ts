import type {Camera,Rect} from "../core/geometry.ts";
import {ZOOM} from "../core/geometry.ts";
import {fitBounds,groupBounds,mergeBounds} from "../scene/board.ts";
import type {Scene} from "../scene/board.ts";

export type CanvasControl={id:string;edge:"top"|"bottom";left:number;right:number;top:number;bottom:number};
export type CanvasViewport={width:number;height:number;usableWidth?:number;windowWidth?:number;windowHeight?:number;occlusions?:readonly CanvasControl[]};

/** Keep the normal fit when possible. Only objects under a control's horizontal span need to clear it. */
export function fitCanvas(groups:Scene,view:CanvasViewport,draft?:Rect):Camera{
  const {height,usableWidth:width=view.width,occlusions=[]}=view;
  const board=groupBounds(groups),box=draft?mergeBounds(board,draft):board,original=fitBounds(box,width,height);
  if(!box||!occlusions.length)return original;
  const frames=draft?[...groups,{bounds:draft}]:groups;
  const {min,max}=box,centerX=(min.x+max.x)/2,centerY=(min.y+max.y)/2;
  const gap=8;
  function atX(zoom:number,x:number):Camera|undefined{
    let low=gap-min.y*zoom,high=height-gap-max.y*zoom;
    for(const {bounds} of frames){
      const left=x+bounds.min.x*zoom,right=x+bounds.max.x*zoom;
      for(const control of occlusions){
        if(right<=control.left-gap||left>=control.right+gap)continue;
        if(control.edge==="bottom")high=Math.min(high,control.top-gap-bounds.max.y*zoom);
        else low=Math.max(low,control.bottom+gap-bounds.min.y*zoom);
      }
      if(low>high)return;
    }
    const y=Math.min(high,Math.max(low,height/2-centerY*zoom));
    return {zoom,offset:{x,y}};
  }
  function placement(zoom:number,refine=false):Camera|undefined{
    const center=width/2-centerX*zoom,centered=atX(zoom,center);
    if(centered)return centered;
    // A lateral shift can move the top row past the zoom controls or frame meter without reducing text size.
    const free=(width-(max.x-min.x)*zoom)/2-gap;
    if(free<=0)return;
    for(const shift of [-free/2,free/2,-free,free]){
      let side=atX(zoom,center+shift);
      if(!side)continue;
      if(refine){
        let outside=center;
        for(let step=0;step<12&&Math.abs(side.offset.x-outside)>1;step++){
          const x=(side.offset.x+outside)/2,closer=atX(zoom,x);
          if(closer)side=closer;else outside=x;
        }
      }
      return side;
    }
  }
  const normal=placement(original.zoom,true);
  if(normal)return normal;
  // Only shrink when translating at the original scale cannot clear the controls.
  let hi=original.zoom,lo=Math.min(ZOOM.min,hi);
  if(!placement(lo))lo=0;
  for(let i=0;i<12;i++){
    const mid=(lo+hi)/2;
    if(placement(mid))lo=mid;else hi=mid;
  }
  return lo>0?placement(lo,true)??original:original;
}
