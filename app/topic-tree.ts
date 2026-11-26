import type {Id,MindMap} from "../core/document.ts";
import type {TopicRef} from "../features/mindmap.ts";
import {TopicOutline,TOPIC_PAGE_SIZE} from "./topic-outline.ts";
import type {OutlineRow} from "./topic-outline.ts";

type Actions={
  choose:(ref:TopicRef)=>boolean;edit:(ref:TopicRef,action:"rename"|"child"|"sibling")=>void;
  history:(redo:boolean)=>void;reorder:(ref:TopicRef,delta:-1|1)=>void;
  search:()=>void;clear:()=>void;canvas:()=>void;
};
type TopicRowView={id:Id;caption:string;context:string;level:number;size:number;position:number;indent:number;expanded?:boolean};
export type TopicTreeView={mapId:Id;epoch:number;title:string;opened:boolean;status:string;rows:readonly TopicRowView[];
  page:number;pages:number;current?:string;cursor?:Id;active?:Id;
  toggle:()=>void;turn:(delta:number)=>void;locate:()=>void;choose:(id:Id,caret:boolean)=>void;
  key:(event:KeyboardEvent,id:Id)=>void;focus:(id:Id)=>void};
export class TopicTree{
  private root:HTMLElement;
  private publish:(view:TopicTreeView|undefined)=>void;
  private actions:Actions;
  private epoch=0;
  private listed=new Set<Id>();
  private map?:MindMap;
  private generation?:symbol;
  private outline?:TopicOutline;
  private expanded=new Map<Id,boolean>();
  private rows:readonly OutlineRow[]=[];
  private page=0;
  private opened=true;
  private term="";
  private active?:Id;
  private locked=false;
  private cursor?:Id;
  constructor(root:HTMLElement,publish:(view:TopicTreeView|undefined)=>void,actions:Actions){
    this.root=root;this.publish=publish;this.actions=actions;
  }
  private focusedId():Id|undefined{
    const element=document.activeElement as HTMLElement|null;
    return element&&this.root.contains(element)?element.dataset.topicId:undefined;
  }
  private turn(delta:number){
    const page=this.page+delta;
    if(page<0||page*TOPIC_PAGE_SIZE>=this.rows.length)return;
    this.page=page;this.cursor=this.rows[page*TOPIC_PAGE_SIZE]?.topic.id;this.render(this.cursor);
  }
  private list(){this.rows=this.outline?.list(this.term,this.expanded)??[];}
  private revealAncestors(id:Id){
    let row=this.outline?.byId.get(id),changed=false;
    while(row?.parent){
      row=this.outline!.byId.get(row.parent)!;
      if(!(this.expanded.get(row.topic.id)??!row.topic.collapsed)){this.expanded.set(row.topic.id,true);changed=true;}
    }
    return changed;
  }
  private locate(id:Id,focus:boolean){
    if(!this.term&&this.revealAncestors(id))this.list();
    const index=this.rows.findIndex(row=>row.topic.id===id);if(index<0)return false;
    this.opened=true;this.page=Math.floor(index/TOPIC_PAGE_SIZE);this.cursor=id;this.render(focus?id:undefined);return true;
  }
  restoreFocus(){
    if(this.active&&this.locate(this.active,true))return;
    this.actions.search();
  }
  sync(map:MindMap|undefined,active:Id|undefined,locked:boolean,generation:symbol,term:string){
    const previous=this.map,reset=previous?.id!==map?.id||generation!==this.generation;
    const structure=reset||previous?.topics!==map?.topics||previous?.rootId!==map?.rootId;
    const selected=this.active!==active,query=this.term!==term;
    if(!structure&&!selected&&!query&&this.locked===locked){this.map=map;return;}
    const hadFocus=this.root.contains(document.activeElement);
    const focusedId=this.focusedId();
    const activeWasListed=Boolean(active&&this.listed.has(active));
    this.map=map;this.generation=generation;this.locked=locked;this.active=active;
    if(reset){
      this.expanded.clear();this.listed.clear();this.epoch++;this.cursor=undefined;this.opened=true;this.page=0;
    }
    if(!map)this.publish(undefined);
    if(!map){this.outline=undefined;this.rows=[];this.term=term;if(hadFocus)this.actions.search();return;}
    if(structure){
      if(!reset)for(const id of this.expanded.keys()){
        if(!map.topics[id]||previous?.topics[id]?.collapsed!==map.topics[id].collapsed)this.expanded.delete(id);
      }
      this.outline=new TopicOutline(map);
    }
    this.term=term;
    if(query){this.page=0;if(term)this.opened=true;}
    // Reorders can move the same ID across a page without changing the selection.
    const keptFocus=structure&&!reset&&!query&&focusedId&&this.outline!.byId.has(focusedId)?focusedId:undefined;
    const target=keptFocus??(selected||reset||query&&!term||structure&&activeWasListed?active:undefined);
    const unfolded=target&&!term&&this.revealAncestors(target);
    if(structure||query||unfolded)this.list();
    if(target){
      const index=this.rows.findIndex(row=>row.topic.id===target);
      if(index>=0){this.page=Math.floor(index/TOPIC_PAGE_SIZE);this.cursor=target;}
    }
    this.render();
    if(reset&&hadFocus)this.actions.search();
  }
  private branch(row:OutlineRow){
    if(this.term||!row.topic.childIds.length)return;
    const id=row.topic.id;this.expanded.set(id,!(this.expanded.get(id)??!row.topic.collapsed));
    this.list();this.cursor=id;this.render(id);
  }
  private setCursor(id:Id){if(this.cursor!==id){this.cursor=id;this.render();}}
  private focusRow(id:Id){
    this.setCursor(id);
    const row=this.root.querySelector<HTMLElement>('[data-topic-id="'+CSS.escape(id)+'"]');
    row?.focus({preventScroll:true});row?.scrollIntoView?.({block:"nearest",inline:"nearest"});
  }
  private key(event:KeyboardEvent,id:Id){
    if(event.isComposing||event.keyCode===229||event.getModifierState?.("AltGraph"))return;
    const key=event.key,row=this.outline!.byId.get(id)!,ref={mapId:this.map!.id,topicId:id};
    if(event.ctrlKey||event.metaKey){
      const k=key.toLowerCase();
      if(!event.altKey&&(k==="z"||k==="y"&&event.ctrlKey&&!event.metaKey&&!event.shiftKey)){
        event.preventDefault();if(!event.repeat)this.actions.history(k==="y"||event.shiftKey);
      }
      return;
    }
    if(event.altKey||event.shiftKey){
      if(event.altKey&&!event.shiftKey&&!this.locked&&id===this.active&&(key==="ArrowUp"||key==="ArrowDown")){
        event.preventDefault();if(!event.repeat)this.actions.reorder(ref,key==="ArrowUp"?-1:1);
      }
      return;
    }
    const index=this.rows.indexOf(row);
    let dest:number|undefined;
    if(key==="ArrowDown")dest=index+1;
    else if(key==="ArrowUp")dest=index-1;
    else if(key==="Home")dest=0;
    else if(key==="End")dest=this.rows.length-1;
    else if(key==="ArrowLeft"||key==="ArrowRight"){
      if(this.term)return;
      const open=this.expanded.get(id)??!row.topic.collapsed;
      if(row.topic.childIds.length&&(key==="ArrowLeft"&&open||key==="ArrowRight"&&!open)){event.preventDefault();this.branch(row);return;}
      const next=key==="ArrowLeft"?row.parent:row.topic.childIds[0];if(next)dest=this.rows.findIndex(entry=>entry.topic.id===next);
    }else if(key==="Escape"){event.preventDefault();this.actions.canvas();return;}
    else if(key===" "||key==="Enter"||key==="F2"||key==="Tab"){
      if(this.locked||key==="Tab"&&this.active!==id)return;
      event.preventDefault();if(event.repeat)return;
      if(key==="F2"||this.active===id&&(key==="Enter"||key==="Tab")){
        this.actions.edit(ref,key==="Tab"?"child":key==="Enter"?"sibling":"rename");
      }else if(this.actions.choose(ref))this.focusRow(id);
      return;
    }else return;
    event.preventDefault();if(dest===undefined||!this.rows[dest])return;
    this.cursor=this.rows[dest].topic.id;this.page=Math.floor(dest/TOPIC_PAGE_SIZE);this.render(this.cursor);
  }
  private render(focus?:Id){
    if(!this.map||!this.outline)return;
    const title=this.outline.byId.get(this.map.rootId)!.caption;
    const pages=Math.max(1,Math.ceil(this.rows.length/TOPIC_PAGE_SIZE));
    this.page=Math.min(this.page,pages-1);
    const start=this.page*TOPIC_PAGE_SIZE,slice=this.opened?this.rows.slice(start,start+TOPIC_PAGE_SIZE):[];
    this.listed=new Set(slice.map(row=>row.topic.id));
    if(this.opened&&(!this.cursor||!this.listed.has(this.cursor)))this.cursor=this.active&&this.listed.has(this.active)?this.active:slice[0]?.topic.id;
    const mapId=this.map.id,epoch=this.epoch;
    const valid=(id:Id)=>epoch===this.epoch&&this.opened&&this.listed.has(id);
    const previous=this.focusedId();
    this.publish({mapId,epoch,title,opened:this.opened,page:this.page,pages,cursor:this.cursor,active:this.active,
      current:this.active&&!this.listed.has(this.active)?this.outline.byId.get(this.active)?.caption:undefined,
      status:(this.locked?"已锁定 · 仅浏览 · ":"")+(this.term?"此脑图匹配 "+this.rows.length+" 个主题":"此脑图共 "+this.outline.rows.length+" 个主题"),
      rows:slice.map((row,i)=>({id:row.topic.id,caption:row.caption,context:this.outline!.context(row,Boolean(this.term)),
        level:this.term?1:row.depth+1,size:this.term?this.rows.length:row.siblings,position:this.term?start+i+1:row.position,
        indent:6+(this.term?0:Math.min(6,row.depth)*10),expanded:!this.term&&row.topic.childIds.length?(this.expanded.get(row.topic.id)??!row.topic.collapsed):undefined})),
      toggle:()=>{this.opened=!this.opened;this.render();},turn:delta=>this.turn(delta),
      locate:()=>{if(this.active){if(this.term&&!this.rows.some(r=>r.topic.id===this.active))this.actions.clear();this.locate(this.active,true);}},
      key:(event,id)=>{if(valid(id))this.key(event,id);},focus:id=>{if(valid(id))this.setCursor(id);},
      choose:(id,caret)=>{
        if(!valid(id))return;
        if(caret&&this.map!.topics[id].childIds.length&&!this.term){this.branch(this.outline!.byId.get(id)!);return;}
        if(!this.locked)this.actions.choose({mapId,topicId:id});
        this.focusRow(id);
      }});
    if(focus)this.focusRow(focus);
    else if(previous&&!this.listed.has(previous)&&this.opened){
      if(this.cursor)this.focusRow(this.cursor);else this.actions.search();
    }
  }
}
