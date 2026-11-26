import test from "node:test";
import assert from "node:assert/strict";
import type {MindMap} from "../core/document.ts";
import {planMapOrigin} from "../session/transform.ts";
import {EditorSession} from "../session/editor.ts";
import {mindViewportBoard} from "./fixtures/mind-viewport.ts";
import {buildScene,hitTest,marqueeHit} from "../scene/board.ts";
import {topicPlacement} from "../scene/topic-placement.ts";
import {layoutMap,topicAt,topicBox} from "../features/mindmap-layout.ts";
import {revealTopicPath} from "../features/mindmap.ts";
import {SceneProjection} from "../scene/projector.ts";

test("absolute map placement rounds both axes and refuses incomplete coordinates without a partial move",()=>{
  const board=mindViewportBoard(8),map=board.objects.map as MindMap;
  for(const invalid of [undefined,NaN,Infinity,-Infinity]){
    assert.equal(planMapOrigin(map,invalid,5),undefined);assert.equal(planMapOrigin(map,5,invalid),undefined);
  }
  assert.equal(planMapOrigin(map,0,0)?.size,0);
  const far={...map,origin:{x:1e16,y:-1e16}};
  const placed=planMapOrigin(far,-.25,0)?.get("map") as MindMap;
  assert.deepEqual(placed.origin,{x:0,y:0});assert.equal(placed.topics,map.topics);assert.deepEqual(map.origin,{x:0,y:0});
  const editor=new EditorSession(board,{offset:{x:0,y:0},zoom:1});editor.select("map");
  const initial=editor.doc.objects.map as MindMap;
  assert(editor.transformSelection({x:12.25,y:-20}));assert.equal((editor.doc.objects.map as MindMap).topics,initial.topics);
  assert(!editor.transformSelection({x:12.25,y:-20}));editor.undo();assert.deepEqual(editor.doc,board);editor.redo();assert.deepEqual((editor.doc.objects.map as MindMap).origin,{x:12,y:-20});
});

test("world primitives, selection bounds, picks and marquee all follow one shared local tree",()=>{
  const board=mindViewportBoard(1000,"chain",true),map=board.objects.map as MindMap,projector=new SceneProjection(board);
  const local=projector.all().find(g=>g.id==="map")!,rows=layoutMap(map),origin={x:-487.25,y:162.5};
  const moved={...map,origin};const patch=projector.overlay({objects:new Map([["map",moved]])}),g=patch.get("map")!;
  assert.equal(topicPlacement(g)?.local,local);assert.equal(layoutMap(moved),rows);
  const shift=(p:{x:number;y:number})=>({x:p.x+origin.x,y:p.y+origin.y});
  assert.deepEqual(g.bounds,{min:shift(local.bounds.min),max:shift(local.bounds.max)});
  for(const i of [0,998,999,1000,2998]){
    const before=local.items[i],after=g.items[i];assert.equal(before.kind,after.kind);
    if(before.kind==="path"&&after.kind==="path")assert.deepEqual(after.points,before.points.map(shift));
    if("box" in before&&"box" in after)assert.deepEqual(after.box,{...before.box,at:shift(before.box.at)});
  }
  assert.deepEqual(g.picks[0],{shape:"rect",box:topicBox(moved,"t0")!.box});
  const target={min:{x:origin.x-1,y:origin.y-1},max:{x:origin.x+1,y:origin.y+1}};
  assert.equal(hitTest(projector.query(target,patch),origin,0),"map");assert.equal(topicAt(moved,origin)?.topicId,"t0");
  assert.deepEqual(marqueeHit([g],target),["map"]);assert.equal(hitTest([g],map.origin,0),undefined);
  assert.deepEqual(marqueeHit([local],target),[]);assert.equal(projector.all().find(x=>x.id==="map"),local);
});

test("unfolding the same temporary ancestor path retains its local rows across placements and preserves canonical folds",()=>{
  const board=mindViewportBoard(90),map=board.objects.map as MindMap;
  const folded={...map,topics:{...map.topics,t3:{...map.topics.t3,collapsed:true}}};
  const display=revealTopicPath(folded,"t70"),other=revealTopicPath({...folded,origin:{x:-72.25,y:89}},"t70");
  assert.equal(display.topics,other.topics);assert.equal(layoutMap(display),layoutMap(other));
  assert(folded.topics.t3.collapsed&&!display.topics.t3.collapsed);
  const row=layoutMap(display).find(row=>row.topic.id==="t70")!;
  const center={x:other.origin.x+row.box.at.x+row.box.width/2,y:other.origin.y+row.box.at.y+row.box.height/2};
  assert.equal(topicAt(other,center)?.topicId,"t70");
  const original=buildScene({...board,objects:{map:display}})[0];
  const warm=buildScene({...board,objects:{map:{...other,theme:"warm"}}})[0];assert.notEqual(topicPlacement(warm)?.local,original);
  assert.notEqual(warm.items.find(p=>p.kind==="box")?.fill,original.items.find(p=>p.kind==="box")?.fill);
});
