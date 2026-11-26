import { AssetVault } from "../features/image-assets.ts";
import type { ImageHeader } from "../features/image-assets.ts";
import type { Decoded } from "../features/standalone.ts";
import type { Id } from "../core/document.ts";

export type Bitmap = ImageBitmap | HTMLImageElement | HTMLCanvasElement;
export function releaseBitmap(image:Bitmap):void {if("close" in image)image.close();}
const MAX_BITMAP_PIXELS=1_500_000;
export const MAX_CACHE_PIXELS=30_000_000;
function renderShape(width:number,height:number):[number,number]{
  const scale=Math.min(1,Math.sqrt(MAX_BITMAP_PIXELS/(width*height)));
  const side=(length:number)=>Math.min(MAX_BITMAP_PIXELS,Math.max(1,Math.floor(length*scale)));
  return [side(width),side(height)];
}
function reduceBitmap(source:Bitmap,width:number,height:number):Bitmap{
  const [w,h]=renderShape(width,height);
  if(w===width&&h===height)return source;
  const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext("2d");
  if(!ctx){releaseBitmap(source);throw new Error("无法创建图片预览。");}
  try{ctx.drawImage(source,0,0,w,h);return canvas;}
  finally{releaseBitmap(source);}
}
// File validation, direct import and viewport demand use one native decoder at a time.
let decoderReady:Promise<void>=Promise.resolve();
export function decodeBrowserImage(bytes:Uint8Array,header:ImageHeader):Promise<Decoded<Bitmap>>{
  const result=decoderReady.then(()=>decodeBitmap(bytes,header));
  decoderReady=result.then(()=>{},()=>{});
  return result;
}
async function decodeBitmap(bytes:Uint8Array,header:ImageHeader):Promise<Decoded<Bitmap>>{
  const source=new Blob([Uint8Array.from(bytes).buffer],{type:header.mime});
  if(typeof createImageBitmap==="function"){
    const image=await createImageBitmap(source);
    const {width,height}=image;
    return {width,height,handle:reduceBitmap(image,width,height)};
  }
  const url=URL.createObjectURL(source), image=new Image();
  try{
    image.src=url;
    await image.decode();
    const {naturalWidth:width,naturalHeight:height}=image;
    return {width,height,handle:reduceBitmap(image,width,height)};
  }finally{URL.revokeObjectURL(url);}
}
type PendingDecode={id:Id;pixels:number;obsolete:boolean};
const area=(bitmap:Bitmap)=>bitmap.width*bitmap.height;

export class ImageCache {
  private images=new Map<Id,Bitmap>();
  private pixels=0;
  private visible:ReadonlySet<Id>=new Set();
  private loading?:PendingDecode;
  private failed=new Set<Id>();
  private invalidate:()=>void;
  constructor(invalidate:()=>void){this.invalidate=invalidate;}
  get(id:Id):Bitmap|undefined{return this.images.get(id);}
  private drop(id:Id,image:Bitmap):void{
    this.images.delete(id);this.pixels-=area(image);releaseBitmap(image);
  }
  /** Retain visible residents. Evict in admission order, only if the entire request fits. */
  private makeRoom(extra:number):boolean{
    let excess=this.pixels+extra-MAX_CACHE_PIXELS;
    if(excess<=0)return true;
    const victims:[Id,Bitmap][]=[];
    for(const entry of this.images){
      if(this.visible.has(entry[0]))continue;
      victims.push(entry);excess-=area(entry[1]);
      if(excess<=0){for(const [id,image] of victims)this.drop(id,image);return true;}
    }
    return false;
  }
  /** A newly imported, already decoded image shares the resident budget with pending previews. */
  add(id:Id,bitmap:Bitmap):void{
    const existing=this.images.get(id),size=area(bitmap);
    if(existing){if(existing!==bitmap)releaseBitmap(bitmap);return;}
    this.failed.delete(id);
    if(!Number.isSafeInteger(size)||size<=0||size>MAX_BITMAP_PIXELS||!this.makeRoom(size+(this.loading?.pixels??0))){
      releaseBitmap(bitmap);return;
    }
    this.images.set(id,bitmap);this.pixels+=size;this.invalidate();
  }
  retain(ids:ReadonlySet<Id>):void{
    for(const [id,image] of this.images)if(!ids.has(id))this.drop(id,image);
    for(const id of this.failed)if(!ids.has(id))this.failed.delete(id);
    if(this.loading&&!ids.has(this.loading.id))this.loading.obsolete=true;
  }
  reset():void{
    this.retain(new Set());this.visible=new Set();
  }
  /** IDs come from bitmap lookups performed by this paint, including cache hits. */
  updateVisible(ids:ReadonlySet<Id>,vault:AssetVault):void{
    this.visible=ids;
    if(this.loading){
      if(!ids.has(this.loading.id))this.loading.obsolete=true;
      return;
    }
    let available=MAX_CACHE_PIXELS;
    for(const id of ids){const image=this.images.get(id);if(image)available-=area(image);}
    if(available<=0)return;
    for(const id of ids){
      if(this.images.has(id)||this.failed.has(id))continue;
      const meta=vault.metadata(id);if(!meta)continue;
      const [w,h]=renderShape(meta.pixelWidth,meta.pixelHeight),pixels=w*h;
      if(pixels>available)continue;
      const payload=vault.get(id);if(!payload||!this.makeRoom(pixels))continue;
      const job:PendingDecode={id,pixels,obsolete:false};this.loading=job;
      void this.decode(job,payload.bytes,{mime:meta.mime,width:meta.pixelWidth,height:meta.pixelHeight});
      return;
    }
  }
  private async decode(job:PendingDecode,bytes:Uint8Array,header:ImageHeader):Promise<void>{
    try{
      const result=await decodeBrowserImage(bytes,header);
      if(job.obsolete||this.images.has(job.id))releaseBitmap(result.handle);
      else if(result.width!==header.width||result.height!==header.height||area(result.handle)!==job.pixels){
        releaseBitmap(result.handle);this.failed.add(job.id);
      }else{
        this.images.set(job.id,result.handle);this.pixels+=job.pixels;
      }
    }catch{if(!job.obsolete&&!this.images.has(job.id))this.failed.add(job.id);}
    finally{this.loading=undefined;this.invalidate();}
  }
}
