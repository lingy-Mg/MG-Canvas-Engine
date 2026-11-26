import type {Id} from "../core/document.ts";
import {gridPoint,roundWorld} from "../core/geometry.ts";
import type {Point,Rect} from "../core/geometry.ts";

type Axis="x"|"y";
type Anchor=0|1|2;
type Target=Readonly<{id:Id;bounds:Rect}>;
type Span=Readonly<{min:number;max:number}>;
/** axis is the translation axis. Alignment lines cross it; spacing rulers run along it. */
type GuideSpan=Readonly<{axis:Axis;at:number;from:number;to:number;targetId:Id}>;
type SpacingGuide=GuideSpan & {kind:"spacing";label:string;lane:Span};
export type AlignmentGuide=SpacingGuide | (GuideSpan & {kind:"alignment";source:Anchor;edge:Anchor;runs:readonly Span[]});
type Pose={source:Anchor;at:number;delta:number};
type AnchorMatch=Pose & {kind:"alignment";target:Target;edge:Anchor;acrossGap:number};
type Slot="before"|"between"|"after";
type SpacingMatch=Pose & {kind:"spacing";first:Target;second:Target;slot:Slot;gap:number;lane:Span};
type Match=AnchorMatch|SpacingMatch;
type Query=(neighborhood:Rect,spacingStrips:readonly Rect[])=>readonly Target[];
const ACQUIRE=4,RELEASE=8,NEAR=72,LEAVE_NEAR=84;
const axes=["x","y"] as const;
const anchors:readonly Anchor[]=[0,1,2];
const other=(axis:Axis):Axis=>axis==="x"?"y":"x";
const value=(b:Rect,a:Axis,i:Anchor)=>i===0?b.min[a]:i===2?b.max[a]:b.min[a]/2+b.max[a]/2;
const apart=(a:Rect,b:Rect,axis:Axis)=>Math.max(0,a.min[axis]-b.max[axis],b.min[axis]-a.max[axis]);
const shifted=(b:Rect,d:Point):Rect=>({min:{x:b.min.x+d.x,y:b.min.y+d.y},max:{x:b.max.x+d.x,y:b.max.y+d.y}});
function anchorRank(match:AnchorMatch):number{
  if(match.source===match.edge)return match.source===1?0:1;
  return match.source===1||match.edge===1?3:2;
}

function sameMatch(a:Match,b:Match|undefined):boolean{
  if(a.kind==="alignment")return b?.kind===a.kind&&a.target.id===b.target.id&&a.source===b.source&&a.edge===b.edge;
  return b?.kind===a.kind&&a.first.id===b.first.id&&a.second.id===b.second.id&&a.slot===b.slot;
}
function preferred(a:Match,b:Match):boolean{
  const distance=Math.abs(a.delta)-Math.abs(b.delta);
  if(distance)return distance<0;
  if(a.kind==="alignment"&&b.kind==="alignment"){
    const rank=a.acrossGap-b.acrossGap||anchorRank(a)-anchorRank(b);
    if(rank)return rank<0;
    if(a.target.id!==b.target.id)return a.target.id<b.target.id;
    return a.source<b.source||a.source===b.source&&a.edge<b.edge;
  }
  if(a.kind==="spacing"&&b.kind==="spacing"){
    if(a.gap!==b.gap)return a.gap<b.gap;
    const width=(a.lane.max-a.lane.min)-(b.lane.max-b.lane.min);
    if(width)return width>0;
    if(a.first.id!==b.first.id)return a.first.id<b.first.id;
    return a.second.id<b.second.id;
  }
  return a.kind==="spacing";
}

function lowerBound(sorted:readonly number[],key:number){
  let lo=0,hi=sorted.length;
  while(lo<hi){
    const mid=Math.floor((lo+hi)/2);
    if(sorted[mid]<key)lo=mid+1;else hi=mid;
  }
  return lo;
}

function rulerPlacement(across:Axis,match:SpacingMatch,box:Rect,view:Rect,zoom:number,parallel:Match|undefined){
  const a=match.first.bounds,b=match.second.bounds;
  const min=Math.max(a.min[across],b.min[across],box.min[across],view.min[across]);
  const max=Math.min(a.max[across],b.max[across],box.max[across],view.max[across]);
  const inset=Math.min((max-min)/2,8/zoom),high=max-inset;
  const nearAlignment=parallel?.kind==="alignment"&&Math.abs(high-parallel.at)*zoom<12&&parallel.at>(min+max)/2+.5/zoom;
  const preferred=nearAlignment?min+inset:high;
  // Anchor to the painted boxes while the pointer moves within the snap band.
  // An intervening object can still constrain both end caps to a smaller clear lane.
  const start=Math.max(min,match.lane.min),end=Math.min(max,match.lane.max),cap=Math.min((end-start)/2,3/zoom);
  return {at:Math.max(start+cap,Math.min(end-cap,preferred)),lane:{min:start,max:end}};
}

/** Only show the exposed portions of an alignment. A parallel ruler gets the gap
 * to itself when a narrow row or column leaves too little room for both marks. */
function alignmentRuns(axis:Axis,at:number,from:number,to:number,source:Rect,targets:readonly Target[],rulers:readonly SpacingGuide[],zoom:number):Span[]{
  const along=other(axis),pad=2/zoom,covered:Span[]=[];
  function cover(min:number,max:number){
    if(max+pad>from&&min-pad<to)covered.push({min:min-pad,max:max+pad});
  }
  function coverBox(box:Rect){
    if(at>=box.min[axis]-pad&&at<=box.max[axis]+pad)cover(box.min[along],box.max[along]);
  }
  coverBox(source);
  for(const target of targets)coverBox(target.bounds);
  for(const ruler of rulers)if(ruler.axis===along&&Math.abs(ruler.at-at)*zoom<12)cover(ruler.from,ruler.to);
  covered.sort((a,b)=>a.min-b.min);
  const runs:Span[]=[];
  let start=from;
  for(const block of covered){
    if(start<block.min)runs.push({min:start,max:block.min});
    start=Math.max(start,block.max);
    if(start>=to)return runs;
  }
  if(start<to)runs.push({min:start,max:to});
  return runs;
}

/** Sweep the cross-axis edges of the visible neighbors. In each band, the
 * nearest two facing edges on either side suffice for all three placements. */
function spacingMatches(axis:Axis,box:Rect,targets:readonly Target[],view:Rect,consider:(m:Match)=>void){
  if(targets.length<2)return;
  const across=other(axis),min=Math.max(view.min[across],box.min[across]),max=Math.min(view.max[across],box.max[across]);
  if(min>=max)return;
  const before:Target[]=[],after:Target[]=[],center=value(box,axis,1);
  for(const t of targets){
    const b=t.bounds;
    if(Math.max(b.min[across],min)>=Math.min(b.max[across],max)||b.min[axis]>view.max[axis]||b.max[axis]<view.min[axis])continue;
    (value(b,axis,1)<center?before:after).push(t);
  }
  if(before.length+after.length<2)return;
  const byEdge=(edge:"min"|"max")=>(a:Target,b:Target)=>a.bounds[edge][axis]-b.bounds[edge][axis]||(a.id<b.id?-1:a.id>b.id?1:0);
  const ordered=before.sort(byEdge("max")).concat(after.sort(byEdge("min")));
  const events:{at:number;rank:number;enter:boolean}[]=[];
  for(const [rank,{bounds}] of ordered.entries()){
    events.push({at:Math.max(min,bounds.min[across]),rank,enter:true},{at:Math.min(max,bounds.max[across]),rank,enter:false});
  }
  events.sort((a,b)=>a.at-b.at);
  const size=box.max[axis]-box.min[axis];
  function add(first:Target|undefined,second:Target|undefined,slot:Slot,lane:Span,opposite?:Target){
    if(!first||!second)return;
    const a=first.bounds,b=second.bounds;
    const space=b.min[axis]-a.max[axis],gap=slot==="between"?(space-size)/2:space;
    if(!(gap>0))return;
    const source=slot==="before"?2:0;
    const at=slot==="before"?a.min[axis]-gap:slot==="between"?a.max[axis]+gap:b.max[axis]+gap;
    if(opposite&&(slot==="after"?opposite.bounds.min[axis]<at:opposite.bounds.max[axis]>at))return;
    consider({kind:"spacing",first,second,slot,gap,lane,source,at,delta:at-value(box,axis,source)});
  }
  const active:number[]=[];
  for(let i=0;i<events.length;){
    const start=events[i].at;
    do{
      const {rank,enter}=events[i++],index=lowerBound(active,rank);
      if(enter)active.splice(index,0,rank);else active.splice(index,1);
    }while(i<events.length&&events[i].at===start);
    if(i===events.length||active.length<2)continue;
    const split=lowerBound(active,before.length),lane={min:start,max:events[i].at};
    const left=ordered[active[split-1]],right=ordered[active[split]];
    add(ordered[active[split-2]],left,"after",lane,right);
    add(left,right,"between",lane);
    add(right,ordered[active[split+1]],"before",lane,left);
  }
}

/** Exists only for one ordinary drag. All coordinates are in world space.
 * The raw pose always comes from the initial grab, including after bypass. */
export class DragAlignment{
  private held:Partial<Record<Axis,Match>>={};
  guides:readonly AlignmentGuide[]=[];
  private source:Rect;
  private viewport:Rect;
  private zoom:number;
  private query:Query;
  constructor(source:Rect,viewport:Rect,zoom:number,query:Query){
    this.source=source;this.viewport=viewport;this.zoom=zoom;this.query=query;
  }
  private choose(axis:Axis,box:Rect,raw:Point,targets:readonly Target[]):Match|undefined{
    const prior=this.held[axis],across=other(axis),view=this.viewport,z=this.zoom;
    let best:Match|undefined,latched=false;
    const consider=(match:Match)=>{
      const distance=Math.abs(match.delta)*z;
      if(distance>RELEASE||match.at<view.min[axis]||match.at>view.max[axis]||(!raw[axis]&&match.delta!==0))return;
      // moveObjects commits a whole-world-unit translation. Never promise equal
      // gutters it cannot produce, or show an alignment line visibly off the object.
      const initial=value(this.source,axis,match.source),offset=match.at-initial;
      const roundoff=8*Number.EPSILON*Math.max(1,Math.abs(initial),Math.abs(match.at));
      const tolerance=match.kind==="spacing"?roundoff:Math.max(roundoff,.5/z);
      if(Math.abs(offset-roundWorld(offset))>tolerance)return;
      const held=sameMatch(match,prior);
      if(!held&&(latched||distance>ACQUIRE||match.kind==="alignment"&&match.acrossGap*z>NEAR))return;
      if((held&&!latched)||!best||preferred(match,best)){best=match;latched=held;}
    };
    for(const target of targets){
      const acrossGap=apart(box,target.bounds,across);
      if(acrossGap*z>LEAVE_NEAR||apart(box,target.bounds,axis)*z>RELEASE)continue;
      for(const i of anchors)for(const j of anchors){
        const at=value(target.bounds,axis,j),delta=at-value(box,axis,i);
        if(Math.abs(delta)*z<=RELEASE)consider({kind:"alignment",target,source:i,edge:j,at,delta,acrossGap});
      }
    }
    if(!latched)spacingMatches(axis,box,targets,view,consider);
    return best;
  }
  resolve(raw:Point,bypass=false):Point{
    this.guides=[];
    const box=shifted(this.source,raw),view=this.viewport;
    if(bypass||(!raw.x&&!raw.y)||!Number.isFinite(raw.x)||!Number.isFinite(raw.y)||
      apart(box,view,"x")||apart(box,view,"y")){
      this.held={};return raw;
    }
    const pad=LEAVE_NEAR/this.zoom;
    const region={min:{x:Math.max(view.min.x,box.min.x-pad),y:Math.max(view.min.y,box.min.y-pad)},
      max:{x:Math.min(view.max.x,box.max.x+pad),y:Math.min(view.max.y,box.max.y+pad)}};
    const row={min:{x:view.min.x,y:Math.max(view.min.y,box.min.y)},max:{x:view.max.x,y:Math.min(view.max.y,box.max.y)}};
    const column={min:{x:Math.max(view.min.x,box.min.x),y:view.min.y},max:{x:Math.min(view.max.x,box.max.x),y:view.max.y}};
    const targets=this.query(region,[row,column]);
    this.held={x:this.choose("x",box,raw,targets),y:this.choose("y",box,raw,targets)};
    // Subtract from the original anchor to avoid drift at a snap boundary.
    const {x,y}=this.held;
    const delta={x:x?x.at-value(this.source,"x",x.source):raw.x,y:y?y.at-value(this.source,"y",y.source):raw.y};
    let final=shifted(this.source,gridPoint(delta));
    for(const axis of axes){
      const match=this.held[axis];
      if(match?.kind!=="spacing")continue;
      const across=other(axis);
      if(Math.max(match.lane.min,final.min[across])>=Math.min(match.lane.max,final.max[across])){
        this.held[axis]=undefined;delta[axis]=raw[axis];final=shifted(this.source,gridPoint(delta));
      }
    }
    const rulers:SpacingGuide[]=[];
    for(const axis of axes){
      const match=this.held[axis];if(match?.kind!=="spacing")continue;
      const a=match.first.bounds,b=match.second.bounds,across=other(axis);
      const placement=rulerPlacement(across,match,final,view,this.zoom,this.held[across]);
      const [start,middle,end]=match.slot==="before"?[final,a,b]:match.slot==="between"?[a,final,b]:[a,b,final];
      const label=String(Number(match.gap.toFixed(2)));
      rulers.push({kind:"spacing",axis,...placement,from:start.max[axis],to:middle.min[axis],targetId:match.first.id,label},
        {kind:"spacing",axis,...placement,from:middle.max[axis],to:end.min[axis],targetId:match.second.id,label});
    }
    const guides:AlignmentGuide[]=[];
    for(const axis of axes){
      const match=this.held[axis];if(match?.kind!=="alignment")continue;
      const across=other(axis),target=match.target.bounds,margin=4/this.zoom;
      const from=Math.max(view.min[across],Math.min(final.min[across],target.min[across])-margin);
      const to=Math.min(view.max[across],Math.max(final.max[across],target.max[across])+margin);
      if(from<=to)guides.push({kind:"alignment",axis,at:match.at,from,to,targetId:match.target.id,source:match.source,edge:match.edge,
        runs:alignmentRuns(axis,match.at,from,to,final,targets,rulers,this.zoom)});
    }
    this.guides=[...guides,...rulers];return delta;
  }
}
