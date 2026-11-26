import { isId, objectById } from "../core/document.ts";
import { decodeProject } from "../platform/project.ts";
import { canvasThemes } from "../platform/theme.ts";
import { buildScene, groupBounds } from "../scene/board.ts";
import { CanvasView } from "../renderers/canvas2d/canvas.ts";
import { decodeBrowserImage, MAX_CACHE_PIXELS, releaseBitmap } from "./image-cache.ts";
import type { Bitmap } from "./image-cache.ts";

const padding=24;
class RenderFailure extends Error {
  code:string;
  constructor(code:string,message:string){super(message);this.code=code;}
}
export async function renderPng(canvas:HTMLCanvasElement,encodedProject:string,options:unknown) {
  if(options===null||typeof options!=="object"||Array.isArray(options))throw new RenderFailure("INVALID","Expected PNG render options");
  const {id,scale:requested}=options as {id?:unknown,scale?:unknown};
  if(id!==undefined&&!isId(id))throw new RenderFailure("INVALID","Expected a valid board object ID");
  const project=decodeProject(encodedProject);
  if(id!==undefined&&!objectById(project.document,id))throw new RenderFailure("NOT_FOUND","Unknown object ID");
  if(requested!==undefined&&(typeof requested!=="number"||!Number.isFinite(requested)||requested<0.05||requested>8))
    throw new RenderFailure("INVALID","Scale must be between 0.05 and 8 pixels per world unit");
  await document.fonts.ready;
  const scene=buildScene(project.document,undefined,id===undefined?undefined:[id]);
  const view=new CanvasView(canvas);
  const bounds=groupBounds(scene);
  const spanX=bounds?bounds.max.x-bounds.min.x:0,spanY=bounds?bounds.max.y-bounds.min.y:0;
  const scale=requested??Math.min(1,(1600-2*padding)/Math.max(1,spanX),(1200-2*padding)/Math.max(1,spanY));
  function extent(span:number,limit:number){
    const pixels=Math.max(1,Math.ceil(span*scale))+2*padding;
    // A limiting extent can round a fraction of a pixel above its integral cap.
    return requested===undefined?Math.min(limit,pixels):pixels;
  }
  const width=bounds?extent(spanX,1600):256,height=bounds?extent(spanY,1200):192;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width>4096||height>4096||width*height>8388608)
    throw new RenderFailure("TOO_LARGE","PNG exceeds the pixel limit. Use auto scale, a smaller scale or one object ID.");
  const offset=bounds?{x:padding-bounds.min.x*scale,y:padding-bounds.min.y*scale}:{x:width/2,y:height/2};
  const needed=new Set<string>();
  for(const group of scene){
    const item=project.document.objects[group.id];
    if(item.kind==="image")needed.add(item.assetId);
  }
  const bitmaps=new Map<string,Bitmap>();
  try{
    let pixels=0;
    for(const {meta,bytes} of project.assets){
      if(!needed.has(meta.id))continue;
      const decoded=await decodeBrowserImage(bytes,{mime:meta.mime,width:meta.pixelWidth,height:meta.pixelHeight});
      bitmaps.set(meta.id,decoded.handle);
      if(decoded.width!==meta.pixelWidth||decoded.height!==meta.pixelHeight)throw new RenderFailure("INVALID","Decoded image dimensions differ for "+meta.id);
      pixels+=decoded.handle.width*decoded.handle.height;
      if(pixels>MAX_CACHE_PIXELS)throw new RenderFailure("TOO_LARGE","Image bitmap budget exceeded. Render an individual object.");
    }
    view.setTheme("light");view.size(width,height,1);
    view.draw(scene,{zoom:scale,offset},[],undefined,asset=>bitmaps.get(asset));
    const png=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,"image/png"));
    if(!png)throw new Error("Canvas PNG encoding failed");
    return {png,metadata:{width,height,scale,offset,bounds:bounds??null,background:canvasThemes.light.bg,
      scope:id===undefined?{kind:"board"}:{kind:"object",id},objectCount:scene.length,imageCount:bitmaps.size}};
  }finally{for(const bitmap of bitmaps.values())releaseBitmap(bitmap);}
}
export function renderPngFailure(error:unknown) {
  return {ok:false,code:error instanceof RenderFailure?error.code:"RENDER_FAILED",
    message:error instanceof Error?error.message:"Unable to paint snapshot"};
}
