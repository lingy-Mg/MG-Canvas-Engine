import {propertyWidget} from "./property-view.ts";
import type {BoardDocument,TextObject} from "../core/document.ts";
import {automaticTextColor} from "../core/text-style.ts";
import type {TextWeight} from "../core/text-style.ts";
import {MAX_TEXT_WIDTH,MIN_TEXT_WIDTH,textFrame} from "../features/plain-text.ts";
import {planTextStyle} from "../features/standalone.ts";
import {standaloneInk} from "../platform/theme.ts";
import type {WorkspaceTheme} from "../platform/theme.ts";
import type {EditorSession} from "../session/editor.ts";
import {fontPicker} from "./font-picker.ts";
import {propertyChoice,propertySection} from "./property-choices.ts";
import {liveColor} from "./property-color.ts";
import {inspectorDegrees,liveProperties} from "./property-draft.ts";

export function textProperties(editor:EditorSession,item:TextObject,enabled:()=>boolean,theme:WorkspaceTheme){
  const form=document.createElement("form");form.className="transform text-properties";
  const live=liveProperties(editor,form,enabled),text=(d:BoardDocument)=>d.objects[item.id] as TextObject;
  const change=(d:BoardDocument,patch:Partial<Parameters<typeof planTextStyle>[1]>)=>{
    const s=text(d);return planTextStyle(s,{width:s.width,align:s.align,color:s.color,fontSize:s.fontSize,...patch});
  };
  const geometry=propertySection(form,"位置与尺寸");
  for(const axis of ["x","y"] as const)live.number(geometry,"text"+axis.toUpperCase(),axis.toUpperCase(),d=>text(d).at[axis],(d,n)=>change(d,{[axis]:n}),undefined,undefined,true);
  live.number(geometry,"textWidth","W 宽度",d=>text(d).width,(d,width)=>change(d,{width}),MIN_TEXT_WIDTH,MAX_TEXT_WIDTH,true);
  const height=live.number(geometry,"textHeight","H 高度",d=>textFrame(text(d)).height,(d,height)=>change(d,{height}),1,undefined,true);
  live.number(geometry,"textRotation","旋转 °",d=>inspectorDegrees(text(d).rotation),(d,n)=>change(d,{rotation:n*Math.PI/180}));
  const mode=propertyChoice(geometry,"textHeightMode","高度方式",[["fit","随文字"],["fixed","固定高度"]],item.heightMode??"fit",
    i=>live.write(i,"修改文字框高度方式",d=>change(d,{heightMode:mode.value,height:textFrame(text(d)).height}),false));
  const style=propertySection(form,"文字样式");
  const family=fontPicker(style,item.fontFamily??"system",i=>live.write(i,"修改字体",d=>change(d,{fontFamily:family.value}),false));
  live.number(style,"textSize","字号",d=>text(d).fontSize,(d,fontSize)=>change(d,{fontSize}),6,160);
  const italic=propertyWidget(style,{kind:"switch",name:"textItalic",caption:"斜体"}).querySelector("input")!;
  italic.addEventListener("change",()=>live.write(italic,"修改斜体",d=>change(d,{italic:italic.checked}),false));
  const weight=propertyChoice(style,"textWeight","字重",[["400","常规"],["500","中等"],["600","半粗"],["700","粗体"]],String(item.fontWeight??500),
    i=>live.write(i,"修改字重",d=>change(d,{fontWeight:Number(weight.value) as TextWeight}),false));
  const align=propertyChoice(style,"textAlign","文字对齐",[["left","居左"],["center","居中"],["right","居右"]],item.align,
    i=>live.write(i,"修改文字对齐",d=>change(d,{align:align.value}),false));
  const paints=propertySection(form,"颜色与背景");
  const ink=(d:BoardDocument)=>standaloneInk(text(d),theme);
  let custom=automaticTextColor(item)?undefined:item.color,solid=item.background??"#ffffff";
  const inkMode=propertyChoice(paints,"textInkMode","文字颜色",[["auto","自动"],["custom","自选"]],automaticTextColor(item)?"auto":"custom",
    i=>live.write(i,"修改文字颜色",d=>change(d,{colorMode:inkMode.value,color:custom??ink(d)}),false));
  const color=liveColor(live,()=>editor.doc,paints,"textInk","字色",ink,(d,color)=>change(d,{colorMode:"custom",color}));
  const bgMode=propertyChoice(paints,"textBackgroundMode","文字框背景",[["transparent","透明"],["solid","纯色"]],item.background?"solid":"transparent",
    i=>live.write(i,"修改文字框背景",d=>change(d,{background:bgMode.value==="solid"?solid:"transparent"}),false));
  const bg=liveColor(live,()=>editor.doc,paints,"textBackground","底色",d=>text(d).background??solid,(d,background)=>change(d,{background}));
  function sync(){
    const s=text(editor.doc);height.disabled=s.heightMode!=="fixed";mode.value=s.heightMode??"fit";
    italic.checked=Boolean(s.italic);weight.value=String(s.fontWeight??500);align.value=s.align;
    inkMode.value=automaticTextColor(s)?"auto":"custom";if(inkMode.value==="custom")custom=s.color;
    bgMode.value=s.background?"solid":"transparent";if(s.background)solid=s.background;
    bg.input.disabled=bg.picker.disabled=!s.background;
  }
  live.watch(sync);
  return {...live,syncTheme(value:WorkspaceTheme){theme=value;color.sync(ink(editor.doc));}};
}
