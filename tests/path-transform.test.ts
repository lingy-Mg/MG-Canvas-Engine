import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {VectorPath,BoardDocument} from "../core/document.ts";
import {validPathGeometry} from "../core/document.ts";
import {pathFrame,pathHandleBox,transformPath} from "../core/path-transform.ts";
import {pathSegments,segmentPoint} from "../core/path-geometry.ts";
import type {Point,Camera} from "../core/geometry.ts";
import {gridPoint,worldToScreen} from "../core/geometry.ts";
import {cornerPoint,rotationHandle,hitResizeHandle,hitRotationHandle,RESIZE_CORNERS} from "../session/resize.ts";
import {EditorSession} from "../session/editor.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {captureClipboard,decodeClipboard,encodeClipboard} from "../features/clipboard.ts";
import {AssetVault} from "../features/image-assets.ts";
import {commitPathEdit} from "../features/vector-path.ts";
import {buildScene,hitTest} from "../scene/board.ts";

const read=(n:string)=>decodeProject(readFileSync(new URL("../docs/fixtures/"+n+".mgcanvas",import.meta.url),"utf8"));
const fixture=read("M5U-Path-Transform"),loop=fixture.document.objects.loop as VectorPath;
const line=fixture.document.objects.line as VectorPath,thread=fixture.document.objects.thread as VectorPath;
const p=(x:number,y:number):Point=>({x,y}),cam:Camera={zoom:1,offset:p(0,0)};
const near=(a:Point,b:Point,tol=1e-8)=>assert(Math.hypot(a.x-b.x,a.y-b.y)<tol,JSON.stringify({a,b,tol}));
const around=(v:Point,o:Point,r:number,k:number)=>p(o.x+k*((v.x-o.x)*Math.cos(r)-(v.y-o.y)*Math.sin(r)),o.y+k*((v.x-o.x)*Math.sin(r)+(v.y-o.y)*Math.cos(r)));
const alone=(path:VectorPath):BoardDocument=>({...fixture.document,schemaVersion:path.curves?4:3,objects:{[path.id]:path},order:[path.id]});
const bytes=(doc:BoardDocument)=>encodeProject(doc,new AssetVault());
function session(path=loop,camera=cam){
  const e=new EditorSession(alone(path),camera);e.select(path.id);return e;
}
function grab(e:EditorSession,type="mouse",operation:"scale"|"rotate"="scale"){
  const id=e.selection!,item=e.doc.objects[id] as VectorPath,frame=pathFrame(item),box=pathHandleBox(frame,e.camera);
  const pivot=worldToScreen(frame.center,e.camera),corner=worldToScreen(cornerPoint(box,"se"),e.camera),knob=rotationHandle(box,e.camera).knob;
  const start=operation==="rotate"?knob:corner;
  e.down(1,type,start,id,false,false,operation==="rotate"?{id,rotate:true}:{id,corner:"se",lockRatio:true});
  return {pivot,start};
}
test("affine similarity transforms every cubic sample and its owned handles, including the closing edge, with constant outline width",()=>{
  const frame=pathFrame(loop),r=.473,k=1.72,next=transformPath(loop,r,k)!;
  assert.equal(next.strokeWidth,3.5);assert.equal(next.stroke,loop.stroke);assert.equal(next.fill,loop.fill);assert.equal(next.closed,true);
  assert.deepEqual(Object.keys(next.curves!),Object.keys(loop.curves!));assert.deepEqual(Object.keys(next).sort(),Object.keys(loop).sort());
  const edges=pathSegments(loop),changed=pathSegments(next);
  edges.forEach((edge,i)=>{
    const snapped=(p:Point)=>gridPoint(around(p,frame.center,r,k));
    assert.deepEqual(changed[i].from,snapped(edge.from));assert.deepEqual(changed[i].to,snapped(edge.to));
    if(edge.controls){assert.deepEqual(changed[i].controls!.c1,snapped(edge.controls.c1));assert.deepEqual(changed[i].controls!.c2,snapped(edge.controls.c2));}
    for(let j=0;j<=200;j++)near(segmentPoint(changed[i],j/200),around(segmentPoint(edge,j/200),frame.center,r,k),Math.SQRT1_2+1e-8);
  });
  near(pathFrame(next).center,frame.center,Math.SQRT1_2);
  near(p(pathFrame(next).width,pathFrame(next).height),p(frame.width*k,frame.height*k),Math.SQRT2);
  const first=changed[0];assert(Math.abs(pathFrame(next).rotation-Math.atan2(first.to.y-first.from.y,first.to.x-first.from.x))<1e-12);
  const at=around(p(150,145),frame.center,r,k);assert.equal(hitTest(buildScene(alone(next)),at,0),loop.id);
});
test("true bounds include the cubic extremum; asymmetric path center survives repeated edits, reopen and nonzero first vertex",()=>{
  const arch=read("M5T-Insert-Vertices").document.objects.arch as VectorPath;
  near(pathFrame(arch).center,p(160,515));assert.equal(pathFrame(arch).height,90);
  let next=loop;
  for(let i=0;i<12;i++){
    const center=pathFrame(next).center;
    next=transformPath(next,(i%2?-13:39)*Math.PI/180,i%2?.8:1.25)!;
    near(pathFrame(next).center,center,Math.SQRT1_2);
    const reopened=decodeProject(bytes(alone(next))).document.objects.loop as VectorPath;
    assert.deepEqual(reopened,next);next=reopened;
  }
});
test("short, vertical, nearly collinear and single-edge paths have four independent targets plus a separated rotation target at both zoom limits",()=>{
  const flat={...line,vertices:[p(0,0),p(1e-12,0),p(0,40),p(1e-10,80)]};
  for(const item of [line,thread,flat])for(const zoom of [.05,16]){
    const camera={zoom,offset:p(-21,38)},frame=pathFrame(item),box=pathHandleBox(frame,camera),pivot=worldToScreen(frame.center,camera);
    assert(box.width*zoom>=47.99999&&box.height*zoom>=47.99999);
    const {base,knob}=rotationHandle(box,camera);assert(Math.abs(Math.hypot(knob.x-base.x,knob.y-base.y)-42)<1e-8);
    for(const touch of [false,true]){
      assert(hitRotationHandle(box,camera,knob,touch));assert.equal(hitResizeHandle(box,camera,knob,touch),undefined);
      assert(!hitRotationHandle(box,camera,pivot,touch));assert.equal(hitResizeHandle(box,camera,pivot,touch),undefined);
      for(const corner of RESIZE_CORNERS){
        const at=worldToScreen(cornerPoint(box,corner),camera);assert.equal(hitResizeHandle(box,camera,at,touch),corner);assert(!hitRotationHandle(box,camera,at,touch));
      }
    }
    const e=session(item,camera),initial=e.doc.objects[item.id] as VectorPath,{pivot:o,start}=grab(e,"touch");e.up(1,around(start,o,0,3));
    assert.equal(e.history.past.length,1);assert.deepEqual(e.doc.objects[item.id],transformPath(initial,0,3));
  }
});
test("identity, invalid scale, out-of-range controls and numeric loss cannot create an edit or resurrect an earlier preview",()=>{
  const e=session(),live=e.doc.objects.loop as VectorPath;
  assert.equal(transformPath(live,0,1),live);assert.equal(transformPath(live,-2*Math.PI,1),live);
  for(const [r,k] of [[0,0],[0,-2],[0,NaN],[Infinity,1],[0,1e20],[0,Number.MIN_VALUE]])assert.equal(transformPath(live,r,k),undefined);
  const outside={...thread,at:p(999999990,0),vertices:[p(0,0),p(1,0)],curves:{0:{out:p(9,0),in:p(1,0)}}};
  assert(validPathGeometry(outside));assert.equal(transformPath(outside,0,10),undefined);
  const {pivot,start}=grab(e);e.move(1,around(start,pivot,0,1.3));assert(e.preview);
  e.up(1,around(start,pivot,0,-.2));assert.equal(e.preview,undefined);assert.equal(e.history.past.length,0);
  const rot=grab(e,"mouse","rotate");e.move(1,around(rot.start,rot.pivot,.4,1));assert(e.preview);
  e.up(1,rot.pivot);assert.equal(e.history.past.length,0);
});
test("a valid legacy contour with a remote local origin rotates without cancellation or loss of the original v3 on undo",()=>{
  const remote={...line,at:p(1e20,0),vertices:[p(-1e20,0),p(-1e20,64)]},e=session(remote);
  const prior=bytes(e.doc),live=e.doc.objects[remote.id] as VectorPath,frame=pathFrame(live);
  const next=transformPath(live,Math.PI/4,.75)!;assert(next&&validPathGeometry(next));
  const before=pathSegments(live)[0],edge=pathSegments(next)[0];
  assert.deepEqual(edge.from,gridPoint(around(before.from,frame.center,Math.PI/4,.75)));assert.deepEqual(edge.to,gridPoint(around(before.to,frame.center,Math.PI/4,.75)));
  near(pathFrame(next).center,frame.center);
  assert(commitPathEdit(e,live,next,e.generation));assert.equal(e.doc.schemaVersion,3);
  e.undo();assert.equal(bytes(e.doc),prior);
});
test("corner projection preserves the grab offset and aspect; pointer-up alone commits once and undo restores exact v3 bytes",()=>{
  const e=session(line),old=bytes(e.doc),item=e.doc.objects.line as VectorPath;
  const frame=pathFrame(item),at=cornerPoint(pathHandleBox(frame,cam),"nw"),o=frame.center;
  const start=p(at.x+3,at.y-2),end=p(start.x+.5*(at.x-o.x),start.y+.5*(at.y-o.y));
  e.down(1,"pen",start,undefined,false,false,{id:line.id,corner:"nw",lockRatio:false});e.up(1,end);
  const next=e.doc.objects.line as VectorPath,expected=transformPath(item,0,1.5)!;
  assert.deepEqual(next.vertices,expected.vertices);near(next.at,expected.at);assert(!("curves" in next));assert.equal(e.doc.schemaVersion,3);
  assert.equal(e.history.past.length,1);e.up(1,end);e.undo();assert.equal(bytes(e.doc),old);
  e.redo();assert.equal(bytes(e.doc),bytes(alone(expected)));
});
test("clockwise rotation uses relative 15-degree Shift snapping; export and object copy remain canonical through preview",()=>{
  const e=session(loop),old=bytes(e.doc),vault=new AssetVault(),live=e.doc.objects.loop as VectorPath;
  const wire=()=>encodeClipboard(captureClipboard(e.doc,e.selectedIds,vault)!);
  const before=wire(),{start,pivot}=grab(e,"mouse","rotate"),end=around(start,pivot,37*Math.PI/180,1);
  e.move(1,end);e.setRotationSnap(true);const preview=e.preview!.objects.get(loop.id) as VectorPath;
  assert.deepEqual(pathSegments(preview)[0].from,gridPoint(around(pathSegments(live)[0].from,pivot,Math.PI/6,1)));
  assert.equal(bytes(e.doc),old);assert.equal(wire(),before);assert.equal(e.history.past.length,0);
  e.up(1,end,undefined,true);assert.equal(bytes(e.doc),bytes(alone(preview)));assert.equal(e.history.past.length,1);
  assert.equal(decodeClipboard(wire()).document.schemaVersion,4);e.undo();assert.equal(wire(),before);assert.equal(bytes(e.doc),old);
});
test("interruptions clear a whole-path draft before late release, second-contact handoff, selection or board replacement",()=>{
  for(const operation of ["rotate","scale"] as const)for(const reason of ["cancel","lost","second","open","select","camera"]){
    const e=session(loop),old=bytes(e.doc),{start,pivot}=grab(e,"touch",operation);
    const q=around(start,pivot,operation==="rotate"?.7:0,operation==="scale"?1.4:1);
    e.move(1,q);assert(e.preview);
    if(reason==="cancel")e.cancel();
    if(reason==="lost")e.pointerCancelled(1);
    if(reason==="select")e.select();
    if(reason==="camera")e.setCamera({...cam,zoom:2});
    if(reason==="open"){e.open(alone(loop),true);assert(!e.busy);}
    if(reason==="second"){e.down(2,"touch",p(q.x+65,q.y),undefined,false);e.move(2,p(q.x+115,q.y));assert(e.camera.zoom>1);e.up(2,q);}
    assert.equal(e.preview,undefined);e.up(1,q);assert.equal(e.history.past.length,0);assert.equal(bytes(e.doc),old);assert(!e.busy);
  }
});
test("mixed selection keeps whole-path handles inactive and format, pressure, assets and bindings survive a commit, save, clipboard and undo",()=>{
  for(const name of ["M5R-Vector-Paths","M5S-Cubic-Paths"]){
    const pkg=read(name),vault=new AssetVault(pkg.assets),e=new EditorSession(pkg.document,cam),id="closed-path";
    const serialized=()=>encodeProject(e.doc,vault),original=serialized();e.selectAll();
    e.down(8,"mouse",p(40,40),id,false,false,{id,rotate:true});assert(!e.transforming);e.pointerCancelled(8);
    const path=e.doc.objects[id] as VectorPath,next=transformPath(path,-.713,.84)!;
    assert(!commitPathEdit(e,path,next,e.generation));e.select(id);assert(commitPathEdit(e,path,next,e.generation));
    for(const other of e.doc.order.filter(s=>s!==id))assert.deepEqual(e.doc.objects[other],pkg.document.objects[other]);
    const saved=serialized(),reopen=decodeProject(saved);assert.deepEqual(reopen.assets,pkg.assets);
    assert.equal(e.doc.schemaVersion,pkg.document.schemaVersion);assert.equal(encodeProject(reopen.document,new AssetVault(reopen.assets)),saved);
    const fragment=captureClipboard(e.doc,e.doc.order,vault)!;assert.deepEqual(decodeClipboard(encodeClipboard(fragment)).assets,pkg.assets);
    assert.equal(e.history.past.length,1);e.undo();assert.equal(serialized(),original);e.redo();assert.equal(serialized(),saved);
  }
});
