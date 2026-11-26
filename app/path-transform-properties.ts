import type {BoardDocument,VectorPath} from "../core/document.ts";
import {transformPath} from "../core/path-transform.ts";
import type {EditorSession} from "../session/editor.ts";
import {propertySection} from "./property-choices.ts";
import {liveProperties} from "./property-draft.ts";

export function pathTransformProperties(editor:EditorSession,item:VectorPath,enabled:()=>boolean){
  const form=document.createElement("form");form.className="transform";form.dataset.pathTransform="true";
  const live=liveProperties(editor,form,enabled),grid=propertySection(form,"整条路径变换");
  const path=(d:BoardDocument)=>d.objects[item.id] as VectorPath;
  for(const axis of ["x","y"] as const)live.number(grid,axis,axis.toUpperCase(),d=>path(d).at[axis],(d,n)=>
    transformPath(path(d),0,1,undefined,{[axis]:n}),undefined,undefined,true);
  live.number(grid,"pathRotation","旋转增量 °",()=>0,(d,n)=>transformPath(path(d),n%360*Math.PI/180,1));
  live.number(grid,"pathScale","等比缩放 %",()=>100,(d,n)=>transformPath(path(d),0,n/100));
  return live;
}
