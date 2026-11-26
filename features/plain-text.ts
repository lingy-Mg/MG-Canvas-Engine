import {estimatedTextWidth,graphemePrefix,normalizeBreaks,textRows} from "./text-layout.ts";
import {inkWidth,standaloneFont,topicMeasureContext} from "../platform/text-metrics.ts";
import {localToWorld} from "../core/geometry.ts";
import type {Box} from "../core/geometry.ts";
import type {TextObject} from "../core/document.ts";
import type {TextFace} from "../core/text-style.ts";

export const MAX_TEXT_LENGTH=12_000,MAX_TOPIC_LENGTH=800,MAX_LABEL_LENGTH=160;
export const MIN_TEXT_WIDTH=24,MAX_TEXT_WIDTH=5000;
export function plainText(input:string,budget=MAX_TEXT_LENGTH):string {
  return graphemePrefix(normalizeBreaks(input),budget);
}
export function plainTextWidth(text:string,fontSize:number,face:TextFace={}):number{
  const ctx=topicMeasureContext();
  if(!ctx)return estimatedTextWidth(text,fontSize);
  ctx.font=standaloneFont(fontSize,face);
  return inkWidth(ctx.measureText(text));
}
export function wrapPlainText(input:string,width:number,fontSize:number,face:TextFace={}):string[] {
  const normalized=normalizeBreaks(input),display=graphemePrefix(normalized,MAX_TEXT_LENGTH);
  const context=topicMeasureContext();
  if(context)context.font=standaloneFont(fontSize,face);
  const measure=context?(value:string)=>context.measureText(value).width:undefined;
  return textRows(display,width,fontSize,{measure,wordWrap:true,truncated:display.length<normalized.length});
}
export function textHeight(input:string,width:number,fontSize:number,face:TextFace={}):number {
  return Math.ceil(Math.max(1,wrapPlainText(input,width,fontSize,face).length)*fontSize*1.4);
}
/** Preserve the first line's local origin when a rotated text frame reflows. */
export function textBoxWithSize(box:Box,width:number,height:number,offset=0):Box{
  if(width===box.width&&height===box.height&&offset===0)return box;
  const center=localToWorld({x:offset+width/2,y:height/2},box);
  return {at:{x:center.x-width/2,y:center.y-height/2},rotation:box.rotation,width,height};
}
const fittedFrames=new WeakMap<TextObject,Box>();
export function textFrame(item:TextObject,lines?:readonly string[]):Box{
  if(item.heightMode==="fixed")return item;
  const cached=fittedFrames.get(item);if(cached)return cached;
  const height=lines?Math.ceil(lines.length*item.fontSize*1.4):textHeight(item.text,item.width,item.fontSize,item);
  const frame=textBoxWithSize(item,item.width,height);fittedFrames.set(item,frame);return frame;
}
export function editKey(action:{ key:string;ctrlKey:boolean;metaKey:boolean;isComposing:boolean;keyCode?:number }, composing:boolean, justEnded:boolean):"commit"|"cancel"|undefined {
  if(composing||justEnded||action.isComposing||action.keyCode===229)return;
  if(action.key==="Escape")return "cancel";
  if(action.key==="Enter"&&(action.ctrlKey||action.metaKey))return "commit";
}

/** The same native composition guard, with Xmind-style structural keys only for topic drafts. */
export function topicEditKey(action:{key:string;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean;isComposing:boolean;keyCode?:number},
  composing:boolean,justEnded:boolean):"child"|"commit"|"newline"|"cancel"|undefined{
  if(composing||justEnded||action.isComposing||action.keyCode===229)return;
  if(action.key==="Escape")return "cancel";
  if(action.key==="Enter")return action.ctrlKey||action.metaKey?"newline":"commit";
  if(action.key==="Tab"&&!action.shiftKey&&!action.ctrlKey&&!action.metaKey)return "child";
}
