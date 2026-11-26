import assert from "node:assert/strict";
import test from "node:test";
import type {MindMap} from "../core/document.ts";
import {deleteTopic,planTopicAddition,withTopicInput} from "../features/mindmap.ts";
import {layoutMap,topicAt} from "../features/mindmap-layout.ts";
import type {LocalTopic} from "../features/mindmap-layout.ts";
import {buildScene} from "../scene/board.ts";
import {MindLayoutMotion} from "../scene/mindmap-motion.ts";
import {reflowDuration} from "../scene/motion-timing.ts";
import {EditorSession} from "../session/editor.ts";
import {mixed} from "./fixtures/mixed.ts";

const basis:MindMap={...mixed.objects["map-a"],origin:{x:0,y:0}};
const add=(map:MindMap,parent:string,id:string)=>planTopicAddition(map,parent,"child",id)!.map;
const row=(rows:readonly LocalTopic[],id:string)=>rows.find(r=>r.topic.id===id)!;
const port=(r:LocalTopic,left:boolean)=>({x:r.box.at.x+(left?0:r.box.width),y:r.box.at.y+r.box.height*(r.depth>=3?1:.5)});

test("new themes unfold from the parent's port on either side while siblings and all curve endpoints share the displayed layout",()=>{
  for(const [side,branch] of [["right","child-a"],["left","child-b"]] as const){
    const before=add(basis,branch,"sibling"),after=add(before,branch,"fresh"),motion=new MindLayoutMotion();
    const goal=layoutMap(after),initial=layoutMap(before);
    motion.transition(before,after,0);
    const added=motion.liveRows(after.id)!.find(r=>r.topic.id==="fresh")!;
    assert.equal(added.alpha,0);assert.equal(added.box.width,0);assert.deepEqual(added.box.at,port(row(initial,branch),side==="left"));
    motion.tick(70);const rows=motion.liveRows(after.id)!,child=rows.find(r=>r.topic.id==="fresh")!;
    assert(child.alpha!>0&&child.alpha!<1);assert(child.box.width>0&&child.box.width<row(goal,"fresh").box.width);
    assert.notDeepEqual(row(rows,"sibling").box,row(initial,"sibling").box);
    assert.notDeepEqual(row(rows,"sibling").box,row(goal,"sibling").box);
    const items=buildScene(mixed,{objects:new Map([[after.id,after]]),topicLayouts:motion.layouts},[after.id])[0].items;
    const curve=items.find(p=>p.kind==="path"&&p.topicAlpha===child.alpha);
    assert(curve?.kind==="path");assert.deepEqual(curve.points[0],port(row(rows,branch),side==="left"));
    assert.deepEqual(curve.points.at(-1),port(child,side!=="left"));
    const continued=add(after,"fresh","deep");motion.transition(after,continued,70);
    assert.deepEqual(row(motion.liveRows(after.id)!,"fresh").box,child.box);
    const renamed=withTopicInput(continued,"deep","现场输入的中文和 123456",true);
    motion.transition(continued,renamed,100);
    assert.equal(row(motion.liveRows(after.id)!,"deep").topic.text,"现场输入的中文和 123456");
    motion.tick(70+reflowDuration);assert(!motion.active);
    motion.transition(renamed,renamed,330);assert(!motion.active);
  }
});

test("a removed subtree and its curves recede together, leave hit testing immediately, and undo smoothly reverses the sampled poses",()=>{
  const before=add(add(add(basis,"child-b","keep"),"child-b","branch"),"branch","tip");
  const doc={...mixed,objects:{...mixed.objects,[before.id]:before}};
  const e=new EditorSession(doc,{offset:{x:0,y:0},zoom:1}),start=e.doc;
  assert.equal(deleteTopic(e,{mapId:before.id,topicId:"branch"}),"child-b");
  const after=e.doc.objects[before.id] as MindMap,motion=new MindLayoutMotion();
  motion.transition(before,after,0);motion.tick(65);
  const rows=motion.layouts.get(before.id)!,leaving=rows.filter(r=>r.retiring),live=motion.liveRows(before.id)!;
  assert.deepEqual(leaving.map(r=>r.topic.id),["branch","tip"]);
  assert.deepEqual(live.map(r=>r.topic.id),layoutMap(after).map(r=>r.topic.id));
  const group=buildScene(e.doc,{objects:new Map(),topicLayouts:motion.layouts},[before.id])[0];
  assert.equal(group.picks.length,live.length);assert.deepEqual(group.topicIds,live.map(r=>r.topic.id));
  assert.equal(group.items.filter(i=>i.kind==="path"&&i.topicAlpha!==undefined).length,2);
  for(const v of leaving){
    assert(v.box.width>0&&v.box.width<row(layoutMap(before),v.topic.id).box.width);
    assert.notEqual(topicAt(after,v.box.at,0,live)?.topicId,v.topic.id);
  }
  e.undo();assert.equal(e.doc,start);motion.transition(after,before,65);
  const reversed=motion.liveRows(before.id)!;
  for(const v of leaving){
    const revived=reversed.find(r=>r.topic.id===v.topic.id)!;
    assert.deepEqual(revived.box,v.box);assert.equal(revived.alpha,v.alpha);assert(!revived.retiring);
  }
  motion.tick(90);assert(row(motion.liveRows(before.id)!,"tip").box.width>row(rows,"tip").box.width);
  motion.tick(65+reflowDuration);assert(!motion.active);assert.equal(e.history.past.length,0);
});
