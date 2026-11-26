import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {TopicOutline,TOPIC_PAGE_SIZE} from "../app/topic-outline.ts";
import {layerQuery} from "../app/layer-search.ts";
import {MindMapInput} from "../features/mindmap-input.ts";
import {deleteTopic,finishTopicDraft,foldTopic,getMap,moveTopic,parentIndex,revealTopicPath,topicDraft} from "../features/mindmap.ts";
import {topicBoxes} from "../features/mindmap-layout.ts";
import {EditorSession} from "../session/editor.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {captureClipboard,encodeClipboard} from "../features/clipboard.ts";
import type {MindMap,Topic} from "../core/document.ts";
const bytes=readFileSync(new URL("../docs/fixtures/M5AI-Topic-Tree.mgcanvas",import.meta.url),"utf8"),doc=decodeProject(bytes).document;
const map=doc.objects["booking-map"] as MindMap,vault=new AssetVault(),ref=(topicId:string)=>({mapId:map.id,topicId});
function init(){
  const e=new EditorSession(doc,{zoom:1,offset:{x:0,y:0}}),mind=new MindMapInput(e,()=>map.id,()=>{});
  e.listen(()=>mind.sync());e.markSaved(e.generation,0);
  return {e,mind,source:()=>getMap(e,map.id)!};
}
test("sidebar preorder, local branch state, full-depth normalized search and same-name identities are independent of saved folds",()=>{
  const outline=new TopicOutline(map),folds=new Map<string,boolean>();
  const ids=(query="")=>outline.list(layerQuery(query),folds).map(r=>r.topic.id);
  assert.deepEqual(ids(),["root","booking","desk","calendar","archive","dup-b","cafe","closed-other"]);
  assert.deepEqual(ids("复核"),["dup-a","dup-same","dup-b"]);assert.deepEqual(ids("deskflow"),["calendar"]);
  assert.deepEqual(ids(" CAFÉ "),["cafe"]);assert.deepEqual(ids("无结果"),[]);
  const contexts=outline.list("复核",folds).map(r=>outline.context(r,true));assert.equal(new Set(contexts).size,3);assert(contexts[0].includes("现场"));assert(contexts[2].includes("归档"));
  folds.set("desk",true);assert(ids().includes("dup-same"));folds.set("booking",false);assert(!ids().includes("calendar"));
  assert.deepEqual(ids("复核"),["dup-a","dup-same","dup-b"]);assert(map.topics.desk.collapsed&&!map.topics.booking.collapsed);
});
test("exact sidebar selection reveals only its ancestors, remains pickable on canvas and preserves clipboard, document and history",()=>{
  const {e,mind}=init();e.select(map.id);const old=e.history,copy=()=>encodeClipboard(captureClipboard(e.doc,e.selectedIds,vault)!);
  const original=copy();assert(mind.focus(map.id,"dup-a",true));assert.equal(mind.selected?.topicId,"dup-a");
  const shown=mind.displayMap(map);assert.equal(mind.displayMap(map),shown);assert.notEqual(shown,map);
  assert.equal(shown.topics.desk.collapsed,false);assert.equal(shown.topics["closed-other"],map.topics["closed-other"]);assert.equal(shown.topics["dup-a"],map.topics["dup-a"]);
  const box=topicBoxes(shown).find(row=>row.topic.id==="dup-a")!.box;
  assert.deepEqual(mind.decor().selected,box);assert.deepEqual(mind.at({x:box.at.x+8,y:box.at.y+8}),ref("dup-a"));
  assert(!topicBoxes(map).some(row=>row.topic.id==="dup-a"));assert.equal(e.history,old);assert(!e.dirty);assert.equal(encodeProject(e.doc,vault),bytes);assert.equal(copy(),original);
  assert(!mind.focus(map.id,"missing",true));assert.deepEqual(mind.selected,ref("dup-a"));mind.reset();assert.equal(mind.displayMap(map),map);
  assert(mind.focus(map.id,"dup-a"));assert.deepEqual(mind.selected,ref("desk"));
});
test("canonical rename, add, reparent, delete and undo retain branch ownership and synchronize a surviving selected ID",()=>{
  const {e,mind,source}=init();mind.focus(map.id,"dup-a",true);
  const edit=topicDraft(e,ref("dup-a"))!;assert.equal(edit.map,source());assert(finishTopicDraft(e,edit,"复核甲"));
  assert(source().topics.desk.collapsed);assert.deepEqual(mind.selected,ref("dup-a"));assert.equal(e.history.past.length,1);
  const add=topicDraft(e,ref("dup-a"),"child")!;assert(finishTopicDraft(e,add,"新子项"));mind.focus(map.id,add.topicId,true);
  assert(source().topics.desk.collapsed);e.undo();assert.deepEqual(mind.selected,ref("dup-a"));assert(!source().topics[add.topicId]);
  assert(moveTopic(e,ref("dup-a"),{target:"archive",place:"child"}));assert(source().topics.desk.collapsed&&source().topics.archive.childIds.includes("dup-a"));
  assert.equal(mind.displayMap(source()),source());e.undo();assert.deepEqual(mind.selected,ref("dup-a"));assert(!mind.displayMap(source()).topics.desk.collapsed);
  assert.equal(deleteTopic(e,ref("desk")),"booking");assert.equal(mind.selected?.topicId,"booking");e.undo();e.undo();assert.equal(encodeProject(e.doc,vault),bytes);
});
test("explicit document folds, independent maps sharing topic IDs, locks, hiding and board replacement stay scoped",()=>{
  const {e,mind,source}=init();mind.focus(map.id,"booking",true);assert(foldTopic(e,ref("booking")));assert(mind.displayMap(source()).topics.booking.collapsed);
  assert(mind.focus(map.id,"dup-same",true));assert(!mind.displayMap(source()).topics.booking.collapsed);assert(source().topics.booking.collapsed);e.undo();
  assert(mind.focus("archive-map","dup-a",true));assert.deepEqual(mind.selected,{mapId:"archive-map",topicId:"dup-a"});assert.equal(mind.displayMap(source()),source());
  e.setLayerLocks(["archive-map"],true);assert(!mind.active&&!mind.focus("archive-map","dup-a",true));
  e.setLayerLocks(["archive-map"],false);mind.focus(map.id,"dup-a",true);e.setLayerVisibility([map.id],false);
  assert(!mind.active&&!mind.focus(map.id,"dup-a",true));e.open(doc,true);assert(!mind.active&&!e.selectedIds.length);assert.equal(encodeProject(e.doc,vault),bytes);
});
test("a 16000-level chain is indexed, searched and revealed iteratively; each page and path caption remain bounded",()=>{
  const n=16000,topics:Record<string,Topic>=Object.create(null);
  for(let i=0;i<n;i++)topics["t"+i]={id:"t"+i,text:i===n-1?"深处目标":"层",childIds:i+1<n?["t"+(i+1)]:[],collapsed:i%7===0};
  const chain={...map,rootId:"t0",topics},outline=new TopicOutline(chain),last="t"+(n-1);
  assert.equal(outline.rows.length,n);assert.equal(outline.list("",new Map()).length,1);
  const [hit]=outline.list("深处目标",new Map());assert.equal(hit.depth,n-1);assert(outline.context(hit,true).length<35);
  const revealed=revealTopicPath(chain,last);assert.equal(topics.t0.collapsed,true);assert.equal(revealed.topics.t0.collapsed,false);
  assert.equal(parentIndex(chain),parentIndex(chain));assert.equal(revealTopicPath(revealed,last),revealed);
  const all=new TopicOutline(revealed).list("",new Map());assert.equal(all.length,n);assert.equal(all.slice(TOPIC_PAGE_SIZE,TOPIC_PAGE_SIZE*2).length,64);
});
