import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDocument } from "../core/document.ts";
import { rectBetween,worldToScreen } from "../core/geometry.ts";
import { EditorSession } from "../session/editor.ts";
import { cornerPoint,hitResizeHandle,resizeAroundOpposite } from "../session/resize.ts";
import { buildScene,hitTest,marqueeHit } from "../scene/board.ts";
import { SceneProjection } from "../scene/projector.ts";
import { planMove,moveObjects } from "../session/transform.ts";
import { largeBoard } from "./fixtures/large-board.ts";
import { mixed } from "./fixtures/mixed.ts";
const p=(x:number,y:number)=>({x,y});
function approx(a:{x:number;y:number},b:{x:number;y:number}){assert(Math.abs(a.x-b.x)+Math.abs(a.y-b.y)<1e-8);}

test("locked rotated image resize preserves opposite corner and natural aspect in all directions",()=>{
  const b={at:p(-40,72),width:140,height:70,rotation:.45};
  for(const corner of ["se","sw","ne","nw"] as const){
    const fixed=cornerPoint(b,corner,true),move=cornerPoint(b,corner);
    const d=p((move.x-fixed.x)*.5,(move.y-fixed.y)*.5);
    const next=resizeAroundOpposite(b,corner,d,true);
    const anchor=cornerPoint(next,corner,true),tip=cornerPoint(next,corner);
    assert(Number.isInteger(next.at.x)&&Number.isInteger(next.at.y));
    assert(Math.abs(anchor.x-fixed.x)<=.5&&Math.abs(anchor.y-fixed.y)<=.5);
    approx(p(tip.x-anchor.x,tip.y-anchor.y),p(move.x+d.x-fixed.x,move.y+d.y-fixed.y));
    assert(Math.abs(next.width/next.height-2)<1e-9);
    assert(next.width>b.width);
  }
});
test("unlocked resizing changes independent dimensions; touching near a handle uses CSS spacing",()=>{
  const b={at:p(0,0),width:150,height:90,rotation:0},cam={offset:p(59,-33),zoom:.8};
  const nw=worldToScreen(cornerPoint(b,"nw"),cam);
  assert.equal(hitResizeHandle(b,cam,p(nw.x-20,nw.y),true),"nw");
  assert.equal(hitResizeHandle(b,cam,p(nw.x-20,nw.y),false),undefined);
  const next=resizeAroundOpposite(b,"nw",p(-11,-7),false);
  assert.deepEqual(next,{...b,at:p(-11,-7),width:161,height:97});
  const limit=resizeAroundOpposite(b,"nw",p(1000,1000),false);
  assert.equal(limit.width,8);assert.equal(limit.height,8);
  assert.deepEqual(cornerPoint(limit,"nw",true),cornerPoint(b,"nw",true));
});
test("resize gesture previews connected shape changes, commits once, and undo restores",()=>{
  const e=new EditorSession(mixed,{offset:p(20,80),zoom:2});
  const id="shape-start",idLine="link-main",shape=mixed.objects[id];
  e.select(id);
  const anchor=worldToScreen(cornerPoint(shape,"se"),e.camera);
  const end=p(anchor.x+90,anchor.y+48),before=e.doc;
  e.down(1,"mouse",anchor,id,false,false,{id,corner:"se",lockRatio:false});
  e.move(1,end);assert(e.preview);assert.strictEqual(e.doc,before);
  const proj=new SceneProjection(e.doc), patch=proj.overlay(e.preview);
  assert(patch.has(idLine));
  const link=patch.get(idLine)?.items[0];assert(link?.kind==="path");
  const source=p(shape.at.x+shape.width+45,shape.at.y+(shape.height+24)/2);
  approx(link.points[0],source);
  e.up(1,end);assert.equal(e.history.past.length,1);
  assert.equal((e.doc.objects[id] as typeof shape).width,shape.width+45);
  assert.strictEqual(e.doc.objects[idLine],before.objects[idLine]);
  e.undo();assert.strictEqual(e.doc,before);e.redo();
  assert.equal((e.doc.objects[id] as typeof shape).width,shape.width+45);
});
test("second pointer and cancellation during touch resize never commit or leave ghosts",()=>{
  const e=new EditorSession(mixed,{offset:p(0,0),zoom:1}), id="picture", image=mixed.objects.picture;
  e.select(id);const anchor=cornerPoint(image,"se"),move=p(anchor.x+15,anchor.y+9);
  e.down(1,"touch",anchor,id,false,false,{id,corner:"se",lockRatio:true});e.move(1,move);
  assert(e.preview);
  e.down(2,"touch",p(100,140),undefined,false);assert(!e.preview);
  e.move(2,p(110,140));e.up(2,p(110,140));e.move(1,p(600,600));e.up(1,p(600,600));
  assert.equal(e.history.past.length,0);assert.deepEqual(e.doc,mixed);
  e.down(3,"mouse",anchor,id,false,false,{id,corner:"se",lockRatio:true});e.move(3,move);
  e.pointerCancelled(3);assert(!e.preview);assert.equal(e.history.past.length,0);
});
test("indexed viewport and hit/marquee match brute force, preserve z and include spanning groups",()=>{
  const f=largeBoard(1500),scene=buildScene(f.document),index=new SceneProjection(f.document);
  assertDocument(f.document);
  const within=rectBetween(p(-25,-25),p(1090,800));
  const intersects=(b:typeof within)=>within.min.x<=b.max.x&&b.min.x<=within.max.x&&within.min.y<=b.max.y&&b.min.y<=within.max.y;
  assert.deepEqual(index.query(within).map(x=>x.id),scene.filter(g=>intersects(g.bounds)).map(x=>x.id));
  assert.equal(hitTest(index.query(rectBetween(p(1,1),p(32,32))),f.probe,3),hitTest(scene,f.probe,3));
  assert.deepEqual(marqueeHit(index.query(within),within),marqueeHit(scene,within));
  const long="long-line",doc={...f.document,order:[...f.document.order,long],objects:{...f.document.objects,[long]:{
    kind:"connector" as const,id:long,from:{kind:"free" as const,point:p(-1e5,500)},to:{kind:"free" as const,point:p(1e5,500)},
    routing:"straight" as const,waypoints:[],label:"",arrow:"none" as const,stroke:"#000",
  }}};
  const next=new SceneProjection(doc);
  assert(next.query(rectBetween(p(-1,498),p(10,510))).some(g=>g.id===long));
  assert(next.query(rectBetween(p(-1e6,-1e6),p(1e6,1e6))).some(g=>g.id===long));
});
test("locally projected preview removes the old position, includes new cells and patches neighboring links only",()=>{
  const f=largeBoard(1500),doc=f.document,index=new SceneProjection(doc);
  const delta=p(3000,-1300), override={objects:moveObjects(planMove(doc,[f.dragId]),delta)},patch=index.overlay(override);
  assert.deepEqual([...patch.keys()].sort(),["l-6","s-0"]);
  const oldBounds=rectBetween(p(0,0),p(112,54)),newBounds=rectBetween(p(2990,-1310),p(3120,-1245));
  assert(index.query(oldBounds).some(g=>g.id==="s-0"));
  assert(!index.query(oldBounds,patch).some(g=>g.id==="s-0"));
  assert(index.query(newBounds,patch).some(g=>g.id==="s-0"));
  assert.deepEqual(index.all(patch),buildScene(doc,override));
});
