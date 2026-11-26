import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {EditorSession} from "../session/editor.ts";
import {SceneProjection} from "../scene/projector.ts";
import {resolveEndpoint} from "../core/document.ts";
import {buildScene,fitScene,hitTest,marqueeHit} from "../scene/board.ts";
import {FlowInput} from "../features/flow-input.ts";
import {captureClipboard,duplicateClipboardSelection,prepareClipboardCut} from "../features/clipboard.ts";
import {deleteBoardSelection,shapePorts} from "../features/flow.ts";
import {SelectionProperties} from "../features/selection-appearance.ts";
import {largeBoard} from "./fixtures/large-board.ts";
import type {Connector,ShapeObject,BoardDocument} from "../core/document.ts";

const bytes=readFileSync(new URL("../docs/fixtures/M5AG-Layer-Locks.mgcanvas",import.meta.url),"utf8");
const data=decodeProject(bytes),vault=new AssetVault(data.assets),camera={zoom:1,offset:{x:0,y:0}};
const init=()=>new EditorSession(data.document,camera);
const all={min:{x:-1e8,y:-1e8},max:{x:1e8,y:1e8}};
const sorted=(ids:Iterable<string>)=>[...ids].sort();
const rect=(x:number,y:number,w:number,h:number)=>({min:{x,y},max:{x:x+w,y:y+h}});
function watch(e:EditorSession){
  const index=new SceneProjection(e.doc);
  e.listen(change=>{index.update(e.doc,change);index.setHidden(e.hiddenIds);});
  return index;
}
test("visibility is per open board, independent of locks, canonical project bytes, saved revision and history",()=>{
  const e=init(),h=e.history;e.markSaved(e.generation,0);
  assert(!e.setLayerVisibility(["b","absent"],false));assert(!e.hiddenIds.size);
  e.setLayerLocks(["b"],true);e.select("standalone");const keep=e.selectedIds;
  assert(e.setLayerVisibility(["b"],false));assert.equal(e.selectedIds,keep);
  assert.deepEqual(sorted(e.hiddenIds),["b","cross","internal"]);assert(!e.setLayerVisibility(["b"],false));
  assert(e.hasHiddenEndpoint("cross"));assert(e.isLocked("b"));assert(!e.dirty&&!e.canUndo);
  assert(e.setLayerVisibility(["internal"],false));assert(e.setLayerVisibility(["cross"],true));
  assert.deepEqual([...e.hiddenIds],["internal"]);assert(e.isLocked("b"));assert(!e.hasHiddenEndpoint("internal"));
  assert(e.setLayerVisibility(["b","outside"],false));assert(e.showAllLayers());assert(!e.showAllLayers());assert.equal(e.selectedIds,keep);
  e.setLayerVisibility(e.doc.order,false);assert.equal(e.hiddenIds.size,e.doc.order.length);assert.equal(e.history,h);
  assert.equal(encodeProject(e.doc,vault),bytes);e.open(data.document,true);assert.equal(e.hiddenIds.size,0);assert(!e.isLocked("b")&&!e.dirty);
});
test("partial group operations and clipboard exclude hidden members; destructive group consequences are atomic",()=>{
  const e=init(),h=e.history;e.setLayerVisibility(["b"],false);e.select("a");
  assert.deepEqual(sorted(e.selectedIds),["a","target"]);assert.equal(e.selectedGroup,"group-intake");assert(!e.enterGroup("b"));
  assert(!e.ungroupSelection());assert(!deleteBoardSelection(e));assert.equal(e.history,h);
  const props=new SelectionProperties(e);assert(props.apply(new Map(),{x:5}));
  assert.equal((e.doc.objects.a as ShapeObject).at.x,(h.doc.objects.a as ShapeObject).at.x+5);
  for(const id of ["b","internal","cross"])assert.equal(e.doc.objects[id],h.doc.objects[id]);
  e.undo();assert.equal(e.doc,h.doc);
  assert(!prepareClipboardCut(e,vault));const fragment=captureClipboard(e.doc,e.selectedIds,vault,e.hiddenIds)!;
  assert.deepEqual(sorted(fragment.document.order),["a","target"]);assert(!fragment.document.flowGroups);
  assert(duplicateClipboardSelection(e,vault));assert.equal(e.doc.order.length,h.doc.order.length+2);e.undo();
  e.selectAll();assert.deepEqual(sorted(e.selectedIds),sorted(h.doc.order.filter(id=>!e.isHidden(id))));
  const wire=captureClipboard(e.doc,e.selectedIds,vault,e.hiddenIds)!;
  assert.deepEqual(wire.document.order,h.doc.order.filter(id=>!e.isHidden(id)));assert.equal(wire.assets.length,1);
  const picked=e.selectedIds;e.setLayerVisibility(["b"],true);assert.equal(e.selectedIds,picked);
});
test("a hidden internal connector leaves visible nodes movable and cannot silently enter a group clipboard",()=>{
  const e=init(),h=e.history;e.setLayerVisibility(["internal"],false);e.select("a");
  assert.deepEqual(sorted(e.selectedIds),["a","b","target"]);
  const cut=prepareClipboardCut(e,vault);assert(!cut);
  assert(e.moveSelection({x:-7,y:8}));assert.equal(e.doc.objects.internal,h.doc.objects.internal);assert.equal(e.doc.objects.cross,h.doc.objects.cross);
  assert(!e.commitEdit({label:"hidden pins",patches:[{op:"putObject",value:{...e.doc.objects.internal as Connector,waypoints:[]}}]},e.generation));
  const part=captureClipboard(e.doc,e.selectedIds,vault,e.hiddenIds)!;
  assert(!part.document.objects.internal&&!part.document.flowGroups);e.undo();assert.equal(e.doc,h.doc);
  e.select("standalone");const waiting=prepareClipboardCut(e,vault)!;assert(waiting);
  e.setLayerVisibility(["qa-label"],false);e.setLayerVisibility(["qa-label"],true);
  assert(!waiting.remove());assert.equal(e.doc,h.doc);
});
test("undo and redo can pass through a hidden layer without revealing it, including an absent ID",()=>{
  const e=init(),id="standalone";e.select(id);assert(e.moveSelection({x:1,y:3}));
  e.setLayerVisibility([id],false);assert(!e.selectedIds.length&&e.canUndo);e.undo();assert(e.isHidden(id));assert.deepEqual(e.doc,data.document);
  e.redo();assert(e.isHidden(id)&&!e.selectedIds.length);
  e.setLayerVisibility([id],true);e.select(id);assert(duplicateClipboardSelection(e,vault));
  const duplicate=e.selection!;e.setLayerVisibility([duplicate],false);e.undo();assert(!e.doc.objects[duplicate]&&!e.isHidden(duplicate));
  e.redo();assert(e.doc.objects[duplicate]&&e.isHidden(duplicate));
});
test("fine and broad queries, stale overlays, forced selections, marquee, hit and fit use the same visible stack",()=>{
  const e=init(),index=watch(e),o=e.doc.objects.standalone as ShapeObject,point={x:o.at.x+4,y:o.at.y+7};
  const near=rect(point.x-2,point.y-2,4,4),patch=index.overlay({objects:new Map([[o.id,{...o,fill:"#010101"}]])});
  assert.equal(hitTest(index.query(near),point,0),o.id);e.setLayerVisibility([o.id,"b"],false);
  for(const box of [near,all]){
    const shown=index.query(box,patch,[o.id,"b"]);assert(shown.every(g=>!e.isHidden(g.id)));
    assert(!marqueeHit(shown,box).includes("b"));assert.notEqual(hitTest(shown,point,0),o.id);
  }
  const expected=new SceneProjection(e.doc).all().filter(g=>!e.isHidden(g.id));
  assert.deepEqual(index.all(patch).map(g=>g.id),expected.map(g=>g.id));assert.deepEqual(fitScene(index.all(),800,550),fitScene(expected,800,550));
  e.setLayerVisibility(e.doc.order,false);assert.deepEqual(index.query(all,patch,e.doc.order),[]);assert.deepEqual(fitScene(index.all(),800,550),{offset:{x:400,y:275},zoom:1});
  e.showAllLayers();assert.equal(hitTest(index.query(near),point,0),o.id);assert.deepEqual(index.query(all).map(g=>g.id),e.doc.order);
});
test("restored cross-group lines use the current endpoint after a cross-cell move and undo, preserving authored manual pins",()=>{
  const e=init(),index=watch(e),edge=e.doc.objects.cross as Connector;
  const before=index.all().find(g=>g.id==="cross")!,endpoint=resolveEndpoint(e.doc,edge.to)!;
  e.setLayerVisibility(["b"],false);e.select("outside");assert(e.enterGroup("outside"));
  assert(e.moveSelection({x:530,y:85}));assert.equal(e.doc.objects.cross,edge);assert(!index.query(all).some(g=>g.id==="cross"));
  assert.deepEqual(resolveEndpoint(e.doc,edge.to),{x:endpoint.x+530,y:endpoint.y+85});
  e.setLayerVisibility(["b"],true);assert.deepEqual(index.query(all),buildScene(e.doc));
  assert.notDeepEqual(index.all().find(g=>g.id==="cross"),before);
  e.setLayerVisibility(["b"],false);e.undo();assert(e.isHidden("cross"));e.setLayerVisibility(["cross"],true);
  assert.deepEqual(index.query(all),buildScene(data.document));assert.deepEqual(index.all().find(g=>g.id==="cross"),before);
  assert.equal(encodeProject(e.doc,vault),bytes);
});
test("hidden neighbors occupy no snap candidate budget; restore puts them back into the same grid slots",()=>{
  const template=largeBoard(1).document.objects["s-0"] as ShapeObject;
  const shape=(id:string,x:number,y:number)=>({...template,id,at:{x,y},width:20,height:10});
  const noise=Array.from({length:540},(_,i)=>shape("covered-"+i,98,20)),rows=[shape("source",0,0),shape("target",100,25),...noise];
  const doc:BoardDocument={schemaVersion:1,id:"visibility-snap",theme:"paper",assets:{},objects:Object.fromEntries(rows.map(o=>[o.id,o])),order:rows.map(o=>o.id)};
  const e=new EditorSession(doc,camera),index=watch(e),hidden=noise.map(o=>o.id),viewport=rect(-125,-100,450,320);
  const snap=()=>{const a=index.prepareDrag(["source"],viewport,1).alignment!;const point=a.resolve({x:77,y:10});return {point,guides:a.guides};};
  e.setLayerVisibility(hidden,false);let result=snap();assert.equal(result.point.x,80);assert(result.guides.some(g=>g.targetId==="target"));
  e.setLayerVisibility(["target"],false);result=snap();assert.equal(result.point.x,77);assert.deepEqual(result.guides,[]);
  e.showAllLayers();assert.equal(index.query(viewport).length,542);assert.deepEqual(snap().guides,[]);
});
test("touch and raw group hits cannot pick hidden IDs; Connect excludes their markers and port hits",()=>{
  const e=init();e.setLayerVisibility(["b"],false);
  e.down(4,"touch",{x:10,y:10},"b",false);e.up(4,{x:10,y:10});assert(!e.selectedIds.length);
  e.down(2,"mouse",{x:0,y:0},undefined,false);e.move(2,{x:400,y:200});e.up(2,{x:400,y:200},()=>["b","internal","a"]);
  assert.deepEqual(sorted(e.selectedIds),["a","target"]);
  const flow=new FlowInput(e,()=>undefined);flow.setMode("connect");
  const b=e.doc.objects.b as ShapeObject,ports=shapePorts(b),visible=flow.decor().markers;
  for(const port of ports)assert(!visible.some(m=>m.point.x===port.point.x&&m.point.y===port.point.y));
  flow.move(8,ports[0].point);assert(!flow.decor().markers.some(m=>m.active));
  e.select("standalone");e.down(3,"touch",{x:0,y:0},"standalone",false);
  assert(!e.setLayerVisibility(["standalone"],false));e.pointerCancelled(3);assert(e.setLayerVisibility(["standalone"],false));
});
