import type {BoardDocument,BoardObject,Connector,Id} from "../core/document.ts";
import type {Point,Rect} from "../core/geometry.ts";
import type {ChangeSet} from "../core/history.ts";
import {objectOrigin} from "../session/transform.ts";
import type {DrawGroup,Scene} from "./board.ts";
import {MindLayoutMotion} from "./mindmap-motion.ts";
import {reflowDuration,easeMovement} from "./motion-timing.ts";

type Sample={alpha:number;reveal:number;object?:BoardObject};
type Track={start:number;duration:number;from:Sample;to:Sample;current:Sample;ghost?:DrawGroup;rank:number};
export type MotionCapture={group?:DrawGroup;rank:number};
export type MotionPaint=Readonly<{alpha:number;reveal:number}>;
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const point=(a:Point,b:Point,t:number)=>({x:mix(a.x,b.x,t),y:mix(a.y,b.y,t)});
const overlaps=(a:Rect,b:Rect)=>a.min.x<=b.max.x&&a.min.y<=b.max.y&&b.min.x<=a.max.x&&b.min.y<=a.max.y;
function interpolateLine(a:Connector,b:Connector,t:number):Connector{
  const endpoint=(x:Connector["from"],y:Connector["to"])=>x.kind==="free"&&y.kind==="free"?{...y,point:point(x.point,y.point,t)}:y;
  return {...b,from:endpoint(a.from,b.from),to:endpoint(a.to,b.to),
    waypoints:a.waypoints.length===b.waypoints.length?b.waypoints.map((p,i)=>point(a.waypoints[i],p,t)):b.waypoints};
}
function pose(a:BoardObject|undefined,b:BoardObject|undefined,t:number){
  if(!a||!b||a===b||a.kind!==b.kind)return b;
  if(a.kind==="connector"&&b.kind==="connector")return interpolateLine(a,b,t);
  const from=objectOrigin(a),to=objectOrigin(b);
  if(!from||!to)return b;
  const at=point(from,to,t);
  return b.kind==="mindmap"?{...b,origin:at}:{...b,at};
}
function moved(a:BoardObject,b:BoardObject){
  const from=objectOrigin(a),to=objectOrigin(b);
  if(from&&to)return from.x!==to.x||from.y!==to.y;
  if(a.kind!=="connector"||b.kind!=="connector")return false;
  const shifted=(x:Connector["from"],y:Connector["to"])=>x.kind==="free"&&y.kind==="free"&&(x.point.x!==y.point.x||x.point.y!==y.point.y);
  return shifted(a.from,b.from)||shifted(a.to,b.to)||a.waypoints.length===b.waypoints.length&&
    a.waypoints.some((p,i)=>p.x!==b.waypoints[i].x||p.y!==b.waypoints[i].y);
}

/** A clock-driven display projection. Only the live groups are passed back to hit testing. */
export class SceneMotion{
  readonly topics=new MindLayoutMotion();
  private tracks=new Map<Id,Track>();
  private exits:[Id,Track][]=[];
  readonly objects=new Map<Id,BoardObject>();
  readonly paint=new Map<Id,MotionPaint>();
  get active(){return this.tracks.size>0||this.topics.active;}
  get departingImageAssets(){
    const ids=new Set<Id>();
    for(const [,track] of this.exits)if(track.from.object?.kind==="image")ids.add(track.from.object.assetId);
    return ids;
  }
  clear(){this.tracks.clear();this.exits=[];this.objects.clear();this.paint.clear();this.topics.clear();}
  capture(change:ChangeSet,group:(id:Id)=>DrawGroup|undefined,rank:(id:Id)=>number){
    const result=new Map<Id,MotionCapture>();
    for(const id of [...change.removed,...change.updated])result.set(id,{group:group(id),rank:rank(id)});
    return result;
  }
  transition(before:BoardDocument,after:BoardDocument,change:ChangeSet,old:ReadonlyMap<Id,MotionCapture>,
    group:(id:Id)=>DrawGroup|undefined,region:Rect,now:number,direct:boolean,liveInk:boolean,presentedMap?:Extract<BoardObject,{kind:"mindmap"}>,
    displayed?:ReadonlyMap<Id,BoardObject>){
    const removed=[...change.removed].sort((a,b)=>(old.get(a)?.rank??0)-(old.get(b)?.rank??0));
    const retire=(id:Id)=>{this.tracks.delete(id);this.objects.delete(id);this.paint.delete(id);};
    for(const [i,id] of removed.entries()){
      this.topics.forget(id);
      const previous=this.tracks.get(id),image=old.get(id);
      retire(id);
      if(liveInk&&before.objects[id]?.kind==="ink")continue; // Already erased under the pointer.
      if(!image?.group||!overlaps(image.group.bounds,region))continue;
      const from=previous?.current??{alpha:1,reveal:1,object:before.objects[id]};
      this.tracks.set(id,{start:now,duration:150,from,to:{alpha:0,reveal:0},current:from,ghost:image.group,rank:image.rank-i});
    }
    for(const id of [...change.added,...change.updated]){
      const item=after.objects[id],base=before.objects[id],prior=this.tracks.get(id),next=group(id),prev=old.get(id)?.group;
      if(!next||!overlaps(next.bounds,region)&&(!prev||!overlaps(prev.bounds,region))){retire(id);continue;}
      if(base?.kind==="mindmap"&&item.kind==="mindmap"&&base.topics!==item.topics)this.topics.transition(presentedMap?.id===id?presentedMap:base,item,now);
      if(direct||(liveInk&&item.kind==="ink")){retire(id);continue;}
      const start=displayed?.get(id)??prior?.current.object??base;
      const moving=Boolean(start&&moved(start,item));
      if(base&&!moving&&!prior)continue;
      const from={alpha:prior?.current.alpha??(base?1:0),reveal:prior?.current.reveal??(base?1:0),object:moving?start:item};
      const to={alpha:1,reveal:1,object:item};
      this.tracks.set(id,{start:now,duration:moving?reflowDuration:170,from,to,current:from,rank:0});
    }
    this.exits=Array.from(this.tracks).filter(([,t])=>t.ghost).sort((a,b)=>a[1].rank-b[1].rank);
    this.tick(now);
  }
  tick(now:number){
    const hadPoses=this.objects.size>0,topicsChanged=this.topics.tick(now);
    let finishedExit=false;
    this.objects.clear();this.paint.clear();
    for(const [id,track] of this.tracks){
      const time=Math.max(0,Math.min(1,(now-track.start)/track.duration));
      if(time>=1){this.tracks.delete(id);if(track.ghost)finishedExit=true;continue;}
      // Soft deceleration for arrivals and reflow. Departures gather speed as they recede.
      const t=track.ghost?time*time:easeMovement(time);
      const alpha=mix(track.from.alpha,track.to.alpha,t),reveal=mix(track.from.reveal,track.to.reveal,t);
      const object=track.ghost?track.from.object:pose(track.from.object,track.to.object,t);
      track.current={alpha,reveal,object};
      this.paint.set(id,track.current);
      if(object&&!track.ghost&&object!==track.to.object)this.objects.set(id,object);
    }
    if(finishedExit)this.exits=this.exits.filter(([id])=>this.tracks.has(id));
    return hadPoses||this.objects.size>0||topicsChanged;
  }
  drawList(live:Scene,rank:(id:Id)=>number):Scene{
    const ghosts=this.exits;
    if(!ghosts.length)return live;
    const result:DrawGroup[]=[];let i=0;
    for(const item of live){
      while(i<ghosts.length&&ghosts[i][1].rank<=rank(item.id))result.push(ghosts[i++][1].ghost!);
      result.push(item);
    }
    while(i<ghosts.length)result.push(ghosts[i++][1].ghost!);
    return result;
  }
}
