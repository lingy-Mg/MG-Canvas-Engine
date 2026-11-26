import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {EditorSession} from "../session/editor.ts";
import {preservesLockedOrder} from "../session/layer-locks.ts";
import {arrangeSelection,canArrange} from "../features/arrange.ts";
import {captureClipboard,cutClipboardSelection,duplicateClipboardSelection,encodeClipboard,prepareClipboardCut} from "../features/clipboard.ts";
import {deleteBoardSelection,free,setConnectorEnd,setFlowNodeLabel,setWaypoint} from "../features/flow.ts";
import {SelectionProperties} from "../features/selection-appearance.ts";
import {resolveEndpoint} from "../core/document.ts";
import {groupUnit} from "../core/flow-groups.ts";
import {moveObjects,movePatches,planMove} from "../session/transform.ts";
import {addDownstream} from "../features/flow-keyboard.ts";
import type {BoardObject,Connector,ShapeObject} from "../core/document.ts";

const bytes=readFileSync(new URL("../docs/fixtures/M5AG-Layer-Locks.mgcanvas",import.meta.url),"utf8"),data=decodeProject(bytes);
const init=()=>new EditorSession(data.document,{offset:{x:0,y:0},zoom:1});
const vault=()=>new AssetVault(data.assets);
const packet=(e:EditorSession)=>encodeProject(e.doc,vault());
function changed(o:BoardObject):BoardObject{
  switch(o.kind){
    case "shape":return {...o,fill:"#775544"};
    case "connector":case "path":return {...o,stroke:"#543321"};
    case "ink":case "text":return {...o,color:"#324865"};
    case "image":return {...o,rotation:.25};
    case "mindmap":return {...o,origin:{x:o.origin.x+15,y:o.origin.y}};
  }
}
test("workspace locks protect every object kind through the publish boundary and leave v5 bytes, dirty and history alone",()=>{
  const e=init(),h=e.history,ids=e.doc.order;
  e.markSaved(e.generation,0);assert(!e.dirty);
  assert(!e.setLayerLocks(["missing"],true));assert(!e.setLayerLocks([ids[0],"missing"],true));assert(!e.isLocked(ids[0]));
  assert(e.setLayerLocks(ids,true));assert(!e.setLayerLocks(ids,true));assert(!e.dirty);assert.equal(e.history,h);assert.equal(packet(e),bytes);
  for(const id of ids){
    assert(e.isLocked(id));
    assert(!e.commitEdit({label:"locked",patches:[{op:"putObject",value:changed(e.doc.objects[id])}]},e.generation));
    assert.equal(e.history,h);
  }
  assert(!e.commitEdit({label:"asset",patches:[{op:"putAsset",value:{...e.doc.assets["asset-1"],pixelWidth:16}}]},e.generation));
  assert.equal(e.history,h);e.open(data.document,true);assert(!e.dirty);assert(ids.every(id=>!e.isLocked(id)));assert.equal(packet(e),bytes);
});
test("mixed selection rejects moves, properties, align, restack and delete as an atomic operation",()=>{
  const e=init(),h=e.history;
  e.select("standalone");e.select("qa-label",true);const form=new SelectionProperties(e);
  assert(e.setLayerLocks(["standalone"],true));assert.equal(e.lockedSelectionCount,1);
  assert(!e.moveSelection({x:9,y:5}));assert(!canArrange(e,"front")&&!arrangeSelection(e,"left"));
  assert(!form.preview(new Map(),{x:7}));assert(!form.apply(new Map(),{x:7}));assert(!deleteBoardSelection(e));
  assert(!e.commitEdit({label:"atomic",patches:["qa-label","standalone"].map(id=>({op:"putObject",value:changed(e.doc.objects[id])}))},e.generation));
  assert.equal(e.history,h);e.setLayerLocks(["standalone"],false);assert(!form.preview(new Map(),{x:7}));
  e.setLayerLocks(["standalone"],true);e.select("qa-label");assert(e.moveSelection({x:-2,y:3}));assert(e.canUndo);e.undo();assert.equal(e.doc,h.doc);
});
test("locked stacking boundaries check every surviving neighbor and allow insertions, removals and internal restacks",()=>{
  const locks=new Set(["b","d"]),order=["a","b","c","d","e","f"];
  for(const next of [order,["new",...order],["b","c","d","f","e"]])assert(preservesLockedOrder(order,next,locks));
  for(const next of [["b","a","c","d","e","f"],["a","d","c","b","e","f"],["a","b","e","d","c","f"]])assert(!preservesLockedOrder(order,next,locks));
  const e=init(),h=e.history;assert(e.setLayerLocks(["standalone"],true));
  const bottom=e.doc.order.filter(id=>id!=="standalone");
  assert(!e.commitEdit({label:"move locked indirectly",patches:[{op:"setOrder",ids:["standalone",...bottom]}]},e.generation));assert.equal(e.history,h);
  e.select("review");assert(!arrangeSelection(e,"front"));assert.equal(e.history,h);
});
test("a locked group member prevents whole-group changes; its unlocked sibling remains editable in member scope",()=>{
  const e=init(),h=e.history;e.select("b");assert.equal(e.selectedGroup,"group-intake");
  assert(e.enterGroup("b"));assert.deepEqual(e.selectedIds,["b"]);e.setLayerLocks(["b"],true);
  assert(!setFlowNodeLabel(e,"b","changed"));assert(!addDownstream(e,e.doc.objects.b as ShapeObject,()=>false));
  assert(e.leaveGroup());assert(!e.ungroupSelection());assert(!deleteBoardSelection(e));assert(!e.moveSelection({x:1,y:0}));assert.equal(e.history,h);
  const members=e.doc.flowGroups!.members;
  assert(!e.commitEdit({label:"change locked roster",patches:[{op:"setFlowGroups",members:{...members,"group-intake":["b","a","target"]}}]},e.generation));
  assert(e.enterGroup("a"));assert(!deleteBoardSelection(e));assert(setFlowNodeLabel(e,"a","新名称"));e.undo();assert.equal(e.doc,h.doc);
  e.setLayerLocks(["outside"],true);e.select("review");assert(e.enterGroup("review"));
  assert(!deleteBoardSelection(e),"deleting the last unlocked sibling would dissolve the locked member's group");
  assert.equal(e.doc,h.doc);e.leaveGroup();e.select("b");const unit=groupUnit(e.doc,"group-intake");e.setLayerLocks(unit,true);
  assert(unit.every(id=>e.isLocked(id)));assert(e.isLocked("internal")&&!e.isLocked("cross"));
});
test("bound endpoints may follow a neighbor, while a locked line's pins, deletion and detachment remain protected",()=>{
  const e=init(),h=e.history,original=e.doc.objects.cross as Connector;e.setLayerLocks(["cross"],true);
  e.select("outside");e.enterGroup("outside");const oldEnd=resolveEndpoint(e.doc,original.to)!;
  assert(e.moveSelection({x:7,y:-2}));assert.deepEqual(resolveEndpoint(e.doc,original.to),{x:oldEnd.x+7,y:oldEnd.y-2});
  assert.deepEqual(e.doc.objects.cross,original);assert(!setConnectorEnd(e,"cross","to",free({x:900,y:50})));assert(!setWaypoint(e,"cross",0,{x:200,y:11}));
  assert(!deleteBoardSelection(e));assert(e.doc.objects.outside);e.undo();assert.equal(e.doc,h.doc);
  const moved=moveObjects(planMove(e.doc,["b","outside"]),{x:4,y:5});assert(moved.has("cross"));
  assert(!e.commitEdit({label:"would translate locked pins",patches:movePatches(moved)},e.generation));assert.equal(e.doc,h.doc);
  e.setLayerLocks(["b"],true);assert(setConnectorEnd(e,"review-link","from",{kind:"anchor",objectId:"b",portId:"south"}));
});
test("two unlocked endpoints cannot preview or commit a move that would translate a locked manual route",()=>{
  const order=["b","outside","cross"],doc={id:"locked-route",theme:"paper",schemaVersion:1 as const,order,assets:{},
    objects:Object.fromEntries(order.map(id=>[id,data.document.objects[id]]))};
  const e=new EditorSession(doc,{offset:{x:0,y:0},zoom:1}),h=e.history;
  e.select("b");e.select("outside",true);e.setLayerLocks(["cross"],true);assert(!e.selectionLocked);
  const props=new SelectionProperties(e);assert(!props.preview(new Map(),{x:8}));assert(!e.moveSelection({x:8,y:3}));
  e.down(7,"mouse",{x:170,y:59},"b",false);e.move(7,{x:195,y:67});
  assert(!e.preview&&!e.alignmentGuides);e.up(7,{x:200,y:69});assert.equal(e.history,h);
  e.setLayerLocks(["cross"],false);assert(e.moveSelection({x:8,y:3}));
  const before=h.doc.objects.cross as Connector,after=e.doc.objects.cross as Connector;
  assert.deepEqual(after.waypoints,before.waypoints.map(p=>({x:p.x+8,y:p.y+3})));e.undo();assert.equal(e.doc,h.doc);
});
test("undo and redo stop at a protected frame, do not skip it, and resume after unlocking",()=>{
  const e=init(),original=e.doc;e.select("standalone");e.moveSelection({x:1,y:0});const h=e.history;e.setLayerLocks(["standalone"],true);
  assert(!e.canUndo);e.undo();assert.equal(e.history,h);
  e.select("qa-label");e.moveSelection({x:0,y:2});assert(e.canUndo);e.undo();assert.equal(e.doc,h.doc);assert(!e.canUndo);
  e.setLayerLocks(["standalone"],false);assert(e.canUndo);e.undo();assert.equal(e.doc,original);e.setLayerLocks(["standalone"],true);
  const stopped=e.history;assert(!e.canRedo);e.redo();assert.equal(e.history,stopped);e.setLayerLocks(["standalone"],false);
  assert(e.canRedo);e.redo();assert.equal(e.doc,h.doc);
});
test("copy of a locked group preserves the fragment and new IDs are unlocked; refused cuts never call the writer",async()=>{
  const e=init(),v=vault();e.select("b");const old=[...e.selectedIds];
  const original=encodeClipboard(captureClipboard(e.doc,old,v)!);
  e.setLayerLocks(["b"],true);assert.equal(encodeClipboard(captureClipboard(e.doc,old,v)!),original);
  let writes=0;assert(!await cutClipboardSelection(e,v,async()=>{writes++;}));assert.equal(writes,0);
  assert(duplicateClipboardSelection(e,v));assert(e.selectedIds.every(id=>!old.includes(id)&&!e.isLocked(id)));
  assert(e.canUndo);e.undo();assert.equal(packet(e),bytes);
  e.setLayerLocks(["cross"],true);e.select("outside");e.enterGroup("outside");
  assert(!prepareClipboardCut(e,v));assert(!await cutClipboardSelection(e,v,async()=>{writes++;}));assert.equal(writes,0);
});
test("after a clipboard write starts, changing locks invalidates deletion even if later unlocked",async()=>{
  const e=init();e.select("standalone");const h=e.history;
  let resolve!:()=>void,payload="";const wait=new Promise<void>(done=>{resolve=done;});
  const cut=cutClipboardSelection(e,vault(),async s=>{payload=s;await wait;});assert(payload.length>0);
  e.setLayerLocks(["standalone"],true);e.setLayerLocks(["standalone"],false);resolve();assert(!await cut);assert.equal(e.history,h);assert.equal(packet(e),bytes);
});
test("mouse and touch never create a locked drag/resize preview, with valid second-touch camera takeover",()=>{
  const e=init(),h=e.history;e.select("standalone");e.setLayerLocks(["standalone"],true);
  e.down(1,"mouse",{x:360,y:52},"standalone",false,false,{id:"standalone",corner:"se"});e.move(1,{x:390,y:83});
  assert(!e.preview);assert(!e.setLayerLocks(["standalone"],false));e.up(1,{x:395,y:83});assert.equal(e.history,h);assert.equal(e.selection,"standalone");
  e.down(2,"touch",{x:360,y:52},"standalone",false);e.down(3,"touch",{x:410,y:52},"standalone",false);e.move(3,{x:470,y:52});
  assert(e.camera.zoom>1);e.pointerCancelled(2);e.up(3,{x:470,y:52});assert(!e.preview&&!e.busy);assert.equal(e.history,h);
});
