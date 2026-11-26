import { transformCompletedInk } from "./ink.ts";
import type { InkBrush } from "./ink.ts";
import { allocateId as draftId } from "../core/id.ts";
import type { BoardObject, Id, ImageAsset, ImageObject, InkObject, TextObject } from "../core/document.ts";
import {isBox,isHexPaint,isPoint} from "../core/document.ts";
import {automaticTextColor,DEFAULT_TEXT_COLOR,textFamilies} from "../core/text-style.ts";
import type {TextFace} from "../core/text-style.ts";
import {boxBounds,gridBox,gridPoint,gridSize} from "../core/geometry.ts";
import type { Point } from "../core/geometry.ts";
import type {History,Patch} from "../core/history.ts";
import type { EditorSession } from "../session/editor.ts";
import { AssetVault, inspectImage, metadataMatches } from "./image-assets.ts";
import type { ImageHeader } from "./image-assets.ts";
import {boundedTextEdit,normalizeBreaks} from "./text-layout.ts";
import { MAX_TEXT_LENGTH,MAX_TEXT_WIDTH,MIN_TEXT_WIDTH,plainTextWidth,textBoxWithSize,textHeight } from "./plain-text.ts";

const writingWidth=360;
export const initialTextBox=Object.freeze({width:writingWidth,height:textHeight("",writingWidth,18),fontSize:18});
export function createText(at:Point):TextObject {
  return {kind:"text",id:draftId("text"),at:gridPoint(at),...initialTextBox,rotation:0,text:"",color:DEFAULT_TEXT_COLOR,align:"left"};
}
export function saveText(editor:EditorSession,generation:symbol,draft:TextObject,input:string,styled=false,keepWidth=false,placement?:History):boolean{
  const current=editor.doc.objects[draft.id];
  if(current?.kind==="text"&&normalizeBreaks(input)===normalizeBreaks(current.text)){
    const changed=styled&&(["fontSize","fontFamily","fontWeight","italic","color","colorMode","background","align"] as const).some(key=>draft[key]!==current[key]);
    return changed&&editor.commitEdit({label:"设置文字属性",patches:[{op:"putObject",value:draft}]},generation,[draft.id],placement);
  }
  const before=current?.kind==="text"?normalizeBreaks(current.text):"";
  const text=boundedTextEdit(before,normalizeBreaks(input),Math.max(MAX_TEXT_LENGTH,before.length));
  if(!text.trim()&&!current)return false;
  let width=draft.width;
  if(!current&&!keepWidth&&!draft.heightMode){
    const longest=Math.max(...text.split("\n").map(row=>plainTextWidth(row,draft.fontSize,draft)));
    width=Math.min(width,Math.max(MIN_TEXT_WIDTH,Math.ceil(longest)+1));
  }
  const height=draft.heightMode==="fixed"?draft.height:textHeight(text,width,draft.fontSize,draft);
  const box=textBoxWithSize(draft,width,height);
  return editor.commitEdit({label:"编辑独立文字",patches:[{op:"putObject",value:{...draft,...box,at:gridPoint(box.at),text}}]},generation,[draft.id],placement);
}
type TextStyleValues=TextFace & Readonly<{fontSize:number;color:string;align:TextObject["align"];width:number;background?:string;colorMode?:"auto"|"custom";
  x?:number;y?:number;rotation?:number;height?:number;heightMode?:"fit"|"fixed"}>;

/** Plan from the committed text. A no-op retains even an old fitted box's stored height. */
export function planTextStyle(item:TextObject,values:TextStyleValues):TextObject|undefined{
  const {fontSize,align}=values;
  const wasAuto=automaticTextColor(item);
  const color=values.colorMode==="auto"?(wasAuto?item.color:DEFAULT_TEXT_COLOR):values.color;
  const auto=values.colorMode==="auto"||values.colorMode===undefined&&wasAuto&&color===item.color;
  const colorMode=color===item.color&&wasAuto===auto?item.colorMode:
    auto?"auto":automaticTextColor({id:item.id,color})?"custom":undefined;
  const family=values.fontFamily??item.fontFamily??"system",weight=values.fontWeight??item.fontWeight??500,italic=values.italic??item.italic??false;
  const background=values.background==="transparent"?undefined:values.background??item.background;
  if(!textFamilies.includes(family)||![400,500,600,700].includes(weight)||typeof italic!=="boolean"||background!==undefined&&!isHexPaint(background))return;
  const faceChanged=family!==(item.fontFamily??"system")||weight!==(item.fontWeight??500)||italic!==Boolean(item.italic);
  const at=gridPoint({x:values.x??item.at.x,y:values.y??item.at.y}),rotation=values.rotation??item.rotation;
  const mode=values.heightMode??item.heightMode??"fit";
  if(mode!=="fit"&&mode!=="fixed"||!["left","center","right"].includes(align)||color!==item.color&&!isHexPaint(color))return;
  if(!Number.isFinite(values.width)||values.width<=0||values.width!==item.width&&(values.width<MIN_TEXT_WIDTH||values.width>MAX_TEXT_WIDTH))return;
  const width=gridSize(values.width);
  if(!Number.isFinite(fontSize)||fontSize<=0||fontSize!==item.fontSize&&(fontSize<6||fontSize>160))return;
  const fixed=mode==="fixed",reflow=faceChanged||width!==item.width||fontSize!==item.fontSize||item.heightMode==="fixed";
  const face={fontFamily:family,fontWeight:weight,italic};
  const rawHeight=fixed?(values.height??item.height):reflow?textHeight(item.text,width,fontSize,face):item.height;
  if(fixed&&rawHeight<1)return;
  const height=gridSize(rawHeight);
  if(!isBox({at,width,height,rotation}))return;
  if(at.x===item.at.x&&at.y===item.at.y&&width===item.width&&height===item.height&&rotation===item.rotation&&
      fontSize===item.fontSize&&color===item.color&&colorMode===item.colorMode&&background===item.background&&!faceChanged&&align===item.align&&fixed===(item.heightMode==="fixed"))return item;
  const next={...item,at,width,height,rotation,fontSize,color,align};
  if(colorMode)next.colorMode=colorMode;else delete next.colorMode;
  if(background)next.background=background;else delete next.background;
  if(family!==(item.fontFamily??"system")){if(family==="system")delete next.fontFamily;else next.fontFamily=family;}
  if(weight!==(item.fontWeight??500)){if(weight===500)delete next.fontWeight;else next.fontWeight=weight;}
  if(italic!==Boolean(item.italic)){if(italic)next.italic=true;else delete next.italic;}
  if(fixed)next.heightMode="fixed";else delete next.heightMode;
  const bounds=boxBounds(next);
  if(isPoint(bounds.min)&&isPoint(bounds.max))return next;
}

export function setTextStyle(editor:EditorSession,item:TextObject,values:TextStyleValues,series?:{start:History;head:History}):boolean{
  if(editor.selectedIds.length!==1||editor.selection!==item.id||editor.doc.objects[item.id]!==item)return false;
  const next=planTextStyle(item,values);
  return Boolean(next&&next!==item&&editor.commitEdit({label:"设置文字属性",patches:[{op:"putObject",value:next}]},editor.generation,undefined,undefined,series));
}
/** Updates one completed stroke, not the brush preference. */
export function setSelectedInkStyle(editor:EditorSession,item:InkObject,style:InkBrush,transform?:Readonly<{degrees:number;scale:number}>):boolean{
  if(editor.selectedIds.length!==1||editor.selection!==item.id||editor.doc.objects[item.id]!==item)return false;
  const updated=transformCompletedInk(item,style,transform?.degrees,transform?.scale);
  if(!updated||updated===item)return false;
  return editor.commitEdit({label:transform&&(transform.degrees%360!==0||transform.scale!==1)?"变换笔迹":"修改笔迹外观",
    patches:[{op:"putObject",value:updated}]},editor.generation,[item.id]);
}
export function deleteStandalone(editor:EditorSession):boolean{
  const ids=new Set(editor.selectedIds);
  if(!ids.size)return false;
  for(const id of ids){const item=editor.doc.objects[id];if(item?.kind!=="text"&&item?.kind!=="image"&&item?.kind!=="ink")return false;}
  const patches:Patch[]=[...ids].map(id=>({op:"removeObject",id}));
  const removedAssets=new Set([...ids].map(id=>editor.doc.objects[id]).filter(item=>item.kind==="image").map(item=>item.assetId));
  for(const item of Object.values(editor.doc.objects))if(!ids.has(item.id)&&item.kind==="image")removedAssets.delete(item.assetId);
  for(const id of removedAssets)patches.push({op:"removeAsset",id});
  return editor.commitEdit({label:"删除独立对象",patches},editor.generation,[]);
}
export function duplicateStandalone(editor:EditorSession):boolean{
  const originals=editor.selectedIds.map(id=>editor.doc.objects[id]);
  if(!originals.length||!originals.every(o=>o?.kind==="text"||o?.kind==="image"||o?.kind==="ink"))return false;
  const copies=originals.map(item=>({...item,id:draftId(item.kind),at:{x:item.at.x+18,y:item.at.y+18}} satisfies BoardObject));
  return editor.commitEdit({label:"复制独立对象",patches:copies.map(value=>({op:"putObject",value}))},editor.generation,copies.map(item=>item.id));
}
export function moveStandaloneLayer(editor:EditorSession,direction:-1|1):boolean{
  if(editor.selectedIds.length!==1||!editor.selection)return false;
  const id=editor.selection, item=editor.doc.objects[id];
  if(item?.kind!=="text"&&item?.kind!=="image"&&item?.kind!=="ink")return false;
  const index=editor.doc.order.indexOf(id),next=index+direction;
  if(index<0||next<0||next>=editor.doc.order.length)return false;
  const order=[...editor.doc.order];[order[index],order[next]]=[order[next],order[index]];
  return editor.commitEdit({label:"改变图层顺序",patches:[{op:"setOrder",ids:order}]},editor.generation);
}
export function referencedAssetIds(editor:EditorSession):Set<Id>{
  const ids=new Set<Id>();
  for(const doc of [editor.doc,...editor.history.past.map(f=>f.doc),...editor.history.future.map(f=>f.doc)])
    for(const id of Object.keys(doc.assets))ids.add(id);
  return ids;
}

export type Decoded<T>=Readonly<{ width:number;height:number;handle:T }>;
export type ImportResult<T> = Readonly<{ image:ImageObject;asset:ImageAsset;handle:T }>;
export async function importStandalone<T>(options:{
  editor:EditorSession;vault:AssetVault;expected:symbol;at:Point;
  read:()=>Promise<Uint8Array>;
  decode:(bytes:Uint8Array,header:ImageHeader)=>Promise<Decoded<T>>;
  dispose:(handle:T)=>void;
  isCurrent?:()=>boolean;
}):Promise<ImportResult<T>|undefined>{
  const {editor,vault,expected,at}=options;
  const current=()=>editor.generation===expected&&(options.isCurrent?.()??true);
  if(!current())return;
  const bytes=await options.read();
  if(!current())return;
  const header=inspectImage(bytes);
  const decoded=await options.decode(bytes,header);
  let accepted=false;
  try{
    if(!current())return;
    const meta:ImageAsset={id:draftId("asset"),mime:header.mime,pixelWidth:decoded.width,pixelHeight:decoded.height};
    if(!metadataMatches(meta,header))throw new Error("图片解码尺寸与文件不一致。");
    const asset=vault.add({ meta,bytes },true);
    const side=Math.max(asset.pixelWidth,asset.pixelHeight), scale=Math.min(32,Math.max(1,64/side),300/side);
    const image:ImageObject=gridBox({kind:"image",id:draftId("image"),assetId:asset.id,at,width:asset.pixelWidth*scale,height:asset.pixelHeight*scale,rotation:0});
    accepted=editor.commitEdit({label:"导入独立图片",patches:[{op:"putAsset",value:asset},{op:"putObject",value:image}]},expected,[image.id]);
    if(accepted)return {image,asset,handle:decoded.handle};
  }finally{
    if(!accepted){options.dispose(decoded.handle);if(current())vault.retain(referencedAssetIds(editor));}
  }
}
