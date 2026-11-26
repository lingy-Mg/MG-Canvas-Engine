import {propertyWidget} from "./property-view.ts";
import {MAX_PATH_STROKE} from "../core/document.ts";
import type {BoardDocument,VectorPath} from "../core/document.ts";
import {pathFill,withPathAppearance} from "../features/vector-path.ts";
import type {EditorSession} from "../session/editor.ts";
import {liveColor} from "./property-color.ts";
import {propertySection} from "./property-choices.ts";
import {liveProperties} from "./property-draft.ts";
import {pathTransformProperties} from "./path-transform-properties.ts";

export function pathInspector(editor:EditorSession,item:VectorPath,whole:()=>boolean,canStyle:()=>boolean,editVertices:()=>void){
  const form=document.createElement("div"),style=document.createElement("form"),actions=document.createElement("div");
  form.className="path-sections";style.className="transform";actions.style.display="contents";
  const geometry=pathTransformProperties(editor,item,whole),live=liveProperties(editor,style,canStyle);
  const grid=propertySection(style,(item.closed?"闭合路径":"开放路径")+" · "+item.vertices.length+" 个顶点");
  const path=(d:BoardDocument)=>d.objects[item.id] as VectorPath;
  liveColor(live,()=>editor.doc,grid,"pathStroke","描边颜色",d=>path(d).stroke,(d,v)=>withPathAppearance(path(d),v,path(d).strokeWidth,path(d).fill));
  live.number(grid,"pathWidth","描边宽度",d=>path(d).strokeWidth,(d,n)=>withPathAppearance(path(d),path(d).stroke,n,path(d).fill),.25,MAX_PATH_STROKE);
  if(item.closed){
    const fill=(d:BoardDocument,v?:string)=>withPathAppearance(path(d),path(d).stroke,path(d).strokeWidth,v);
    const color=liveColor(live,()=>editor.doc,grid,"pathFill","填充颜色",d=>path(d).fill,fill,{placeholder:"默认 · "+pathFill},d=>path(d).fill??pathFill);
    const check=propertyWidget(grid,{kind:"switch",name:"pathFilled",caption:"启用填充"}).querySelector("input")!;
    check.addEventListener("change",()=>live.write(check,"修改路径填充",d=>fill(d,check.checked?pathFill:undefined),false));
    live.watch(()=>{check.checked=path(editor.doc).fill!==undefined;color.input.disabled=color.picker.disabled=!check.checked;});
  }
  propertyWidget(actions,{kind:"action",label:"编辑顶点",className:"button inline-action",
    run:()=>{if(live.current()){live.finish();editVertices();}}},style);
  form.append(geometry.form,style,actions);
  const syncMode=()=>{geometry.form.hidden=!whole();actions.hidden=!whole();style.hidden=!canStyle();};
  syncMode();return {form,syncMode,reset:live.reset,dispose(){live.dispose();geometry.dispose();}};
}
