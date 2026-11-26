import {DEFAULT_SHAPE_STROKE,MAX_SHAPE_STROKE} from "../core/document.ts";
import type {BoardDocument,ShapeObject} from "../core/document.ts";
import {planShapeTransform} from "../session/shape-properties.ts";
import type {ShapeTransform} from "../session/shape-properties.ts";
import type {EditorSession} from "../session/editor.ts";
import {liveColor} from "./property-color.ts";
import {propertySection} from "./property-choices.ts";
import {inspectorDegrees,liveProperties} from "./property-draft.ts";

export function shapeProperties(editor:EditorSession,item:ShapeObject,enabled:()=>boolean){
  const form=document.createElement("form");form.className="transform";form.dataset.shapeProperties="true";
  const live=liveProperties(editor,form,enabled),geometry=propertySection(form,"位置与尺寸"),appearance=propertySection(form,"节点外观");
  const shape=(doc:BoardDocument)=>doc.objects[item.id] as ShapeObject;
  const transform=(doc:BoardDocument,values:Partial<ShapeTransform>,style:Partial<NonNullable<ShapeTransform["shapeStyle"]>>={})=>{
    const s=shape(doc);
    return planShapeTransform(doc,s,{...s.at,...values,shapeStyle:{rotation:s.rotation,strokeWidth:s.strokeWidth??DEFAULT_SHAPE_STROKE,...style}},editor.hiddenIds);
  };
  for(const [key,title] of [["x","X"],["y","Y"],["width","W 宽度"],["height","H 高度"]] as const){
    const pos=key==="x"||key==="y";
    live.number(geometry,key,title,d=>pos?shape(d).at[key]:shape(d)[key],(d,n)=>transform(d,{[key]:n}),pos?undefined:1,undefined,true);
  }
  live.number(geometry,"rotation","旋转 °",d=>inspectorDegrees(shape(d).rotation),(d,n)=>transform(d,{},{rotation:n*Math.PI/180}));
  if(item.shape==="rect")live.number(geometry,"radius","圆角",d=>shape(d).cornerRadius,(d,n)=>transform(d,{},{radius:n}),0);
  live.number(appearance,"strokeWidth","描边粗细",d=>shape(d).strokeWidth??DEFAULT_SHAPE_STROKE,(d,n)=>transform(d,{},{strokeWidth:n}),0,MAX_SHAPE_STROKE);
  for(const [key,title] of [["fill","填充"],["stroke","描边颜色"]] as const)
    liveColor(live,()=>editor.doc,appearance,key,title,d=>shape(d)[key],(d,value)=>transform(d,{},{[key]:value}),{allowTransparent:key==="fill"});
  return live;
}
