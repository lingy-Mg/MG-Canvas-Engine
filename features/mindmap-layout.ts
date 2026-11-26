import {MAX_TOPIC_LENGTH} from "./plain-text.ts";
import {estimatedTextWidth,graphemePrefix,normalizeBreaks,textRows} from "./text-layout.ts";
import {inkWidth,nodeFont,topicMeasureContext} from "../platform/text-metrics.ts";
import type { Id, MindMap,Topic } from "../core/document.ts";
import type { Box,Point } from "../core/geometry.ts";

export type LocalTopic=Readonly<{topic:Topic;box:Box;depth:number;branch:number;side:"left"|"right";parent?:Id;lines:readonly string[];fontSize:number}>;
type Dimensions=Readonly<{width:number;height:number;lines:readonly string[];fontSize:number}>;
const layouts=new WeakMap<MindMap["topics"],{context?:CanvasRenderingContext2D;entries:Map<string,readonly LocalTopic[]>}>();
// Immutable topics survive sibling style edits. Reflow the visible tree, but measure only changed topics.
const measurements=new WeakMap<Topic,{context?:CanvasRenderingContext2D;tiers:Dimensions[]}>();
export const DEFAULT_TOPIC_GAP=17;
const tiers=[
  {fontSize:18,weight:800,minWidth:126,minHeight:48,padX:12,padY:8,gap:1},
  {fontSize:15,weight:700,minWidth:84,minHeight:40,padX:10,padY:7,gap:1},
  {fontSize:13,weight:600,minWidth:74,minHeight:34,padX:8,padY:6,gap:.8},
  {fontSize:12,weight:500,minWidth:60,minHeight:27,padX:6,padY:5,gap:.65},
] as const;
const columnStep=[0,199,188];
export const topicTier=(depth:number)=>tiers[Math.min(depth,tiers.length-1)];
const point=(x:number,y:number):Point=>({x,y});
const box=(at:Point,width:number,height:number):Box=>({at,width,height,rotation:0});
function size(topic:Topic,depth:number,context?:CanvasRenderingContext2D):Dimensions{
  const role=Math.min(depth,tiers.length-1),tier=tiers[role];
  let cached=measurements.get(topic);
  if(!cached||cached.context!==context){cached={context,tiers:[]};measurements.set(topic,cached);}
  const previous=cached.tiers[role];if(previous)return previous;
  const {fontSize,weight,minWidth,minHeight,padX,padY}=tier;
  const original=normalizeBreaks(topic.text||"未命名"),text=graphemePrefix(original,MAX_TOPIC_LENGTH);
  const display=text.length<original.length?text+"…":text;
  if(context)context.font=nodeFont(fontSize,weight);
  const measure=context?(s:string)=>inkWidth(context.measureText(s)):undefined;
  let width=topic.appearance?.width,lines:string[];
  if(width===undefined){
    lines=display.split("\n");
    const longest=Math.max(...lines.map(row=>measure?measure(row):estimatedTextWidth(row,fontSize)));
    width=Math.max(minWidth,Math.ceil(longest)+2*padX+2);
  }else lines=textRows(display,width-2*padX,fontSize,{measure});
  const height=Math.max(minHeight,Math.ceil(lines.length*fontSize*1.35)+2*padY);
  return cached.tiers[role]={width,height,lines,fontSize};
}
export function layoutMap(map:MindMap):readonly LocalTopic[]{
  const scale=map.scale??1,spacing=map.spacing??DEFAULT_TOPIC_GAP;
  const gapAt=(depth:number)=>spacing*scale*topicTier(depth).gap;
  const key=[map.rootId,map.layout,scale,spacing].join("/");
  const context=topicMeasureContext();
  let cached=layouts.get(map.topics);
  if(!cached||cached.context!==context){cached={context,entries:new Map()};layouts.set(map.topics,cached);}
  const cache=cached.entries,previous=cache.get(key);if(previous)return previous;
  const root=map.topics[map.rootId], dimensions=new Map<Id,Dimensions>(), height=new Map<Id,number>();
  type Side="left"|"right";
  const widths:Record<Side,number[]>={left:[],right:[]};
  const pending:Array<[Topic,number,Side,boolean]>=[[root,0,"right",false]];
  while(pending.length){
    const [topic,depth,side,exit]=pending.pop()!,kids=topic.collapsed?[]:topic.childIds;
    if(!exit){
      const base=size(topic,depth,context);
      dimensions.set(topic.id,scale===1?base:{...base,width:base.width*scale,height:base.height*scale,fontSize:base.fontSize*scale});
      if(depth<columnStep.length)widths[side][depth]=Math.max(widths[side][depth]??0,base.width*scale);
      if(!depth)widths.left[0]=base.width*scale;
      pending.push([topic,depth,side,true]);
      kids.forEach((id,i)=>{
        const child=map.topics[id];
        const childSide=depth?side:map.layout==="balanced"?(child.side??(i%2?"left":"right")):map.layout;
        pending.push([child,depth+1,childSide,false]);
      });
    }else{
      const h=kids.reduce((n,id)=>n+(height.get(id)??0),0)+Math.max(0,kids.length-1)*gapAt(depth+1);
      height.set(topic.id,Math.max(h,dimensions.get(topic.id)!.height));
    }
  }
  const rootSize=dimensions.get(root.id)!;
  const output:LocalTopic[]=[{topic:root,box:box(point(-rootSize.width/2,-rootSize.height/2),rootSize.width,rootSize.height),
    depth:0,branch:-1,side:"right",lines:rootSize.lines,fontSize:rootSize.fontSize}];
  if(!root.collapsed){
    const columns:Record<Side,number[]>={left:[0],right:[0]};
    for(const side of ["left","right"] as const)for(let depth=1;depth<widths[side].length;depth++){
      const clearance=(widths[side][depth-1]+widths[side][depth])/2+32*scale;
      columns[side][depth]=columns[side][depth-1]+Math.max(columnStep[depth]*scale,clearance)+gapAt(depth);
    }
    const sides:{left:Id[];right:Id[]}={left:[],right:[]};
    const branchIndex=new Map<Id,number>();
    root.childIds.forEach((id,i)=>{
      branchIndex.set(id,i);
      const side=map.layout==="balanced"?(map.topics[id].side??(i%2?"left":"right")):map.layout;sides[side].push(id);
    });
    const rows:Array<{id:Id;depth:number;branch:number;y:number;side:"left"|"right";parent:Id;parentEdge:number}>=[];
    const enqueue=(ids:readonly Id[],depth:number,mid:number,side:"left"|"right",parent:Id,parentEdge:number,branch?:number)=>{
      const gap=gapAt(depth);
      let top=mid-(ids.reduce((n,id)=>n+(height.get(id)??0),0)+Math.max(0,ids.length-1)*gap)/2;
      for(const id of ids){const h=height.get(id)!;rows.push({id,depth,branch:branch??branchIndex.get(id)!,y:top+h/2,side,parent,parentEdge});top+=h+gap;}
    };
    enqueue(sides.left,1,0,"left",root.id,-rootSize.width/2);enqueue(sides.right,1,0,"right",root.id,rootSize.width/2);
    for(let i=0;i<rows.length;i++){
      const r=rows[i],topic=map.topics[r.id],d=dimensions.get(r.id)!;
      const sign=r.side==="left"?-1:1;
      // Underlined descendants share an inward edge relative to their own parent, even when labels have different widths.
      const x=r.depth<columnStep.length?sign*columns[r.side][r.depth]:r.parentEdge+sign*(30*scale+gapAt(r.depth)+d.width/2);
      output.push({topic,box:box(point(x-d.width/2,r.y-d.height/2),d.width,d.height),depth:r.depth,branch:r.branch,side:r.side,parent:r.parent,lines:d.lines,fontSize:d.fontSize});
      if(!topic.collapsed)enqueue(topic.childIds,r.depth+1,r.y,r.side,topic.id,x+sign*d.width/2,r.branch);
    }
  }
  cache.set(key,output);return output;
}
export function topicBoxes(map:MindMap):readonly (LocalTopic&{box:Box})[]{
  return layoutMap(map).map(t=>({...t,box:{...t.box,at:{x:t.box.at.x+map.origin.x,y:t.box.at.y+map.origin.y}}}));
}
const topicIndexes=new WeakMap<readonly LocalTopic[],ReadonlyMap<Id,LocalTopic>>();
export function layoutIndex(rows:readonly LocalTopic[]):ReadonlyMap<Id,LocalTopic>{
  let index=topicIndexes.get(rows);
  if(!index){index=new Map(rows.map(row=>[row.topic.id,row]));topicIndexes.set(rows,index);}
  return index;
}
export function topicBox(map:MindMap,id:Id,rows=layoutMap(map)):LocalTopic|undefined{
  const row=layoutIndex(rows).get(id);
  if(row)return {...row,box:{...row.box,at:{x:row.box.at.x+map.origin.x,y:row.box.at.y+map.origin.y}}};
}
export function topicAt(map:MindMap,point:Point,margin=0,locals=layoutMap(map)):{topicId:Id;box:Box}|undefined{
  const x=point.x-map.origin.x,y=point.y-map.origin.y;
  for(let i=locals.length-1;i>=0;i--){
    const {topic,box}=locals[i];
    if(x>=box.at.x-margin&&x<=box.at.x+box.width+margin&&y>=box.at.y-margin&&y<=box.at.y+box.height+margin)
      return {topicId:topic.id,box:{...box,at:{x:box.at.x+map.origin.x,y:box.at.y+map.origin.y}}};
  }
}
