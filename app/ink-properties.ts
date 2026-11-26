import type {BoardDocument,InkObject} from "../core/document.ts";
import {MAX_INK_SCALE,MAX_INK_WIDTH,MIN_INK_SCALE,MIN_INK_WIDTH,transformCompletedInk} from "../features/ink.ts";
import type {EditorSession} from "../session/editor.ts";
import {liveColor} from "./property-color.ts";
import {propertySection} from "./property-choices.ts";
import {liveProperties} from "./property-draft.ts";

export function inkProperties(editor:EditorSession,item:InkObject,enabled:()=>boolean){
  const form=document.createElement("form");form.className="transform";
  const live=liveProperties(editor,form,enabled),grid=propertySection(form,"位置与变换"),appearance=propertySection(form,"笔迹样式");
  const ink=(d:BoardDocument)=>d.objects[item.id] as InkObject;
  for(const axis of ["x","y"] as const)live.number(grid,axis,axis.toUpperCase(),d=>ink(d).at[axis],(d,n)=>{
    const s=ink(d);return transformCompletedInk(s,s,0,1,{...s.at,[axis]:n});
  },undefined,undefined,true);
  live.number(grid,"selectedInkTurn","旋转增量 °",()=>0,(d,n)=>transformCompletedInk(ink(d),ink(d),n,1),-360,360);
  live.number(grid,"selectedInkScale","等比缩放 %",()=>100,(d,n)=>transformCompletedInk(ink(d),ink(d),0,n/100),MIN_INK_SCALE*100,MAX_INK_SCALE*100);
  live.number(appearance,"selectedInkWidth","基础笔宽",d=>ink(d).baseWidth,(d,n)=>transformCompletedInk(ink(d),{...ink(d),baseWidth:n},0,1),MIN_INK_WIDTH,MAX_INK_WIDTH);
  liveColor(live,()=>editor.doc,appearance,"selectedInkColor","颜色",d=>ink(d).color,(d,color)=>transformCompletedInk(ink(d),{...ink(d),color},0,1));
  return live;
}
