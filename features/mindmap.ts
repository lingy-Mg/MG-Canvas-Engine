import {MAX_TOPIC_LENGTH} from "./plain-text.ts";
import {boundedTextEdit,normalizeBreaks} from "./text-layout.ts";
import { isTopicAppearance,objectById } from "../core/document.ts";
import { allocateId } from "../core/id.ts";
import type { Id,MindMap,Topic,TopicAppearance } from "../core/document.ts";
import type { Point } from "../core/geometry.ts";
import { gridPoint, roundWorld } from "../core/geometry.ts";
import type { EditorSession } from "../session/editor.ts";
import {topicBox} from "./mindmap-layout.ts";

export type TopicRef=Readonly<{mapId:Id;topicId:Id}>;
export type TopicRelation="child"|"sibling";
export type TopicDrop=Readonly<{target:Id;place:"child"|"before"|"after";side?:Topic["side"]}>;
export const MIND_THEMES=["spectrum","indigo","mint","warm"] as const;
export {MAX_TOPIC_LENGTH} from "./plain-text.ts";
export type MindTheme=typeof MIND_THEMES[number];
export type TopicDraft=Readonly<{generation:symbol;before?:MindMap;map:MindMap;topicId:Id;newTopic:boolean;addition?:{relativeTo:Id;relation:TopicRelation}}>;
export function getMap(editor:EditorSession,id:Id):MindMap|undefined{
  const item=objectById(editor.doc,id);return item?.kind==="mindmap"?item:undefined;
}
const parentsByTopics=new WeakMap<MindMap["topics"],ReadonlyMap<Id,Id>>();
export function parentIndex(map:MindMap):ReadonlyMap<Id,Id>{
  const cached=parentsByTopics.get(map.topics);if(cached)return cached;
  const result=new Map<Id,Id>();
  for(const topic of Object.values(map.topics))for(const id of topic.childIds)result.set(id,topic.id);
  parentsByTopics.set(map.topics,result);return result;
}
export function topSide(map:MindMap,id:Id):Topic["side"]|undefined{
  if(map.layout!=="balanced")return map.layout;
  if(id===map.rootId)return undefined;
  const parents=parentIndex(map);
  let child=id;
  while(parents.has(child)&&parents.get(child)!==map.rootId)child=parents.get(child)!;
  const i=map.topics[map.rootId].childIds.indexOf(child);
  if(i<0)return undefined;
  return map.topics[child].side??(i%2?"left":"right");
}
/** Switching one primary branch preserves sibling order, colors and the other siblings' displayed sides. */
export function withBranchSide(map:MindMap,id:Id,side:"left"|"right"):MindMap|undefined{
  const children=map.topics[map.rootId].childIds;
  if(!children.includes(id)||topSide(map,id)===side)return;
  const topics={...map.topics};
  children.forEach((child,index)=>{
    const current=topics[child];
    const previous=map.layout==="balanced"?(current.side??(index%2?"left":"right")):map.layout;
    const next=child===id?side:previous;
    if(current.side!==next)topics[child]={...current,side:next};
  });
  return {...map,layout:"balanced",topics};
}
/** Change the side and the visible sibling slot as a single tree transaction. */
export function planPrimaryDrop(map:MindMap,id:Id,drop:TopicDrop):MindMap|undefined{
  const ids=map.topics[map.rootId].childIds;
  if(!drop.side||!ids.includes(id)||drop.target===id)return;
  const switched=withBranchSide(map,id,drop.side)??map;
  if(drop.place==="child")return drop.target===map.rootId&&switched!==map?switched:undefined;
  const peers=ids.filter((child,i)=>switched.layout!=="balanced"||(switched.topics[child].side??(i%2?"left":"right"))===drop.side);
  const targetPos=peers.indexOf(drop.target);
  if(targetPos<0)return;
  if(peers.indexOf(id)===targetPos+(drop.place==="before"?-1:1))return switched===map?undefined:switched;
  return dropPlan(switched,id,drop);
}
// Colors travel with primary branches. Only an order that differs from palette order needs storing.
function keepBranchColors(before:MindMap,after:MindMap):MindMap{
  const old=before.topics[before.rootId].childIds,ids=after.topics[after.rootId].childIds;
  if(old===ids)return after;
  const slots=new Map(old.map((id,i)=>[id,before.branchColors?.[i]??i]));
  const used=new Set(ids.map(id=>slots.get(id)));let firstFree=0;
  const branchColors=ids.map(id=>{
    const prior=slots.get(id);if(prior!==undefined)return prior;
    while(used.has(firstFree))firstFree++;
    return firstFree++;
  });
  if(branchColors.some((slot,i)=>slot!==i))return {...after,branchColors};
  const {branchColors:_colors,...natural}=after;return natural;
}
/** Project the chosen topics into trees, retaining their nearest chosen ancestor and sibling order. */
export function selectedTopicTrees(map:MindMap,include:(id:Id)=>boolean):MindMap[]{
  type Tree={rootId:Id;topics:Record<Id,Topic>};
  const trees:Tree[]=[];
  const pending:Array<{id:Id;tree?:Tree;children?:Id[]}>=[{id:map.rootId}];
  while(pending.length){
    const entry=pending.pop()!,topic=map.topics[entry.id];
    let {tree,children}=entry;
    if(include(topic.id)){
      if(!tree){tree={rootId:topic.id,topics:Object.create(null)};trees.push(tree);}
      children?.push(topic.id);children=[];
      const {side,...data}=topic;
      tree.topics[topic.id]={...data,childIds:children,...(side&&tree.rootId!==topic.id?{side}:{})};
    }
    for(let i=topic.childIds.length-1;i>=0;i--)pending.push({id:topic.childIds[i],tree,children});
  }
  return trees.map(({rootId,topics},i)=>{
    const box=rootId!==map.rootId?topicBox(map,rootId)?.box:undefined;
    const origin=box?gridPoint({x:box.at.x+box.width/2,y:box.at.y+box.height/2}):map.origin;
    const {branchColors:_colors,...base}=map;
    const tree={...base,id:i?allocateId("map"):map.id,rootId,origin,topics};
    return rootId===map.rootId?keepBranchColors(map,tree):tree;
  });
}
/** A partial marquee can delete individual topics. Its surviving children stay in the tree. */
export function withoutSelectedTopics(map:MindMap,selected:ReadonlySet<Id>):MindMap|undefined{
  if(selected.size===Object.keys(map.topics).length)return;
  if(!selected.size||selected.size===1&&selected.has(map.rootId))return map;
  return selectedTopicTrees(map,id=>id===map.rootId||!selected.has(id))[0];
}
// Pin imported/legacy implicit sides when changing root order; untouched branches
// must not flip from left to right just because an earlier sibling was moved.
function stabilizeRootSides(previous:MindMap,topics:Record<Id,Topic>,except?:Id):Record<Id,Topic>{
  previous.topics[previous.rootId].childIds.forEach((id,i)=>{
    const topic=topics[id];
    if(id!==except&&topic&&!topic.side)topics[id]={...topic,side:i%2?"left":"right"};
  });
  return topics;
}
export function visibleTopic(map:MindMap,id:Id):Id{
  if(!Object.hasOwn(map.topics,id))return map.rootId;
  const parents=parentIndex(map);
  let current=id, visible=id;
  while(parents.has(current)){
    current=parents.get(current)!;
    if(map.topics[current].collapsed)visible=current;
  }
  return visible;
}
const revealedPaths=new WeakMap<MindMap["topics"],{id:Id;topics:MindMap["topics"]}>();
/** Display-only. Unfold just the selected topic's ancestors, preserving all
 * committed objects for history, serialization and authoring commands. */
export function revealTopicPath(map:MindMap,id:Id):MindMap{
  if(!Object.hasOwn(map.topics,id))return map;
  const prior=revealedPaths.get(map.topics);
  if(prior?.id===id)return prior.topics===map.topics?map:{...map,topics:prior.topics};
  const parents=parentIndex(map);let topics:Record<Id,Topic>|undefined;
  for(let ancestor=parents.get(id);ancestor;ancestor=parents.get(ancestor)){
    const topic=map.topics[ancestor];if(!topic.collapsed)continue;
    topics??={...map.topics};topics[ancestor]={...topic,collapsed:false};
  }
  revealedPaths.set(map.topics,{id,topics:topics??map.topics});
  return topics?{...map,topics}:map;
}
export function newMindDraft(editor:EditorSession,origin:Point,id=allocateId("map"),rootId=allocateId("topic")):TopicDraft{
  return {generation:editor.generation,topicId:rootId,newTopic:true,map:{
    id,kind:"mindmap",origin:gridPoint(origin),rootId,layout:"balanced",theme:"spectrum",
    topics:{[rootId]:{id:rootId,text:"中心主题",collapsed:false,childIds:[]}},
  }};
}
export function topicDraft(editor:EditorSession,ref:TopicRef,relation?:TopicRelation,newId?:Id):TopicDraft|undefined{
  const map=getMap(editor,ref.mapId);
  if(!map||!Object.hasOwn(map.topics,ref.topicId))return;
  const target=map.topics[ref.topicId];
  if(!relation)return {generation:editor.generation,before:map,map,topicId:target.id,newTopic:false};
  const id=newId??allocateId("topic"), planned=planTopicAddition(map,target.id,relation,id);
  if(planned)return {generation:editor.generation,before:map,map:planned.map,topicId:id,newTopic:true,addition:{relativeTo:target.id,relation}};
}
export function planTopicAddition(map:MindMap,targetId:Id,relation:TopicRelation,id:Id) {
  if(!Object.hasOwn(map.topics,targetId)||Object.hasOwn(map.topics,id))return;
  const target=map.topics[targetId];
  const parent=relation==="child"?target:map.topics[parentIndex(map).get(target.id)??""];
  if(!parent)return;
  const children=[...parent.childIds];
  const position=relation==="child"?children.length:children.indexOf(target.id)+1;
  children.splice(position,0,id);
  const side=parent.id!==map.rootId?undefined:relation==="sibling"?topSide(map,target.id):
    map.layout==="balanced"?(parent.childIds.length%2?"left":"right"):map.layout;
  const newTopic:Topic={id,text:"新主题",childIds:[],collapsed:false,...(side?{side}:{})};
  const topics={...map.topics,[parent.id]:{...parent,childIds:children,collapsed:false},[id]:newTopic};
  const next=keepBranchColors(map,{...map,topics:parent.id===map.rootId?stabilizeRootSides(map,topics):topics});
  return {map:next,parentId:parent.id,position};
}
export function finishTopicDraft(editor:EditorSession,draft:TopicDraft,input:string):boolean{
  if(editor.generation!==draft.generation||objectById(editor.doc,draft.map.id)!==draft.before)return false;
  const topic=draft.map.topics[draft.topicId];
  if(!draft.newTopic&&normalizeBreaks(input)===normalizeBreaks(topic.text))return false;
  const map=withTopicInput(draft.map,topic.id,input,draft.newTopic);
  return editor.commitEdit({label:draft.newTopic?(draft.before?"新增脑图主题":"创建脑图"):"修改脑图主题",patches:[{op:"putObject",value:map}]},draft.generation,[map.id]);
}
export function withTopicInput(map:MindMap,id:Id,input:string,newTopic:boolean):MindMap {
  const topic=map.topics[id],before=newTopic?"":normalizeBreaks(topic.text);
  const entered=boundedTextEdit(before,normalizeBreaks(input),Math.max(MAX_TOPIC_LENGTH,before.length));
  const text=newTopic&&!entered?topic.text:entered;
  return text===topic.text?map:{...map,topics:{...map.topics,[id]:{...topic,text}}};
}
function editMap(editor:EditorSession,map:MindMap,label:string):boolean{
  return editor.commitEdit({label,patches:[{op:"putObject",value:map}]},editor.generation,[map.id]);
}
export function withMindLayout(map:MindMap,layout:unknown):MindMap|undefined {
  if(layout!=="left"&&layout!=="right"&&layout!=="balanced")return;
  return layout===map.layout?map:{...map,layout};
}
export function setMindStyle(editor:EditorSession,id:Id,layout:MindMap["layout"],theme:string|undefined,
  style?:Pick<MindMap,"spacing"|"scale"|"skin">):boolean{
  const map=getMap(editor,id);
  const next=map&&withMindStyle(map,layout,theme,style);
  return Boolean(next&&editMap(editor,next,"修改整张脑图样式"));
}
export function withMindStyle(map:MindMap,layout:MindMap["layout"],theme:string|undefined,style?:Pick<MindMap,"spacing"|"scale"|"skin">){
  if(theme!==map.theme&&!MIND_THEMES.some(value=>value===theme))return;
  const laidOut=withMindLayout(map,layout);
  if(!laidOut)return;
  const next={...laidOut,...(theme!==map.theme?{theme}:{}),...style};
  if(next.spacing!==undefined&&(!Number.isFinite(next.spacing)||next.spacing<4||next.spacing>80)||
    next.scale!==undefined&&(!Number.isFinite(next.scale)||next.scale<.5||next.scale>2)||
    next.skin!==undefined&&!["rounded","square","capsule"].includes(next.skin))return;
  return next;
}
/** Build the canonical edit; temporary tree expansion belongs to the view. */
export function withTopicAppearance(map:MindMap,id:Id,style?:TopicAppearance):MindMap|undefined{
  if(!Object.hasOwn(map.topics,id)||(style!==undefined&&!isTopicAppearance(style)))return;
  if(style?.width!==undefined)style={...style,width:roundWorld(style.width)};
  const {appearance:old,...base}=map.topics[id];
  const keys=["width","strokeWidth","fill","textColor","stroke"] as const;
  if(keys.every(k=>old?.[k]===style?.[k])&&(style!==undefined||old===undefined))return map;
  const topic=style&&Object.keys(style).length?{...base,appearance:{...style}}:base;
  const topics={...map.topics,[id]:topic};
  const parents=parentsByTopics.get(map.topics);
  if(parents)parentsByTopics.set(topics,parents);
  return {...map,topics};
}
export function setTopicAppearance(editor:EditorSession,ref:TopicRef,style?:TopicAppearance):boolean{
  const map=getMap(editor,ref.mapId),next=map&&withTopicAppearance(map,ref.topicId,style);
  return !!next&&next!==map&&editMap(editor,next,"修改脑图主题外观");
}
export function foldTopic(editor:EditorSession,ref:TopicRef):boolean{
  const map=getMap(editor,ref.mapId),topic=map?.topics[ref.topicId];
  if(!map||!topic||!topic.childIds.length)return false;
  return editMap(editor,{...map,topics:{...map.topics,[topic.id]:{...topic,collapsed:!topic.collapsed}}},"展开或折叠脑图分支");
}
export function deleteTopic(editor:EditorSession,ref:TopicRef):Id|undefined{
  const map=getMap(editor,ref.mapId);
  const plan=map&&planTopicDeletion(map,ref.topicId);
  if(plan&&editMap(editor,plan.map,"删除脑图分支"))return plan.parentId;
}
export function planTopicDeletion(map:MindMap,topicId:Id) {
  if(topicId===map.rootId)return;
  const parentId=parentIndex(map).get(topicId);
  if(!parentId)return;
  const parent=map.topics[parentId];
  const topics={...map.topics,[parentId]:{...parent,childIds:parent.childIds.filter(id=>id!==topicId)}};
  const pending=[topicId],removedIds:Id[]=[];
  while(pending.length){
    const id=pending.pop()!,children=topics[id].childIds;
    for(let i=children.length-1;i>=0;i--)pending.push(children[i]);
    removedIds.push(id);
    delete topics[id];
  }
  return {map:keepBranchColors(map,{...map,topics:parentId===map.rootId?stabilizeRootSides(map,topics):topics}),parentId,removedIds};
}
/** A legal drop already at its destination returns the original map. */
export function planTopicMove(map:MindMap,id:Id,drop:TopicDrop):MindMap|undefined{
  if(id===map.rootId||id===drop.target||!Object.hasOwn(map.topics,id)||!Object.hasOwn(map.topics,drop.target))return;
  const index=parentIndex(map),oldParentId=index.get(id);
  const nextParentId = drop.place==="child"?drop.target:index.get(drop.target);
  if(!oldParentId||!nextParentId)return;
  for(let cursor:Id|undefined=nextParentId;cursor;cursor=index.get(cursor))if(cursor===id)return;
  const oldParent=map.topics[oldParentId],parent=map.topics[nextParentId],topic=map.topics[id];
  const oldKids=oldParent.childIds.filter(item=>item!==id);
  const nextKids=nextParentId===oldParentId?[...oldKids]:[...parent.childIds];
  let slot=nextKids.length;
  if(drop.place!=="child"){
    const i=nextKids.indexOf(drop.target);
    if(i<0)return;
    slot=i+(drop.place==="after"?1:0);
  }
  nextKids.splice(slot,0,id);
  const side=nextParentId!==map.rootId?undefined:drop.side ??
    (drop.place==="child"?(oldParentId===nextParentId?topic.side:undefined):topSide(map,drop.target));
  const {side:_oldSide,...withoutSide}=topic;
  const nextTopic=side?{...withoutSide,side}:withoutSide;
  const nextParent={...parent,childIds:nextKids,...(drop.place==="child"?{collapsed:false}:{})};
  if(nextParentId===oldParentId&&nextKids.every((child,i)=>child===oldParent.childIds[i])&&side===topic.side&&nextParent.collapsed===oldParent.collapsed)return map;
  const topics={...map.topics,[oldParentId]:{...oldParent,childIds:oldKids},[nextParentId]:nextParent,[id]:nextTopic};
  const next={...map,topics:(oldParentId===map.rootId||nextParentId===map.rootId)?stabilizeRootSides(map,topics,id):topics};
  return keepBranchColors(map,next);
}
export function dropPlan(map:MindMap,id:Id,drop:TopicDrop):MindMap|undefined{
  const next=planTopicMove(map,id,drop);
  return next===map?undefined:next;
}
export function moveTopic(editor:EditorSession,ref:TopicRef,drop:TopicDrop):boolean{
  const map=getMap(editor,ref.mapId),next=map&&dropPlan(map,ref.topicId,drop);
  return next?editMap(editor,next,"调整脑图层级或顺序"):false;
}
export function reorderTopic(editor:EditorSession,ref:TopicRef,delta:-1|1):boolean{
  const map=getMap(editor,ref.mapId);
  if(!map)return false;
  const parent=map.topics[parentIndex(map).get(ref.topicId)??""];
  if(!parent)return false;
  const position=parent.childIds.indexOf(ref.topicId),target=parent.childIds[position+delta];
  if(!target)return false;
  return moveTopic(editor,ref,{target,place:delta<0?"before":"after",side:topSide(map,ref.topicId)});
}
