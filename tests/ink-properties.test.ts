import { test } from "node:test";
import {readFileSync} from "node:fs";
import {SceneProjection} from "../scene/projector.ts";
import assert from "node:assert/strict";
import { EditorSession } from "../session/editor.ts";
import { setSelectedInkStyle } from "../features/standalone.ts";
import { INK_BRUSH_VERSION,inkBounds,inkPoints,transformCompletedInk } from "../features/ink.ts";
import type { InkObject } from "../core/document.ts";
import { demo } from "../app/demo.ts";
import { buildScene,hitTest } from "../scene/board.ts";
import { captureClipboard,pasteClipboard } from "../features/clipboard.ts";
import { AssetVault } from "../features/image-assets.ts";
import { decodeProject,encodeProject } from "../platform/project.ts";

test("selected ink appearance is undoable and round trips without changing the pressure path",()=>{
  const stroke:InkObject={kind:"ink",id:"typed-stroke",at:{x:22,y:41},brushVersion:INK_BRUSH_VERSION,
    color:"#334488",baseWidth:6,samples:[[0,0,.2],[5,7,.6],[10,9,1]]};
  const e=new EditorSession(demo,{offset:{x:0,y:0},zoom:1});
  assert(e.commitEdit({label:"ink",patches:[{op:"putObject",value:stroke}]},e.generation,[stroke.id]));
  const before=e.doc.objects[stroke.id];assert(before.kind==="ink");
  assert(!setSelectedInkStyle(e,before,{color:"red",baseWidth:9}));
  assert(!setSelectedInkStyle(e,before,{color:"#003388",baseWidth:.1}));
  assert(!setSelectedInkStyle(e,before,{color:"#003388",baseWidth:130}));
  assert(!setSelectedInkStyle(e,before,{color:"#003388",baseWidth:NaN}));
  assert(!setSelectedInkStyle(e,before,{color:before.color.toUpperCase(),baseWidth:before.baseWidth}));
  assert.equal(e.history.past.length,1);
  assert(setSelectedInkStyle(e,before,{color:"#118855",baseWidth:18}));
  const after=e.doc.objects[stroke.id];assert(after.kind==="ink");
  assert.deepEqual(after.samples,before.samples);assert.deepEqual(after.at,before.at);
  assert.deepEqual([after.color,after.baseWidth,after.brushVersion],["#118855",18,INK_BRUSH_VERSION]);
  assert(inkBounds(inkPoints(after))!.min.x<inkBounds(inkPoints(before))!.min.x);
  assert(!setSelectedInkStyle(e,before,{color:"#003388",baseWidth:12}),"stale form");
  assert.deepEqual(decodeProject(encodeProject(e.doc,new AssetVault())).document.objects[stroke.id],after);
  e.undo();assert.deepEqual(e.doc.objects[stroke.id],before);
  e.redo();assert.deepEqual(e.doc.objects[stroke.id],after);
  e.select("flow-source");
  assert(!setSelectedInkStyle(e,after,{color:"#003388",baseWidth:12}),"nonselected stroke");
});

test("selected ink rotates and scales uniformly about first point, preserving pressure, hit and copy semantics",()=>{
  const stroke:InkObject={kind:"ink",id:"affine-stroke",at:{x:200,y:200},brushVersion:INK_BRUSH_VERSION,
    color:"#334488",baseWidth:5,samples:[[0,0,.1],[30,0,.6],[40,10,.97]]};
  const e=new EditorSession(demo,{offset:{x:0,y:0},zoom:1}),vault=new AssetVault();
  assert(e.commitEdit({label:"ink",patches:[{op:"putObject",value:stroke}]},e.generation,[stroke.id]));
  const before=e.doc.objects[stroke.id];assert(before.kind==="ink");
  assert(!setSelectedInkStyle(e,before,before,{degrees:360,scale:1}));
  assert(!setSelectedInkStyle(e,before,before,{degrees:NaN,scale:1}));
  assert(!setSelectedInkStyle(e,before,before,{degrees:90,scale:0}));
  assert(!setSelectedInkStyle(e,before,before,{degrees:15,scale:100}),"out-of-range scaled width");
  assert(setSelectedInkStyle(e,before,before,{degrees:90,scale:2}));
  const turned=e.doc.objects[stroke.id];assert(turned.kind==="ink");
  assert.deepEqual(turned.at,before.at);
  assert.deepEqual(turned.samples,[[0,0,.1],[0,60,.6],[-20,80,.97]]);
  assert.equal(turned.baseWidth,10);
  assert.deepEqual(Object.keys(turned).sort(),Object.keys(before).sort(),"v2 key set did not change");
  const group=buildScene(e.doc).find(g=>g.id===turned.id)!;
  assert.equal(hitTest([group],{x:200,y:250},0),turned.id);
  assert.equal(hitTest([group],{x:230,y:200},0),undefined);
  const assetFree=encodeProject(e.doc,vault);
  assert.equal(decodeProject(assetFree).document.schemaVersion,2);
  assert.deepEqual(decodeProject(assetFree).document.objects[turned.id],turned);
  const fragment=captureClipboard(e.doc,[turned.id],vault);assert(fragment);
  assert(pasteClipboard(e,vault,fragment,{delta:{x:50,y:8}}));
  const copy=e.doc.objects[e.selection!];assert(copy.kind==="ink"&&copy.id!==turned.id);
  assert.deepEqual(copy.samples,turned.samples);assert.deepEqual(copy.at,{x:250,y:208});
  e.undo();assert.equal(e.doc.objects[copy.id],undefined);
  e.select(turned.id);assert(e.moveSelection({x:10,y:-3}));
  const moved=e.doc.objects[turned.id];assert(moved.kind==="ink");
  assert.deepEqual(moved.at,{x:210,y:197});assert.deepEqual(moved.samples,turned.samples);
  e.undo();e.undo();assert.deepEqual(e.doc.objects[turned.id],before);
});

test("axis-aligned ink reopens exactly after each quarter turn in either direction",()=>{
  const stroke:InkObject={kind:"ink",id:"axes",at:{x:5,y:10},brushVersion:INK_BRUSH_VERSION,
    color:"#123456",baseWidth:3,samples:[[0,0,.1],[0,30,.4],[-17,0,.9]]};
  const vault=new AssetVault();
  for(const degrees of [90,-90]){
    const editor=new EditorSession(demo,{offset:{x:0,y:0},zoom:1});
    assert(editor.commitEdit({label:"ink",patches:[{op:"putObject",value:stroke}]},editor.generation,[stroke.id]));
    for(let i=0;i<4;i++){
      const before=editor.doc.objects[stroke.id];assert(before.kind==="ink");
      assert(setSelectedInkStyle(editor,before,before,{degrees,scale:1}));
      const reopened=decodeProject(encodeProject(editor.doc,vault)).document.objects[stroke.id];
      assert.deepEqual(editor.doc.objects[stroke.id],reopened);
    }
    assert.deepEqual(editor.doc.objects[stroke.id],stroke);
  }
});

test("an ink transform beyond world bounds rejects the whole style and geometry edit",()=>{
  const stroke:InkObject={kind:"ink",id:"edge",at:{x:999_999_990,y:8},brushVersion:INK_BRUSH_VERSION,
    color:"#123456",baseWidth:4,samples:[[0,0,.1],[-20,0,.8]]};
  const editor=new EditorSession(demo,{offset:{x:0,y:0},zoom:1});
  assert(editor.commitEdit({label:"ink",patches:[{op:"putObject",value:stroke}]},editor.generation,[stroke.id]));
  const history=editor.history,original=editor.doc.objects[stroke.id];assert(original.kind==="ink");
  assert(!setSelectedInkStyle(editor,original,{color:"#aabbcc",baseWidth:3},{degrees:180,scale:1}));
  assert.equal(editor.history,history);
  editor.undo();assert.equal(editor.doc.schemaVersion,1);
  editor.redo();assert.deepEqual(editor.doc.objects[stroke.id],stroke);
});

const mixedInk=decodeProject(readFileSync(new URL("../docs/fixtures/M5AG-Layer-Locks.mgcanvas",import.meta.url),"utf8"));
const inkId="sample-ink",baseBrush={color:"#a13c52",baseWidth:8};
function selectedInk(){
  const editor=new EditorSession(mixedInk.document),vault=new AssetVault(mixedInk.assets);
  editor.select(inkId);
  return {editor,vault,stroke:editor.doc.objects[inkId] as InkObject};
}

test("ink appearance overlay expands pressure bounds and hit independently of the committed mixed scene",()=>{
  const {editor,vault,stroke}=selectedInk(),history=editor.history,bytes=encodeProject(editor.doc,vault);
  const scene=new SceneProjection(editor.doc),preview=transformCompletedInk(stroke,baseBrush)!;
  assert.strictEqual(preview.samples,stroke.samples);assert.strictEqual(preview.at,stroke.at);
  const patch=scene.overlay({objects:new Map([[inkId,preview]])}),edge={x:stroke.at.x-1.32,y:stroke.at.y},region={min:edge,max:edge};
  assert.equal(hitTest(scene.query(region),edge,0),undefined);assert.equal(hitTest(scene.query(region,patch),edge,0),inkId);
  const drawn=patch.get(inkId)!;assert.deepEqual(drawn.bounds,inkBounds(inkPoints(preview)));
  assert.strictEqual(editor.history,history);assert.equal(encodeProject(editor.doc,vault),bytes);
  assert.deepEqual(captureClipboard(editor.doc,[inkId],vault)!.document.objects[inkId],stroke);
  assert(setSelectedInkStyle(editor,stroke,baseBrush));assert.equal(editor.history.past.length,1);
  assert.deepEqual(buildScene(editor.doc).find(g=>g.id===inkId),drawn);assert.deepEqual(editor.doc.order,mixedInk.document.order);
  editor.undo();assert.equal(encodeProject(editor.doc,vault),bytes);editor.redo();assert.deepEqual(editor.doc.objects[inkId],preview);
});

test("appearance-only edits keep a previously rotated stroke's sample coordinates, pressure, origin and z-order",()=>{
  const {editor,vault,stroke}=selectedInk();assert(setSelectedInkStyle(editor,stroke,stroke,{degrees:90,scale:1}));
  const rotated=editor.doc.objects[inkId] as InkObject;
  assert.deepEqual(rotated.samples,[[0,0,.15],[-3,18,.78],[-16,28,.44]]);
  const prior=editor.doc,oldBytes=encodeProject(prior,vault),adjusted=transformCompletedInk(rotated,baseBrush)!;
  assert.strictEqual(adjusted.samples,rotated.samples);assert.strictEqual(adjusted.at,rotated.at);
  assert(setSelectedInkStyle(editor,rotated,baseBrush));assert.deepEqual(editor.doc.objects[inkId],{...rotated,...baseBrush});
  for(const id of prior.order)if(id!==inkId)assert.deepEqual(editor.doc.objects[id],prior.objects[id]);
  assert.deepEqual(editor.doc.order,prior.order);assert.deepEqual(editor.doc.flowGroups,prior.flowGroups);assert.equal(editor.doc.schemaVersion,5);
  const stored=decodeProject(encodeProject(editor.doc,vault));assert.deepEqual(stored.document.objects[inkId],adjusted);assert.deepEqual(stored.assets,mixedInk.assets);
  editor.undo();assert.equal(encodeProject(editor.doc,vault),oldBytes);
});

test("coincident pressure samples and a single dot retain their pressure footprint when a width draft hits either limit",()=>{
  const {stroke}=selectedInk();
  for(const samples of [[[0,0,.2]],[[0,0,.2],[0,0,.9],[0,0,0]]] as const){
    const dot={...stroke,samples},highest=Math.max(...samples.map(s=>s[2]));
    for(const width of [.25,128]){
      const next=transformCompletedInk(dot,{color:"#000000",baseWidth:width})!;assert.strictEqual(next.samples,samples);
      const radius=width*(.2+1.6*highest)/2;
      assert.deepEqual(inkBounds(inkPoints(next)),{min:{x:dot.at.x-radius,y:dot.at.y-radius},max:{x:dot.at.x+radius,y:dot.at.y+radius}});
    }
  }
});

test("locked or hidden ink and stale snapshots cannot publish a previously valid candidate",()=>{
  const {editor,stroke}=selectedInk(),before=editor.history;
  const next=transformCompletedInk(stroke,baseBrush)!;assert(next!==stroke);
  editor.setLayerLocks([inkId],true);assert(!setSelectedInkStyle(editor,stroke,baseBrush));editor.setLayerLocks([inkId],false);
  editor.setLayerVisibility([inkId],false);assert(!setSelectedInkStyle(editor,stroke,baseBrush));editor.showAllLayers();
  editor.select(inkId);editor.select("qa-picture",true);assert(!setSelectedInkStyle(editor,stroke,baseBrush));assert.strictEqual(editor.history,before);
  editor.open(mixedInk.document,true);editor.select(inkId);assert(!setSelectedInkStyle(editor,stroke,baseBrush));
  assert.equal(editor.history.past.length,0);
});
