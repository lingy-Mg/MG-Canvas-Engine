import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {BoardDocument,Connector,ShapeObject} from "../core/document.ts";
import {resolveEndpoint} from "../core/document.ts";
import {prepareDragCopies} from "../features/clipboard.ts";
import {AssetVault} from "../features/image-assets.ts";
import {topicBox} from "../features/mindmap-layout.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {marqueeHit} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";
import {EditorSession} from "../session/editor.ts";
import type {DragSetup} from "../session/editor.ts";

const point=(x:number,y:number)=>({x,y});
const view={min:point(-2000,-2000),max:point(2000,2000)},camera={offset:point(0,0),zoom:1};
const fixture=(name:string)=>decodeProject(readFileSync(new URL("../docs/fixtures/"+name+".mgcanvas",import.meta.url),"utf8"));
const plain=fixture("M5V-Drag-Alignment").document;
function setup(doc:BoardDocument,vault=new AssetVault()){
  const scene=new SceneProjection(doc);
  const editor=new EditorSession(doc,camera,(ids,cam,copy):DragSetup|undefined=>{
    if(!copy)return scene.prepareDrag(ids,view,cam.zoom);
    const copies=prepareDragCopies(editor,ids,vault);
    return copies&&scene.prepareCopyDrag(copies,view,cam.zoom);
  });
  editor.listen(change=>{if(change)scene.update(editor.doc,change);scene.setHidden(editor.hiddenIds);});
  return {editor,scene};
}
const copyDown=(e:EditorSession,id:string)=>e.down(1,"mouse",point(0,0),id,false,false,"copy");

test("drag copies have stable preview IDs, keep both drawings visible and snap to the originals' edge gap",()=>{
  const a={...plain.objects.a as ShapeObject,at:point(0,0),width:20,height:20};
  const b={...a,id:"b",at:point(80,0)};
  const {editor:e,scene}=setup({...plain,objects:{a,b},order:["a","b"]});
  e.select("b");const original=e.doc;copyDown(e,"a");
  e.move(1,point(157,0));const copy=e.preview!.ids[0];
  assert.equal(e.preview!.ids.length,1);assert(!e.doc.objects[copy]);
  assert.deepEqual((e.preview!.objects.get(copy) as ShapeObject).at,point(160,0));
  assert.deepEqual(e.alignmentGuides?.filter(g=>g.kind==="spacing").map(g=>g.to-g.from),[60,60]);
  const paint=scene.query(view,scene.overlay(e.preview));
  assert.deepEqual(paint.map(g=>g.id),["a","b",copy]);assert.equal(paint[0].bounds.min.x,0);assert.equal(paint[2].bounds.min.x,160);
  e.move(1,point(155,0));assert.deepEqual(e.preview!.ids,[copy]);assert.equal(e.history.past.length,0);assert.equal(e.doc,original);
  e.up(1,point(157,0));assert.deepEqual(e.selectedIds,[copy]);assert.equal(e.history.past.length,1);
  assert.deepEqual(e.doc.objects.a,a);assert.deepEqual(e.doc.objects.b,b);assert.deepEqual((e.doc.objects[copy] as ShapeObject).at,point(160,0));
  const result=e.doc;e.undo();assert.equal(e.doc,original);e.redo();assert.equal(e.doc,result);
});

test("a locked flow group can be copied atomically with fresh group and endpoint IDs, including connectors with no move patch",()=>{
  const doc=fixture("M5X-Flow-Groups").document,internal=doc.objects.internal as Connector;
  const {editor:e}=setup({...doc,objects:{...doc.objects,internal:{...internal,waypoints:[]}}});
  e.select("a");const originals=e.doc,sourceIds=originals.order.filter(id=>e.selectedIds.includes(id));
  assert(e.setLayerLocks(e.selectedIds,true));copyDown(e,"a");
  e.up(1,point(305,-40),undefined,false,true);
  const ids=e.doc.order.slice(originals.order.length),map=new Map(sourceIds.map((old,i)=>[old,ids[i]]));
  assert.equal(ids.length,sourceIds.length);assert.deepEqual(new Set(e.selectedIds),new Set(ids));
  for(const id of originals.order)assert.deepEqual(e.doc.objects[id],originals.objects[id]);
  const copied=e.doc.objects[map.get("internal")!] as Connector;
  assert.deepEqual(copied.from,{kind:"anchor",objectId:map.get("a"),portId:"east"});
  assert.deepEqual(copied.to,{kind:"anchor",objectId:map.get("b"),portId:"west"});assert.deepEqual(copied.waypoints,[]);
  const groups=e.doc.flowGroups!.members;
  assert.deepEqual(groups[e.selectedGroup!],originals.flowGroups!.members["group-intake"].map(id=>map.get(id)));
  assert(!Object.hasOwn(originals.flowGroups!.members,e.selectedGroup!));assert(e.isLocked("a"));assert(!e.selectionLocked);
  assert.equal(e.history.past.length,1);e.undo();assert.equal(e.doc,originals);
});

test("copying a bound connector alone detaches both anchors and translates endpoints and hand-authored bends",()=>{
  const {editor:e}=setup(plain),original=e.doc.objects.cross as Connector,d=point(35,-19);
  copyDown(e,original.id);e.up(1,d);
  const copied=e.doc.objects[e.selection!] as Connector;
  for(const end of ["from","to"] as const){
    const old=resolveEndpoint(plain,original[end])!;
    assert.deepEqual(copied[end],{kind:"free",point:point(old.x+d.x,old.y+d.y)});
  }
  assert.deepEqual(copied.waypoints,original.waypoints.map(p=>point(p.x+d.x,p.y+d.y)));
  assert.deepEqual(e.doc.objects.cross,original);assert.equal(e.history.past.length,1);
});

test("mixed selection copies preserve image assets, pressure, curves and remapped mind-map topics on reopen",()=>{
  const source=fixture("M5S-Cubic-Paths"),vault=new AssetVault(source.assets),{editor:e}=setup(source.document,vault);
  e.selectAll();const before=e.doc,originalBytes=encodeProject(before,vault),first=before.order[0];
  copyDown(e,first);e.move(1,point(41,67),false,true);
  assert.equal(encodeProject(e.doc,vault),originalBytes);const ids=e.preview!.ids;
  e.up(1,point(40,70),undefined,false,true);assert.deepEqual(e.doc.order.slice(before.order.length),ids);
  assert.deepEqual(e.doc.assets,before.assets);assert.equal(vault.assetIds().length,source.assets.length);
  for(const [i,id] of ids.entries()){
    const old=before.objects[before.order[i]],copy=e.doc.objects[id];assert.notEqual(old.id,copy.id);
    if(old.kind==="connector"||copy.kind==="connector")continue;
    if(old.kind==="mindmap"&&copy.kind==="mindmap"){
      assert.notEqual(copy.rootId,old.rootId);assert.deepEqual(Object.values(copy.topics).map(t=>t.text),Object.values(old.topics).map(t=>t.text));continue;
    }
    if(old.kind==="mindmap"||copy.kind==="mindmap")assert.fail("copy kind changed");
    assert.deepEqual(copy,{...old,id,at:point(old.at.x+40,old.at.y+70)});
  }
  const bytes=encodeProject(e.doc,vault),reopened=decodeProject(bytes);
  assert.equal(encodeProject(reopened.document,new AssetVault(reopened.assets)),bytes);
  e.undo();assert.equal(e.doc,before);
});

test("an Alt drag from a marquee-selected topic copies just that topic at its visible position",()=>{
  const {document}=fixture("M5S-Cubic-Paths"),map=document.objects["mind-booking"];
  assert(map.kind==="mindmap");
  const id=map.topics[map.rootId].childIds[0],{box}=topicBox(map,id)!;
  const center=point(box.at.x+box.width/2,box.at.y+box.height/2);
  const {editor:e,scene}=setup({schemaVersion:1,id:"branch-copy",theme:document.theme,objects:{[map.id]:map},order:[map.id],assets:{}});
  const before=e.doc;
  e.down(1,"mouse",point(center.x-5,center.y-5),undefined,false);
  e.up(1,point(center.x+5,center.y+5),(area,topics)=>marqueeHit(scene.query(area),area,topics));
  assert.deepEqual([...e.selectedTopics.get(map.id)!],[id]);
  e.down(1,"mouse",center,map.id,false,false,"copy");
  const dest=point(center.x+120,center.y+35);
  e.move(1,dest,false,true);
  const copied=e.preview!.objects.get(e.preview!.ids[0])!;
  assert(copied.kind==="mindmap");assert.notEqual(copied.rootId,id);
  assert.deepEqual(Object.values(copied.topics).map(t=>t.text),[map.topics[id].text]);
  assert.deepEqual(copied.origin,point(Math.round(center.x)+120,Math.round(center.y)+35));
  e.up(1,dest,undefined,false,true);assert.equal(e.selection,copied.id);
  assert.equal(e.doc.objects[map.id],before.objects[map.id]);assert.equal(e.history.past.length,1);
  e.undo();assert.equal(e.doc,before);
});

test("taps, zero-net moves, cancellation and second contacts cannot leave a duplicate or consume redo",()=>{
  for(const reason of ["tap","return","cancel","lost","pinch","open","select"]){
    const {editor:e}=setup(plain);
    e.select("b");assert(e.moveSelection(point(20,0)));e.undo();const before=e.doc;
    const touch=reason==="pinch";if(touch)e.select("a");
    e.down(1,touch?"touch":"mouse",point(0,0),"a",false,false,"copy");
    if(reason!=="tap"){e.move(1,point(40,30));assert(e.preview?.objects.size);}
    if(reason==="cancel")e.cancel();
    if(reason==="lost")e.pointerCancelled(1);
    if(reason==="pinch")e.down(2,"touch",point(60,60),undefined,false);
    if(reason==="open")e.open(plain,true);
    if(reason==="select")e.select("outside");
    e.up(1,reason==="tap"?point(1,1):reason==="return"?point(0,0):point(40,30));
    if(touch)e.up(2,point(60,60));
    assert(!e.preview&&!e.draggingCopies);assert.deepEqual(e.doc,before);assert.equal(e.history.past.length,0);
    if(reason!=="open")assert.equal(e.history.future.length,1);
  }
});
