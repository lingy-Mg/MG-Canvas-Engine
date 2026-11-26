import {test} from "node:test";
import assert from "node:assert/strict";
import {createHistory,diffDocuments,dispatch,redo,undo} from "../core/history.ts";
import type {History,HistoryResult,Patch} from "../core/history.ts";
import {assertDocument,DocumentValidationError,resolveEndpoint} from "../core/document.ts";
import type {BoardObject,Connector,MindMap,ShapeObject} from "../core/document.ts";
import {rectBetween} from "../core/geometry.ts";
import {buildScene,hitTest,marqueeHit} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";
import {layoutMap} from "../features/mindmap-layout.ts";
import {largeBoard} from "./fixtures/large-board.ts";
import {mixed} from "./fixtures/mixed.ts";

const p=(x:number,y:number)=>({x,y});
const apply=(h:History,...patches:Patch[])=>dispatch(h,{label:"test",patches});
const shape=(o:BoardObject):ShapeObject=>{assert(o.kind==="shape");return o;};
const line=(o:BoardObject):Connector=>{assert(o.kind==="connector");return o;};
const map=(o:BoardObject):MindMap=>{assert(o.kind==="mindmap");return o;};
function equivalent(index:SceneProjection,next:HistoryResult){
  const rebuilt=new SceneProjection(next.state.doc);
  assert.deepEqual(index.all(),rebuilt.all());
  for(const limits of [rectBetween(p(-300,-100),p(145,170)),rectBetween(p(-20000,-20000),p(20000,20000)),rectBetween(p(2400,-450),p(4000,260))]){
    assert.deepEqual(index.query(limits),rebuilt.query(limits));
    assert.deepEqual(marqueeHit(index.query(limits),limits),marqueeHit(rebuilt.query(limits),limits));
  }
}
test("incremental shape resize/move updates attached line, not its stored pins; undo/redo match rebuild",()=>{
  const initial=createHistory(largeBoard(1500).document),s=shape(initial.doc.objects["s-0"]);
  const index=new SceneProjection(initial.doc),unrelated=index.all().find(g=>g.id==="s-1")!;
  const moved=apply(initial,{op:"putObject",value:{...s,at:p(2600,-350),height:s.height+12}});
  assert.deepEqual(index.update(moved.state.doc,moved.changeSet),{mode:"incremental",projected:2});
  equivalent(index,moved);
  assert.strictEqual(index.all().find(g=>g.id==="s-1"),unrelated);
  assert.strictEqual(moved.state.doc.objects["l-6"],initial.doc.objects["l-6"]);
  assert(!index.query(rectBetween(p(-4,-4),p(112,54))).some(g=>g.id==="s-0"));
  assert(index.query(rectBetween(p(2590,-370),p(2760,-240))).some(g=>g.id==="s-0"));
  const before=undo(moved.state);
  assert.deepEqual(index.update(before.state.doc,before.changeSet),{mode:"incremental",projected:2});equivalent(index,before);
  const after=redo(before.state);index.update(after.state.doc,after.changeSet);equivalent(index,after);
});
test("insert, order change, rewire, and removal update spatial memberships and z without rebuilding",()=>{
  const state=createHistory(mixed),idx=new SceneProjection(state.doc);
  const s=shape(state.doc.objects["shape-start"]),copy={...s,id:"inserted"};
  let r=apply(state,{op:"putObject",value:copy});
  assert.deepEqual(idx.update(r.state.doc,r.changeSet),{mode:"incremental",projected:1});equivalent(idx,r);
  const area=rectBetween(p(-160,-36),p(-130,-15)),probe=p(-145,-24);
  assert.equal(hitTest(idx.query(area),probe,1),"inserted");
  const order=r.state.doc.order,inserted=idx.all().find(g=>g.id===copy.id);
  r=apply(r.state,{op:"setOrder",ids:[copy.id,...order.filter(id=>id!==copy.id)]});
  assert.deepEqual(idx.update(r.state.doc,r.changeSet),{mode:"incremental",projected:0});
  assert.equal(hitTest(idx.query(area),probe,1),"shape-start");
  assert.strictEqual(idx.all().find(g=>g.id===copy.id),inserted);
  let original=line(r.state.doc.objects["link-main"]);
  r=apply(r.state,{op:"putObject",value:{...original,from:{kind:"anchor",objectId:copy.id,portId:"south"}}});
  idx.update(r.state.doc,r.changeSet);equivalent(idx,r);
  const moved=(id:string)=>{
    const item=shape(r.state.doc.objects[id]);
    return idx.overlay({objects:new Map([[id,{...item,at:p(12,16)}]])});
  };
  assert(!moved(s.id).has("link-main"));assert(moved(copy.id).has("link-main"));
  original=line(r.state.doc.objects["link-main"]);
  const anchor=resolveEndpoint(r.state.doc,original.from)!;
  r=apply(r.state,{op:"putObject",value:{...original,from:{kind:"free",point:anchor}}},{op:"removeObject",id:copy.id});
  idx.update(r.state.doc,r.changeSet);equivalent(idx,r);
  assert(!idx.query(area).some(g=>g.id===copy.id));
  const back=undo(r.state);idx.update(back.state.doc,back.changeSet);equivalent(idx,back);
  assert(idx.overlay({objects:new Map([[copy.id,{...copy,at:p(88,88)}]])}).has("link-main"));
});
test("local vs spanning membership is replaced on update and delete, including far-away probes",()=>{
  const state=createHistory(mixed),idx=new SceneProjection(state.doc),free=line(state.doc.objects["free-line"]);
  const long={...free,from:{kind:"free" as const,point:p(-2e5,500)},to:{kind:"free" as const,point:p(2e5,500)}};
  let r=apply(state,{op:"putObject",value:long});idx.update(r.state.doc,r.changeSet);equivalent(idx,r);
  const at=rectBetween(p(99990,499),p(100002,503));
  assert(idx.query(at).some(g=>g.id===long.id));
  r=apply(r.state,{op:"putObject",value:free});idx.update(r.state.doc,r.changeSet);equivalent(idx,r);
  assert(!idx.query(at).some(g=>g.id===free.id));
  r=apply(r.state,{op:"removeObject",id:free.id});idx.update(r.state.doc,r.changeSet);equivalent(idx,r);
  assert(!idx.all().some(g=>g.id===free.id));
});
test("map origin keeps local layout cache; local edit reprojects same map only",()=>{
  const state=createHistory(mixed),idx=new SceneProjection(state.doc),m=map(state.doc.objects["map-a"]);
  const oldLayout=layoutMap(m),neighbor=idx.all().find(g=>g.id==="map-b"),flow=idx.all().find(g=>g.id==="link-main");
  let r=apply(state,{op:"putObject",value:{...m,origin:p(84,-307)}});
  assert.deepEqual(r.changeSet.invalidatedMaps,[]);
  assert.deepEqual(idx.update(r.state.doc,r.changeSet),{mode:"incremental",projected:1});
  assert.strictEqual(layoutMap(map(r.state.doc.objects[m.id])),oldLayout);
  equivalent(idx,r);
  const moved=map(r.state.doc.objects[m.id]),root=moved.topics[moved.rootId];
  r=apply(r.state,{op:"putObject",value:{...moved,topics:{...moved.topics,[root.id]:{...root,collapsed:true}}}});
  assert.deepEqual(r.changeSet.invalidatedMaps,[m.id]);
  assert.deepEqual(idx.update(r.state.doc,r.changeSet),{mode:"incremental",projected:1});
  assert.strictEqual(idx.all().find(g=>g.id==="map-b"),neighbor);assert.strictEqual(idx.all().find(g=>g.id==="link-main"),flow);
  assert.equal(layoutMap(map(r.state.doc.objects[m.id])).length,1);equivalent(idx,r);
});
test("missing deltas, new board, global theme, broad edit deliberately use full rebuild",()=>{
  const state=createHistory(largeBoard(1500).document),idx=new SceneProjection(state.doc);
  const theme=apply(state,{op:"setTheme",theme:"dark"});
  assert.equal(idx.update(theme.state.doc,theme.changeSet).mode,"full");
  assert.equal(idx.update(theme.state.doc).mode,"none");
  const wide=apply(theme.state,...Object.values(theme.state.doc.objects).filter(o=>o.kind==="shape").slice(0,600).map(o=>({op:"putObject" as const,value:{...o,label:"更新"}})));
  assert.equal(idx.update(wide.state.doc,wide.changeSet).mode,"full");equivalent(idx,wide);
  assert.equal(idx.update(state.doc).mode,"full");
  assert.equal(idx.update({...state.doc,id:"separate"},wide.changeSet).mode,"full");
});
test("fast finite geometry result equals authoritative full path and preserves externally immutable input",()=>{
  const state=createHistory(mixed),s=shape(state.doc.objects["shape-start"]),at=p(1700,-320);
  const edit={op:"putObject",value:{...s,rotation:.15,at,width:113,height:50}} as const;
  const quick=apply(state,edit),checked=apply(state,edit,{op:"setOrder",ids:state.doc.order});
  assert.deepEqual(quick.state.doc,checked.state.doc);assert.deepEqual(quick.changeSet,checked.changeSet);
  assertDocument(quick.state.doc);
  at.x=0;assert.equal(shape(quick.state.doc.objects[s.id]).at.x,1700);
  assert.strictEqual(quick.state.doc.order,state.doc.order);
  const wrong={...s,at:{x:NaN,y:0}};
  assert.throws(()=>apply(state,{op:"putObject",value:wrong}),DocumentValidationError);
  const invalid={...s,width:0};
  assert.throws(()=>apply(state,{op:"putObject",value:invalid}),DocumentValidationError);
});
test("fast transform cannot bypass zero-length bound line validation; undo change sets reverse inserts",()=>{
  const state=createHistory(mixed),s=shape(state.doc.objects["shape-start"]),from={kind:"anchor" as const,objectId:s.id,portId:"east" as const};
  const target=resolveEndpoint(state.doc,from)!;
  const guarded:Connector={...line(state.doc.objects["free-line"]),id:"guarded",routing:"straight",from,to:{kind:"free",point:p(target.x+20,target.y)}};
  const made=apply(state,{op:"putObject",value:guarded});
  const prior=made.state.doc;
  assert.throws(()=>apply(made.state,{op:"putObject",value:{...s,at:p(s.at.x+20,s.at.y)}}),/zero-length connector/);
  assert.strictEqual(made.state.doc,prior);
  const back=undo(made.state);
  assert.deepEqual(back.changeSet.removed,["guarded"]);
  assert.deepEqual(back.changeSet.invalidatedConnectors,diffDocuments(made.state.doc,back.state.doc).invalidatedConnectors);
  const forward=redo(back.state);assert.deepEqual(forward.changeSet,made.changeSet);
});
