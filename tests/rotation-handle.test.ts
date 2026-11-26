import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {SceneProjection} from "../scene/projector.ts";
import {buildScene} from "../scene/board.ts";
import {resolveEndpoint} from "../core/document.ts";
import type {ShapeObject} from "../core/document.ts";
import {localToWorld,worldToScreen} from "../core/geometry.ts";
import type {Camera,Point} from "../core/geometry.ts";
import {constrainRotation,cornerPoint,dragRotation,hitResizeHandle,hitRotationHandle,rotationHandle,RESIZE_CORNERS} from "../session/resize.ts";
import {EditorSession} from "../session/editor.ts";

const read=(name:string)=>decodeProject(readFileSync(new URL("../docs/fixtures/"+name+".mgcanvas",import.meta.url),"utf8"));
const pair=read("M5P-Selection-Translation"),meeting=read("Meeting-Room-Mobile-QA");
const shape=pair.document.objects.b as ShapeObject, camera={offset:{x:170,y:130},zoom:1};
const near=(a:number,b:number)=>assert(Math.abs(a-b)<1e-9,`${a} differs from ${b}`);
function turn(point:Point,pivot:Point,degrees:number):Point{
  const a=degrees*Math.PI/180,x=point.x-pivot.x,y=point.y-pivot.y;
  return {x:pivot.x+x*Math.cos(a)-y*Math.sin(a),y:pivot.y+x*Math.sin(a)+y*Math.cos(a)};
}
function begin(type="mouse",cam:Camera=camera){
  const editor=new EditorSession(pair.document,cam);
  const pivot=worldToScreen({x:48,y:17},cam),{knob}=rotationHandle(shape,cam);
  editor.select(shape.id);editor.down(1,type,knob,shape.id,false,false,{id:shape.id,rotate:true});
  return {editor,pivot,knob};
}
test("rotation circle stays 42 CSS pixels from the box and has a separate mouse and touch target at all zooms",()=>{
  for(const zoom of [.05,.4,1,3,16])for(const rotation of [0,.72,Math.PI/2,-2.8]){
    const box={...shape,width:3,height:2,rotation},cam={...camera,zoom};
    const {knob,base}=rotationHandle(box,cam);
    assert.deepEqual(base,worldToScreen(localToWorld({x:1.5,y:0},box),cam));
    near(Math.hypot(knob.x-base.x,knob.y-base.y),42);
    assert(hitRotationHandle(box,cam,{x:knob.x+8.9,y:knob.y}));
    assert(!hitRotationHandle(box,cam,{x:knob.x+9.1,y:knob.y}));
    assert(hitRotationHandle(box,cam,{x:knob.x,y:knob.y+17.9},true));
    assert(!hitRotationHandle(box,cam,{x:knob.x,y:knob.y+18.1},true));
    assert(!hitRotationHandle(box,cam,base,true));assert(!hitResizeHandle(box,cam,knob,true));
    for(const corner of RESIZE_CORNERS){
      const p=worldToScreen(cornerPoint(box,corner),cam);
      assert(!hitRotationHandle(box,cam,p,true));
      assert(Math.hypot(knob.x-p.x,knob.y-p.y)>22+18);
    }
  }
});
test("off-centre grabs cross the angle seam, preserve the pivot, and snap to board angles in 15 degree increments",()=>{
  const pivot={x:39,y:63},start={x:-5,y:65},initial=17*Math.PI/180;
  for(const change of [-108,-29,22,130]){
    const p=turn(start,pivot,change);
    const raw=dragRotation(initial,pivot,start,p)!;
    near(raw,(17+change)*Math.PI/180);
    near(constrainRotation(raw,initial,true),Math.round((17+change)/15)*Math.PI/12);
  }
  assert.equal(dragRotation(initial,pivot,start,start),initial);
  assert.equal(dragRotation(initial,pivot,start,pivot),undefined);
});
test("one release rotates the selected shape and exactly matches the live projection for both bound manual paths",()=>{
  const {editor,pivot,knob}=begin(),old=editor.history,projector=new SceneProjection(editor.doc);
  const p=turn(knob,pivot,90);
  editor.move(1,turn(knob,pivot,33));editor.move(1,p);
  assert.equal(editor.history,old);assert.deepEqual(editor.doc,pair.document);
  assert.deepEqual([...editor.preview!.objects.keys()],["b"]);
  const live=projector.overlay(editor.preview);
  assert.deepEqual([...live.keys()].sort(),["b","cross","internal"]);
  const path=(id:string)=>live.get(id)!.items.find(i=>i.kind==="path")!;
  assert.deepEqual(path("internal").points.at(-1),{x:48,y:9});
  assert.deepEqual(path("cross").points[0],{x:48,y:25});
  editor.up(1,p);editor.pointerCancelled(1);
  assert.equal(editor.history.past.length,1);assert(!editor.preview&&!editor.busy);
  for(const group of buildScene(editor.doc))if(live.has(group.id))assert.deepEqual(group,live.get(group.id));
  const reopened=decodeProject(encodeProject(editor.doc,new AssetVault())).document;
  assert.deepEqual(reopened.objects.b,{...shape,rotation:Math.PI/2});
  for(const id of ["internal","cross"] as const){
    const edge=reopened.objects[id];assert(edge.kind==="connector");
    assert.deepEqual(edge,pair.document.objects[id]);
    assert.deepEqual(resolveEndpoint(reopened,edge.from),path(id).points[0]);
  }
  editor.undo();assert.deepEqual(editor.doc,pair.document);assert.equal(editor.history.past.length,0);
  editor.redo();assert.equal(encodeProject(editor.doc,new AssetVault()),encodeProject(reopened,new AssetVault()));
});
test("image rotation changes only its angle and round trips the original PNG and optional aspect lock",()=>{
  const source=meeting.document.objects["qa-picture"];assert(source.kind==="image");
  for(const item of [source,{...source,lockAspect:false as const}]){
    const doc={...meeting.document,objects:{...meeting.document.objects,[item.id]:item}};
    const editor=new EditorSession(doc,camera),{knob}=rotationHandle(item,camera);
    const pivot=worldToScreen(localToWorld({x:item.width/2,y:item.height/2},item),camera);
    editor.select(item.id);editor.down(2,"pen",knob,item.id,false,false,{id:item.id,rotate:true});
    editor.up(2,turn(knob,pivot,-27),undefined,true);
    const saved=decodeProject(encodeProject(editor.doc,new AssetVault(meeting.assets)));
    assert.deepEqual(saved.assets,meeting.assets);
    assert.deepEqual(saved.document.objects[item.id],{...item,rotation:-Math.PI/6});
    editor.undo();assert.deepEqual(editor.doc,doc);
  }
});
test("tap, drag back and degenerate pivot samples leave no unwanted history; release supplies the final modifiers",()=>{
  for(const action of ["tap","return","pivot","snap"]){
    const {editor,pivot,knob}=begin(),p=turn(knob,pivot,22);
    if(action!=="tap"){editor.move(1,p);editor.move(1,pivot);}
    editor.up(1,action==="pivot"?pivot:action==="snap"?p:knob,undefined,true);
    assert.equal(editor.history.past.length,action==="tap"||action==="return"?0:1);
    const result=editor.doc.objects.b;assert(result.kind==="shape");
    near(result.rotation,(action==="pivot"||action==="snap"?15:0)*Math.PI/180);
  }
});
test("dragging through half a turn keeps the angle continuous and a complete revolution creates no undo step",()=>{
  const {editor,pivot,knob}=begin();
  for(const degrees of [89,175,192,269,350]){
    editor.move(1,turn(knob,pivot,degrees));
    const item=editor.preview?.objects.get("b");assert(item?.kind==="shape");
    near(item.rotation,degrees*Math.PI/180);
  }
  editor.up(1,knob);assert(!editor.preview);assert.equal(editor.history.past.length,0);
});
test("Esc, lost capture, changing selection or camera and reopening clear the rotation and ignore late release",()=>{
  for(const action of ["esc","lost","selection","camera","open"]){
    const {editor,knob,pivot}=begin(),end=turn(knob,pivot,64);editor.move(1,end);assert(editor.preview);
    if(action==="esc")editor.cancel();
    if(action==="lost")editor.pointerCancelled(1);
    if(action==="selection")editor.select("a");
    if(action==="camera")editor.setCamera({...camera,zoom:.5});
    if(action==="open")editor.open(meeting.document,true);
    editor.move(1,end);editor.up(1,end);
    assert(!editor.rotating&&!editor.preview&&!editor.busy);assert.equal(editor.history.past.length,0);
    assert.deepEqual(editor.doc,action==="open"?meeting.document:pair.document);
  }
});
test("a second finger takes over for pinch; lifting either finger never resumes or commits the rotation",()=>{
  for(const first of [1,2]){
    const {editor,knob,pivot}=begin("touch"),p=turn(knob,pivot,52);
    editor.move(1,p);assert(editor.preview);
    editor.down(2,"touch",{x:360,y:160},undefined,false);assert(!editor.preview&&!editor.rotating);
    editor.move(2,{x:410,y:180});assert.notEqual(editor.camera.zoom,camera.zoom);
    editor.up(first,p);const last=first===1?2:1;editor.move(last,knob);editor.up(last,knob);
    assert.deepEqual(editor.doc,pair.document);assert.equal(editor.history.past.length,0);assert(!editor.busy);
  }
});
