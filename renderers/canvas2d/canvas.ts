import { autoLabelInk,canvasStroke,canvasThemes,contrastInk,contrastRatio,labelSurface,standaloneInk } from "../../platform/theme.ts";
import type { WorkspaceTheme } from "../../platform/theme.ts";
import { DEFAULT_SHAPE_STROKE } from "../../core/document.ts";
import { HIGHLIGHTER_BRUSH_VERSION,inkPoints,inkSegmentHull } from "../../features/ink.ts";
import type { InkGeometry,InkPoint } from "../../features/ink.ts";
import { boxBounds,worldToScreen } from "../../core/geometry.ts";
import type { Box,Camera, Point, Rect } from "../../core/geometry.ts";
import {nodeFont,standaloneFont} from "../../platform/text-metrics.ts";
import {plainTextWidth} from "../../features/plain-text.ts";
import { NodeLabelPainter } from "./node-text.ts";
import {MIN_INDEXED_TOPICS,TopicViewport} from "./topic-viewport.ts";
import { DotGridPainter } from "./dot-grid.ts";
import {topicPlacement} from "../../scene/topic-placement.ts";
import {paintFlowDraft,paintFlowMarkers} from "./flow-decor.ts";
import {traceShape} from "./shape-outline.ts";
import {revealPrimitive} from "./reveal.ts";
import type {MotionPaint} from "../../scene/motion.ts";
import { mergeBounds } from "../../scene/board.ts";
import type {PathSegment} from "../../core/path-geometry.ts";
import type {AlignmentGuide} from "../../session/drag-alignment.ts";
import type {PathDecor} from "../../features/path-input.ts";
import { TEXT_EDGES,textWidthGrip } from "../../session/text-width.ts";
import { cornerPoint,rotationHandle } from "../../session/resize.ts";
import type { MindDecor } from "../../features/mindmap-input.ts";
import type { FlowDecor } from "../../features/flow-input.ts";
import type { Primitive, Scene } from "../../scene/board.ts";
import {cardDisplayLayout,cardInk,cardPlaceholderInk} from "../../features/card-content.ts";
import type {CellAddress} from "../../features/table.ts";

const readableText=5;
const smallImage=24;
type OverviewInk=Readonly<{step:number;points:readonly InkPoint[];minRadius:number;maxRadius:number}>;
type InkPath={ox:number;oy:number;width?:number;body:Path2D;halo?:Path2D};

function traceInk(path:CanvasPath,points:readonly InkPoint[],ox:number,oy:number,width:number|undefined,pad=0){
  if(width!==undefined){
    path.moveTo(points[0].x-ox,points[0].y-oy);
    for(let i=1;i<points.length;i++)path.lineTo(points[i].x-ox,points[i].y-oy);
    return;
  }
  for(let i=0;i<points.length;i++){
    const p=points[i],x=p.x-ox,y=p.y-oy,r=p.radius+pad;
    // Each disk and hull starts its own contour. Fill closes them implicitly.
    path.moveTo(x+r,y);path.arc(x,y,r,0,2*Math.PI);
    const next=points[i+1],quad=next&&inkSegmentHull(pad?{...p,radius:r}:p,pad?{...next,radius:next.radius+pad}:next);
    if(quad){
      path.moveTo(quad[0].x-ox,quad[0].y-oy);
      for(let j=1;j<quad.length;j++)path.lineTo(quad[j].x-ox,quad[j].y-oy);
    }
  }
}

function traceSegment(c:CanvasRenderingContext2D,s:PathSegment,map:(p:Point)=>Point=p=>p){
  const end=map(s.to);
  if(s.controls){const a=map(s.controls.c1),b=map(s.controls.c2);c.bezierCurveTo(a.x,a.y,b.x,b.y,end.x,end.y);}
  else c.lineTo(end.x,end.y);
}

function drawTextWidthGrips(c:CanvasRenderingContext2D,box:Box,camera:Camera,view:{width:number;height:number},accent:string,fill:string){
  const dy=4*Math.cos(box.rotation),dx=-4*Math.sin(box.rotation);
  c.save();c.lineCap="round";
  for(const edge of TEXT_EDGES){
    const {base,center,extension}=textWidthGrip(box,camera,edge,view);
    if(extension){
      c.strokeStyle=accent;c.lineWidth=1.45;c.beginPath();
      c.moveTo(base.x,base.y);c.lineTo(center.x,center.y);c.stroke();
    }
    c.beginPath();c.moveTo(center.x-dx,center.y-dy);c.lineTo(center.x+dx,center.y+dy);
    c.strokeStyle=accent;c.lineWidth=7;c.stroke();
    c.strokeStyle=fill;c.lineWidth=4;c.stroke();
  }
  c.restore();
}

function drawSnapGuides(c:CanvasRenderingContext2D,guides:readonly AlignmentGuide[],camera:Camera,theme:WorkspaceTheme,width:number,height:number){
  const palette=canvasThemes[theme],z=camera.zoom;
  c.save();c.lineCap="butt";c.font=nodeFont(11,650);c.textAlign="center";c.textBaseline="middle";
  for(const guide of guides){
    const vertical=guide.kind==="alignment"?guide.axis==="x":guide.axis==="y";
    const along=vertical?"y":"x",across=vertical?"x":"y",offset=camera.offset[along];
    const at=camera.offset[across]+guide.at*z;
    function segment(from:number,to:number){
      if(vertical){c.moveTo(at,from);c.lineTo(at,to);}
      else{c.moveTo(from,at);c.lineTo(to,at);}
    }
    c.beginPath();
    if(guide.kind==="alignment"){
      if(!guide.runs.length)continue;
      c.strokeStyle=palette.guide;c.lineWidth=1;c.setLineDash([4,3]);
      for(const run of guide.runs)segment(offset+run.min*z,offset+run.max*z);
      c.stroke();continue;
    }
    c.strokeStyle=palette.spacing;c.fillStyle=palette.spacing;c.lineWidth=1.4;c.setLineDash([]);
    const from=offset+guide.from*z,to=offset+guide.to*z,mid=(from+to)/2;
    const textWidth=c.measureText(guide.label)?.width??guide.label.length*7;
    const low=camera.offset[across]+guide.lane.min*z,high=camera.offset[across]+guide.lane.max*z;
    const crossHalf=(vertical?textWidth:11)/2+1,labelHalf=(vertical?11:textWidth)/2+3;
    const labelAt=Math.max(low+crossHalf,Math.min(high-crossHalf,at)),x=vertical?labelAt:mid,y=vertical?mid:labelAt;
    const fits=high-low>=2*crossHalf&&to-from>=2*labelHalf+8&&x-textWidth/2>=1&&x+textWidth/2<=width-1&&y>=7&&y<=height-7;
    if(fits){segment(from,mid-labelHalf);segment(mid+labelHalf,to);}
    else segment(from,to);
    const cap=Math.min(3,at-low,high-at);
    for(const end of [from,to]){
      if(vertical){c.moveTo(at-cap,end);c.lineTo(at+cap,end);}
      else{c.moveTo(end,at-cap);c.lineTo(end,at+cap);}
    }
    c.stroke();
    if(fits)c.fillText(guide.label,x,y);
  }
  c.restore();
}

export class CanvasView {
  private canvas:HTMLCanvasElement|OffscreenCanvas;
  private ctx:CanvasRenderingContext2D;
  private labels=new NodeLabelPainter();
  private readonly cardPlaceholders:boolean;
  private readonly overviewDetail:boolean;
  private detailScale=Infinity;
  private inkStep=0;
  private overviewInk=new WeakMap<readonly InkPoint[],readonly OverviewInk[]>();
  private inkPaths=new WeakMap<readonly InkPoint[],InkPath>();
  private textBaselines=new Map<string,number>();
  private editingSurface?:{id:string;color:string};
  labelBackdrop(id:string){return this.editingSurface?.id===id?this.editingSurface.color:undefined;}
  private topics:TopicViewport;
  private grid=new DotGridPainter();
  private theme:WorkspaceTheme="light";
  private surfaceInk=contrastInk(canvasThemes.light.bg);
  private inks=new Map<string,ReturnType<typeof canvasStroke>>();
  private ratio=1;
  private pixelsPerUnit=1;
  private pixelOriginX=0;
  private pixelOriginY=0;
  private width=1;
  private height=1;
  constructor(canvas:HTMLCanvasElement|OffscreenCanvas,options:{cardPlaceholders?:boolean;overviewDetail?:boolean}={}) {
    const ctx=canvas.getContext("2d") as CanvasRenderingContext2D|null;
    if (!ctx) throw new Error("Canvas 2D unavailable");
    this.canvas=canvas;this.ctx=ctx;this.topics=new TopicViewport(ctx);this.cardPlaceholders=Boolean(options.cardPlaceholders);
    this.overviewDetail=Boolean(options.overviewDetail);
  }
  setTheme(theme:WorkspaceTheme){
    if(this.theme!==theme){this.theme=theme;this.surfaceInk=contrastInk(canvasThemes[theme].bg);this.inks.clear();}
  }
  private ink(ink:string){
    const existing=this.inks.get(ink);
    if(existing!==undefined)return existing;
    const paint=canvasStroke(ink,this.theme);
    if(this.inks.size>=192)this.inks.clear();
    this.inks.set(ink,paint);
    return paint;
  }
  size(width:number,height:number,ratio:number) {
    this.width=Math.max(1,width);
    this.height=Math.max(1,height);
    this.ratio=ratio;
    const w=Math.ceil(this.width*ratio), h=Math.ceil(this.height*ratio);
    if (this.canvas.width!==w) this.canvas.width=w;
    if (this.canvas.height!==h) this.canvas.height=h;
  }
  draw(scene:Scene,camera:Camera,selected:readonly string[]=[],marquee?:Rect,bitmap?:(assetId:string)=>CanvasImageSource|undefined,editing?:{objectId:string;topicId?:string;cell?:CellAddress;card?:boolean},flow?:FlowDecor,mind?:MindDecor,resize?:Box & {kind?:string;outline?:Box},draft?:InkGeometry|readonly InkGeometry[],vector?:PathDecor,guides?:readonly AlignmentGuide[],motion?:ReadonlyMap<string,MotionPaint>,reuse?:{damage?:Rect;content?:(context:CanvasRenderingContext2D)=>void}) {
    const c=this.ctx,r=this.ratio,w=this.width,h=this.height,z=camera.zoom,o=camera.offset,palette=canvasThemes[this.theme];
    this.pixelsPerUnit=z*r;this.pixelOriginX=o.x*r;this.pixelOriginY=o.y*r;
    const detailScale=this.overviewDetail?z:Infinity;
    // Quantize the tolerance so pan and nearby wheel positions reuse the same samples.
    this.inkStep=this.overviewDetail&&this.pixelsPerUnit<1?2**Math.floor(Math.log2(.8/this.pixelsPerUnit)):0;
    c.setTransform(r,0,0,r,0,0);
    const damage=reuse?.damage;
    if(damage){
      c.save();c.beginPath();c.rect(damage.min.x,damage.min.y,damage.max.x-damage.min.x,damage.max.y-damage.min.y);c.clip();
    }
    if(reuse?.content)reuse.content(c);
    else{
      const area=damage??{min:{x:0,y:0},max:{x:w,y:h}};
      c.fillStyle=palette.bg;c.fillRect(area.min.x,area.min.y,area.max.x-area.min.x,area.max.y-area.min.y);
      c.fillStyle=palette.grid;
      this.grid.draw(c,w,h,r,z,o);
    }
    c.setTransform(z*r,0,0,z*r,o.x*r,o.y*r);
    let textOutline:Box|undefined,topicWindow:Rect|undefined;
    let paintedLeft=Infinity,paintedTop=Infinity,paintedRight=-Infinity,paintedBottom=-Infinity;
    this.editingSurface=undefined;
    for (const group of reuse?.content?[]:scene) {
      const resizingText=resize?.kind==="text"&&selected.length===1&&group.id===selected[0];
      // A selected text box keeps its real glyph layout during width previews.
      this.detailScale=resizingText?Infinity:detailScale;
      if(resizingText){
        const pick=group.picks[0];if(pick&&"box" in pick)textOutline=pick.box;
      }
      const a=worldToScreen(group.bounds.min,camera), b=worldToScreen(group.bounds.max,camera);
      if (a.x>w+30 || a.y>h+30 || b.x< -30 || b.y< -30) continue;
      let items:readonly Primitive[];
      if((group.topicCount??0)>=MIN_INDEXED_TOPICS&&(a.x<0||a.y<0||b.x>w||b.y>h)){
        const pad=4/r;
        topicWindow??={min:{x:(-o.x-pad)/z,y:(-o.y-pad)/z},max:{x:(w-o.x+pad)/z,y:(h-o.y+pad)/z}};
        items=this.topics.items(group,topicWindow);
        // The map's branch pass sets these before any topic boxes, even if all visible branches are culled.
        if(items.length!==(topicPlacement(group)?.local??group).items.length){c.lineJoin="round";c.lineCap="round";}
      }else items=group.items;
      let backdrop:string|undefined;
      const editingCard=editing?.objectId===group.id&&editing.card;
      const effect=motion?.get(group.id);
      if(effect){c.save();c.globalAlpha=effect.alpha;}
      for(const item of items){
        if(item.kind==="box"&&!item.underline&&(item.fill==="transparent"||editingCard)&&!group.topicCount){
          const center=worldToScreen({x:item.box.at.x+item.box.width/2,y:item.box.at.y+item.box.height/2},camera);
          backdrop=palette.bg;
          // Only read the already-painted layer when geometry could be underneath this transparent frame.
          if((this.detailScale>=.25||editing?.objectId===group.id)&&center.x>=paintedLeft&&center.x<=paintedRight&&center.y>=paintedTop&&center.y<=paintedBottom&&center.x>=0&&center.x<w&&center.y<h){
            const data=c.getImageData?.(Math.floor(center.x*r),Math.floor(center.y*r),1,1)?.data;
            if(data?.length===4)backdrop="#"+[data[0],data[1],data[2]].map(v=>v.toString(16).padStart(2,"0")).join("");
          }
          if(editing?.objectId===group.id)this.editingSurface={id:group.id,color:backdrop};
          if(editingCard)continue; // The native card owns its editable paper, including transparent paper.
        }
        if(editing?.objectId===group.id&&(item.kind==="cardText"||item.kind==="textBlock"&&(!item.cell||item.cell.row===editing.cell?.row&&item.cell.col===editing.cell.col)||
          (item.kind==="nodeLabel"&&item.topicId===editing.topicId)))continue;
        const faded=item.topicAlpha!==undefined&&item.topicAlpha<1;
        if(faded){c.save();c.globalAlpha*=item.topicAlpha!;}
        this.drawItem(effect&&effect.reveal<1?revealPrimitive(item,effect.reveal):item,bitmap,backdrop);
        if(faded)c.restore();
      }
      if(effect)c.restore();
      paintedLeft=Math.min(a.x,paintedLeft);paintedTop=Math.min(a.y,paintedTop);paintedRight=Math.max(b.x,paintedRight);paintedBottom=Math.max(b.y,paintedBottom);
    }
    if(reuse?.content&&resize?.kind==="text"&&selected.length===1){
      const pick=scene.find(group=>group.id===selected[0])?.picks[0];
      if(pick&&"box" in pick)textOutline=pick.box;
    }
    if(draft)for(const piece of "samples" in draft?[draft]:draft)
      this.drawInk(inkPoints(piece),piece.color,piece.brushVersion===HIGHLIGHTER_BRUSH_VERSION,piece.subpixel);
    if(flow)paintFlowDraft(c,flow,camera,r,palette);
    let selectionFrame:Rect|undefined;
    const multiple=selected.length+(mind?.range?.length??0)>1;
    if(selected.length||marquee||multiple){
      c.setTransform(r,0,0,r,0,0);c.setLineDash([]);c.lineWidth=1.25;
      const ids=new Set(selected);
      let bounds:Rect|undefined;
      if(ids.size&&!resize)for(const group of scene){
        if(!ids.has(group.id))continue;
        if(multiple&&!marquee)bounds=mergeBounds(bounds,group.bounds);
        const a=worldToScreen(group.bounds.min,camera),b=worldToScreen(group.bounds.max,camera);
        c.strokeStyle=multiple?palette.accentMuted:palette.accent;
        c.strokeRect(a.x-4,a.y-4,b.x-a.x+8,b.y-a.y+8);
      }
      if(multiple&&!marquee){
        for(const topic of mind?.range??[])bounds=mergeBounds(bounds,boxBounds(topic));
      }
      if(bounds){
        const a=worldToScreen(bounds.min,camera),b=worldToScreen(bounds.max,camera);
        selectionFrame={min:{x:a.x-7,y:a.y-7},max:{x:b.x+7,y:b.y+7}};
        c.strokeStyle=palette.accent;c.setLineDash([4,3]);
        c.strokeRect(selectionFrame.min.x,selectionFrame.min.y,b.x-a.x+14,b.y-a.y+14);c.setLineDash([]);
      }
      if(marquee){
        const a=marquee.min,b=marquee.max;
        c.fillStyle=palette.accentFill;c.strokeStyle=palette.accent;
        c.fillRect(a.x,a.y,b.x-a.x,b.y-a.y);c.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);
      }
    }
    if(mind?.selected||mind?.drop||mind?.range?.length){
      c.setTransform(r,0,0,r,0,0);c.setLineDash([]);c.lineWidth=1.6;
      const outline=(box:MindDecor["selected"],color:string)=>{if(!box)return;const a=worldToScreen(box.at,camera);
        c.strokeStyle=color;c.strokeRect(a.x-3,a.y-3,box.width*z+6,box.height*z+6);};
      outline(mind.selected,palette.accent);
      for(const box of mind.range??[])outline(box,palette.accent);
      if(mind.drop){
        const {box,drop,valid}=mind.drop;
        const color=valid?palette.valid:palette.invalid;
        if(drop.place==="child")outline(box,color);
        else{
          const a=worldToScreen(box.at,camera),y=a.y+(drop.place==="before"?-5:box.height*z+5);
          c.strokeStyle=color;c.lineWidth=2.3;c.beginPath();c.moveTo(a.x-4,y);c.lineTo(a.x+box.width*z+4,y);c.stroke();
        }
      }
    }
    if(resize){
      c.setTransform(r,0,0,r,0,0);c.setLineDash([]);c.lineWidth=1.45;c.strokeStyle=palette.accent;
      // Fitted legacy text may paint beyond its stored wrap box. Its width grips still edit the stored width.
      const corners=["nw","ne","se","sw"] as const;
      const outline=textOutline??resize.outline??resize;
      const contour=corners.map(corner=>worldToScreen(cornerPoint(outline,corner),camera));
      c.beginPath();c.moveTo(contour[0].x,contour[0].y);
      for(const p of contour.slice(1))c.lineTo(p.x,p.y);
      c.closePath();c.stroke();
      if(resize.kind==="text")drawTextWidthGrips(c,resize,camera,{width:w,height:h},palette.accent,palette.handle);
      else{
        c.fillStyle=palette.handle;
        for(const corner of corners){const p=worldToScreen(cornerPoint(resize,corner),camera);c.fillRect(p.x-4.5,p.y-4.5,9,9);c.strokeRect(p.x-4.5,p.y-4.5,9,9);}
        if(resize.kind!=="table"){
          const {base,knob}=rotationHandle(resize,camera);
          c.beginPath();c.moveTo(base.x,base.y);c.lineTo(knob.x,knob.y);c.stroke();
          c.beginPath();c.arc(knob.x,knob.y,5.5,0,2*Math.PI);c.fill();c.stroke();
        }
      }
    }
    if(vector?.points.length){
      const points=vector.points.map(p=>worldToScreen(p,camera)),first=points[0],last=points[points.length-1];
      c.setTransform(r,0,0,r,0,0);c.strokeStyle=palette.accent;c.lineWidth=1.6;c.setLineDash([]);
      if(vector.drawing){
        c.beginPath();c.moveTo(first.x,first.y);for(const p of points.slice(1))c.lineTo(p.x,p.y);c.stroke();
        if(vector.hover){const end=worldToScreen(vector.hover,camera);
          c.setLineDash([4,3]);c.beginPath();c.moveTo(last.x,last.y);c.lineTo(end.x,end.y);c.stroke();c.setLineDash([]);
        }
      }
      if(vector.selected){
        const s=vector.selected,map=(p:Point)=>worldToScreen(p,camera),start=map(s.from),end=map(s.to);
        c.beginPath();c.moveTo(start.x,start.y);traceSegment(c,s,map);c.stroke();
        if(s.controls){
          const out=map(s.controls.c1),incoming=map(s.controls.c2);
          c.lineWidth=1;c.setLineDash([3,3]);c.beginPath();c.moveTo(start.x,start.y);c.lineTo(out.x,out.y);
          c.moveTo(end.x,end.y);c.lineTo(incoming.x,incoming.y);c.stroke();c.setLineDash([]);
          c.fillStyle=palette.accent;
          for(const h of [out,incoming]){c.beginPath();c.arc(h.x,h.y,4.5,0,2*Math.PI);c.fill();c.stroke();}
        }
      }
      c.fillStyle=palette.handle;
      for(const p of points){c.fillRect(p.x-3.5,p.y-3.5,7,7);c.strokeRect(p.x-3.5,p.y-3.5,7,7);}
      if(vector.insertAt){
        const p=worldToScreen(vector.insertAt,camera);
        c.fillStyle=palette.handle;c.strokeStyle=palette.accent;c.lineWidth=1.5;
        c.beginPath();c.arc(p.x,p.y,6,0,2*Math.PI);c.fill();c.stroke();
        c.beginPath();c.moveTo(p.x-3,p.y);c.lineTo(p.x+3,p.y);c.moveTo(p.x,p.y-3);c.lineTo(p.x,p.y+3);c.stroke();
      }
      if(vector.drawing&&points.length>=3){c.beginPath();c.arc(first.x,first.y,7,0,2*Math.PI);c.stroke();}
    }
    if(flow)paintFlowMarkers(c,flow,camera,r,palette,w,h);
    if(guides?.length){
      c.setTransform(r,0,0,r,0,0);drawSnapGuides(c,guides,camera,this.theme,w,h);
    }
    if(damage)c.restore();
    return marquee??selectionFrame;
  }
  // Both adjoining strokes end at the same device-pixel boundary. Two abutting
  // antialiased caps at a fractional column would leave a translucent seam.
  private joinX(x:number){
    return (Math.round(x*this.pixelsPerUnit+this.pixelOriginX)-this.pixelOriginX)/this.pixelsPerUnit;
  }
  private drawTopicBranch(item:Extract<Primitive,{kind:"path"}>){
    const c=this.ctx,[a,,,b]=item.points,{start,end}=item.junction!,width=item.width;
    const x1=start===undefined?a.x:this.joinX(a.x),x2=this.joinX(b.x),sign=Math.sign(x2-x1);
    const shoulder=Math.min(Math.abs(x2-x1)/4,Math.max(8,3*Math.max(start??width,end,width)));
    const xStart=start===undefined||start===width?x1:this.joinX(x1+sign*shoulder);
    const xEnd=end===width?x2:this.joinX(x2-sign*shoulder);
    const mid=(xStart+xEnd)/2;
    c.save();c.fillStyle=c.strokeStyle=item.color;c.lineWidth=width;c.lineCap="butt";
    c.beginPath();c.moveTo(xStart,a.y);c.bezierCurveTo(mid,a.y,mid,b.y,xEnd,b.y);c.stroke();
    // A custom underline can be thicker, thinner or hidden. Ease the width on
    // a short horizontal tangent, leaving the curved part at its full weight.
    function taper(from:number,to:number,y:number,w1:number,w2:number){
      if(from===to)return;
      const mid=(from+to)/2,h1=w1/2,h2=w2/2;
      c.beginPath();c.moveTo(from,y-h1);c.bezierCurveTo(mid,y-h1,mid,y-h2,to,y-h2);
      c.lineTo(to,y+h2);c.bezierCurveTo(mid,y+h2,mid,y+h1,from,y+h1);c.closePath();c.fill();
    }
    if(start!==undefined)taper(x1,xStart,a.y,start,width);
    taper(xEnd,x2,b.y,width,end);c.restore();
  }
  private drawItem(item:Primitive,bitmap?:(id:string)=>CanvasImageSource|undefined,backdrop?:string) {
    const c=this.ctx,palette=canvasThemes[this.theme];
    if(item.kind==="cardText"){
      const b=item.box,w=b.width,h=b.height;
      if(!b.label&&!this.cardPlaceholders)return;
      if(b.content.fontSize*2*this.detailScale<readableText)return;
      const layout=b.label?item.layout:cardDisplayLayout(b),ink=b.label?cardInk(b,this.theme,backdrop):cardPlaceholderInk(b,this.theme,backdrop);
      c.save();c.translate(b.at.x+w/2,b.at.y+h/2);c.rotate(b.rotation);c.translate(-w/2,-h/2);
      c.beginPath();c.rect(0,0,w,h);c.clip();c.fillStyle=ink;
      for(const band of layout.bands){
        c.save();c.globalAlpha*=band.kind==="code"?.07:.42;c.fillRect(band.x,band.y,band.width,band.height);c.restore();
      }
      c.textAlign="left";c.textBaseline="alphabetic";
      for(const run of layout.glyphs){
        if(run.size*this.detailScale<readableText)continue;
        c.font=run.font;c.fillText(run.text,run.x,run.baseline);
        const thickness=Math.max(1,run.size/16);
        if(run.link||run.underline)c.fillRect(run.x,run.baseline+thickness,run.width,thickness);
        if(run.strike)c.fillRect(run.x,run.baseline-run.size*.32,run.width,thickness);
      }
      c.restore();
    }else if(item.kind==="nodeLabel"){
      if(item.fontSize*this.detailScale<readableText)return;
      const ink=item.labelFill!==undefined?autoLabelInk("#212735",backdrop??labelSurface(item.labelFill,this.theme)):item.surfaceInk?this.surfaceInk:item.color;
      this.labels.draw(c,item,ink);
    } else if (item.kind==="text") {
      if(item.size*this.detailScale<readableText)return;
      c.font=nodeFont(item.size,item.weight); c.fillStyle=item.surfaceInk?this.surfaceInk:item.canvasInk&&this.ink(item.color).contrast<4.5?palette.ink:item.color; c.textAlign=item.align; c.textBaseline="middle";
      if (item.maxWidth && item.maxWidth>0) c.fillText(item.text,item.at.x,item.at.y,item.maxWidth);
      else c.fillText(item.text,item.at.x,item.at.y);
    } else if(item.kind==="tableGrid"){
      const {at,width,height}=item.box;
      c.save();c.fillStyle=palette.handle;c.fillRect(at.x,at.y,width,height);
      for(const {box,color} of item.backgrounds){c.fillStyle=color;c.fillRect(box.at.x,box.at.y,box.width,box.height);}
      c.strokeStyle=palette.placeholderBorder;c.lineWidth=1;c.lineCap="butt";c.beginPath();c.rect(at.x,at.y,width,height);
      let last=0;
      for(let i=1;i<item.rowEdges.length-1;i++){
        const edge=item.rowEdges[i];if(Math.min(edge-last,height-edge)*this.detailScale<2)continue;
        const y=at.y+edge;c.moveTo(at.x,y);c.lineTo(at.x+width,y);last=edge;
      }
      last=0;
      for(let i=1;i<item.columnEdges.length-1;i++){
        const edge=item.columnEdges[i];if(Math.min(edge-last,width-edge)*this.detailScale<2)continue;
        const x=at.x+edge;c.moveTo(x,at.y);c.lineTo(x,at.y+height);last=edge;
      }
      c.stroke();c.restore();
    } else if(item.kind==="ink"){
      // Reproduce current handwriting with the same positions and radii as the
      // live preview. At overview scales cache its exact immutable vector path.
      const overview=item.subpixel?undefined:this.inkOverview(item.points);
      // The midpoint radius differs by at most .3 backing pixels at this zoom.
      const width=overview&&(overview.maxRadius-overview.minRadius)*this.pixelsPerUnit<=.6?
        overview.minRadius+overview.maxRadius:undefined;
      this.drawInk(overview?.points??item.points,item.color,item.highlighter,item.subpixel,width,true);
    } else if(item.kind==="image"||item.kind==="textBlock"){
      const b=item.box,w=b.width,h=b.height;
      const detail=item.kind==="textBlock"&&item.fontSize*this.detailScale>=readableText;
      if(item.kind==="textBlock"&&!detail&&item.cell&&!item.background)return;
      c.save();c.translate(b.at.x+w/2,b.at.y+h/2);c.rotate(b.rotation);c.translate(-w/2,-h/2);
      if(item.kind==="image"){
        // Cast from the whole frame, clipping the caster out of the image interior.
        // Canvas shadow blur and offsets use backing pixels, independently of the world transform.
        if(item.shadow!==false&&Math.min(w,h)*this.detailScale>=smallImage){
          const pad=14*this.ratio/this.pixelsPerUnit;
          c.save();c.beginPath();c.rect(-pad,-pad,w+2*pad,h+2*pad);c.rect(0,0,w,h);c.clip("evenodd");
          c.shadowColor=palette.imageShadow;c.shadowBlur=6*this.ratio;c.shadowOffsetY=1.25*this.ratio;
          c.fillStyle=palette.bg;c.fillRect(0,0,w,h);c.restore();
        }
        const img=bitmap?.(item.assetId);
        if(img)c.drawImage(img,0,0,w,h);
        else {
          c.fillStyle=palette.placeholder;c.fillRect(0,0,w,h);c.strokeStyle=palette.placeholderBorder;c.lineWidth=1;c.strokeRect(0,0,w,h);
          if(w>34&&h>20&&12*this.detailScale>=readableText){c.font=standaloneFont(12);c.fillStyle=palette.placeholderInk;c.textAlign="center";c.textBaseline="middle";c.fillText("图片",w/2,h/2,w-10);}
        }
      }else{
        if(item.clip){c.beginPath();c.rect(0,0,w,h);c.clip();}
        if(item.background){c.fillStyle=item.background;c.fillRect(0,0,w,h);}
        if(!detail){
          if(!item.cell){
            c.fillStyle=standaloneInk(item,this.theme);c.globalAlpha*=.45;
            for(let i=0;i<Math.min(3,item.lines.length);i++){
              const line=item.lines[i];if(!line.trim())continue;
              const span=Math.min(w,line.length*item.fontSize*.62);
              const x=item.textAlign==="right"?w-span:item.textAlign==="center"?(w-span)/2:0;
              c.fillRect(x,(i*1.4+.5)*item.fontSize,span,item.fontSize*.42);
            }
          }
          c.restore();return;
        }
        const {fontSize,textAlign}=item, x=textAlign==="right"?w:textAlign==="center"?w/2:0;
        const font=standaloneFont(fontSize,item);
        c.font=font;c.fillStyle=standaloneInk(item,this.theme);c.textAlign=textAlign;c.textBaseline="alphabetic";
        const lineHeight=fontSize*1.4;
        let baseline=this.textBaselines.get(font);
        if(baseline===undefined){
          const metrics=c.measureText("国Mg"),ascent=metrics?.fontBoundingBoxAscent??fontSize*.8;
          const descent=metrics?.fontBoundingBoxDescent??fontSize*.2;
          baseline=(lineHeight-ascent-descent)/2+ascent;
          if(this.textBaselines.size>=128)this.textBaselines.clear();
          this.textBaselines.set(font,baseline);
        }
        for(let i=0;i<item.lines.length;i++){
          if(item.clip&&i*lineHeight>=h)break;
          const y=i*lineHeight+baseline;
          const row=item.lines[i];
          // Soft-wrapped textarea lines can have hanging spaces outside the
          // frame. Passing that advance as a constrained run compresses its ink.
          const line=row.endsWith(" ")&&(c.measureText(row)?.width??0)>w?row.replace(/ +$/u,""):row;
          if(w<fontSize&&plainTextWidth(line,fontSize,item)>w)c.fillText(line,x,y);
          else c.fillText(line,x,y,w);
          if(item.strike||item.underline){
            const length=Math.min(w,c.measureText(line).width);
            const left=textAlign==="left"?0:textAlign==="center"?(w-length)/2:w-length;
            const thick=Math.max(1,fontSize/16);
            if(item.strike)c.fillRect(left,y-fontSize*.32,length,thick);
            if(item.underline)c.fillRect(left,y+thick,length,thick);
          }
        }
      }
      c.restore();
    } else if (item.kind==="box") {
      const { box:b, shape:s }=item,w=b.width,h=b.height;
      const outline=item.strokeWidth??DEFAULT_SHAPE_STROKE;
      if(item.underline){
        if(outline===0)return;
        const x1=this.joinX(b.at.x),x2=this.joinX(b.at.x+w),y=b.at.y+h;
        c.save();c.strokeStyle=c.fillStyle=item.stroke;c.lineWidth=outline;c.lineCap="butt";
        c.beginPath();c.moveTo(x1,y);c.lineTo(x2,y);c.stroke();
        if(item.underline!=="joined"){
          const right=item.underline==="right",angle=right?-Math.PI/2:Math.PI/2;
          c.beginPath();c.arc(right?x2:x1,y,outline/2,angle,angle+Math.PI);c.closePath();c.fill();
        }
        c.restore();return;
      }
      c.save(); c.translate(b.at.x+w/2,b.at.y+h/2); c.rotate(b.rotation);c.translate(-w/2,-h/2);
      c.fillStyle=item.fill;c.strokeStyle=item.stroke;
      // Rounded stroke joins keep the visual bounds within a half-stroke of the shape path.
      if(item.strokeWidth!==undefined&&outline>0){c.lineWidth=outline;c.lineJoin="round";}
      else if(outline>0)c.lineWidth=outline;
      c.beginPath();
      traceShape(c,s,w,h,item.radius);
      if(item.fill!=="transparent")c.fill();
      if(outline>0){
        if(backdrop&&(contrastRatio(item.stroke,backdrop)??Infinity)<3){
          c.save();c.strokeStyle=contrastInk(backdrop);c.globalAlpha*=.3;
          c.lineWidth=outline+1.5*this.ratio/this.pixelsPerUnit;c.stroke();c.restore();
        }
        c.stroke();
      }
      c.restore();
    } else {
      if(item.junction){this.drawTopicBranch(item);return;}
      const p=item.arrows?.shaft??item.points;
      if(p.length<2)return;
      c.strokeStyle=item.color;
      if(item.arrow!==undefined&&this.theme==="dark")c.strokeStyle=this.ink(c.strokeStyle).connector;
      c.fillStyle=c.strokeStyle;c.lineWidth=item.width;c.lineCap=item.arrows?"butt":"round";c.lineJoin="round";c.beginPath();c.moveTo(p[0].x,p[0].y);
      if(item.segments)for(const segment of item.segments)traceSegment(c,segment);
      else if(item.curved && p.length===4) c.bezierCurveTo(p[1].x,p[1].y,p[2].x,p[2].y,p[3].x,p[3].y);
      else for(let i=1;i<p.length;i++)c.lineTo(p[i].x,p[i].y);
      if(item.closed){c.closePath();if(item.fill){c.fillStyle=item.fill;c.fill("evenodd");}}
      if(item.arrow===undefined&&this.theme==="dark"&&this.ink(item.color).contrast<2.4){
        c.strokeStyle=palette.halo;c.lineWidth=item.width+2;c.stroke();
        c.strokeStyle=item.color;c.lineWidth=item.width;
      }
      c.stroke();
      if(item.arrows)for(const [tip,left,right] of item.arrows.heads){
        c.beginPath();c.moveTo(tip.x,tip.y);c.lineTo(left.x,left.y);c.lineTo(right.x,right.y);c.closePath();c.fill();
      }
    }
  }
  private inkOverview(points:readonly InkPoint[]):OverviewInk|undefined{
    const step=this.inkStep;
    if(!step||points.length<3)return;
    const cached=this.overviewInk.get(points);
    const match=cached?.find(entry=>entry.step===step);if(match)return match;
    let last=points[0];
    let min=last.radius,max=min;
    const reduced=[last],stepSquared=step*step;
    for(let i=1;i<points.length;i++){
      const p=points[i],dx=p.x-last.x,dy=p.y-last.y;
      min=Math.min(min,p.radius);max=Math.max(max,p.radius);
      if(i===points.length-1||dx*dx+dy*dy>=stepSquared||Math.abs(p.radius-last.radius)>=step/2){
        reduced.push(p);last=p;
      }
    }
    const result={step,points:reduced,minRadius:min,maxRadius:max};
    this.overviewInk.set(points,cached?[result,cached[0]]:[result]);
    return result;
  }
  private drawInk(points:readonly InkPoint[],color:string,highlighter=false,subpixel=false,centerlineWidth?:number,committed=false){
    const c=this.ctx;
    const first=points[0];
    if(!first)return;
    // Pass viewport-local coordinates to the rasterizer. At large world
    // offsets a float32 path can otherwise lose several pixels at high zoom.
    const scale=this.pixelsPerUnit;
    const ox=subpixel?Math.round(-this.pixelOriginX/scale):0,oy=subpixel?Math.round(-this.pixelOriginY/scale):0;
    if(subpixel){
      c.save();c.setTransform(scale,0,0,scale,ox*scale+this.pixelOriginX,oy*scale+this.pixelOriginY);
    }
    const retain=committed&&subpixel&&this.inkStep>0&&typeof Path2D!=="undefined";
    let cached=retain?this.inkPaths.get(points):undefined;
    if(cached&&(cached.ox!==ox||cached.oy!==oy))cached=undefined;
    let width=cached?.width;
    if(!cached&&(centerlineWidth!==undefined||subpixel&&points.length>1&&points.every(p=>p.radius===first.radius))&&
      points.some(p=>p.x!==first.x||p.y!==first.y))width=centerlineWidth??first.radius*2;
    if(retain&&!cached){
      const body=new Path2D();traceInk(body,points,ox,oy,width);
      cached={ox,oy,width,body};this.inkPaths.set(points,cached);
    }
    if(width!==undefined){c.lineJoin="round";c.lineCap="round";c.setLineDash([]);}
    const paint=(drawColor:string,pad=0)=>{
      if(width!==undefined){c.strokeStyle=drawColor;c.lineWidth=width+pad*2;}
      else c.fillStyle=drawColor;
      let path=cached?.body;
      if(cached&&pad&&width===undefined){
        if(!cached.halo){cached.halo=new Path2D();traceInk(cached.halo,points,ox,oy,width,pad);}
        path=cached.halo;
      }
      if(!path){c.beginPath();traceInk(c,points,ox,oy,width,pad);}
      if(width!==undefined){
        if(path)c.stroke(path);else c.stroke();
      }else{
        if(path)c.fill(path);else c.fill();
      }
    };
    if(!highlighter&&this.theme==="dark"&&this.ink(color).contrast<2.4)paint(canvasThemes[this.theme].halo,1);
    paint(highlighter?color+"66":color);
    if(subpixel)c.restore();
  }
}
