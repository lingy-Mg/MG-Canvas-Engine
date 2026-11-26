import type { Point, Rect } from "../core/geometry.ts";
import { gridPoint, roundWorld } from "../core/geometry.ts";
import {noteNib} from "./note-nib.ts";
import {InkCenterline} from "./ink-centerline.ts";

export const INK_BRUSH_VERSION = 1;
export const HIGHLIGHTER_BRUSH_VERSION = 2;
export const NOTE_BRUSH_VERSION = 3;
export type InkBrushVersion = typeof INK_BRUSH_VERSION | typeof HIGHLIGHTER_BRUSH_VERSION | typeof NOTE_BRUSH_VERSION;
export const MAX_INK_SAMPLES = 16_384;
export const MIN_INK_WIDTH = 0.25;
export const MAX_INK_WIDTH = 128;
export const MAX_INK_COORDINATE = 1_000_000_000;
export const FIXED_INK_PRESSURE = 0.5;
export type InkDevice = "pen" | "mouse" | "touch";
export type InkSample = readonly [dx: number, dy: number, pressure: number];
export type InkBrush = Readonly<{ color:string; baseWidth:number; brushVersion?:InkBrushVersion }>;
/** The object anchor is editable on the world grid. A subpixel stroke keeps
 * the actual first contact (within half a unit of that anchor) and every
 * subsequent position in world units relative to it. */
export type InkGeometry = InkBrush & Readonly<{
  at:Point; brushVersion:InkBrushVersion; samples:readonly InkSample[]; subpixel?:true;
}>;
export type InkPoint = Point & Readonly<{ radius:number }>;
export type InkQuad = readonly [Point, Point, Point, Point];

/** Bring imported coordinates onto the document's world grid. */
export function gridInk<T extends InkGeometry>(stroke:T):T {
  if(stroke.subpixel){
    const [x,y]=stroke.samples[0],at=gridPoint({x:stroke.at.x+x,y:stroke.at.y+y});
    const samples=stroke.samples.map(([dx,dy,p]):InkSample=>Object.freeze([dx+(stroke.at.x-at.x),dy+(stroke.at.y-at.y),p]));
    return {...stroke,at:Object.freeze(at),samples:Object.freeze(samples)};
  }
  const at=Object.freeze(gridPoint(stroke.at));
  const samples=stroke.samples.map(([x,y,p]):InkSample=>Object.freeze([
    roundWorld(stroke.at.x+x)-at.x,roundWorld(stroke.at.y+y)-at.y,p,
  ]));
  return {...stroke,at,samples:Object.freeze(samples)};
}

const finitePoint=(point:Point)=>Number.isFinite(point.x)&&Number.isFinite(point.y)&&
  Math.abs(point.x)<=MAX_INK_COORDINATE&&Math.abs(point.y)<=MAX_INK_COORDINATE;
const clamp01=(value:number)=>Math.max(0,Math.min(1,value));

export function normalizeInkPressure(device:InkDevice,observed:number|undefined,fallback=FIXED_INK_PRESSURE):number {
  if(device==="mouse")return FIXED_INK_PRESSURE;
  return Number.isFinite(observed)?clamp01(observed!):Number.isFinite(fallback)?clamp01(fallback):FIXED_INK_PRESSURE;
}
export function inkRadius(baseWidth:number,pressure:number):number {
  // At p=0.5 thickness is exactly baseWidth. Keep a visible floor for the pen.
  return baseWidth*(0.2+1.6*clamp01(pressure))/2;
}
export function validInkBrush(brush:InkBrush):boolean {
  return (brush.brushVersion===undefined||brush.brushVersion===INK_BRUSH_VERSION||brush.brushVersion===HIGHLIGHTER_BRUSH_VERSION||brush.brushVersion===NOTE_BRUSH_VERSION)&&
    typeof brush.color==="string"&&/^#[0-9a-f]{6}$/i.test(brush.color)&&Number.isFinite(brush.baseWidth)&&brush.baseWidth>=MIN_INK_WIDTH&&brush.baseWidth<=MAX_INK_WIDTH;
}
export function validInkGeometry(value:unknown):value is InkGeometry {
  if(!value||typeof value!=="object")return false;
  const v=value as Partial<InkGeometry>;
  if(v.brushVersion===undefined||!v.at||!finitePoint(v.at)||!validInkBrush(v as InkBrush)||
    (v.subpixel!==undefined&&(v.subpixel!==true||v.brushVersion===NOTE_BRUSH_VERSION))||
    !Array.isArray(v.samples)||v.samples.length<1||v.samples.length>MAX_INK_SAMPLES)return false;
  let first=true;
  for(const s of v.samples){
    if(!Array.isArray(s)||s.length!==3||!s.every(Number.isFinite)||
      !finitePoint({x:s[0]+v.at.x,y:s[1]+v.at.y})||s[2]<0||s[2]>1||
      // Sparse arrays normally cannot enter JSON, but reject them for live validation too.
      !Object.hasOwn(s,0)||!Object.hasOwn(s,1)||!Object.hasOwn(s,2))return false;
    if(first&&(v.subpixel?(Math.abs(s[0])>.5||Math.abs(s[1])>.5):(s[0]!==0||s[1]!==0)))return false;
    first=false;
  }
  return true;
}

export const MIN_INK_SCALE=.01, MAX_INK_SCALE=100;
/** Bakes a relative transform around the first sample. No new serialized fields.
 * The radius and local centerline scale together; captured pressures are untouched. */
export function transformCompletedInk<T extends InkGeometry>(stroke:T,brush:InkBrush,degrees=0,scale=1,origin:Point=stroke.at):T|undefined{
  if(!finitePoint(origin)||!validInkBrush(brush)||!Number.isFinite(degrees)||!Number.isFinite(scale)||scale<MIN_INK_SCALE||scale>MAX_INK_SCALE)return;
  origin=gridPoint(origin);
  const rotation=degrees%360;
  const baseWidth=brush.baseWidth*scale,color=brush.color.toLowerCase();
  const finalBrush={baseWidth,color:color===stroke.color.toLowerCase()?stroke.color:color};
  if(!validInkBrush(finalBrush))return;
  const moved=origin.x!==stroke.at.x||origin.y!==stroke.at.y;
  const at=moved?{x:origin.x,y:origin.y}:stroke.at;
  if(rotation===0&&scale===1){
    if(!moved&&finalBrush.color===stroke.color&&baseWidth===stroke.baseWidth)return stroke;
    const next={...stroke,...finalBrush,at};
    if(moved&&!validInkGeometry(next))return;
    return next;
  }
  const radians=rotation*Math.PI/180;
  const cosine=Math.abs(rotation)%180===90?0:Math.cos(radians);
  const sine=rotation%180===0?0:Math.sin(radians);
  const [firstX,firstY]=stroke.samples[0];
  const samples=stroke.samples.map(([x,y,pressure]):InkSample=>{
    const dx=x-firstX,dy=y-firstY;
    const nx=firstX+(dx*cosine-dy*sine)*scale,ny=firstY+(dx*sine+dy*cosine)*scale;
    return stroke.subpixel?[nx,ny,pressure]:[roundWorld(nx),roundWorld(ny),pressure];
  });
  const next={...stroke,...finalBrush,at,samples};
  return validInkGeometry(next)?next:undefined;
}

export type InkAppend = "added" | "ignored" | "overflow";

function sameSample(sample:InkSample,x:number,y:number,pressure:number):boolean {
  return sample[0]===x&&sample[1]===y&&sample[2]===pressure;
}

/** Provisional builder. Only finish() is safe to publish to document history. */
export class InkAccumulator {
  private readonly points:InkSample[]=[];
  private readonly origin:Point;
  private readonly brush:Required<InkBrush>;
  private readonly device:InkDevice;
  private readonly capacity:number;
  private readonly centerline:InkCenterline;
  // Until a distinctive contact reading arrives, 0.5 could be either the
  // browser default or real pressure. Retain the prefix for that one decision.
  private pendingReadings?:number[];
  private pendingCoincidentChange=false;
  private overflowed=false;
  constructor(device:InkDevice,at:Point,brush:InkBrush,pressure?:number,capacity=MAX_INK_SAMPLES,
    capture:{zoom?:number;timeStamp?:number;reportedPressure?:boolean}={}){
    const zoom=capture.zoom??1;
    if(!finitePoint(at)||!validInkBrush(brush)||!Number.isSafeInteger(capacity)||capacity<1||capacity>MAX_INK_SAMPLES||!Number.isFinite(zoom)||zoom<=0)
      throw new RangeError("invalid ink brush, origin, capacity or zoom");
    this.device=device;this.capacity=capacity;
    if(device!=="mouse"&&!capture.reportedPressure)this.pendingReadings=[];
    this.origin=Object.freeze(gridPoint(at));
    this.centerline=new InkCenterline(zoom,{
      min:{x:-MAX_INK_COORDINATE-this.origin.x,y:-MAX_INK_COORDINATE-this.origin.y},
      max:{x:MAX_INK_COORDINATE-this.origin.x,y:MAX_INK_COORDINATE-this.origin.y},
    });
    // Version 3 is only a playback format for strokes saved with a simulated nib.
    const brushVersion=brush.brushVersion===HIGHLIGHTER_BRUSH_VERSION?HIGHLIGHTER_BRUSH_VERSION:INK_BRUSH_VERSION;
    this.brush=Object.freeze({color:brush.color,baseWidth:brush.baseWidth,brushVersion});
    this.append(at,pressure);
  }
  /** Borrowed read-only view for RAF; rendering must not retain as committed data. */
  get draft():InkGeometry {
    return {...this.brush,at:this.origin,samples:this.points,subpixel:true};
  }
  get hasReportedPressure():boolean {return this.device!=="mouse"&&!this.pendingReadings;}
  private useReportedPressure(readings:readonly number[]):void {
    for(let i=0;i<readings.length;i++){
      const [x,y,p]=this.points[i];
      if(p!==readings[i])this.points[i]=Object.freeze([x,y,readings[i]]);
    }
    this.pendingReadings=undefined;
  }
  append(at:Point,pressure?:number,_timeStamp?:number):InkAppend {
    if(this.overflowed)return "overflow";
    if(!finitePoint(at))return "ignored";
    const {x,y}=at;
    const observed=typeof pressure==="number"&&pressure>=0&&pressure<=1?pressure:undefined;
    if(this.pendingReadings && observed!==undefined && observed>0 && observed!==FIXED_INK_PRESSURE)
      this.useReportedPressure(this.pendingReadings);
    const last=this.points.at(-1);
    const reported=normalizeInkPressure(this.device,observed,this.pendingReadings?.at(-1)??last?.[2]);
    const p=this.pendingReadings?FIXED_INK_PRESSURE:reported;
    const dx=x-this.origin.x,dy=y-this.origin.y;
    if(last&&sameSample(last,dx,dy,p)){
      if(!this.pendingReadings||this.pendingReadings.at(-1)===reported){
        return "ignored";
      }
      // A stationary 0 -> 0.5 transition may turn out to be genuine pressure.
      this.pendingCoincidentChange=true;
    }
    const next:InkSample=Object.freeze([dx,dy,p]);
    if(this.points.length>=this.capacity){this.overflowed=true;return "overflow";}
    this.pendingReadings?.push(reported);
    this.points.push(next);
    this.centerline.append(this.points,this.pendingReadings,!this.hasReportedPressure);
    return "added";
  }
  /** Release pressure (defined as zero) is not a contact pressure sample. */
  finish(at:Point,_timeStamp?:number):InkGeometry|undefined {
    if(this.append(at)==="overflow")return;
    const samples=this.pendingReadings&&this.pendingCoincidentChange
      ?this.points.filter(([x,y,p],i)=>i===0||!sameSample(this.points[i-1],x,y,p))
      :this.points.slice();
    return Object.freeze({...this.draft,samples:Object.freeze(samples)});
  }
}
export function inkPoints(stroke:InkGeometry):readonly InkPoint[] {
  const marker=stroke.brushVersion===HIGHLIGHTER_BRUSH_VERSION;
  const points=stroke.samples.map(([x,y,p])=>({x:x+stroke.at.x,y:y+stroke.at.y,
    radius:marker?stroke.baseWidth*(0.8+0.4*p)/2:inkRadius(stroke.baseWidth,p)}));
  return stroke.brushVersion===NOTE_BRUSH_VERSION&&points.length?noteNib(points,stroke.baseWidth,stroke.samples[stroke.samples.length-1][2]):points;
}
export function inkBounds(points:readonly InkPoint[]):Rect|undefined {
  if(!points.length)return;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const {x,y,radius} of points){
    minX=Math.min(minX,x-radius);minY=Math.min(minY,y-radius);
    maxX=Math.max(maxX,x+radius);maxY=Math.max(maxY,y+radius);
  }
  return {min:{x:minX,y:minY},max:{x:maxX,y:maxY}};
}
/** Hull sides between endpoint disks for a linearly tapered segment. */
export function inkSegmentHull(a:InkPoint,b:InkPoint):InkQuad|undefined {
  const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy),dr=b.radius-a.radius;
  if(!Number.isFinite(length)||length<=Math.abs(dr))return; // one endpoint disk contains the other
  const ux=dx/length,uy=dy/length,along=-dr/length,across=Math.sqrt(Math.max(0,1-along*along));
  const p={x:along*ux-across*uy,y:along*uy+across*ux},q={x:along*ux+across*uy,y:along*uy-across*ux};
  const offset=(center:InkPoint,n:Point)=>({x:center.x+center.radius*n.x,y:center.y+center.radius*n.y});
  return [offset(a,p),offset(a,q),offset(b,q),offset(b,p)];
}
/** Exact hit test against the continuous linear-radius sweep (or one dot). */
export function hitInk(points:readonly InkPoint[],at:Point,tolerance=0):boolean {
  for(let i=0;i<points.length;i++){
    const a=points[i],r=a.radius+Math.max(0,tolerance),x=at.x-a.x,y=at.y-a.y;
    if(Math.hypot(x,y)<=r)return true;
    const b=points[i+1];if(!b)continue;
    const dx=b.x-a.x,dy=b.y-a.y,dr=b.radius-a.radius,den=dx*dx+dy*dy-dr*dr;
    if(!(den>0))continue; // nested disks or degenerate; endpoints suffice
    const t=(x*dx+y*dy+r*dr)/den;
    if(t>0&&t<1&&Math.hypot(x-dx*t,y-dy*t)<=r+dr*t)return true;
  }
  return false;
}

/** A circular eraser swept between two actual contacts. In the interior of
 * its projected span, distance to the spine minus the varying ink radius
 * is piecewise linear, with possible minima at samples or spine crossings. */
export function eraserHitsInk(points:readonly InkPoint[],from:Point,to:Point,radius:number):boolean {
  if(hitInk(points,from,radius))return true;
  const dx=to.x-from.x,dy=to.y-from.y,length=Math.hypot(dx,dy);
  if(!length)return false;
  if(hitInk(points,to,radius))return true;
  const ux=dx/length,uy=dy/length;
  let previousAlong=0,previousSide=0;
  for(let i=0;i<points.length;i++){
    const p=points[i],x=p.x-from.x,y=p.y-from.y;
    const along=x*ux+y*uy,side=y*ux-x*uy;
    if(along>=0&&along<=length&&Math.abs(side)<=radius+p.radius)return true;
    if(i>0 && previousSide*side<0){
      const crossing=previousAlong+(along-previousAlong)*previousSide/(previousSide-side);
      if(crossing>=0&&crossing<=length)return true;
    }
    previousAlong=along;previousSide=side;
  }
  return false;
}
