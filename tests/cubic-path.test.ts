import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {assertDocument} from "../core/document.ts";
import type {VectorPath} from "../core/document.ts";
import {worldToScreen} from "../core/geometry.ts";
import {closestSegment,insideVector,pathSegments,segmentDistance,segmentPoint,vectorBounds} from "../core/path-geometry.ts";
import {commitPathVertex,withPathControl,withPathVertex,withSegmentKind} from "../features/vector-path.ts";
import {PathInput} from "../features/path-input.ts";
import {buildScene,hitTest,marqueeHit} from "../scene/board.ts";
import {EditorSession} from "../session/editor.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {captureClipboard,decodeClipboard,encodeClipboard,pasteClipboard} from "../features/clipboard.ts";
const p=(x:number,y:number)=>({x,y}),rect=(x:number,y:number,w=0,h=0)=>({min:p(x,y),max:p(x+w,y+h)});
const legacy=decodeProject(readFileSync(new URL("../docs/fixtures/M5R-Vector-Paths.mgcanvas",import.meta.url),"utf8"));
const fixture=decodeProject(readFileSync(new URL("../docs/fixtures/M5S-Cubic-Paths.mgcanvas",import.meta.url),"utf8"));
const straight:VectorPath={kind:"path",id:"line",at:p(0,0),vertices:[p(0,0),p(100,0)],closed:false,stroke:"#123456",strokeWidth:2};
const arch:VectorPath={...straight,curves:{0:{out:p(0,100),in:p(0,100)}}};
const camera={offset:p(0,0),zoom:1};
const board=(shape:VectorPath)=>({...legacy.document,schemaVersion:shape.curves?4 as const:3 as const,order:[shape.id],objects:{[shape.id]:shape},assets:{}});
const near=(a:number,b:number,epsilon=1e-7)=>assert(Math.abs(a-b)<epsilon,a+" differs from "+b);
test("segment conversion keeps the contour straight with integer handles and undoes v4 promotion exactly",()=>{
  const e=new EditorSession(board(straight),camera);e.select("line");const input=new PathInput(e);
  const original=e.doc;input.start(original.objects.line as VectorPath);assert(input.toggle());
  const converted=e.doc.objects.line as VectorPath,s=pathSegments(converted)[0];
  assert.equal(e.doc.schemaVersion,4);assert.equal(e.history.past.length,1);
  assert.deepEqual(s.controls,{c1:p(33,0),c2:p(67,0)});
  for(const t of [0,.01,.25,.5,.9,1]){near(segmentPoint(s,t).x,100*t,.5);near(segmentPoint(s,t).y,0);}
  assert.equal(withSegmentKind(converted,0,true),converted);
  assert.equal(withSegmentKind(converted,1,true),converted);
  assert.equal(withPathControl(converted,0,"out",p(0,0)),converted);
  const bytes=encodeProject(e.doc,new AssetVault());assert(input.toggle());assert.equal(encodeProject(e.doc,new AssetVault()),encodeProject(original,new AssetVault()));
  e.undo();assert.equal(encodeProject(e.doc,new AssetVault()),bytes);e.undo();assert.deepEqual(e.doc,original);assert.equal(e.history.past.length,0);
});
test("open cubic extrema bound the rendered arch, stroke and marquee hit the arch and reject the chord and control hull",()=>{
  const segments=pathSegments(arch),scene=buildScene(board(arch));
  assert.deepEqual(segmentPoint(segments[0],.5),p(50,75));assert.deepEqual(vectorBounds(segments),rect(0,0,100,75));
  assert.deepEqual(scene[0].bounds,rect(-1,-1,102,77));
  for(const zoom of [.05,.25,1,4,16]){
    const tolerance=2/zoom;assert.equal(hitTest(scene,p(50,75+1+tolerance-.002),tolerance),"line");
    assert.equal(hitTest(scene,p(50,75+1+tolerance+.002),tolerance),undefined);
    assert.equal(closestSegment(segments,p(50,75),8/zoom),0);
  }
  assert.equal(hitTest(scene,p(50,0),0),undefined);assert.equal(hitTest(scene,p(50,92),1),undefined);
  assert.deepEqual(marqueeHit(scene,rect(49,74,2,2)),["line"]);assert.deepEqual(marqueeHit(scene,rect(47,6,6,3)),[]);
  assert.deepEqual(marqueeHit(scene,rect(40,76.01,20,.5)),[]);
});
test("closing cubic uses the last-to-first anchors, even-odd curved fill and transparent marquee boundaries",()=>{
  const triangle:VectorPath={...straight,closed:true,fill:"#225588",vertices:[p(0,0),p(50,-40),p(100,0)],curves:{2:{out:p(0,100),in:p(0,100)}}};
  const segments=pathSegments(triangle),scene=buildScene(board(triangle));
  assert.deepEqual(segments[2].from,p(100,0));assert.deepEqual(segments[2].to,p(0,0));
  assert(insideVector(segments,p(50,60)));assert(!insideVector(segments,p(50,75.1)));assert(!insideVector(segments,p(-10,75)));
  assert.equal(hitTest(scene,p(50,40),0),"line");assert.deepEqual(marqueeHit(scene,rect(48,36,2,3)),["line"]);
  const {fill,...outline}=triangle;assert.deepEqual(marqueeHit(buildScene(board(outline)),rect(48,36,2,3)),[]);
  const twice=[...segments,...segments];assert(!insideVector(twice,p(50,60)));
  const straightened=withSegmentKind(triangle,2,false);assert(!straightened.curves);assert.equal(straightened.fill,fill);
});
test("retracted, reversing, point-like, nearly linear and large-coordinate cubics stay finite and selectable",()=>{
  const from=p(0,0),to=p(10,0),over={from,to,controls:{c1:p(100,0),c2:p(100,0)}};
  const extent=vectorBounds([over]);assert(extent.max.x>75&&extent.max.x<80);
  assert(segmentDistance(over,rect(62,0),.01)<.00011);assert.equal(segmentDistance(over,rect(81,0),.2),Infinity);
  for(const s of [{from,to,controls:{c1:from,c2:to}},{from,to:from,controls:{c1:from,c2:from}},
    {from,to:from,controls:{c1:p(100,80),c2:p(-100,80)}},{from,to,controls:{c1:p(3,1e-14),c2:p(7,-1e-14)}},
    {from:p(9e8,1e8),to:p(-9e8,-1e8),controls:{c1:p(-8e8,7e8),c2:p(8e8,-7e8)}}]){
    const bounds=vectorBounds([s]);
    for(let i=0;i<=20;i++){
      const v=segmentPoint(s,i/20);
      assert(v.x>=bounds.min.x-1e-6&&v.x<=bounds.max.x+1e-6&&v.y>=bounds.min.y-1e-6&&v.y<=bounds.max.y+1e-6);
      assert(segmentDistance(s,{min:v,max:v},.005)<.005);
    }
  }
});
test("vertex ownership moves its incoming and outgoing controls only; translating the entire path preserves every local vector",()=>{
  const path:VectorPath={...arch,closed:true,vertices:[p(0,0),p(100,0),p(80,70)],
    curves:{0:{out:p(15,30),in:p(-20,25)},1:{out:p(-12,19),in:p(24,-15)},2:{out:p(14,12),in:p(20,11)}}};
  const before=pathSegments(path),vertex=withPathVertex(path,1,p(9,-8)),after=pathSegments(vertex);
  assert.equal(vertex.curves,path.curves);assert.deepEqual(after[0].controls!.c1,before[0].controls!.c1);
  assert.deepEqual(after[0].controls!.c2,p(89,17));assert.deepEqual(after[1].controls!.c1,p(97,11));
  assert.deepEqual(after[1].controls!.c2,before[1].controls!.c2);assert.deepEqual(after[2],before[2]);
  const edited=withPathControl(vertex,2,"in",p(7,5));assert.deepEqual(edited.curves![2].in,p(27,16));assert.equal(edited.curves![2].out,vertex.curves![2].out);
  assert.equal(edited.curves![0],vertex.curves![0]);assert.equal(edited.vertices,vertex.vertices);
  const e=new EditorSession(board(edited),camera);e.select("line");const bytes=encodeProject(e.doc,new AssetVault());
  assert(e.moveSelection(p(15,-5)));const translated=e.doc.objects.line as VectorPath;
  assert.deepEqual(translated.at,p(15,-5));assert.deepEqual(translated.vertices,edited.vertices);assert.deepEqual(translated.curves,edited.curves);
  const moved=pathSegments(translated);pathSegments(edited).forEach((s,i)=>{
    for(const t of [0,.24,.5,.81,1]){const a=segmentPoint(s,t),b=segmentPoint(moved[i],t);near(b.x-a.x,15);near(b.y-a.y,-5);}
  });
  e.undo();assert.equal(encodeProject(e.doc,new AssetVault()),bytes);
});
test("zoom-independent control grabs keep their click offset; overlap selection and stale edit guards protect history",()=>{
  const item={...arch,curves:{0:{out:p(0,0),in:p(-100,0)}}};
  for(const zoom of [.05,.5,2,16]){
    const cam={offset:p(220,160),zoom},e=new EditorSession(board(item),cam);e.select("line");const input=new PathInput(e);
    input.start(e.doc.objects.line as VectorPath);input.part="in";
    const anchor=worldToScreen(item.at,cam),start=p(anchor.x+3,anchor.y+2),end=p(start.x+12,start.y-8);
    assert(input.down(1,"mouse",start));input.move(1,end);
    const candidate=input.preview!.objects.get("line") as VectorPath;
    near(candidate.curves![0].in.x,Math.round(-100+12/zoom));near(candidate.curves![0].in.y,Math.round(-8/zoom));
    assert.deepEqual(candidate.curves![0].out,p(0,0));assert.deepEqual(e.doc.objects.line,item);assert.equal(e.history.past.length,0);
    input.up(8,end);assert.equal(e.history.past.length,0);input.up(1,end);input.up(1,end);assert.equal(e.history.past.length,1);
    assert.deepEqual(e.doc.objects.line,candidate);e.undo();input.sync();assert(!input.preview&&!input.mode);
    assert(!commitPathVertex(e,candidate,candidate,e.generation));
  }
  const e=new EditorSession(board(item),camera);e.select("line");const input=new PathInput(e);
  input.start(e.doc.objects.line as VectorPath);input.part="out";
  assert(input.down(1,"mouse",p(100,0)));input.up(1,p(115,9));
  assert.deepEqual((e.doc.objects.line as VectorPath).vertices[1],p(115,9));
});
test("v4 files and clipboard fragments retain controls, original PNG, pressure and bindings; plain subsets still use their oldest format",()=>{
  const {document,assets}=fixture,vault=new AssetVault(assets),bytes=encodeProject(document,vault);
  const rebuilt=decodeProject(bytes);assert.equal(encodeProject(rebuilt.document,new AssetVault(rebuilt.assets)),bytes);
  for(const id of legacy.document.order.filter(id=>!["open-path","closed-path"].includes(id)))
    assert.deepEqual(document.objects[id],legacy.document.objects[id]);
  assert.deepEqual(assets,legacy.assets);
  for(const [id,version] of [["qa-picture",1],["sample-ink",2],["straight-path",3],["closed-path",4]] as const){
    assert.equal(captureClipboard(document,[id],vault)!.document.schemaVersion,version);
  }
  const fragment=captureClipboard(document,document.order,vault)!,wire=encodeClipboard(fragment);
  const decoded=decodeClipboard(wire)!;assert.equal(encodeClipboard(decoded),wire);
  const e=new EditorSession(legacy.document,camera),destination=new AssetVault(legacy.assets);
  assert(pasteClipboard(e,destination,decoded,{delta:p(-12,9)}));assert.equal(e.doc.schemaVersion,4);
  for(const id of ["open-path","closed-path"]){
    const old=document.objects[id] as VectorPath;
    const copy=e.selectedIds.map(i=>e.doc.objects[i]).find(o=>o.kind==="path"&&o.stroke===old.stroke) as VectorPath;
    assert.deepEqual(copy.curves,old.curves);assert.notEqual(copy.id,id);assert.deepEqual(copy.vertices,old.vertices);
  }
  e.undo();assert.deepEqual(e.doc,legacy.document);assert.deepEqual(decodeProject(encodeProject(e.doc,destination)).assets,legacy.assets);
});
test("mislabeled, empty, out-of-range, partial, noncanonical and future curve encodings reject before import or paste",()=>{
  const original=board(arch),pair=arch.curves![0];
  for(const curves of [{},[],{1:pair},{"01":pair},{"0.0":pair},{"-1":pair},{0:{out:p(0,1)}},
    {0:{...pair,unknown:1}},{0:{out:p(1.1e9,0),in:p(0,0)}},{0:{out:{x:1,y:2,extra:3},in:p(0,0)}}]){
    assert.throws(()=>assertDocument({...original,objects:{line:{...arch,curves}}}));
  }
  for(const version of [1,2,3,5]){
    const input={...original,schemaVersion:version};assert.throws(()=>assertDocument(input));
    const text=JSON.stringify({format:"mg-canvas.project",version:1,document:input,assets:{}});
    assert.throws(()=>decodeProject(text));assert.throws(()=>decodeClipboard("MG-CANVAS-CLIPBOARD/1\n"+text));
  }
  assert.throws(()=>assertDocument({...board(straight),schemaVersion:4}));
  assert.throws(()=>decodeClipboard("MG-CANVAS-CLIPBOARD/5\n{}"));
});
