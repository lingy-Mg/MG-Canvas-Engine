import { screenToWorld } from "../core/geometry.ts";
import type { Camera,Point } from "../core/geometry.ts";
import { InkAccumulator,MAX_INK_SAMPLES } from "./ink.ts";
import type { InkBrush,InkDevice,InkGeometry } from "./ink.ts";

export type InkPointer = Readonly<{
  id:number; device:InkDevice;
  /** Canvas-local CSS coordinates, never device pixels. */
  at:Point; pressure?:number;
  /** Monotonic sample time in milliseconds when supplied by the input device. */
  timeStamp?:number;
  /** Primary contact or an explicitly routed hardware eraser. */
  primaryTip?:boolean;
}>;
export type InkMotion = Pick<InkPointer,"at"|"pressure"|"timeStamp">;
type CancelReason = "interrupted"|"contact-cancelled"|"pinch"|"pen-priority"|"sample-limit";
export type InkAction =
  | Readonly<{kind:"stroke-start"|"stroke-update"}>
  | Readonly<{kind:"stroke-commit";stroke:InkGeometry;preceding?:readonly InkGeometry[]}>
  | Readonly<{kind:"pan-start"|"pan-end"}>
  | Readonly<{kind:"pan";delta:Point}>
  | Readonly<{kind:"stroke-cancel";reason:CancelReason}>
  | Readonly<{kind:"erase-sweep";points:readonly Point[];radius:number}>
  | Readonly<{kind:"erase-commit"}>
  | Readonly<{kind:"nav-reset"}>
  | Readonly<{kind:"nav";phase:"down"|"move"|"up"|"cancel";pointer:InkPointer}>;

type InkOptions={brush:InkBrush;camera:Camera;fingerInk:boolean;eraserDiameterCss?:number};
type MotionSource="raw"|"move";
type MotionTick={time:number;seen:InkMotion[];raw:number;move:number};
type Owner={pointer:InkPointer;camera:Camera}&(
  {path:InkAccumulator;radius?:undefined;tick?:MotionTick}|{path?:undefined;radius:number}
);
const sanePoint=(p:Point)=>Number.isFinite(p.x)&&Number.isFinite(p.y);
const copyPoint=(p:Point):Point=>({x:p.x,y:p.y});
const copyPointer=(p:InkPointer):InkPointer=>({...p,at:copyPoint(p.at)});
const nav=(phase:"down"|"move"|"up"|"cancel",pointer:InkPointer):InkAction=>({kind:"nav",phase,pointer:copyPointer(pointer)});

// Raw and coalesced packets can share a timestamp with a new position or
// pressure. Match ordered readings within that clock tick, including returns
// to the same position, before discarding the overlap between the streams.
function freshMotion(owner:{pointer:InkPointer;tick?:MotionTick},sample:InkMotion,source:MotionSource):boolean {
  const time=sample.timeStamp;
  if(time===undefined||!Number.isFinite(time))return source==="move";
  if(time<(owner.pointer.timeStamp??-Infinity))return false;
  const tick=owner.tick??={time,seen:[],raw:0,move:0};
  if(time<tick.time)return false;
  if(time>tick.time){tick.time=time;tick.seen.length=0;tick.raw=tick.move=0;}
  const same=(s:InkMotion)=>s.at.x===sample.at.x&&s.at.y===sample.at.y&&Object.is(s.pressure,sample.pressure);
  for(let i=tick[source];i<tick.seen.length;i++){
    if(same(tick.seen[i])){tick[source]=i+1;return false;}
  }
  const last=tick.seen.at(-1);
  if(last&&same(last))return false;
  tick.seen.push({at:copyPoint(sample.at),pressure:sample.pressure});
  tick[source]=tick.seen.length;
  return true;
}

/**
 * DOM-free arbiter for the Ink tool. The caller owns pointer capture and routes
 * the returned navigation actions to EditorSession. Never send a pointer to
 * both routers before ownership is decided.
 */
export class InkInput {
  private owner?:Owner;
  private pan?:{id:number;at:Point;writer?:InkPointer};
  private parts:InkGeometry[]=[];
  private readonly navigation=new Map<number,InkPointer>();
  private readonly ignored=new Map<number,InkDevice>();
  private readonly maxSamples:number;
  constructor(maxSamples=MAX_INK_SAMPLES){this.maxSamples=maxSamples;}
  get draft():InkGeometry|undefined {return this.owner?.path?.draft;}
  get preview():InkGeometry|readonly InkGeometry[]|undefined {
    const tip=this.draft;return this.parts.length&&tip?[...this.parts,tip]:tip;
  }
  get panning():boolean {return Boolean(this.pan);}
  get erasing():boolean {return this.owner?.radius!==undefined;}
  get ownerId():number|undefined {return this.owner?.pointer.id;}
  get drawing():boolean {return Boolean(this.owner||this.pan);}
  owns(id:number):boolean {
    return this.ownerId===id||this.pan?.id===id||this.navigation.has(id)||this.ignored.has(id);
  }
  beginPan(mouse:InkPointer):readonly InkAction[] {
    if(this.pan||this.ignored.has(mouse.id)||mouse.device!=="mouse"||!sanePoint(mouse.at))return [];
    const writer=this.owner?.pointer,stroke=this.owner?.path?.draft;
    this.pan={id:mouse.id,at:mouse.at,writer:writer&&stroke?{...writer,pressure:stroke.samples.at(-1)?.[2]}:writer};
    return this.navigation.size?[this.resetNavigation(true),{kind:"pan-start"}]:[{kind:"pan-start"}];
  }
  panTo(mouse:InkPointer):readonly InkAction[] {
    const pan=this.pan;
    if(pan?.id!==mouse.id||!sanePoint(mouse.at))return [];
    if(pan.writer?.id===mouse.id&&!mouse.primaryTip)pan.writer=undefined;
    const delta={x:mouse.at.x-pan.at.x,y:mouse.at.y-pan.at.y};pan.at=mouse.at;
    return delta.x||delta.y?[{kind:"pan",delta}]:[];
  }
  /** Called after the last pan delta has been applied to the camera. Keep
   * completed pieces provisional until the writing contact actually ends. */
  endPan(mouse:InkPointer,options:InkOptions):readonly InkAction[] {
    const pan=this.pan;
    if(pan?.id!==mouse.id)return [];
    this.pan=undefined;
    const actions:InkAction[]=[{kind:"pan-end"}],owner=this.owner;
    let writer=pan.writer;
    if(!owner||owner.pointer.id===mouse.id)writer=mouse.primaryTip?mouse:undefined;
    if(!writer)return owner?[...actions,...this.up(owner.pointer.id)]:actions;
    const resume={...writer,timeStamp:mouse.timeStamp??writer.timeStamp};
    if(!owner)return [...actions,...this.down(resume,options)];
    const pausedAt=screenToWorld(owner.pointer.at,owner.camera),resumedAt=screenToWorld(resume.at,options.camera);
    if(owner.path&&pan.writer&&Math.hypot(resumedAt.x-pausedAt.x,resumedAt.y-pausedAt.y)*options.camera.zoom<1e-6){
      // The page travelled with the mouse. Resume the same path at the same
      // spot so a translucent marker does not paint a second overlapping cap.
      owner.camera={zoom:options.camera.zoom,offset:copyPoint(options.camera.offset)};
      owner.pointer=resume;owner.tick=undefined;
      if(owner.path.append(resumedAt,resume.pressure)==="overflow")actions.push(this.abandon("sample-limit",true));
      return actions;
    }
    const piece=owner.path?.finish(pausedAt);
    const remaining=this.maxSamples-(piece?.samples.length??0)-this.parts.reduce((n,s)=>n+s.samples.length,0);
    if(owner.path&&(!piece||remaining<1))return [...actions,this.abandon("sample-limit",true)];
    const next=this.prepare(resume,{...options,brush:owner.path?.draft??options.brush,
      eraserDiameterCss:owner.radius===undefined?undefined:owner.radius*2*owner.camera.zoom},owner.path?.hasReportedPressure,remaining);
    if(!next)return [...actions,...this.up(owner.pointer.id)];
    if(piece)this.parts.push(piece);
    this.owner=next;
    if(next.radius!==undefined)actions.push({kind:"erase-sweep",points:[screenToWorld(resume.at,next.camera)],radius:next.radius});
    return actions;
  }
  down(pointer:InkPointer,options:InkOptions):readonly InkAction[] {
    if(this.owns(pointer.id)||!sanePoint(pointer.at)||
      (pointer.device!=="touch"&&pointer.primaryTip!==true))return [];
    if(this.pan){this.ignored.set(pointer.id,pointer.device);return [];}
    if(pointer.device==="pen"){
      if(this.owner?.pointer.device==="pen"){this.ignored.set(pointer.id,"pen");return [];}
      // A tip press preempts an in-flight finger stroke or camera gesture.
      const start=this.prepare(pointer,options);
      if(!start)return [];
      const actions:InkAction[]=[];
      if(this.owner)actions.push(this.abandon("pen-priority",true));
      if(this.navigation.size)actions.push(this.resetNavigation(true));
      this.owner=start;
      return [...actions,...this.startActions(start)];
    }
    const active=this.owner;
    if(pointer.device==="touch"){
      if(active?.pointer.device==="touch"){
        // Hand off both contacts. Replaying the first at its latest position
        // avoids panning by the distance it already travelled as a draft.
        const first=active.pointer, action=this.abandon("pinch",false);
        this.navigation.set(first.id,first);this.navigation.set(pointer.id,copyPointer(pointer));
        return [action,nav("down",first),nav("down",pointer)];
      }
      // App-level mitigation only. Hold suspected palm IDs through release;
      // do not let a held palm become a camera gesture after a pen lifts.
      if(active||Array.from(this.ignored.values()).includes("touch")){
        this.ignored.set(pointer.id,"touch");return [];
      }
      if(this.navigation.size||!options.fingerInk){
        this.navigation.set(pointer.id,copyPointer(pointer));return [nav("down",pointer)];
      }
    }else if(active||this.navigation.size){
      this.ignored.set(pointer.id,pointer.device);return [];
    }
    this.owner=this.prepare(pointer,options);
    return this.owner?this.startActions(this.owner):[];
  }
  private startActions(owner:Owner):InkAction[]{
    const actions:InkAction[]=[{kind:"stroke-start"}];
    if(owner.radius!==undefined)actions.push({kind:"erase-sweep",points:[screenToWorld(owner.pointer.at,owner.camera)],radius:owner.radius});
    return actions;
  }
  /** Adapter passes the coalesced batch OR the parent sample, never both. */
  move(id:number,samples:readonly InkMotion[],source:"move"|"raw"="move"):readonly InkAction[] {
    const active=this.owner;
    if(this.pan){
      const writer=this.pan.writer,last=samples.at(-1);
      if(writer?.id===id&&last&&sanePoint(last.at)&&(last.timeStamp??Infinity)>=(writer.timeStamp??-Infinity)){
        const p=last.pressure;
        this.pan.writer={...writer,...last,pressure:p!==undefined&&p>=0&&p<=1?p:writer.pressure};
      }
      return [];
    }
    if(source==="raw"&&(!active?.path||active.pointer.id!==id))return [];
    if(active?.pointer.id===id){
      if(!active.path){
        const points=[screenToWorld(active.pointer.at,active.camera)];
        for(const {at} of samples){
          if(!sanePoint(at)||(at.x===active.pointer.at.x&&at.y===active.pointer.at.y))continue;
          const world=screenToWorld(at,active.camera);
          if(!sanePoint(world))continue;
          points.push(world);active.pointer={...active.pointer,at:copyPoint(at)};
        }
        return points.length>1?[{kind:"erase-sweep",points,radius:active.radius}]:[];
      }
      let changed=false;
      let latest:InkMotion|undefined;
      for(const sample of samples){
        if(!sanePoint(sample.at)||!freshMotion(active,sample,source))continue;
        latest=sample;
        const progress=active.path.append(screenToWorld(sample.at,active.camera),sample.pressure,sample.timeStamp);
        if(progress==="overflow")return [this.abandon("sample-limit",true)];
        if(progress==="added")changed=true;
      }
      if(latest)active.pointer={...active.pointer,at:copyPoint(latest.at),...(active.tick?{timeStamp:active.tick.time}:{})};
      return changed?[{kind:"stroke-update"}]:[];
    }
    const before=this.navigation.get(id),last=samples.at(-1);
    if(before&&last&&sanePoint(last.at)){
      const next={...before,at:copyPoint(last.at)};
      this.navigation.set(id,next);return [nav("move",next)];
    }
    return [];
  }
  up(id:number,at?:Point,timeStamp?:number):readonly InkAction[] {
    const active=this.owner;
    if(active?.pointer.id===id){
      if(this.pan){this.pan.writer=undefined;return [];}
      const end=at&&sanePoint(at)?at:active.pointer.at;
      if(!active.path){
        const final=this.move(id,[{at:end}]);
        this.owner=undefined;
        return [...final,{kind:"erase-commit"}];
      }
      const stroke=active.path.finish(screenToWorld(end,active.camera),timeStamp);
      const preceding=this.parts;this.parts=[];
      this.owner=undefined;
      return stroke?[{kind:"stroke-commit",stroke,...(preceding.length?{preceding}:{})}]:[{kind:"stroke-cancel",reason:"sample-limit"}];
    }
    this.ignored.delete(id);
    const before=this.navigation.get(id);
    if(!before)return [];
    this.navigation.delete(id);
    return [nav("up",at&&sanePoint(at)?{...before,at}:before)];
  }
  cancel(id:number):readonly InkAction[] {
    this.ignored.delete(id);
    if(this.pan?.id===id){const actions=this.interrupt();this.ignored.delete(id);return actions;}
    if(this.pan&&this.ownerId===id&&!this.pan.writer)return []; // implicit capture loss after the writer lifted
    if(this.pan?.writer?.id===id)this.pan.writer=undefined;
    if(this.ownerId===id)return [this.abandon("contact-cancelled",false)];
    const before=this.navigation.get(id);
    if(!before)return [];
    this.navigation.delete(id);
    return [nav("cancel",before)];
  }
  /**
   * Escape/tool switch quarantines held IDs until release; blur/visibility/
   * generation/teardown may forget all contacts whose terminal events are lost.
   */
  interrupt(forgetContacts=false):readonly InkAction[] {
    const actions:InkAction[]=[];
    if(this.pan){if(!forgetContacts)this.ignored.set(this.pan.id,"mouse");this.pan=undefined;actions.push({kind:"pan-end"});}
    if(this.owner)actions.push(this.abandon("interrupted",!forgetContacts));
    if(this.navigation.size)actions.push(this.resetNavigation(!forgetContacts));
    if(forgetContacts)this.ignored.clear();
    return actions;
  }
  private prepare(pointer:InkPointer,{camera,brush,eraserDiameterCss}:InkOptions,reportedPressure=false,capacity=this.maxSamples):Owner|undefined {
    if(!sanePoint(camera.offset)||!Number.isFinite(camera.zoom)||camera.zoom<=0)return;
    const stable={offset:copyPoint(camera.offset),zoom:camera.zoom};
    const at=screenToWorld(pointer.at,stable);
    if(!sanePoint(at))return;
    if(eraserDiameterCss!==undefined){
      const radius=eraserDiameterCss/(2*stable.zoom);
      if(Number.isFinite(radius)&&radius>0)return {pointer:copyPointer(pointer),camera:stable,radius};
      return;
    }
    try{
      const path=new InkAccumulator(pointer.device,at,brush,pointer.pressure,capacity,{zoom:stable.zoom,timeStamp:pointer.timeStamp,reportedPressure});
      return {pointer:copyPointer(pointer),camera:stable,path};
    }catch(error){
      if(!(error instanceof RangeError))throw error;
    }
  }
  private abandon(reason:CancelReason,keep:boolean):InkAction {
    const p=this.owner!.pointer;
    this.owner=undefined;this.parts=[];
    if(keep)this.ignored.set(p.id,p.device);
    return {kind:"stroke-cancel",reason};
  }
  private resetNavigation(keep:boolean):InkAction {
    if(keep)for(const p of this.navigation.values())this.ignored.set(p.id,p.device);
    this.navigation.clear();return {kind:"nav-reset"};
  }
}
