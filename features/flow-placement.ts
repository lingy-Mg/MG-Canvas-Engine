import type {BoardDocument} from "../core/document.ts";
import type {Camera,Point,Rect} from "../core/geometry.ts";
import {screenToWorld} from "../core/geometry.ts";
import {buildScene,fitBounds,groupBounds,mergeBounds} from "../scene/board.ts";
import type {SceneProjection} from "../scene/projector.ts";
import type {FlowDrawingPlan} from "./flow-drawing.ts";
import {columnGap} from "./flow-layout.ts";

export type DrawingViewport={scene:SceneProjection;width:number;height:number;camera:Camera};

/** Locate a whole drawing without moving anything that is already on the board. */
export function flowPlacement(doc:BoardDocument,plan:FlowDrawingPlan,view:DrawingViewport):Point{
  const {scene,width,height,camera}=view,existing=scene.all(),board=groupBounds(existing);
  const values=plan.operations.map(op=>op.value);
  const draft={...doc,objects:Object.fromEntries(values.map(item=>[item.id,item])),order:values.map(item=>item.id)};
  const footprint=groupBounds(buildScene(draft))!;
  const w=footprint.max.x-footprint.min.x,h=footprint.max.y-footprint.min.y;
  const center=screenToWorld({x:width/2,y:height/2},camera);
  const shift=(x:number,y:number)=>({x:Math.round(x-footprint.min.x),y:Math.round(y-footprint.min.y)});
  if(!board)return shift(center.x-w/2,center.y-h/2);

  const gap=columnGap,spots=new Map<string,Point>();
  function add(x:number,y:number){
    const delta=shift(x,y);spots.set(delta.x+","+delta.y,delta);
  }
  function adjacent(box:Rect){
    add(box.max.x+gap,box.min.y);add(box.min.x,box.max.y+gap);
    add(box.min.x-w-gap,box.min.y);add(box.min.x,box.min.y-h-gap);
  }
  adjacent(board);
  add(center.x-w/2,center.y-h/2);
  add((board.min.x+board.max.x-w)/2,(board.min.y+board.max.y-h)/2);
  // Sample at most 24 existing objects to bound the number of searches for gaps between clusters.
  const stride=Math.max(1,Math.ceil(existing.length/24));
  for(let i=0;i<existing.length;i+=stride)adjacent(existing[i].bounds);
  const candidates=[...spots.values()].map(delta=>{
    const min={x:delta.x+footprint.min.x,y:delta.y+footprint.min.y},max={x:min.x+w,y:min.y+h};
    const union=mergeBounds(board,{min,max});
    const area=(union.max.x-union.min.x)*(union.max.y-union.min.y);
    const distance=Math.hypot(min.x+w/2-center.x,min.y+h/2-center.y);
    // Allow for integer rounding when a candidate sits exactly one column gap from an existing object.
    const margin=gap-1,clearance={min:{x:min.x-margin,y:min.y-margin},max:{x:max.x+margin,y:max.y+margin}};
    return {delta,clearance,zoom:fitBounds(union,width,height).zoom,area,distance};
  }).sort((a,b)=>b.zoom-a.zoom||a.area-b.area||a.distance-b.distance);
  for(const {delta,clearance} of candidates){
    if(!scene.query(clearance).length)return delta;
  }
  // The right-hand exterior is always available, including at extreme integer rounding boundaries.
  return shift(board.max.x+gap+1,board.min.y);
}
