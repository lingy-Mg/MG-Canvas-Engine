import { screenToWorld } from "../core/geometry.ts";
import type { Box,Point } from "../core/geometry.ts";
import type { Id,MindMap } from "../core/document.ts";
import type { EditorSession } from "../session/editor.ts";
import { dropPlan,getMap,newMindDraft,parentIndex,planPrimaryDrop,revealTopicPath,visibleTopic } from "./mindmap.ts";
import type { TopicDraft,TopicDrop,TopicRef } from "./mindmap.ts";
import { DEFAULT_TOPIC_GAP,layoutIndex,layoutMap,topicAt,topicBox } from "./mindmap-layout.ts";
import type {LocalTopic} from "./mindmap-layout.ts";

type Pointer={id:number;type:string;start:Point;current:Point;generation:symbol;ref?:TopicRef;map?:MindMap;moving:boolean;additive?:boolean};
type DropPreview=Readonly<{box:Box;drop:TopicDrop;valid:boolean}>;
export type MindDecor=Readonly<{selected?:Box;range?:readonly Box[];drop?:DropPreview}>;
type TopQuery=(screen:Point,touch?:boolean)=>Id|undefined;
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);

function topicDropAt(map:MindMap,id:Id,world:Point,zoom:number,primary:boolean):TopicDrop|undefined{
  const rows=layoutMap(map),index=layoutIndex(rows),x=world.x-map.origin.x,y=world.y-map.origin.y;
  const source=index.get(id);
  if(!source)return;
  const hit=topicAt(map,world);
  if(hit?.topicId===id)return;
  const side=Math.abs(x)<6/zoom?source.side:x<0?"left":"right";
  if(primary){
    // A primary branch stays a child of the root. Never interpret its descendants as insertion targets.
    const hovered=hit&&index.get(hit.topicId);
    if(hovered&&hovered.depth>1&&hovered.branch===source.branch)return {target:hovered.topic.id,place:"child"};
    let previous:Id|undefined;
    for(const peerId of map.topics[map.rootId].childIds){
      const peer=index.get(peerId);
      if(peerId===id||peer?.side!==side)continue;
      if(y<peer.box.at.y+peer.box.height/2)return {target:peerId,place:"before",side};
      previous=peerId;
    }
    return previous?{target:previous,place:"after",side}:{target:map.rootId,place:"child",side};
  }
  if(hit){
    const offset=world.y-hit.box.at.y,band=Math.min(hit.box.height*.25,12/zoom);
    const place=hit.topicId===map.rootId?"child":offset<=band?"before":offset>=hit.box.height-band?"after":"child";
    return {target:hit.topicId,place,...(hit.topicId===map.rootId&&map.layout==="balanced"?{side}:{})};
  }
  // The space between rows is also a sibling insertion target. Distant empty canvas cancels the drop.
  let best=Math.max(10/zoom,(map.spacing??DEFAULT_TOPIC_GAP)*(map.scale??1)/2),drop:TopicDrop|undefined;
  for(const row of rows){
    const b=row.box;
    if(row.topic.id===id||!row.depth||x<b.at.x-6/zoom||x>b.at.x+b.width+6/zoom)continue;
    const before=y<b.at.y,dy=before?b.at.y-y:y-b.at.y-b.height;
    if(dy>=0&&dy<=best){best=dy;drop={target:row.topic.id,place:before?"before":"after"};}
  }
  return drop;
}

export class MindMapInput {
  armed=false;
  selected:TopicRef|undefined;
  pointer:Pointer|undefined;
  private target?:DropPreview;
  private proposed?:MindMap;
  private exact=false;
  private source?:MindMap;
  private displayed=new WeakMap<MindMap,{id:Id;map:MindMap}>();
  displayMap(map:MindMap,id=this.selected?.topicId):MindMap{
    if(!this.exact||this.selected?.mapId!==map.id||!id)return map;
    const cached=this.displayed.get(map);if(cached?.id===id)return cached.map;
    const shown=revealTopicPath(map,id);this.displayed.set(map,{id,map:shown});return shown;
  }
  get revealed():MindMap|undefined{
    if(!this.exact||!this.source)return;
    const shown=this.displayMap(this.source);return shown===this.source?undefined:shown;
  }
  private editor:EditorSession;
  private hit:TopQuery;
  private draft:(value:TopicDraft)=>void;
  private appearance?:(map:MindMap)=>MindMap|undefined;
  private displayedRows?:(id:Id)=>readonly LocalTopic[]|undefined;
  constructor(editor:EditorSession,hit:TopQuery,draft:(value:TopicDraft)=>void,appearance?:(map:MindMap)=>MindMap|undefined,displayedRows?:(id:Id)=>readonly LocalTopic[]|undefined){
    this.editor=editor;this.hit=hit;this.draft=draft;this.appearance=appearance;this.displayedRows=displayedRows;
  }
  private paintedMap(map:MindMap){return this.appearance?.(map)??this.displayMap(map);}
  get active():boolean{return Boolean(this.selected);}
  armCreate(active:boolean){
    this.reset();this.armed=active;
  }
  private clearDrop(){this.target=undefined;this.proposed=undefined;}
  cancelPointer(){this.pointer=undefined;this.clearDrop();}
  reset(){this.cancelPointer();this.selected=undefined;this.source=undefined;this.exact=false;this.armed=false;}
  focus(mapId:Id,topicId?:Id,fromTree=false):boolean{
    const map=getMap(this.editor,mapId);
    if(!map||this.editor.isHidden(mapId)||this.editor.isLocked(mapId))return false;
    const id=topicId??map.rootId;
    if(fromTree&&!Object.hasOwn(map.topics,id))return false;
    this.exact=fromTree||this.exact&&this.selected?.mapId===mapId;
    this.armed=false;this.source=map;
    this.selected={mapId,topicId:this.exact&&Object.hasOwn(map.topics,id)?id:visibleTopic(map,id)};
    this.editor.select(mapId);
    return true;
  }
  sync(){
    const selected=this.selected;
    if(!selected)return;
    const map=getMap(this.editor,selected.mapId);
    if(!map||this.editor.isHidden(selected.mapId)||this.editor.isLocked(selected.mapId)||this.editor.selectedIds.length!==1||this.editor.selection!==selected.mapId){
      this.reset();return;
    }
    if(map===this.source)return;
    let id=selected.topicId;
    if(!Object.hasOwn(map.topics,id)){
      const parents=this.source&&parentIndex(this.source);
      while(!Object.hasOwn(map.topics,id)&&parents?.has(id))id=parents.get(id)!;
      if(!Object.hasOwn(map.topics,id))id=map.rootId;
    }
    this.source=map;
    const visible=this.exact?id:visibleTopic(map,id);
    if(visible!==selected.topicId)this.selected={mapId:map.id,topicId:visible};
  }
  at(screen:Point,touch=false):TopicRef|undefined{
    const match=this.hit(screen,touch),map=match&&getMap(this.editor,match);
    if(!map||this.editor.isHidden(map.id)||this.editor.isLocked(map.id))return;
    const hit=topicAt(this.paintedMap(map),screenToWorld(screen,this.editor.camera),0,this.displayedRows?.(map.id));
    if(hit)return {mapId:map.id,topicId:hit.topicId};
  }
  down(id:number,type:string,screen:Point,additive=false):boolean{
    if(this.pointer)return false;
    const generation=this.editor.generation;
    if(this.armed){
      this.pointer={id,type,start:screen,current:screen,generation,moving:false};return true;
    }
    const ref=this.at(screen,type==="touch");
    if(!ref)return false;
    const map=getMap(this.editor,ref.mapId);
    if(!map)return false;
    this.pointer={id,type,start:screen,current:screen,generation,ref,map,moving:false,additive};
    return true;
  }
  move(id:number,screen:Point):boolean{
    const pointer=this.pointer;
    if(!pointer||pointer.id!==id)return false;
    pointer.current=screen;
    if(!pointer.moving&&distance(pointer.start,screen)<(pointer.type==="touch"?10:5))return true;
    pointer.moving=true;
    if(!pointer.ref||!pointer.map||pointer.ref.topicId===pointer.map.rootId)return true;
    const map=pointer.map, zoom=this.editor.camera.zoom, world=screenToWorld(screen,this.editor.camera);
    const under=this.hit(screen,pointer.type==="touch");
    if((under&&under!==map.id)||getMap(this.editor,map.id)!==map||pointer.generation!==this.editor.generation||
      this.editor.isLocked(map.id)||this.editor.isHidden(map.id)){this.clearDrop();return true;}
    const shown=this.displayMap(map),topicId=pointer.ref.topicId,parents=parentIndex(map);
    const primary=parents.get(topicId)===map.rootId;
    const drop=topicDropAt(shown,topicId,world,zoom,primary);
    if(!drop){this.clearDrop();return true;}
    const last=this.target?.drop;
    if(last?.target===drop.target&&last.place===drop.place&&last.side===drop.side)return true;
    this.proposed=primary?planPrimaryDrop(map,topicId,drop):dropPlan(map,topicId,drop);
    // Keep the hit layout fixed until release. Show the new box on an empty side.
    const emptySide=primary&&drop.target===map.rootId&&this.proposed;
    const box=emptySide?topicBox(emptySide,topicId)!.box:topicBox(shown,drop.target)!.box;
    this.target={box,drop,valid:Boolean(this.proposed)};
    return true;
  }
  up(id:number,screen:Point):boolean{
    const p=this.pointer;
    if(!p||p.id!==id)return false;
    this.move(id,screen);
    const next=this.proposed;
    this.cancelPointer();
    if(p.generation!==this.editor.generation)return true;
    if(!p.ref){
      if(!p.moving){
        this.armed=false;this.draft(newMindDraft(this.editor,screenToWorld(screen,this.editor.camera)));
      }
    }else if(!p.moving){
      if(p.additive)this.editor.select(p.ref.mapId,true);else this.focus(p.ref.mapId,p.ref.topicId);
    }else if(next&&getMap(this.editor,p.ref.mapId)===p.map){
      const range=this.editor.selectedTopics.get(next.id)?.has(p.ref.topicId);
      const done=this.editor.commitEdit({label:"调整脑图分支位置",patches:[{op:"putObject",value:next}]},p.generation,range?undefined:[next.id]);
      if(done&&!range)this.focus(next.id,p.ref.topicId);
    }
    return true;
  }
  decor():MindDecor{
    const selected=this.selected;
    const map=selected&&getMap(this.editor,selected.mapId);
    const range:Box[]=[];
    for(const [id,topics] of this.editor.selectedTopics){
      const current=getMap(this.editor,id);if(!current||this.editor.isHidden(id))continue;
      const shown=this.paintedMap(current);
      for(const topicId of topics){const row=topicBox(shown,topicId,this.displayedRows?.(id));if(row)range.push(row.box);}
    }
    const shown=map&&this.paintedMap(map);
    return {selected:shown&&selected?topicBox(shown,selected.topicId,this.displayedRows?.(shown.id))?.box:undefined,range,drop:this.target};
  }
}
