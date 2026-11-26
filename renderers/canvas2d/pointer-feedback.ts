import {boxBounds,worldToScreen,type Camera,type Point,type Rect} from "../../core/geometry.ts";
import type {FlowDecor} from "../../features/flow-input.ts";
import {canvasThemes,type WorkspaceTheme} from "../../platform/theme.ts";
import {mergeBounds,outlineRadius,type DrawGroup,type SceneHit,type ScenePick} from "../../scene/board.ts";
import {paintFlowDraft,paintFlowMarkers} from "./flow-decor.ts";
import {traceShape} from "./shape-outline.ts";

type Part=Pick<DrawGroup,"bounds"|"picks">;
export type HoverOutline={owner:object;topic?:string;visibility:number;parts:()=>readonly Part[]};

export function hitOutline(hit:SceneHit):Part{
  if(!hit.topicId||!("box" in hit.target))return hit.group;
  const local=hit.target.box,origin=hit.origin;
  const box=origin?{...local,at:{x:local.at.x+origin.x,y:local.at.y+origin.y}}:local;
  return {picks:[{...hit.target,box,radius:outlineRadius(local)}],bounds:boxBounds(box)};
}
const samePoint=(a:Point,b:Point)=>a.x===b.x&&a.y===b.y;
function sameFlow(a?:FlowDecor,b?:FlowDecor){
  if(a===b)return true;
  const points=a?.draft??[],other=b?.draft??[],marks=a?.markers??[],rest=b?.markers??[];
  return a?.arrow===b?.arrow&&points.length===other.length&&marks.length===rest.length&&
    points.every((p,i)=>samePoint(p,other[i]))&&marks.every((m,i)=>m.kind===rest[i].kind&&m.active===rest[i].active&&
      m.selected===rest[i].selected&&samePoint(m.point,rest[i].point));
}

function tracePick(c:CanvasRenderingContext2D,pick:ScenePick,camera:Camera){
  const screen=(p:Point)=>worldToScreen(p,camera),z=camera.zoom;
  if("box" in pick){
    const b=pick.box,w=b.width*z,h=b.height*z,center=screen({x:b.at.x+b.width/2,y:b.at.y+b.height/2});
    c.save();c.translate(center.x,center.y);c.rotate(b.rotation);c.translate(-w/2,-h/2);
    traceShape(c,pick.shape,w,h,(pick.radius??outlineRadius(b))*z);c.restore();return;
  }
  if("segments" in pick){
    const first=pick.segments[0];if(!first)return;
    const start=screen(first.from);c.moveTo(start.x,start.y);
    for(const segment of pick.segments){
      const end=screen(segment.to);
      if(segment.controls){
        const a=screen(segment.controls.c1),b=screen(segment.controls.c2);c.bezierCurveTo(a.x,a.y,b.x,b.y,end.x,end.y);
      }else c.lineTo(end.x,end.y);
    }
    return;
  }
  const points="ink" in pick?pick.ink:pick.points;
  if(!points.length)return;
  const start=screen(points[0]);
  if("ink" in pick&&points.length===1){
    const radius=Math.max(1.5,pick.ink[0].radius*z);
    c.moveTo(start.x+radius,start.y);c.arc(start.x,start.y,radius,0,2*Math.PI);return;
  }
  c.moveTo(start.x,start.y);
  for(let i=1;i<points.length;i++){const p=screen(points[i]);c.lineTo(p.x,p.y);}
}

/** Editor-only layer. Repeated hits on the same contour perform no canvas work. */
export class PointerFeedback{
  private canvas:HTMLCanvasElement;
  private ctx?:CanvasRenderingContext2D;
  private previous?:HoverOutline;
  private flow?:FlowDecor;
  private camera?:Camera;
  private theme?:WorkspaceTheme;
  private ratio=0;
  private damage?:Rect;
  constructor(canvas:HTMLCanvasElement){this.canvas=canvas;}
  draw(target:HoverOutline|undefined,flow:FlowDecor|undefined,camera:Camera,theme:WorkspaceTheme,w:number,h:number,r:number){
    if(!target&&!flow?.markers.length&&!flow?.draft?.length&&!this.damage)return false;
    const width=Math.max(1,Math.round(w*r)),height=Math.max(1,Math.round(h*r));
    const resized=this.canvas.width!==width||this.canvas.height!==height;
    if(!resized&&this.ratio===r&&this.camera===camera&&this.theme===theme&&this.previous?.owner===target?.owner&&
      this.previous?.topic===target?.topic&&this.previous?.visibility===target?.visibility&&sameFlow(this.flow,flow))return false;
    const c=this.ctx??=this.canvas.getContext("2d")!;
    if(resized){this.canvas.width=width;this.canvas.height=height;}
    c.setTransform(r,0,0,r,0,0);
    if(!resized&&this.damage){
      const {min,max}=this.damage;c.clearRect(min.x,min.y,max.x-min.x,max.y-min.y);
    }
    this.previous=target;this.flow=flow;this.camera=camera;this.theme=theme;this.ratio=r;
    let damage:Rect|undefined;
    const palette=canvasThemes[theme];
    if(target){
      c.beginPath();
      for(const part of target.parts()){
        const min=worldToScreen(part.bounds.min,camera),max=worldToScreen(part.bounds.max,camera);
        if(min.x>w+4||min.y>h+4||max.x< -4||max.y< -4)continue;
        damage=mergeBounds(damage,{min,max});
        for(const pick of part.picks)tracePick(c,pick,camera);
      }
      c.setLineDash([]);c.lineJoin=c.lineCap="round";
      c.globalAlpha=.85;c.strokeStyle=palette.bg;c.lineWidth=4;c.stroke();
      c.globalAlpha=1;c.strokeStyle=palette.hover;c.lineWidth=2;c.stroke();
    }
    if(flow){
      paintFlowDraft(c,flow,camera,r,palette);paintFlowMarkers(c,flow,camera,r,palette,w,h);
      const include=(point:Point)=>{const p=worldToScreen(point,camera);damage=mergeBounds(damage,{min:p,max:p});};
      for(const p of flow.draft??[])include(p);
      for(const m of flow.markers)include(m.point);
    }
    this.damage=damage?{min:{x:Math.max(0,Math.floor(damage.min.x-16)),y:Math.max(0,Math.floor(damage.min.y-16))},
      max:{x:Math.min(w,Math.ceil(damage.max.x+16)),y:Math.min(h,Math.ceil(damage.max.y+16))}}:undefined;
    return true;
  }
}
