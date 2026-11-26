import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {MAX_PATH_VERTICES,MAX_BOARD_PATH_VERTICES} from "../core/document.ts";
import type {BoardDocument,VectorPath} from "../core/document.ts";
import type {Point} from "../core/geometry.ts";
import {gridPoint} from "../core/geometry.ts";
import {pathSegments,segmentPoint,nearestParameter} from "../core/path-geometry.ts";
import type {PathSegment} from "../core/path-geometry.ts";
import {withInsertedVertex,commitPathEdit} from "../features/vector-path.ts";
import {PathInput} from "../features/path-input.ts";
import {EditorSession} from "../session/editor.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {SceneProjection} from "../scene/projector.ts";
import {hitTest,marqueeHit} from "../scene/board.ts";
import {CanvasView} from "../renderers/canvas2d/canvas.ts";

const read=(name:string)=>decodeProject(readFileSync(new URL("../docs/fixtures/"+name+".mgcanvas",import.meta.url),"utf8"));
const sample=read("M5T-Insert-Vertices"),mixed=read("M5S-Cubic-Paths"),lines=read("M5R-Vector-Paths");
const arch=sample.document.objects.arch as VectorPath,closing=sample.document.objects.closing as VectorPath;
const p=(x:number,y:number):Point=>({x,y}),camera={zoom:1,offset:p(0,0)};
const near=(a:Point,b:Point,epsilon=1e-9)=>assert(Math.hypot(a.x-b.x,a.y-b.y)<epsilon,JSON.stringify([a,b,epsilon]));
const board=(shape:VectorPath):BoardDocument=>({...sample.document,schemaVersion:shape.curves?4:3,order:[shape.id],objects:{[shape.id]:shape}});
const bytes=(d:BoardDocument)=>encodeProject(d,new AssetVault());
function compareSplit(s:PathSegment,children:readonly PathSegment[],t:number){
  const [a,b]=children;assert.deepEqual(a.to,b.from);
  assert.deepEqual(a.to,gridPoint(segmentPoint(s,t)));
  // Each rounded control is within half a unit per axis. Bézier weights form a convex combination.
  const gridError=Math.SQRT1_2+1e-9;
  for(let n=0;n<=160;n++){
    const u=n/160;near(segmentPoint(a,u),segmentPoint(s,u*t),gridError);near(segmentPoint(b,u),segmentPoint(s,t+(1-t)*u),gridError);
  }
}
test("unequal de Casteljau subdivision preserves the open curve, attached handles, sibling segments and one-step history",()=>{
  const original=mixed.document.objects["open-path"] as VectorPath;
  const item:VectorPath={...original,curves:{...original.curves,1:{out:p(-11,20),in:p(3,-7)}}};
  const e=new EditorSession(board(item),camera);e.select(item.id);const old=bytes(e.doc),live=e.doc.objects[item.id] as VectorPath,edges=pathSegments(live);
  const split=withInsertedVertex(live,0,.271),newEdges=pathSegments(split);
  assert.equal(split.vertices.length,item.vertices.length+1);assert.equal(split.vertices[0],live.vertices[0]);assert.equal(split.vertices[2],live.vertices[1]);
  assert.equal(split.curves![2],live.curves![1]);assert.deepEqual(newEdges[2],edges[1]);compareSplit(edges[0],newEdges,.271);
  assert(commitPathEdit(e,live,split,e.generation,"插入路径顶点"));assert.equal(e.history.past.length,1);assert.equal(e.doc.schemaVersion,4);
  const saved=bytes(e.doc);assert.equal(bytes(decodeProject(saved).document),saved);e.undo();assert.equal(bytes(e.doc),old);e.redo();assert.equal(bytes(e.doc),saved);
});
test("splitting middle straight and closed last edges keeps the first vertex, sparse curve indices, fill and v3/v4 formats",()=>{
  const old=lines.document.objects["closed-path"] as VectorPath,curved:VectorPath={...old,curves:{0:{out:p(15,3),in:p(-9,-4)},3:{out:p(-5,45),in:p(-30,9)}}};
  const edges=pathSegments(curved),middle=withInsertedVertex(curved,1,.64),mapped=pathSegments(middle);
  assert.deepEqual(Object.keys(middle.curves!),["0","4"]);assert.deepEqual(mapped[0],edges[0]);assert.deepEqual(mapped[3],edges[2]);assert.deepEqual(mapped[4],edges[3]);
  compareSplit(edges[1],mapped.slice(1),.64);
  const last=withInsertedVertex(curved,3,.39),end=pathSegments(last);
  assert.equal(last.closed,true);assert.equal(last.fill,old.fill);assert.equal(last.at,old.at);assert.equal(last.vertices[0],old.vertices[0]);
  assert.deepEqual(last.vertices.slice(0,4),old.vertices);assert.deepEqual(end.slice(0,3),edges.slice(0,3));compareSplit(edges[3],end.slice(3),.39);
  const plain=withInsertedVertex(old,3,.39);assert(!("curves" in plain));assert.equal(decodeProject(bytes(board(plain))).document.schemaVersion,3);
});
test("click projection finds the cubic parameter on a nonuniform collinear segment and on returning or overlapping geometry",()=>{
  const ease:PathSegment={from:p(8,27),to:p(808,27),controls:{c1:p(8,27),c2:p(8,27)}};
  const t=nearestParameter(ease,p(108,31));assert(Math.abs(t-.5)<1e-5);
  const returning:PathSegment={from:p(40,30),to:p(55,42),controls:{c1:p(140,230),c2:p(-90,195)}};
  for(const u of [.037,.19,.45,.681,.964]){
    const at=segmentPoint(returning,u);near(segmentPoint(returning,nearestParameter(returning,at)),at,.0002);
  }
  const straight={from:p(35,51),to:p(90,51)};assert.equal(nearestParameter(straight,p(4,82)),0);assert.equal(nearestParameter(straight,p(100,51)),1);
  assert.equal(nearestParameter({from:p(16,71),to:p(16,71),controls:{c1:p(16,71),c2:p(16,71)}},p(17,71)),0);
});
test("invalid indices, endpoints, collapsed splits and vertex limits leave the document and its history untouched",()=>{
  const e=new EditorSession(board(arch),camera);e.select(arch.id);const before=e.history,source=e.doc.objects.arch as VectorPath;
  for(const [i,t] of [[-1,.5],[1,.5],[.25,.5],[NaN,.5],[0,NaN],[0,Infinity],[0,-.1],[0,0],[0,1e-7],[0,1-1e-7],[0,1],[0,1.4]]){
    assert.equal(withInsertedVertex(source,i,t),source);
    assert(!commitPathEdit(e,source,withInsertedVertex(source,i,t),e.generation));assert.equal(e.history,before);
  }
  // B(.5) returns to the starting anchor even though .5 is an interior parameter.
  const folded:VectorPath={...arch,vertices:[p(0,0),p(120,0)],curves:{0:{out:p(-40,0),in:p(-120,0)}}};
  assert.equal(withInsertedVertex(folded,0,.5),folded);
  const {curves,...line}=arch,points=Array.from({length:MAX_PATH_VERTICES},(_,i)=>p(i,24)),full={...line,vertices:points};
  assert.equal(withInsertedVertex(full,1,.5),full);
  const objects:Record<string,VectorPath>={arch:{...line,vertices:[p(0,0),p(64,16)]}};
  for(let count=2;count<MAX_BOARD_PATH_VERTICES;count+=points.length){
    const id="budget-"+count;objects[id]={...line,id,vertices:points.slice(0,Math.min(points.length,MAX_BOARD_PATH_VERTICES-count))};
  }
  const large=new EditorSession({...board(line),objects,order:Object.keys(objects)},camera),input=new PathInput(large);
  large.select("arch");const live=large.doc.objects.arch as VectorPath,history=large.history;input.start(live);
  assert(!input.canInsert&&!input.armInsert()&&!input.insertMidpoint());
  assert(!commitPathEdit(large,live,withInsertedVertex(live,0,.5),large.generation));assert.equal(large.history,history);
  const single=new EditorSession(board(full),camera),limited=new PathInput(single);single.select(full.id);
  limited.start(single.doc.objects[full.id] as VectorPath);assert(!limited.canInsert);
});
test("insert is single-use, rejects near endpoints in CSS pixels, ignores accidental drags and discards stale pointer releases",()=>{
  const e=new EditorSession(board(arch),camera);e.select("arch");const input=new PathInput(e);e.listen(()=>input.sync());input.start(e.doc.objects.arch as VectorPath);
  const s=pathSegments(arch)[0],at=segmentPoint(s,.31),old=e.history;
  input.down(5,"mouse",at);input.up(5,at);assert.equal(e.history,old);
  assert(input.armInsert());input.move(5,at);assert.deepEqual(input.decor()!.insertAt!,gridPoint(at));assert.equal(e.history,old);
  for(const [device,margin] of [["mouse",4],["touch",10]] as const){
    const endpoint=p(s.from.x,s.from.y+margin);input.down(5,device,endpoint);input.up(5,endpoint);assert.equal(e.history,old);
  }
  input.down(5,"mouse",at);input.move(5,p(at.x+27,at.y));input.move(5,at);input.up(5,at);assert.equal(e.history,old);
  input.down(5,"mouse",at);input.history(false);input.up(5,at);assert.equal(e.history,old);assert(input.mode==="anchors"&&!input.inserting&&!input.preview);
  input.armInsert();input.down(8,"touch",at);input.up(8,at);input.up(8,at);
  assert.equal(e.history.past.length,1);assert(!input.inserting);assert.equal((e.doc.objects.arch as VectorPath).vertices.length,3);
  input.history(false);assert.equal(e.history.past.length,0);assert.equal(input.mode,"anchors");input.history(true);assert.equal(e.history.past.length,1);
});
test("undo and redo discard active control previews, retain the surviving path and clamp the active segment after topology changes",()=>{
  const e=new EditorSession(board(closing),camera),input=new PathInput(e);e.listen(()=>input.sync());e.select("closing");input.start(e.doc.objects.closing as VectorPath,2);
  input.armInsert();assert(input.insertMidpoint());input.choose(3);const committed=bytes(e.doc);
  const last=pathSegments(e.doc.objects.closing as VectorPath)[3],handle=last.controls!.c2;
  input.part="in";input.down(9,"mouse",handle);input.move(9,p(handle.x+20,handle.y+28));assert(input.preview);
  input.history(false);assert.equal(input.mode,"anchors");assert.equal(input.segment,2);assert(!input.pointer&&!input.preview);input.up(9,handle);
  assert.equal(bytes(e.doc),bytes(board(closing)));assert.equal(e.history.past.length,0);
  input.part="out";const first=pathSegments(closing)[2].controls!.c1;
  input.down(10,"mouse",first);input.move(10,p(first.x-20,first.y+18));assert(input.preview);
  input.history(true);input.up(10,first);assert.equal(bytes(e.doc),committed);assert.equal(e.history.past.length,1);assert.equal(input.mode,"anchors");
});
test("a newly inserted anchor can be dragged immediately, with separate insert and move undo/redo frames",()=>{
  const e=new EditorSession(board(arch),camera),input=new PathInput(e);e.select(arch.id);e.listen(()=>input.sync());
  input.start(e.doc.objects.arch as VectorPath);const original=bytes(e.doc);
  input.armInsert();assert(input.insertMidpoint());const inserted=bytes(e.doc),center=pathSegments(e.doc.objects.arch as VectorPath)[0].to;
  const end=p(center.x+11,center.y-17);input.down(3,"mouse",center);input.move(3,end);assert.equal(bytes(e.doc),inserted);
  input.up(3,end);const moved=bytes(e.doc);assert.notEqual(moved,inserted);assert.equal(e.history.past.length,2);
  const edges=pathSegments(e.doc.objects.arch as VectorPath);near(edges[0].to,end);near(edges[1].from,end);
  input.history(false);assert.equal(bytes(e.doc),inserted);input.history(false);assert.equal(bytes(e.doc),original);
  input.history(true);assert.equal(bytes(e.doc),inserted);input.history(true);assert.equal(bytes(e.doc),moved);assert.equal(input.mode,"anchors");
});
test("only the cubic bulge in 512-unit grid row 1 is drawn and picked in preview, incremental commit, undo and redo",()=>{
  // With one handle on each side, the cubic stays in row 0. Move only the outgoing handle.
  const low:VectorPath={...arch,curves:{0:{out:p(0,-120),in:p(0,120)}}};
  const e=new EditorSession(board(low),camera),projection=new SceneProjection(e.doc),input=new PathInput(e);
  const changes:string[]=[];e.listen(change=>{input.sync();if(change)changes.push(projection.update(e.doc,change).mode);});e.select("arch");input.start(e.doc.objects.arch as VectorPath);
  const viewport={min:p(152,552),max:p(168,566)},paint:number[][]=[];
  const context=new Proxy({bezierCurveTo:(...args:number[])=>paint.push(args)}, {get:(obj,key)=>Reflect.get(obj,key)??(()=>{})});
  const view=new CanvasView({getContext:()=>context} as unknown as HTMLCanvasElement);view.size(16,14,1);
  function frame(expected:boolean){
    // Pass no selected IDs: only the spatial index and the preview overlay can supply this group.
    const scene=projection.query(viewport,projection.overlay(input.preview));paint.length=0;
    view.draw(scene,{offset:p(-152,-552),zoom:1},[]);
    assert.deepEqual(paint,expected?[[100,590,220,590,220,470]]:[]);
    assert.equal(hitTest(scene,p(160,560),0),expected?"arch":undefined);
    assert.deepEqual(marqueeHit(scene,{min:p(159,559.5),max:p(161,560.5)}),expected?["arch"]:[]);
    assert.equal(hitTest(scene,p(160,562),0),undefined);
    if(expected)assert.equal(scene[0].bounds.max.y,561);
  }
  frame(false);input.part="out";input.down(7,"mouse",p(100,350));input.move(7,p(100,590));assert.equal(e.history.past.length,0);
  frame(true);input.up(7,p(100,590));assert.equal(e.history.past.length,1);frame(true);
  input.history(false);frame(false);input.history(true);frame(true);assert.deepEqual(changes,["incremental","incremental","incremental"]);
  input.part="out";input.down(8,"mouse",p(100,590));input.move(8,p(100,350));frame(false);
  assert.equal(e.history.past.length,1);input.cancel();input.up(8,p(100,350));frame(true);
});
