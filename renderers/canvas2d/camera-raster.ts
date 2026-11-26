import {screenToWorld} from "../../core/geometry.ts";
import type {Camera,Rect} from "../../core/geometry.ts";
import type {WorkspaceTheme} from "../../platform/theme.ts";
import type {Scene} from "../../scene/board.ts";
import {CanvasView} from "./canvas.ts";

type Surface={canvas:OffscreenCanvas;view:CanvasView};
type Capture=Surface&{camera:Camera;width:number;height:number;ratio:number;theme:WorkspaceTheme;assets:Set<string>};
type Paint=(context:CanvasRenderingContext2D)=>void;

/** Reproject a bounded, overscanned content bitmap while live overlays use current geometry. */
export class CameraRaster{
  private current?:Capture;
  private spare?:Surface;
  work:"none"|"reuse"|"extend"|"rebuild"="none";
  queriedGroups=0;

  clear(){this.current=undefined;this.spare=undefined;}

  paint(camera:Camera,w:number,h:number,ratio:number,theme:WorkspaceTheme,query:(region:Rect)=>Scene,
    bitmap:(assetId:string)=>CanvasImageSource|undefined,visibleAssets:Set<string>):Paint|undefined{
    this.work="none";
    this.queriedGroups=0;
    if(typeof OffscreenCanvas==="undefined"||w<1||h<1)return;
    const marginX=Math.ceil(w*.18),marginY=Math.ceil(h*.18),width=w+2*marginX,height=h+2*marginY;
    if(width*height*ratio*ratio>10_000_000){this.clear();return;}
    let content=this.current;
    if(content&&(content.width!==width||content.height!==height||content.ratio!==ratio||content.theme!==theme)){
      this.clear();content=undefined;
    }
    const scale=content?camera.zoom/content.camera.zoom:1;
    const x=content?content.camera.offset.x-camera.offset.x/scale:0;
    const y=content?content.camera.offset.y-camera.offset.y/scale:0;
    if(content&&scale>=.74&&scale<=1.60&&x>=0&&y>=0&&x+w/scale<=width&&y+h/scale<=height){
      this.work="reuse";
      return this.transfer(content,x,y,w,h,scale,visibleAssets);
    }
    const previous=content,canvas=this.spare?.canvas??new OffscreenCanvas(1,1);
    const view=this.spare?.view??new CanvasView(canvas,{overviewDetail:true,cardPlaceholders:true});
    const baseX=camera.offset.x+marginX,baseY=camera.offset.y+marginY;
    const shiftPixelsX=previous?Math.round((baseX-previous.camera.offset.x)*ratio):0;
    const shiftPixelsY=previous?Math.round((baseY-previous.camera.offset.y)*ratio):0;
    const reuse=previous&&scale===1&&Math.abs(shiftPixelsX)<width*ratio*.65&&Math.abs(shiftPixelsY)<height*ratio*.65;
    const shiftX=shiftPixelsX/ratio,shiftY=shiftPixelsY/ratio;
    const pose:Camera={zoom:camera.zoom,offset:reuse?
      {x:previous.camera.offset.x+shiftX,y:previous.camera.offset.y+shiftY}:{x:baseX,y:baseY}};
    const assets=new Set<string>();
    const lookup=(id:string)=>{assets.add(id);return bitmap(id);};
    view.size(width,height,ratio);view.setTheme(theme);
    const ctx=canvas.getContext("2d")!;
    // Align the cache to device pixels; the final crop retains the fractional camera position.
    if(reuse){
      this.work="extend";
      ctx.setTransform(1,0,0,1,0,0);
      ctx.drawImage(previous.canvas,shiftPixelsX,shiftPixelsY);
      for(const group of this.groups(query,pose,{min:{x:0,y:0},max:{x:width,y:height}})){
        if(group.topicCount)continue;
        for(const item of group.items)if(item.kind==="image")assets.add(item.assetId);
      }
      const left=Math.max(0,shiftX),right=Math.min(width,width+shiftX);
      const top=Math.max(0,shiftY),bottom=Math.min(height,height+shiftY);
      for(const [x0,y0,x1,y1] of [[0,0,left,height],[right,0,width,height],[left,0,right,top],[left,bottom,right,height]]){
        if(x1<=x0||y1<=y0)continue;
        const damage={min:{x:x0,y:y0},max:{x:x1,y:y1}};
        view.draw(this.groups(query,pose,damage),pose,[],undefined,lookup,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,{damage});
      }
    }else{
      this.work="rebuild";
      view.draw(this.groups(query,pose,{min:{x:0,y:0},max:{x:width,y:height}}),pose,[],undefined,lookup);
    }
    this.current={canvas,view,camera:pose,width,height,ratio,theme,assets};
    this.spare=previous;
    return this.transfer(this.current,pose.offset.x-camera.offset.x,pose.offset.y-camera.offset.y,w,h,1,visibleAssets);
  }

  private groups(query:(region:Rect)=>Scene,camera:Camera,area:Rect){
    const scene=query({min:screenToWorld({x:area.min.x-32,y:area.min.y-32},camera),
      max:screenToWorld({x:area.max.x+32,y:area.max.y+32},camera)});
    this.queriedGroups+=scene.length;
    return scene;
  }

  private transfer(content:Capture,x:number,y:number,w:number,h:number,scale:number,visibleAssets:Set<string>):Paint{
    for(const id of content.assets)visibleAssets.add(id);
    const ratio=content.ratio;
    return context=>context.drawImage(content.canvas,x*ratio,y*ratio,w*ratio/scale,h*ratio/scale,0,0,w,h);
  }
}
