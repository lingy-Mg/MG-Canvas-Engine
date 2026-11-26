import { assertDocument, freezeData, isBranchColors, isRecord, objectById, readDocument, validFlowLabelSize } from "../core/document.ts";
import type { BoardDocument, BoardObject, Id, MindMap } from "../core/document.ts";
import {MAX_CARD_TEXT,validCardStyle} from "../core/card.ts";
import type {ShapeObject} from "../core/document.ts";
import { assertAsset, AssetVault, MAX_IMAGE_BYTES, MAX_TOTAL_ASSET_BYTES } from "../features/image-assets.ts";
import type { AssetPayload } from "../features/image-assets.ts";

export type ProjectNames=Readonly<{title?:string;fileName?:string}>;
export type ProjectPackage=Readonly<{ document:BoardDocument; assets:readonly AssetPayload[] }>&ProjectNames;
export const PROJECT_NAME="mg-canvas.project";
export const MAX_PROJECT_CHARS=72*1024*1024;

export function readProjectNames(source:unknown):ProjectNames {
  if(!isRecord(source))return {};
  const title=typeof source.title==="string"?source.title.trim():"";
  const fileName=typeof source.fileName==="string"?source.fileName.split(/[\\/]/).pop()?.trim():"";
  return {...(title?{title}:{}),...(fileName?{fileName}:{})};
}

// Released v1–v5 readers validate map keys and preserve arbitrary theme tokens.
// Carry the additional map style through those readers and their normal saves.
const stylePrefix="mgcanvas:mind-style/1:";
function packMapStyle(map:MindMap):MindMap{
  const {spacing,scale,skin,theme,branchColors,...base}=map;
  if(spacing===undefined&&scale===undefined&&skin===undefined&&branchColors===undefined)return map;
  return {...base,theme:stylePrefix+JSON.stringify([theme??null,spacing??null,scale??null,skin??null,...(branchColors?[branchColors]:[])])};
}
function unpackMapStyle(map:MindMap):MindMap{
  if(!map.theme?.startsWith(stylePrefix)||map.spacing!==undefined||map.scale!==undefined||map.skin!==undefined||map.branchColors!==undefined)return map;
  let token:unknown;
  try{token=JSON.parse(map.theme.slice(stylePrefix.length));}catch{return map;}
  if(!Array.isArray(token)||(token.length!==4&&token.length!==5))return map;
  const [theme,spacing,scale,skin,branchColors]=token;
  if(branchColors!==undefined&&!isBranchColors(branchColors,map.topics[map.rootId].childIds.length))return map;
  if(spacing===null&&scale===null&&skin===null&&branchColors===undefined)return map;
  if(theme!==null&&typeof theme!=="string"||spacing!==null&&!(typeof spacing==="number"&&spacing>=4&&spacing<=80)||
    scale!==null&&!(typeof scale==="number"&&scale>=.5&&scale<=2)||skin!==null&&!["rounded","square","capsule"].includes(skin))return map;
  const {theme:_packed,...base}=map;
  return {...base,...(theme===null?{}:{theme}),...(spacing===null?{}:{spacing}),...(scale===null?{}:{scale}),...(skin===null?{}:{skin}),
    ...(branchColors===undefined?{}:{branchColors})};
}
// Older shape readers preserve arbitrary stroke tokens and the human-readable label.
// Keep the source in the label so it also survives a round trip through those readers.
const cardPrefix="mgcanvas:card-style/1:";
function packCard(item:ShapeObject):ShapeObject{
  if(!item.content)return item;
  const {content,...base}=item;return {...base,stroke:cardPrefix+JSON.stringify([base.stroke,content])};
}
function unpackCard(item:ShapeObject):ShapeObject{
  if(item.content||item.shape!=="rect"||!item.stroke.startsWith(cardPrefix)||item.label.length>MAX_CARD_TEXT)return item;
  let value:unknown;try{value=JSON.parse(item.stroke.slice(cardPrefix.length));}catch{return item;}
  return Array.isArray(value)&&value.length===2&&typeof value[0]==="string"&&validCardStyle(value[1])?
    {...item,stroke:value[0],content:value[1]}:item;
}
function projectObjects(doc:BoardDocument,convert:(item:BoardObject)=>BoardObject):BoardDocument{
  let objects:Record<Id,BoardObject>|undefined;
  for(const id of doc.order){
    const item=doc.objects[id],next=convert(item);
    if(next===item)continue;
    objects??={...doc.objects};objects[id]=next;
  }
  return objects?{...doc,objects}:doc;
}
function objectIds(doc:BoardDocument,input:unknown,kind:"image"|"connector",error:string){
  if(!Array.isArray(input)||input.length>doc.order.length)throw new Error(error);
  const seen=new Set<Id>();
  for(const id of input){
    if(typeof id!=="string"||seen.has(id)||objectById(doc,id)?.kind!==kind)throw new Error(error);
    seen.add(id);
  }
  return seen;
}
function readProjectDocument(input:unknown,uneditedIds:unknown=[],shadowlessIds:unknown=[],portCurveIds:unknown=[],autoFromIds:unknown=[],autoToIds:unknown=[],labelSizes?:unknown):BoardDocument{
  const doc=readDocument(input);
  const unedited=objectIds(doc,uneditedIds,"connector","工程中的连线编辑记录无效。");
  const shadowless=objectIds(doc,shadowlessIds,"image","工程中的图片阴影设置无效。");
  const portCurves=objectIds(doc,portCurveIds,"connector","工程中的端口曲线记录无效。");
  const autoFrom=objectIds(doc,autoFromIds,"connector","工程中的自动起点记录无效。");
  const autoTo=objectIds(doc,autoToIds,"connector","工程中的自动终点记录无效。");
  const unpacked=projectObjects(doc,item=>{
    if(item.kind==="mindmap")return unpackMapStyle(item);
    if(item.kind==="shape")return unpackCard(item);
    if(item.kind==="connector"&&(unedited.has(item.id)||portCurves.has(item.id)||autoFrom.has(item.id)||autoTo.has(item.id))){
      const autoPorts=autoFrom.has(item.id)?(autoTo.has(item.id)?"both":"from"):autoTo.has(item.id)?"to":undefined;
      if(portCurves.has(item.id)&&item.routing!=="curve")throw new Error("端口曲线记录与连线类型不一致。");
      return {...item,...(unedited.has(item.id)?{unedited:true as const}:{}),...(portCurves.has(item.id)?{portCurve:true as const}:{}),...(autoPorts?{autoPorts}:{})};
    }
    if(item.kind==="image"&&shadowless.has(item.id))return {...item,shadow:false};
    return item;
  });
  if(labelSizes===undefined)return unpacked===doc?doc:freezeData(unpacked);
  if(!isRecord(labelSizes))throw new Error("工程中的流程标签字号表无效。");
  const objects={...unpacked.objects};
  for(const [id,size] of Object.entries(labelSizes)){
    const item=objectById(unpacked,id);
    if(!validFlowLabelSize(size)||!item||(item.kind!=="connector"&&(item.kind!=="shape"||item.content))||
      (item.labelFontSize!==undefined&&item.labelFontSize!==size))throw new Error("工程中的流程标签字号或对象引用无效。");
    objects[id]={...item,labelFontSize:size};
  }
  return freezeData({...unpacked,objects});
}

function encodeBytes(bytes:Uint8Array):string {
  const chunks:string[]=[];
  for(let i=0;i<bytes.length;i+=24000)chunks.push(String.fromCharCode(...bytes.subarray(i,i+24000)));
  return btoa(chunks.join(""));
}
function decodeBytes(src:unknown):Uint8Array {
  if(typeof src!=="string"||src.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||src.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(src))throw new Error("图片编码不完整。");
  const binary=atob(src),result=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)result[i]=binary.charCodeAt(i);
  return result;
}
export function encodeProject(doc:BoardDocument,vault:AssetVault,names?:ProjectNames):string {
  assertDocument(doc);
  const captured=vault.capture(doc), assets=Object.create(null) as Record<Id,string>;
  for(const [id,bytes] of captured)assets[id]=encodeBytes(bytes);
  // Legacy readers validate object keys, and ignore optional package metadata.
  const uneditedConnectors:Id[]=[],shadowlessImages:Id[]=[],portCurves:Id[]=[],autoFrom:Id[]=[],autoTo:Id[]=[];
  const flowLabelSizes:Record<Id,number>=Object.create(null);
  const document=projectObjects(doc,object=>{
    let item=object;
    if((item.kind==="shape"||item.kind==="connector")&&item.labelFontSize!==undefined){
      const {labelFontSize,...rest}=item;flowLabelSizes[item.id]=labelFontSize;item=rest;
    }
    if(item.kind==="mindmap")return packMapStyle(item);
    if(item.kind==="shape")return packCard(item);
    if(item.kind==="connector"&&(item.unedited||item.portCurve||item.autoPorts)){
      if(item.autoPorts==="from"||item.autoPorts==="both")autoFrom.push(item.id);
      if(item.autoPorts==="to"||item.autoPorts==="both")autoTo.push(item.id);
      if(item.unedited)uneditedConnectors.push(item.id);
      if(item.portCurve)portCurves.push(item.id);
      const {unedited,portCurve,autoPorts,...stored}=item;return stored;
    }
    if(item.kind==="image"&&item.shadow===false){
      shadowlessImages.push(item.id);const {shadow,...stored}=item;return stored;
    }
    return item;
  });
  const result=JSON.stringify({format:PROJECT_NAME,version:1,document,assets,...readProjectNames(names),...(Object.keys(flowLabelSizes).length?{flowLabelSizes}:{}),
    ...(uneditedConnectors.length?{uneditedConnectors}:{}),...(shadowlessImages.length?{shadowlessImages}:{}),...(portCurves.length?{portCurves}:{}),
    ...(autoFrom.length?{autoFrom}:{}),...(autoTo.length?{autoTo}:{})});
  if(result.length>MAX_PROJECT_CHARS)throw new Error("项目过大。");
  return result;
}
export function decodeProject(json:string):ProjectPackage {
  if(json.length>MAX_PROJECT_CHARS)throw new Error("项目过大。");
  const data=JSON.parse(json) as unknown;
  if(data&&typeof data==="object"&&"schemaVersion" in data){
    // M1/M2A demo snapshots had no image data. Do not accept broken external references.
    const doc=readProjectDocument(data);
    if(Object.keys(doc.assets).length)throw new Error("旧格式没有可恢复的图片数据。");
    return {document:doc,assets:[]};
  }
  if(!data||typeof data!=="object"||!("format" in data)||data.format!==PROJECT_NAME||
      !("version" in data)||data.version!==1||!("document" in data)||!("assets" in data)||
      !data.assets||typeof data.assets!=="object"||Array.isArray(data.assets))throw new Error("不支持此项目格式。");
  const doc=readProjectDocument(data.document,"uneditedConnectors" in data?data.uneditedConnectors:undefined,
    "shadowlessImages" in data?data.shadowlessImages:undefined,"portCurves" in data?data.portCurves:undefined,
    "autoFrom" in data?data.autoFrom:undefined,"autoTo" in data?data.autoTo:undefined,"flowLabelSizes" in data?data.flowLabelSizes:undefined), payload=data.assets as Record<Id,unknown>;
  const keys=Object.keys(payload);
  if(keys.length!==Object.keys(doc.assets).length)throw new Error("项目图片清单不一致。");
  let total=0;
  const assets:AssetPayload[]=[];
  for(const id of keys){
    if(!Object.hasOwn(doc.assets,id))throw new Error("项目包含未知图片数据。");
    const bytes=decodeBytes(payload[id]), meta=doc.assets[id];
    total+=bytes.length;
    if(total>MAX_TOTAL_ASSET_BYTES)throw new Error("项目图片总容量超过 48 MiB。");
    assertAsset(meta,bytes);
    assets.push({ meta,bytes });
  }
  return {document:doc,assets,...readProjectNames(data)};
}
