import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import type {BoardDocument,VectorPath} from "../core/document.ts";
import type {Point} from "../core/geometry.ts";
import {worldToScreen} from "../core/geometry.ts";
import {pathSegments,segmentPoint} from "../core/path-geometry.ts";
import {pathFrame,pathHandleBox,transformPath} from "../core/path-transform.ts";
import {decodeProject} from "../platform/project.ts";
import {EditorSession} from "../session/editor.ts";
import {cornerPoint,rotationHandle} from "../session/resize.ts";
import {hitTest,marqueeHit} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";

const base=decodeProject(readFileSync(new URL("../docs/fixtures/M5S-Cubic-Paths.mgcanvas",import.meta.url),"utf8")).document;
const loop=base.objects["closed-path"] as VectorPath,p=(x:number,y:number):Point=>({x,y});
const cam={zoom:1,offset:p(50,75)},shift=(v:Point,d:Point)=>p(v.x+d.x,v.y+d.y);
const alone=(path:VectorPath):BoardDocument=>({...base,objects:{[path.id]:path},order:[path.id]});
function near(a:Point,b:Point){assert(Math.hypot(a.x-b.x,a.y-b.y)<1e-7,JSON.stringify([a,b]));}

test("pure absolute path placement retains relative arrays, styles and every cubic sample across tile boundaries",()=>{
  for(const id of ["closed-path","open-path","straight-path"]){
    const path=base.objects[id] as VectorPath,at=p(-40,620),delta=p(at.x-path.at.x,at.y-path.at.y);
    const moved=transformPath(path,0,1,undefined,p(-40.25,619.5))!;
    assert.deepEqual(moved,{...path,at});assert.equal(moved.vertices,path.vertices);assert.equal(moved.curves,path.curves);
    assert.equal(transformPath(path,2*Math.PI,1,undefined,path.at),path);
    const before=pathSegments(path),after=pathSegments(moved);
    before.forEach((edge,i)=>{for(const t of [0,.25,.5,.75,1])near(segmentPoint(after[i],t),shift(segmentPoint(edge,t),delta));});
    const projector=new SceneProjection(alone(path)),patch=projector.overlay({objects:new Map([[id,moved]])});
    const where=after[0].from,area={min:p(where.x-1,where.y-1),max:p(where.x+1,where.y+1)};
    assert.equal(hitTest(projector.query(area,patch),where,0),id);assert.deepEqual(marqueeHit(projector.query(area,patch),area),[id]);
    assert.deepEqual(projector.query(area),[]);
  }
});
test("centered similarity precedes explicit final axes while untouched axes follow the original transform",()=>{
  const angle=.68,ratio=1.4,rotated=transformPath(loop,angle,ratio)!;
  const explicit=transformPath(loop,angle,ratio,undefined,{x:0})!;
  assert.deepEqual(explicit,{...rotated,at:{x:0,y:rotated.at.y}});
  const both=transformPath(loop,angle,ratio,undefined,{x:loop.at.x,y:-31.25})!;
  assert.deepEqual(both,{...rotated,at:{x:loop.at.x,y:-31}});
  const doc=alone(loop),editor=new EditorSession(doc,cam);editor.select(loop.id);
  assert(editor.transformSelection({x:0,y:-31.25}));assert.equal(editor.history.past.length,1);
  assert.deepEqual(editor.doc.objects[loop.id],{...loop,at:p(0,-31)});editor.undo();assert.deepEqual(editor.doc,doc);
  // Nonzero first local anchor in an older project: X/Y locate its stored origin.
  const old={...loop,vertices:loop.vertices.map(v=>shift(v,p(13,-9)))};
  const placed=transformPath(old,0,1,undefined,p(20,-10))!;assert.deepEqual(pathSegments(placed)[0].from,p(33,-19));
});
test("translation rejects nonfinite, out-of-range control points and lost world edges, validating combined transforms at the final destination",()=>{
  const line:VectorPath={kind:"path",id:"line",at:p(999999940,0),vertices:[p(0,0),p(50,0)],closed:false,stroke:"#000000",strokeWidth:1};
  assert.equal(transformPath(line,0,8),undefined);assert(transformPath(line,0,8,undefined,p(0,0)));
  const curve={...line,at:p(0,0),curves:{0:{out:p(120,0),in:p(0,0)}}};
  assert.equal(transformPath(curve,0,1,undefined,p(999999900,0)),undefined);
  for(const x of [NaN,Infinity,-Infinity])assert.equal(transformPath(curve,0,1,undefined,{x}),undefined);
  const tiny={...line,at:p(0,0),vertices:[p(0,0),p(1e-10,0)]};
  assert.equal(transformPath(tiny,0,1,undefined,p(1e9,0)),undefined);
  const nearFlat={...curve,curves:{0:{out:p(0,1e-10),in:p(0,0)}}};
  assert(transformPath(nearFlat,0,1,undefined,p(0,10)));
  assert.equal(transformPath(nearFlat,0,1,undefined,p(0,1e9)),undefined);
});
test("a visible preview grip transfers only its own pointer delta to the canonical path",()=>{
  for(const op of ["rotation","scale"] as const){
    const editor=new EditorSession(alone(loop),cam);editor.select(loop.id);
    const shown=transformPath(loop,.4,1.7,undefined,p(490,310))!,frame=pathFrame(shown),box=pathHandleBox(frame,cam);
    const pivot=worldToScreen(frame.center,cam),start=op==="rotation"?rotationHandle(box,cam).knob:worldToScreen(cornerPoint(box,"se"),cam);
    const delta=p(start.x-pivot.x,start.y-pivot.y),end=op==="rotation"?shift(pivot,p(-delta.y,delta.x)):shift(pivot,p(1.3*delta.x,1.3*delta.y));
    editor.down(1,"mouse",start,loop.id,false,false,op==="rotation"?{id:loop.id,rotate:true}:{id:loop.id,corner:"se",lockRatio:true},box);
    editor.move(1,end);assert.deepEqual(editor.doc.objects[loop.id],loop);editor.up(1,end);
    const changed=editor.doc.objects[loop.id] as VectorPath,expected=transformPath(loop,op==="rotation"?Math.PI/2:0,op==="scale"?1.3:1)!;
    near(changed.at,expected.at);changed.vertices.forEach((v,i)=>near(v,expected.vertices[i]));
    near(pathFrame(changed).center,pathFrame(expected).center);assert.equal(editor.history.past.length,1);
    editor.undo();assert.deepEqual(editor.doc.objects[loop.id],loop);
  }
});
