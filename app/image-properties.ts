import {propertyWidget} from "./property-view.ts";
import type {BoardDocument,ImageObject} from "../core/document.ts";
import {planImageTransform} from "../session/image-properties.ts";
import type {ImageTransform} from "../session/image-properties.ts";
import type {EditorSession} from "../session/editor.ts";
import {inspectorDegrees,liveProperties} from "./property-draft.ts";
import {propertySection} from "./property-choices.ts";

export function imageProperties(editor:EditorSession,item:ImageObject,enabled:()=>boolean){
  const form=document.createElement("form");form.className="transform";
  const grid=propertySection(form,"图片位置与尺寸"),live=liveProperties(editor,form,enabled);
  const image=(d:BoardDocument)=>d.objects[item.id] as ImageObject;
  const change=(d:BoardDocument,v:Partial<ImageTransform>)=>planImageTransform(d,image(d),{...image(d).at,...v});
  for(const [key,title] of [["x","X"],["y","Y"],["width","W 宽度"],["height","H 高度"]] as const){
    const size=key==="width"||key==="height";
    live.number(grid,key,title,d=>size?image(d)[key]:image(d).at[key],
      (d,n)=>change(d,{[key]:n,ratioDriver:size?key:undefined}),size?1:undefined,undefined,true);
  }
  live.number(grid,"rotation","旋转 °",d=>inspectorDegrees(image(d).rotation),(d,n)=>change(d,{imageRotation:n*Math.PI/180}));
  const row=document.createElement("div");row.style.display="contents";
  const options=propertyWidget(row,{kind:"image-options"},form);
  const [lock,shadow]=Array.from(options.querySelectorAll("input")),restore=options.querySelector("button")!;
  lock.addEventListener("change",()=>live.write(lock,"修改图片比例锁定",d=>change(d,{lockRatio:lock.checked}),false));
  live.watch(()=>{lock.checked=image(editor.doc).lockAspect!==false;});
  restore.addEventListener("click",()=>live.write(restore,"恢复图片原始比例",d=>change(d,{imageNaturalRatio:true,ratioDriver:"width"}),false));
  shadow.addEventListener("change",()=>live.write(shadow,"设置图片阴影",d=>{
    const next={...image(d)};if(shadow.checked)delete next.shadow;else next.shadow=false;return next;
  },false));
  live.watch(()=>{shadow.checked=image(editor.doc).shadow!==false;});
  return {...live,actions:row};
}
