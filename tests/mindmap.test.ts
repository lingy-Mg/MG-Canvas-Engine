import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSession } from "../session/editor.ts";
import { MindMapInput } from "../features/mindmap-input.ts";
import { deleteTopic,dropPlan,finishTopicDraft,foldTopic,getMap,moveTopic,newMindDraft,parentIndex,reorderTopic,setMindStyle,topicDraft,topSide,visibleTopic } from "../features/mindmap.ts";
import type { TopicDraft,TopicRef } from "../features/mindmap.ts";
import { topicEditKey } from "../features/plain-text.ts";
import { layoutMap,topicBoxes } from "../features/mindmap-layout.ts";
import { buildScene,hitTest } from "../scene/board.ts";
import { worldToScreen,screenToWorld } from "../core/geometry.ts";
import { AssetVault } from "../features/image-assets.ts";
import { decodeProject,encodeProject } from "../platform/project.ts";
import { mixed } from "./fixtures/mixed.ts";
import type { MindMap } from "../core/document.ts";
const p=(x:number,y:number)=>({x,y});
function env(){
  const e=new EditorSession(mixed,{offset:p(193,270),zoom:1.4});
  const ready:TopicDraft[]=[];
  const query=(point:ReturnType<typeof p>)=>hitTest(buildScene(e.doc),screenToWorld(point,e.camera),5/e.camera.zoom);
  const mind=new MindMapInput(e,query,draft=>ready.push(draft));
  e.listen(()=>mind.sync());
  return {e,mind,ready,screen:(world:ReturnType<typeof p>)=>worldToScreen(world,e.camera)};
}
function add(e:EditorSession,ref:TopicRef,text:string,kind:"child"|"sibling"="child"):string{
  const draft=topicDraft(e,ref,kind);assert(draft);
  assert(finishTopicDraft(e,draft,text));
  return draft.topicId;
}
const ref=(topicId:string,mapId="map-a"):TopicRef=>({mapId,topicId});
function center(map:MindMap,id:string,offset=0){
  const box=topicBoxes(map).find(t=>t.topic.id===id)?.box;assert(box);
  return p(box.at.x+box.width/2,box.at.y+box.height/2+offset);
}

test("new independent map is staged without history; initial text and creation undo together",()=>{
  const {e}=env(),baseline=e.doc;
  const abandoned=newMindDraft(e,p(300,500));
  assert(!e.doc.objects[abandoned.map.id]);assert.equal(e.history.past.length,0);
  const draft=newMindDraft(e,p(800,500));
  assert.equal(buildScene(e.doc,{objects:new Map([[draft.map.id,draft.map]]),extra:[draft.map.id]}).at(-1)?.id,draft.map.id);
  assert(!e.doc.objects[draft.map.id]);assert(finishTopicDraft(e,draft,"网络规划"));
  assert.equal(getMap(e,draft.map.id)?.topics[draft.topicId].text,"网络规划");assert.equal(e.history.past.length,1);
  e.undo();assert.strictEqual(e.doc,baseline);e.redo();assert.equal(e.doc.objects[draft.map.id].kind,"mindmap");
});

test("child and sibling prepare and apply ordered trees; a root never gets a sibling",()=>{
  const {e}=env(),initial=e.doc;
  assert.equal(topicDraft(e,ref("root-a"),"sibling"),undefined);
  const child=add(e,ref("child-a"),"工作日\r\n预约");
  const sibling=add(e,ref(child),"假期预约","sibling");
  const middle=getMap(e,"map-a")!;
  assert.deepEqual(middle.topics["child-a"].childIds,[child,sibling]);
  assert.equal(middle.topics[child].text,"工作日\n预约");
  const planned=topicDraft(e,ref(sibling),"sibling")!;assert(!middle.topics[planned.topicId]);
  assert.equal(e.history.past.length,2); e.undo();
  assert(!getMap(e,"map-a")!.topics[sibling]);
  assert.strictEqual(e.doc.objects["link-main"],initial.objects["link-main"]);
  assert.strictEqual(e.doc.objects["map-b"],initial.objects["map-b"]);
});
test("an outdated topic draft cannot overwrite changed tree or write into reopened board",()=>{
  const {e}=env(),draft=topicDraft(e,ref("root-a"),"child")!;
  add(e,ref("child-a"),"先发生");
  assert(!finishTopicDraft(e,draft,"不能覆盖"));assert.equal(e.history.past.length,1);
  const retry=topicDraft(e,ref("root-a"),"child")!;
  e.open(mixed,false);assert(!finishTopicDraft(e,retry,"同一文件不同会话"));assert.equal(e.history.past.length,0);
});

test("drop guards cycles and roots; reparent and reorder are single commands scoped to one tree",()=>{
  const {e}=env(),node=add(e,ref("child-a"),"权限");
  const deeper=add(e,ref(node),"访客");
  const prior=e.doc,map=getMap(e,"map-a")!;
  assert.equal(dropPlan(map,"child-a",{target:deeper,place:"child"}),undefined);
  assert.equal(dropPlan(map,"root-a",{target:"child-b",place:"child"}),undefined);
  assert(!moveTopic(e,ref(node),{target:"root-b",place:"child"}));
  assert(moveTopic(e,ref(node),{target:"child-b",place:"child"}));
  assert.equal(parentIndex(getMap(e,"map-a")!).get(node),"child-b");
  assert.strictEqual(e.doc.objects["map-b"],prior.objects["map-b"]);assert.strictEqual(e.doc.objects["link-main"],prior.objects["link-main"]);
  e.undo();assert.strictEqual(e.doc,prior);
  const next=add(e,ref(node),"员工","sibling");
  assert(reorderTopic(e,ref(next),-1));assert.deepEqual(getMap(e,"map-a")!.topics["child-a"].childIds,[next,node]);
});
test("fold hides descendants, focus falls back to visible ancestor; subtree deletion is undoable",()=>{
  const {e,mind}=env(),child=add(e,ref("child-a"),"嵌套活动");
  assert(mind.focus("map-a",child));
  assert(foldTopic(e,ref("child-a")));
  assert.equal(visibleTopic(getMap(e,"map-a")!,child),"child-a");assert.equal(mind.selected?.topicId,"child-a");
  assert(!layoutMap(getMap(e,"map-a")!).some(t=>t.topic.id===child));
  e.undo();assert(layoutMap(getMap(e,"map-a")!).some(t=>t.topic.id===child));
  const prior=e.doc;
  assert.equal(deleteTopic(e,ref("root-a")),undefined);
  assert.equal(deleteTopic(e,ref("child-a")),"root-a");
  assert(!getMap(e,"map-a")!.topics[child]);e.undo();assert.strictEqual(e.doc,prior);
});
test("layout handles wrapped text, directional changes and per-map theme in the mixed scene",()=>{
  const {e}=env();
  const a=add(e,ref("child-a"),"很长的主题反复测试间距\n第二行以及余量".repeat(12));
  const b=add(e,ref(a),"短主题","sibling");
  const other=e.doc.objects["map-b"], before=e.doc.objects["link-main"];
  assert(setMindStyle(e,"map-a","left","mint"));
  const map=getMap(e,"map-a")!,computed=layoutMap(map);
  for(const {depth,box} of computed)if(depth>0)assert(box.at.x+box.width<0);
  const top=computed.find(t=>t.topic.id===a)!,bottom=computed.find(t=>t.topic.id===b)!;
  assert(top.lines.length>1);assert(top.box.at.y+top.box.height<bottom.box.at.y);
  const root=buildScene(e.doc).find(g=>g.id==="map-a")?.items.find(x=>x.kind==="box");
  assert(root?.kind==="box");assert.equal(root.fill,"#13564d");
  assert.strictEqual(e.doc.objects["map-b"],other);assert.strictEqual(e.doc.objects["link-main"],before);
  assert(setMindStyle(e,"map-a","right","warm"));
  assert(layoutMap(getMap(e,"map-a")!).every(t=>t.depth===0||t.box.at.x>0));
  assert(setMindStyle(e,"map-a","balanced","indigo"));
  const portable=decodeProject(encodeProject({...e.doc,order:e.doc.order.filter(id=>id!=="picture"),assets:{},objects:Object.fromEntries(Object.entries(e.doc.objects).filter(([id])=>id!=="picture"))},new AssetVault()));
  assert.deepEqual(portable.document.objects["map-a"],getMap(e,"map-a"));
});
test("top-level reorder pins legacy implicit sides so unrelated branches do not flip",()=>{
  const {e}=env();
  const draft=newMindDraft(e,p(200,100));
  const map:MindMap={...draft.map,topics:{
    [draft.topicId]:{...draft.map.topics[draft.topicId],childIds:["one","two","three"]},
    one:{id:"one",text:"一",collapsed:false,childIds:[]},two:{id:"two",text:"二",collapsed:false,childIds:[]},three:{id:"three",text:"三",collapsed:false,childIds:[]},
  }};
  assert(finishTopicDraft(e,{...draft,map},map.topics[map.rootId].text));
  assert.equal(topSide(map,"two"),"left");
  assert(moveTopic(e,ref("one",map.id),{target:"three",place:"after",side:"right"}));
  const reordered=getMap(e,map.id)!;assert.deepEqual(reordered.topics[map.rootId].childIds,["two","three","one"]);
  assert.equal(topSide(reordered,"two"),"left");assert.equal(topSide(reordered,"three"),"right");
});

test("mouse target preview marks valid reparent, rejects a cycle, and cancels without speculative focus or edits",()=>{
  const {e,mind,screen}=env();
  const child=add(e,ref("child-a"),"下层");
  const map=getMap(e,"map-a")!;
  assert(mind.focus(map.id,map.rootId));
  const source=screen(center(map,"child-a")),invalid=screen(center(map,child)),valid=screen(center(map,"child-b",-6));
  const before=e.doc;
  assert(mind.down(1,"mouse",source));mind.move(1,invalid);
  assert.equal(mind.decor().drop?.valid,false);mind.up(1,invalid);
  assert.strictEqual(e.doc,before);assert.equal(mind.selected?.topicId,map.rootId);
  assert(mind.down(2,"mouse",source));mind.move(2,valid);assert.equal(mind.decor().drop?.valid,true);
  mind.cancelPointer();assert(!mind.up(2,valid));assert.strictEqual(e.doc,before);
  assert(mind.down(3,"mouse",source));mind.move(3,valid);mind.up(3,valid);
  assert.equal(parentIndex(getMap(e,map.id)!).get("child-a"),map.rootId);
  assert.equal(topSide(getMap(e,map.id)!,"child-a"),topSide(map,"child-b"));
  assert.equal(mind.selected?.topicId,"child-a");e.undo();assert.strictEqual(e.doc,before);
});

test("tap selects nested topic; top-edge drop reorders and a different map is not a valid drop target",()=>{
  const {e,mind,screen}=env();
  const node=add(e,ref("child-a"),"一"),second=add(e,ref(node),"二","sibling");
  const map=getMap(e,"map-a")!,other=getMap(e,"map-b")!;
  assert(!mind.selected,"start outside topic editing mode");
  const source=screen(center(map,second));
  assert(mind.down(1,"touch",source));mind.up(1,source);
  assert.equal(mind.selected?.topicId,second);assert.equal(e.selection,map.id);
  const wrong=screen(center(other,other.rootId));
  assert(mind.down(2,"touch",source));mind.move(2,wrong);assert(!mind.decor().drop);mind.up(2,wrong);
  const box=topicBoxes(map).find(t=>t.topic.id===node)!.box;
  const target=screen(p(box.at.x+box.width/2,box.at.y+1));
  assert(mind.down(3,"touch",source));mind.move(3,target);assert.equal(mind.decor().drop?.drop.place,"before");mind.up(3,target);
  assert.deepEqual(getMap(e,map.id)!.topics["child-a"].childIds,[second,node]);
  e.select("shape-start");assert(!mind.selected);
});
test("create gesture issues a draft; keyboard actions protect composition and support consecutive structural edits",()=>{
  const {e,mind,ready,screen}=env(), blank=screen(p(800,-200));
  mind.armCreate(true);assert(mind.down(1,"touch",blank));mind.up(1,blank);
  assert.equal(ready.length,1);assert(!e.doc.objects[ready[0].map.id]);
  const key={key:"Enter",ctrlKey:false,metaKey:false,shiftKey:false,isComposing:false};
  assert.equal(topicEditKey(key,true,false),undefined);
  assert.equal(topicEditKey(key,false,true),undefined);
  assert.equal(topicEditKey({...key,isComposing:true},false,false),undefined);
  assert.equal(topicEditKey({...key,keyCode:229},false,false),undefined);
  assert.equal(topicEditKey({...key,ctrlKey:true},false,false),"newline");
  assert.equal(topicEditKey({...key,key:"Tab"},false,false),"child");
  assert.equal(topicEditKey({...key,key:"Tab",shiftKey:true},false,false),undefined);
  assert.equal(topicEditKey(key,false,false),"commit");
  assert.equal(topicEditKey({...key,key:"Escape"},false,false),"cancel");
});
