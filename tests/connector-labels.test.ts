import assert from "node:assert/strict";
import {test} from "node:test";
import type {BoardDocument,BoardObject,Connector} from "../core/document.ts";
import type {Rect} from "../core/geometry.ts";
import {insideVector,segmentDistance} from "../core/path-geometry.ts";
import {createHistory,dispatch,redo,undo} from "../core/history.ts";
import {flowLabelAnchor} from "../features/flow.ts";
import {estimatedTextWidth} from "../features/text-layout.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {buildScene,marqueeHit} from "../scene/board.ts";
import type {DrawGroup} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";

const p=(x:number,y:number)=>({x,y});
function line(id:string,x:number,label=""):Connector{
  return {kind:"connector",id,label,routing:"orthogonal",arrow:"end",stroke:"#456",strokeWidth:2,
    labelFontSize:16,waypoints:[],from:{kind:"free",point:p(x,0)},to:{kind:"free",point:p(x,220)}};
}
const makeBoard=(...objects:BoardObject[]):BoardDocument=>({id:"label-layout",schemaVersion:1,theme:"paper",order:objects.map(o=>o.id),
  objects:Object.fromEntries(objects.map(o=>[o.id,o])),assets:{}});
function text(group:DrawGroup){
  const item=group.items.find(item=>item.kind==="text");assert(item);return item;
}
function glyph(group:DrawGroup):Rect{
  const t=text(group),width=estimatedTextWidth(t.text,t.size);
  const x=t.at.x-(t.align==="left"?0:t.align==="right"?width:width/2);
  return {min:p(x,t.at.y-t.size/2),max:p(x+width,t.at.y+t.size/2)};
}
function gap(group:DrawGroup,box:Rect){
  const path=group.items[0];assert(path.kind==="path");
  const pts=path.arrows?.shaft??path.points;
  let d=Infinity;
  for(let i=1;i<pts.length;i++)d=Math.min(d,segmentDistance({from:pts[i-1],to:pts[i]},box,Infinity)-path.width/2);
  for(const head of path.arrows?.heads??[]){
    const sides=head.map((from,i)=>({from,to:head[(i+1)%3]}));
    if(insideVector(sides,box.min))return 0;
    for(const side of sides)d=Math.min(d,segmentDistance(side,box,Infinity));
  }
  return d;
}
test("an offset parallel connector clears the whole caption, in board, viewport and single-object export",()=>{
  const owner=line("snapshot",0,"写入快照"),other=line("internal",68);
  const doc=makeBoard(owner,other),scene=buildScene(doc),caption=scene[0],ink=glyph(caption);
  assert.equal(text(caption).align,"right");assert(gap(scene[1],ink)>=6);
  assert.deepEqual(buildScene(doc,undefined,[owner.id]),[caption]);
  const projection=new SceneProjection(doc);
  assert.deepEqual(projection.all(),scene);
  const probe={min:ink.min,max:ink.min};
  assert.deepEqual(projection.query(probe),[caption]);
  assert.deepEqual(marqueeHit([caption],probe),[]); // Hit testing still follows the native line.
  const raw=buildScene(makeBoard({...owner,label:""},other))[0];
  assert.deepEqual(caption.items[0],raw.items[0]);assert.deepEqual(caption.picks,raw.picks);
});
test("moving a separate line invalidates the caption during preview, commit, undo, redo and visibility changes",()=>{
  const owner=line("snapshot",0,"写入快照"),distant=line("internal",240),near=line("internal",65);
  const original=makeBoard(owner,distant),h=createHistory(original),index=new SceneProjection(original);
  const first=index.group(owner.id)!;
  assert.equal(text(first).align,"left");
  const override={objects:new Map([[near.id,near]])},patch=index.overlay(override);
  assert.equal(text(index.group(owner.id,patch)!).align,"right");
  assert.deepEqual(index.all(patch),buildScene(original,override));assert.strictEqual(index.group(owner.id),first);
  const moved=dispatch(h,{label:"重新接线",patches:[{op:"putObject",value:near}]});
  index.update(moved.state.doc,moved.changeSet);
  assert.strictEqual(moved.state.doc.objects[owner.id],h.doc.objects[owner.id]);
  assert.deepEqual(index.all(),buildScene(moved.state.doc));
  index.setHidden(new Set([near.id]));assert.deepEqual(index.group(owner.id),first);
  index.setHidden(new Set());assert.equal(text(index.group(owner.id)!).align,"right");
  const before=undo(moved.state);index.update(before.state.doc,before.changeSet);assert.deepEqual(index.group(owner.id),first);
  const after=redo(before.state);index.update(after.state.doc,after.changeSet);assert.deepEqual(index.all(),buildScene(after.state.doc));
});
test("old captions respect a hand-positioned annotation and keep explicit route pins across export and reopening",()=>{
  const {labelFontSize,...legacy}=line("caption",0,"写入快照");
  const owner={...legacy,waypoints:[p(0,10)]},wall=line("internal",42);
  const manual:BoardObject={kind:"text",id:"manual",at:p(-80,92),width:74,height:50,heightMode:"fixed",rotation:0,
    text:"手动定位",fontSize:14,align:"left",color:"#121212"};
  const doc=makeBoard(owner,wall,manual),saved=encodeProject(doc,new AssetVault()),scene=buildScene(doc);
  const box=glyph(scene[0]),note=scene[2].bounds;
  assert.equal(text(scene[0]).size,10);assert(gap(scene[1],box)>=6);
  assert(box.max.y+6<=note.min.y||box.min.y-6>=note.max.y||box.min.x-6>=note.max.x||box.max.x+6<=note.min.x);
  assert.deepEqual(scene[2],buildScene(makeBoard(manual))[0]);
  assert.equal(encodeProject(doc,new AssetVault()),saved);
  const loaded=decodeProject(saved).document;
  assert.deepEqual(loaded.objects[owner.id],owner);assert.deepEqual(loaded.objects[manual.id],manual);
  assert.deepEqual(buildScene(loaded),scene);
});
test("curve samples, arrowheads and diamond outlines decide collision, including empty corners in overlapping bounds",()=>{
  const owner=line("owner",0,"写入快照");
  const diamond:BoardObject={kind:"shape",id:"choice",shape:"diamond",at:p(52,15),width:144,height:110,rotation:0,
    label:"?",cornerRadius:0,strokeWidth:2,fill:"#eeeeee",stroke:"#444444"};
  const distant:Connector={...line("slant",20),routing:"straight",from:{kind:"free",point:p(20,-300)},to:{kind:"free",point:p(200,240)}};
  const natural=buildScene(makeBoard(owner))[0];
  assert.deepEqual(text(buildScene(makeBoard(owner,diamond,distant))[0]),text(natural));
  const crossing:Connector={...line("curve",90),routing:"curve",portCurve:true,
    from:{kind:"free",point:p(18,10)},to:{kind:"free",point:p(18,215)},waypoints:[p(62,105)]};
  const scene=buildScene(makeBoard(owner,crossing));
  assert(gap(scene[1],glyph(natural))<=0);assert(gap(scene[1],glyph(scene[0]))>=6);
  const tip:Connector={...line("tip",77),routing:"straight",strokeWidth:3,from:{kind:"free",point:p(77,190)},to:{kind:"free",point:p(77,96)}};
  const withArrow=buildScene(makeBoard(owner,tip));
  assert(gap(withArrow[1],glyph(natural))<=0);assert(gap(withArrow[1],glyph(withArrow[0]))>=6);
});
test("nearby captions get separate space independent of visibility order and retain the clear original anchors",()=>{
  const a=line("a",0,"写入快照"),b=line("b",1,"读取快照"),doc=makeBoard(a,b),index=new SceneProjection(doc);
  const first=text(index.group("a")!),second=text(index.group("b")!);
  assert.equal(first.align,"left");assert.equal(second.align,"right");
  assert.deepEqual(text(buildScene(makeBoard(b,a))[0]),second);
  index.setHidden(new Set(["a"]));assert.equal(text(index.group("b")!).align,"left");
  index.setHidden(new Set());assert.deepEqual(text(index.group("b")!),second);
  const route=index.group("a")!.items[0];assert(route.kind==="path");
  assert.deepEqual(flowLabelAnchor(route.points,false,16),{point:first.at,align:first.align});
});
