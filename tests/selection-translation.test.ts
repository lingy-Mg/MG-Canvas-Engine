import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {SelectionProperties} from "../features/selection-appearance.ts";
import type {AppearanceKey} from "../features/selection-appearance.ts";
import {EditorSession} from "../session/editor.ts";
import {resolveEndpoint} from "../core/document.ts";
import type {Connector,InkObject} from "../core/document.ts";
import {SceneProjection} from "../scene/projector.ts";
import {captureClipboard,encodeClipboard} from "../features/clipboard.ts";
import {moveObjects,planMove} from "../session/transform.ts";
import {mixed} from "./fixtures/mixed.ts";

const board=decodeProject(readFileSync(new URL("../docs/fixtures/M5P-Selection-Translation.mgcanvas",import.meta.url),"utf8")).document;
const camera={offset:{x:0,y:0},zoom:1},vault=new AssetVault(),noStyles=new Map();
function pick(editor:EditorSession,...ids:string[]){
  editor.select(ids[0]);for(const id of ids.slice(1))editor.select(id,true);
  return new SelectionProperties(editor);
}
test("relative move previews both incident routes, commits the manual pins once and reopens with original binding IDs",()=>{
  const editor=new EditorSession(board,camera),model=pick(editor,"a","b"),history=editor.history;
  const original=encodeProject(editor.doc,vault),copy=encodeClipboard(captureClipboard(editor.doc,board.order,vault)!);
  const moved=model.preview(noStyles,{x:5});assert(moved);
  assert.deepEqual([...moved.keys()].sort(),["a","b","internal"]);
  const projection=new SceneProjection(editor.doc),shown=projection.overlay({objects:moved});
  assert.deepEqual([...shown.keys()].sort(),["a","b","cross","internal"]);
  const inside=shown.get("internal")!.items.find(p=>p.kind==="path"),cross=shown.get("cross")!.items.find(p=>p.kind==="path");
  assert(inside&&cross);assert.deepEqual([inside.points[0],inside.points.at(-1),cross.points[0],cross.points.at(-1)],
    [{x:31,y:17},{x:45,y:17},{x:61,y:17},{x:90,y:47}]);
  assert.equal(editor.history,history);assert.equal(encodeProject(editor.doc,vault),original);
  assert.equal(encodeClipboard(captureClipboard(editor.doc,board.order,vault)!),copy);
  assert(model.apply(noStyles,{x:5}));assert.equal(editor.history.past.length,1);
  const reopened=decodeProject(encodeProject(editor.doc,vault)).document;
  const a=reopened.objects.a,b=reopened.objects.b;assert(a.kind==="shape"&&b.kind==="shape");
  assert.deepEqual([a.at,b.at],[{x:15,y:10},{x:45,y:10}]);
  const internal=reopened.objects.internal as Connector,external=reopened.objects.cross as Connector;
  assert.deepEqual(internal,{...board.objects.internal,waypoints:[{x:35,y:4},{x:41,y:4}]});
  assert.deepEqual(external,board.objects.cross);assert.deepEqual(reopened.objects.outside,board.objects.outside);
  assert.deepEqual(resolveEndpoint(reopened,external.from),{x:61,y:17});
  assert.deepEqual(resolveEndpoint(reopened,external.to),{x:90,y:47});
  const applied=encodeProject(editor.doc,vault);editor.undo();assert.equal(encodeProject(editor.doc,vault),original);
  assert.equal(editor.history.past.length,0);editor.redo();assert.equal(encodeProject(editor.doc,vault),applied);
});
test("empty, explicit zero and unfinished offsets produce no undo; valid signed axes are relative and combine with appearance",()=>{
  const e=new EditorSession(board,camera),model=pick(e,"a","b","internal"),history=e.history;
  for(const delta of [{},{x:0},{y:-0},{x:0,y:0}]){assert.equal(model.preview(noStyles,delta)?.size,0);assert(!model.apply(noStyles,delta));}
  const styles=new Map<AppearanceKey,string|number>([["lineWidth",4]]);
  for(const delta of [{x:NaN,y:2},{y:Infinity},{x:-Infinity}]){
    assert.equal(model.preview(styles,delta),undefined);assert(!model.apply(styles,delta));
  }
  assert.equal(e.history,history);assert(model.apply(styles,{x:-2.5,y:0}));
  assert.equal(e.history.past.length,1);
  const line=e.doc.objects.internal as Connector;
  assert.deepEqual(line,{...board.objects.internal,strokeWidth:4,waypoints:[{x:28,y:4},{x:34,y:4}]});
  e.undo();assert.equal(encodeProject(e.doc,vault),encodeProject(board,vault));
  assert(new SelectionProperties(e).apply(noStyles,{y:-3}));
  const a=e.doc.objects.a;assert(a.kind==="shape");assert.deepEqual(a.at,{x:10,y:7});
});
test("translation shares drag semantics for heterogeneous objects, free lines, anchored-only selections and pressure strokes",()=>{
  const e=new EditorSession(mixed,camera),stroke:InkObject={kind:"ink",id:"pressure",at:{x:5,y:6},baseWidth:3,color:"#115599",brushVersion:1,samples:[[0,0,.12],[8,2,.96]]};
  assert(e.commitEdit({label:"fixture",patches:[{op:"putObject",value:stroke}]},e.generation));
  const form=pick(e,"shape-start","note","picture","map-a","free-line","pressure"),d={x:-7,y:12};
  const expected=moveObjects(planMove(e.doc,e.selectedIds),d);
  assert.deepEqual(form.preview(noStyles,d),expected);
  assert(form.apply(noStyles,d));
  for(const [id,item] of expected)assert.deepEqual(e.doc.objects[id],item);
  const after=e.doc.objects.pressure;assert(after.kind==="ink");assert.deepEqual(after.samples,stroke.samples);
  const e2=new EditorSession(board,camera),bound=pick(e2,"internal","cross");
  assert(!bound.canTranslate);assert(!bound.apply(noStyles,{x:4}));
  assert(!pick(e2,"a").canTranslate);
});
test("stale selection, document history and generation cannot commit a relative draft to reused IDs",()=>{
  const e=new EditorSession(board,camera),d={x:5};
  let form=pick(e,"a","b");assert(form.preview(noStyles,d)?.size);
  pick(e,"a","outside");pick(e,"a","b");assert(!form.apply(noStyles,d));
  form=new SelectionProperties(e);assert(e.moveSelection({x:2,y:0}));e.undo();assert(!form.apply(noStyles,d));
  form=new SelectionProperties(e);e.open(board,true);pick(e,"a","b");assert(!form.apply(noStyles,d));assert.equal(e.history.past.length,0);
});

test("a translation taking a pressure sample beyond its supported range rejects simultaneous edits for every object",()=>{
  const e=new EditorSession(board,camera);
  const ink:InkObject={kind:"ink",id:"edge-ink",at:{x:999999992,y:0},baseWidth:4,color:"#112233",brushVersion:1,samples:[[0,0,.26],[8,2,.85]]};
  assert(e.commitEdit({label:"fixture",patches:[{op:"putObject",value:ink}]},e.generation));
  const form=pick(e,"a",ink.id),history=e.history;
  const edits=new Map<AppearanceKey,string|number>([["lineColor","#654320"]]);
  assert.equal(form.preview(edits,{x:1}),undefined);assert(!form.apply(edits,{x:1}));assert.equal(e.history,history);
  assert(form.apply(edits,{x:-1}));const moved=e.doc.objects[ink.id];assert(moved.kind==="ink");
  assert.deepEqual(moved.samples,ink.samples);assert.equal(moved.at.x,999999991);
});
