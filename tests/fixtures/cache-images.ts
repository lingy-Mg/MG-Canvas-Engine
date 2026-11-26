import {crc32,deflateSync} from "node:zlib";
import type {BoardDocument,BoardObject,ImageAsset} from "../../core/document.ts";
import {AssetVault} from "../../features/image-assets.ts";
import {encodeProject} from "../../platform/project.ts";

export const cacheWidth=1500,cacheHeight=1000;
export const cacheId=(i:number)=>"asset-"+i;
export const cacheColor=(tag:number):[number,number,number]=>[48+tag,100+tag%90,196-tag%97];
const zeroRows=deflateSync(Buffer.alloc((1+Math.ceil(cacheWidth/8))*cacheHeight));
function chunk(name:string,data:Uint8Array):Buffer{
  const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length,0);result.write(name,4);result.set(data,8);
  result.writeUInt32BE(crc32(result.subarray(4,-4)),result.length-4);return result;
}
/** Real single-colour indexed PNG. Only the palette varies between full-size assets. */
export function cachePNG(tag:number):Buffer{
  const header=Buffer.alloc(13);header.writeUInt32BE(cacheWidth,0);header.writeUInt32BE(cacheHeight,4);
  header[8]=1;header[9]=3;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),
    chunk("PLTE",Uint8Array.from(cacheColor(tag))),chunk("IDAT",zeroRows),chunk("IEND",new Uint8Array())]);
}
export function cacheFixture(alternate=false){
  const objects:Record<string,BoardObject>={},assets:Record<string,ImageAsset>={},vault=new AssetVault();
  const indices=alternate?[20]:Array.from({length:22},(_,i)=>i);
  for(const i of indices){
    const id=cacheId(i),meta:ImageAsset={id,mime:"image/png",pixelWidth:cacheWidth,pixelHeight:cacheHeight};
    assets[id]=vault.add({meta,bytes:cachePNG(alternate?42:i)});
  }
  function put(id:string,i:number,x:number,y:number){objects[id]={id,kind:"image",assetId:cacheId(i),at:{x,y},width:64,height:44,rotation:0};}
  if(alternate)put("replacement",20,40,60);
  else{
    for(let i=0;i<20;i++)put("home-"+i,i,40+i%5*110,60+Math.floor(i/5)*95);
    put("remote",20,4040,60);put("remote-copy",20,4260,190);
    put("paint-margin",21,4831,60); // Inside the scene query's 32 px, outside the renderer's 30 px.
    for(let i=0;i<21;i++)put("dense-"+i,i,8040+i%6*110,60+Math.floor(i/6)*95);
    put("isolated",21,12040,60);
  }
  const document:BoardDocument={id:alternate?"cache-replacement":"cache-panning",schemaVersion:1,theme:"paper",assets,objects,order:Object.keys(objects)};
  return {document,vault,wire:encodeProject(document,vault)};
}
