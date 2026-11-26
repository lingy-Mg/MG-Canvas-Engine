import type {Id,MindMap,Topic} from "../core/document.ts";
import {graphemePrefix} from "../features/text-layout.ts";
import {layerQuery} from "./layer-search.ts";

export const TOPIC_PAGE_SIZE=64;
export type OutlineRow={topic:Topic;caption:string;name:string;parent?:Id;depth:number;position:number;siblings:number;end:number;occurrence:number};
export class TopicOutline {
  readonly rows:OutlineRow[]=[];
  readonly byId=new Map<Id,OutlineRow>();
  private counts=new Map<string,number>();

  constructor(map:MindMap){
    const pending:{id:Id;depth:number;parent?:Id;position:number;siblings:number}[]=[{id:map.rootId,depth:0,position:1,siblings:1}];
    while(pending.length){
      const slot=pending.pop()!,topic=map.topics[slot.id],text=topic.text||"未命名主题";
      const name=layerQuery(text),occurrence=(this.counts.get(name)??0)+1;
      const row={...slot,topic,caption:graphemePrefix(text,96),name,occurrence,end:this.rows.length+1};
      this.counts.set(name,occurrence);this.byId.set(topic.id,row);this.rows.push(row);
      const kids=topic.childIds;
      for(let i=kids.length-1;i>=0;i--)pending.push({id:kids[i],parent:topic.id,depth:row.depth+1,position:i+1,siblings:kids.length});
    }
    // The last child's subtree ends at the same index as its parent's.
    for(let i=this.rows.length-1;i>=0;i--){
      const row=this.rows[i],last=row.topic.childIds.at(-1);
      if(last)row.end=this.byId.get(last)!.end;
    }
  }
  list(query:string,expanded:ReadonlyMap<Id,boolean>):readonly OutlineRow[]{
    if(query)return this.rows.filter(row=>row.name.includes(query));
    const list:OutlineRow[]=[];
    for(let i=0;i<this.rows.length;){
      const row=this.rows[i];list.push(row);
      i=(expanded.get(row.topic.id)??!row.topic.collapsed)?i+1:row.end;
    }
    return list;
  }
  /** At most three ancestor captions per displayed row, even for very deep maps. */
  context(row:OutlineRow,search:boolean):string{
    const count=this.counts.get(row.name)??1;
    if(!search&&count<2)return "";
    const path:string[]=[];let parent=row.parent;
    while(parent&&path.length<3){
      const next=this.byId.get(parent)!;path.unshift(next.caption);parent=next.parent;
    }
    if(parent)path.unshift("…");
    if(count>1)path.push("同名 "+row.occurrence+"/"+count);
    return path.join(" › ");
  }
}
