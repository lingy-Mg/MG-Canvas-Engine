import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import type {InkObject} from "../core/document.ts";
import {createHistory,dispatch,undo,redo} from "../core/history.ts";
import {inkPoints,transformCompletedInk} from "../features/ink.ts";
import {decodeProject} from "../platform/project.ts";
import {EditorSession} from "../session/editor.ts";
import {planMove} from "../session/transform.ts";
import {SceneProjection} from "../scene/projector.ts";
import {hitTest,marqueeHit} from "../scene/board.ts";

const base=decodeProject(readFileSync(new URL("../docs/fixtures/M5S-Cubic-Paths.mgcanvas",import.meta.url),"utf8")).document;
const id="sample-ink",stroke=base.objects[id] as InkObject;
const point=(x:number,y:number)=>({x,y});
const camera={offset:point(0,0),zoom:1};

test("XY translates the first contact and shares every captured offset and pressure, including after rotation",()=>{
  for(const source of [stroke,transformCompletedInk(stroke,stroke,37,1.5)!]){
    for(const [requested,at] of [[point(5,-76.25),point(5,-76)],[point(0,0),point(0,0)],[point(-610.5,910),point(-610,910)]]){
      const result=transformCompletedInk(source,source,0,1,requested)!;
      assert.deepEqual(result,{...source,at});assert.equal(result.samples,source.samples);
      assert.notEqual(result.at,requested);assert.equal(result.brushVersion,source.brushVersion);
      const previous=inkPoints(source),next=inkPoints(result);
      next.forEach((s,i)=>{assert.equal(s.radius,previous[i].radius);assert.equal(s.x,at.x+source.samples[i][0]);assert.equal(s.y,at.y+source.samples[i][1]);});
    }
    assert.equal(transformCompletedInk(source,source,360,1,{...source.at}),source);
  }
});
test("combined ink places a rotated and scaled local stroke once at the final anchor",()=>{
  const at=point(0,-41.25),brush={color:"#000000",baseWidth:5};
  assert.deepEqual(transformCompletedInk(stroke,brush,90,2,at),{...stroke,at:point(0,-41),...brush,baseWidth:10,
    samples:[[0,0,.15],[-6,36,.78],[-32,56,.44]]});
  const edge={...stroke,at:point(1e9-28,0)};
  assert(!transformCompletedInk(edge,edge,0,2));
  assert(transformCompletedInk(edge,edge,0,2,at),"only final world samples constrain a combined transform");
  for(const bad of [point(NaN,0),point(0,Infinity),point(1e9-27,0),point(0,1e9-15)])assert(!transformCompletedInk(stroke,stroke,0,1,bad));
  assert(!transformCompletedInk(stroke,{...brush,baseWidth:80},90,2,at));
});
test("completed ink history validates same-length edits, owns changed tuples and preserves other roots",()=>{
  const state=createHistory(base),before=state.doc.objects[id] as InkObject;
  const next=transformCompletedInk(before,{color:"#000000",baseWidth:5},90,2,point(5,0))!;
  const proposal=structuredClone(next);
  const changed=dispatch(state,{label:"墨迹",patches:[{op:"putObject",value:proposal}]});
  const after=changed.state.doc.objects[id] as InkObject;
  assert.deepEqual(after,next);assert(Object.isFrozen(after.samples)&&Object.isFrozen(after.samples[1]));
  assert.notEqual(after.samples,proposal.samples);assert.equal(changed.state.doc.order,state.doc.order);assert.equal(changed.state.doc.assets,state.doc.assets);
  assert.deepEqual(changed.changeSet.updated,[id]);assert.deepEqual(changed.changeSet.invalidatedConnectors,[]);
  assert.equal(changed.state.doc.objects["flow-first"],state.doc.objects["flow-first"]);
  assert.equal(undo(changed.state).state.doc,state.doc);assert.equal(redo(undo(changed.state).state).state.doc,changed.state.doc);
  assert.equal(dispatch(changed.state,{label:"重复",patches:[{op:"putObject",value:structuredClone(after)}]}).state,changed.state);
  for(const invalid of [{...before,samples:[[0,0,.4],[3,2,1.1],[2,1,.5]]},{...before,at:point(1e9,0)}]){
    assert.throws(()=>dispatch(state,{label:"越界",patches:[{op:"putObject",value:invalid as InkObject}]}),{name:"DocumentValidationError"});
  }
  const longer={...before,samples:[...before.samples,[30,20,.2] as const]};
  assert.deepEqual(dispatch(state,{label:"结构变更",patches:[{op:"putObject",value:longer}]}).state.doc.objects[id],longer);
});
test("programmatic position and single-ink movement planning skip connector candidates and retain immutable samples",()=>{
  const session=new EditorSession(base,camera);session.select(id);
  const before=session.doc,original=before.objects[id] as InkObject;
  const watched={...before,objects:new Proxy(before.objects,{ownKeys(){throw Error("unnecessary board enumeration");}})};
  assert.deepEqual(planMove(watched,[id]),{movers:[original],connectors:[]});
  assert(session.transformSelection({x:0,y:-31.5}));const moved=session.doc.objects[id] as InkObject;
  assert.equal(moved.samples,original.samples);assert.deepEqual(moved,{...original,at:point(0,-31)});
  assert.equal(session.history.past.length,1);assert(!session.transformSelection({x:1e9,y:0}));
  assert(!session.transformSelection({x:0,y:-31.5}));session.undo();assert.equal(session.doc,before);
});
test("cross-cell preview projects, selects and hits the pressure silhouette with a single local patch",()=>{
  const origin={...stroke,at:point(880,200)},to=point(100,90);
  const board={...base,objects:{...base.objects,[id]:origin}},projector=new SceneProjection(board);
  const next=transformCompletedInk(origin,origin,0,1,to)!,patch=projector.overlay({objects:new Map([[id,next]])});
  assert.deepEqual([...patch.keys()],[id]);const at=inkPoints(next)[1],area={min:point(at.x-1,at.y-1),max:point(at.x+1,at.y+1)};
  const scene=projector.query(area,patch);assert.equal(hitTest(scene,at,0),id);assert.deepEqual(marqueeHit(scene,area).filter(s=>s===id),[id]);
  assert(!projector.query(area).some(g=>g.id===id));
});
