import type { BoardDocument, Id, ImageAsset } from "../core/document.ts";

export const MAX_IMAGE_BYTES=8*1024*1024;
export const MAX_IMAGE_PIXELS=24_000_000;
export const MAX_TOTAL_ASSET_BYTES=48*1024*1024;
export type ImageHeader=Readonly<{ mime:ImageAsset["mime"]; width:number; height:number }>;
export type AssetPayload=Readonly<{ meta:ImageAsset; bytes:Uint8Array }>;
const u8=(bytes:Uint8Array,offset:number)=>bytes[offset] ?? 0;
const u16be=(b:Uint8Array,i:number)=>u8(b,i)*256+u8(b,i+1);
const u24le=(b:Uint8Array,i:number)=>u8(b,i)+u8(b,i+1)*256+u8(b,i+2)*65536;
const u32be=(b:Uint8Array,i:number)=>u16be(b,i)*65536+u16be(b,i+2);
const u32le=(b:Uint8Array,i:number)=>u24le(b,i)+u8(b,i+3)*16777216;
const hasText=(b:Uint8Array,i:number,s:string)=>[...s].every((c,j)=>u8(b,i+j)===c.charCodeAt(0));
const equalBytes=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((c,i)=>c===b[i]);
const invalid=(msg="图片数据无效或不完整。")=>new Error(msg);

export function inspectImage(bytes:Uint8Array):ImageHeader {
  if(bytes.length>MAX_IMAGE_BYTES)throw invalid("图片过大：单张最多 8 MiB。");
  let info:ImageHeader|undefined;
  if(bytes.length>=33&&[137,80,78,71,13,10,26,10].every((c,i)=>bytes[i]===c)){
    if(u32be(bytes,8)!==13||!hasText(bytes,12,"IHDR"))throw invalid();
    let body=false,ended=false;
    for(let i=8;i+12<=bytes.length;){
      const size=u32be(bytes,i),end=i+12+size;
      if(end>bytes.length)throw invalid();
      if(hasText(bytes,i+4,"acTL")||hasText(bytes,i+4,"fcTL")||hasText(bytes,i+4,"fdAT"))throw invalid("暂不支持动态 PNG。");
      if(hasText(bytes,i+4,"IDAT"))body=true;
      if(hasText(bytes,i+4,"IEND")){ended=size===0;break;}
      i=end;
    }
    if(!body||!ended)throw invalid();
    info={mime:"image/png",width:u32be(bytes,16),height:u32be(bytes,20)};
  }else if(bytes.length>4&&bytes[0]===255&&bytes[1]===216){
    for(let i=2;i<bytes.length;){
      if(bytes[i++]!==255)throw invalid();
      while(bytes[i]===255)i++;
      const marker=bytes[i++];
      if(marker===0xda||marker===0xd9)break;
      if(marker>=0xd0&&marker<=0xd7||marker===1)continue;
      const size=u16be(bytes,i);
      if(size<2||i+size>bytes.length)throw invalid();
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        if(size<8)throw invalid();
        info={mime:"image/jpeg",width:u16be(bytes,i+5),height:u16be(bytes,i+3)};
        break;
      }
      i+=size;
    }
    if(!info||bytes.at(-2)!==255||bytes.at(-1)!==217)throw invalid();
  }else if(bytes.length>=20&&hasText(bytes,0,"RIFF")&&hasText(bytes,8,"WEBP")){
    if(u32le(bytes,4)+8!==bytes.length)throw invalid();
    let extended:ImageHeader|undefined,frame:ImageHeader|undefined;
    for(let i=12;i+8<=bytes.length;){
      const size=u32le(bytes,i+4), start=i+8,end=start+size+(size%2);
      if(end>bytes.length)throw invalid();
      if(hasText(bytes,i,"ANIM")||hasText(bytes,i,"ANMF")||(hasText(bytes,i,"VP8X")&&(u8(bytes,start)&2)))throw invalid("暂不支持动态 WebP。");
      if(hasText(bytes,i,"VP8X")&&size>=10)extended={mime:"image/webp",width:1+u24le(bytes,start+4),height:1+u24le(bytes,start+7)};
      if(hasText(bytes,i,"VP8L")&&size>=5&&bytes[start]===0x2f){
        const bits=u32le(bytes,start+1);
        frame={mime:"image/webp",width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};
      }
      if(hasText(bytes,i,"VP8 ")&&size>=10&&bytes[start+3]===0x9d&&bytes[start+4]===1&&bytes[start+5]===0x2a)
        frame={mime:"image/webp",width:(u8(bytes,start+6)+256*u8(bytes,start+7))&0x3fff,height:(u8(bytes,start+8)+256*u8(bytes,start+9))&0x3fff};
      i=end;
    }
    if(!frame || (extended && (extended.width!==frame.width||extended.height!==frame.height)))throw invalid();
    info=extended??frame;
  }
  if(!info)throw invalid("只支持静态 PNG、JPEG 或 WebP。");
  if(!info.width||!info.height||info.width*info.height>MAX_IMAGE_PIXELS)throw invalid("图片像素过多：单张最多 2400 万像素。");
  return info;
}

export function metadataMatches(meta:ImageAsset,header:ImageHeader):boolean {
  return meta.mime===header.mime &&
    (meta.pixelWidth===header.width&&meta.pixelHeight===header.height ||
     (meta.pixelWidth===header.height&&meta.pixelHeight===header.width)); // EXIF orientation can swap axes
}
export function assertAsset(meta:ImageAsset,bytes:Uint8Array):void {
  if(!metadataMatches(meta,inspectImage(bytes)))throw invalid("图片数据与项目清单不一致。");
}

/** Original immutable bytes are separate from the board, undo snapshots and decoder cache. */
export class AssetVault {
  private data=new Map<Id,AssetPayload>();
  private bytes=0;
  constructor(initial:Iterable<AssetPayload>=[]){
    for(const item of initial)this.add(item);
  }
  assetIds():readonly Id[]{return [...this.data.keys()];}
  metadata(id:Id):ImageAsset|undefined{return this.data.get(id)?.meta;}
  get(id:Id):AssetPayload|undefined {
    const item=this.data.get(id);
    return item && {meta:item.meta,bytes:item.bytes.slice()};
  }
  add(item:AssetPayload, reuse=false):ImageAsset {
    assertAsset(item.meta,item.bytes);
    if(reuse){
      for(const old of this.data.values()){
        if(old.meta.mime===item.meta.mime&&old.meta.pixelWidth===item.meta.pixelWidth&&old.meta.pixelHeight===item.meta.pixelHeight&&equalBytes(old.bytes,item.bytes))return old.meta;
      }
    }
    if(this.data.has(item.meta.id))throw invalid("重复的图片资产 ID。");
    if(this.bytes+item.bytes.length>MAX_TOTAL_ASSET_BYTES)throw invalid("画板原图容量已达 48 MiB；请缩小图片或清理历史后再试。");
    const meta=Object.freeze({...item.meta});
    this.data.set(meta.id,{meta,bytes:item.bytes.slice()});this.bytes+=item.bytes.length;return meta;
  }
  capture(doc:BoardDocument):ReadonlyMap<Id,Uint8Array> {
    const owned=new Map<Id,Uint8Array>();
    for(const id of Object.keys(doc.assets)){
      const item=this.data.get(id);
      if(!item)throw invalid("画板中的图片原始数据缺失。");
      owned.set(id,item.bytes.slice());
    }
    return owned;
  }
  retain(ids:ReadonlySet<Id>):void {
    for(const [id,item] of this.data){
      if(!ids.has(id)){this.bytes-=item.bytes.length;this.data.delete(id);}
    }
  }
}
