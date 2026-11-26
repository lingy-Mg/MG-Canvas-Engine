import type {Id,MindMap} from "../core/document.ts";
import type {Box} from "../core/geometry.ts";
import {layoutIndex,layoutMap} from "../features/mindmap-layout.ts";
import type {LocalTopic} from "../features/mindmap-layout.ts";
import {reflowDuration,easeMovement} from "./motion-timing.ts";

export type PaintedTopic=LocalTopic&{alpha?:number;retiring?:MindMap};
type Step={row:PaintedTopic;from:Box;to:Box;alpha:number;endAlpha:number};
type Track={goal:MindMap;start:number;duration:number;steps:Step[]};
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
function sameTree(a:readonly LocalTopic[],b:readonly LocalTopic[]){
  return a.length===b.length&&a.every((v,i)=>v.topic.id===b[i].topic.id&&v.parent===b[i].parent&&v.side===b[i].side);
}
function portBox(parent:Box,row:LocalTopic,parentDepth:number):Box{
  return {at:{x:parent.at.x+(row.side==="left"?0:parent.width),y:parent.at.y+parent.height*(parentDepth>=3?1:.5)},width:0,height:0,rotation:0};
}
function frame(step:Step,t:number):PaintedTopic{
  const {from,to,row}=step;
  const box=from===to?to:{at:{x:mix(from.at.x,to.at.x,t),y:mix(from.at.y,to.at.y,t)},
    width:mix(from.width,to.width,t),height:mix(from.height,to.height,t),rotation:0};
  return {...row,box,alpha:mix(step.alpha,step.endAlpha,t)};
}

/** Local topic poses are sampled by the same display clock as all other objects. */
export class MindLayoutMotion{
  readonly layouts=new Map<Id,readonly PaintedTopic[]>();
  private live=new Map<Id,readonly PaintedTopic[]>();
  private tracks=new Map<Id,Track>();
  get active(){return this.tracks.size>0;}
  liveRows(id:Id){return this.live.get(id);}
  clear(){this.tracks.clear();this.layouts.clear();this.live.clear();}
  forget(id:Id){this.tracks.delete(id);this.layouts.delete(id);this.live.delete(id);}
  private sample(id:Id,track:Track,now:number){
    const time=Math.max(0,Math.min(1,(now-track.start)/track.duration)),t=easeMovement(time);
    if(time>=1){this.forget(id);return;}
    const rows=track.steps.map(step=>frame(step,t));
    this.layouts.set(id,rows);this.live.set(id,rows.filter(row=>!row.retiring));
  }
  tick(now:number){
    const changed=this.active;
    for(const [id,track] of this.tracks)this.sample(id,track,now);
    return changed;
  }
  transition(before:MindMap,after:MindMap,now:number){
    const id=after.id,track=this.tracks.get(id);
    if(before.id!==id||before.rootId!==after.rootId){this.forget(id);return;}
    if(track?.goal===after)return;
    const target=layoutMap(after),priorGoal=layoutMap(track?.goal??before),structural=!sameTree(priorGoal,target);
    if(!structural&&!track)return;
    if(track&&target===priorGoal){track.goal=after;return;}
    if(track)this.sample(id,track,now);
    const source=this.layouts.get(id)??layoutMap(before) as readonly PaintedTopic[];
    const old=layoutIndex(source) as ReadonlyMap<Id,PaintedTopic>,next=layoutIndex(target);
    const starts=new Map<Id,Box>(),ends=new Map<Id,Box>(),steps:Step[]=[];
    for(const row of target){
      const key=row.topic.id,existing=old.get(key),parent=row.parent&&starts.get(row.parent);
      const from=existing?.box??(parent?portBox(parent,row,row.depth-1):row.box);
      starts.set(key,from);ends.set(key,row.box);
      steps.push({row,from,to:row.box,alpha:existing?existing.alpha??1:0,endAlpha:1});
    }
    for(const row of source){
      const key=row.topic.id;if(next.has(key))continue;
      const parent=row.parent&&ends.get(row.parent),to=parent?portBox(parent,row,row.depth-1):row.box;
      ends.set(key,to);steps.push({row:{...row,retiring:row.retiring??before},from:row.box,to,alpha:row.alpha??1,endAlpha:0});
    }
    // Typing updates the destination and keeps the current deadline. A new structural edit starts at the displayed pose.
    const elapsed=track?now-track.start:0;
    const nextTrack={goal:after,start:now,duration:structural?reflowDuration:Math.max(1,(track?.duration??reflowDuration)-elapsed),steps};
    this.tracks.set(id,nextTrack);this.sample(id,nextTrack,now);
  }
}
