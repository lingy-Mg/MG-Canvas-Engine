import {gridPoint,screenToWorld} from "../core/geometry.ts";
import type {Camera,Point} from "../core/geometry.ts";
import {initialDocumentBox,initialStickyBox} from "./card-content.ts";
import {flowPresets,isFlowPreset} from "./flow.ts";
import {initialTextBox} from "./standalone.ts";
import {initialTableBox} from "./table.ts";

const initialBoxes={sticky:initialStickyBox,markdown:initialDocumentBox,text:initialTextBox,table:initialTableBox,...flowPresets};
export type PlacementTool=keyof typeof initialBoxes;
/** A placement becomes a drag in screen pixels, independently of zoom or display density. */
export const placementDragged=(start:Point,end:Point)=>Math.hypot(end.x-start.x,end.y-start.y)>=12;

/** Content frames start at the pointer. A flow preset is centered on a click or stretched between two corners on a drag. */
export function placementBox(tool:PlacementTool,screen:Point,camera:Camera,dragStart?:Point){
  const world=screenToWorld(screen,camera),{width,height}=initialBoxes[tool];
  if(!isFlowPreset(tool))return {at:gridPoint(world),width,height};
  if(!dragStart)return {at:gridPoint({x:world.x-width/2,y:world.y-height/2}),width,height};
  const start=gridPoint(screenToWorld(dragStart,camera)),end=gridPoint(world);
  const span=(n:number)=>Math.min(1_000_000,Math.max(8,Math.abs(n)));
  const w=span(end.x-start.x),h=span(end.y-start.y);
  return {at:{x:end.x<start.x?start.x-w:start.x,y:end.y<start.y?start.y-h:start.y},width:w,height:h};
}
