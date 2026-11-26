import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSession } from "../session/editor.ts";
import { buildScene, fitScene, hitTest, layoutMap, marqueeHit } from "../scene/board.ts";
import { MemoryDocumentStore, SaveCoordinator } from "../platform/store.ts";
import type { DocumentStore } from "../platform/store.ts";
import { parseDocument } from "../core/document.ts";
import { rectBetween, screenToWorld, worldToScreen } from "../core/geometry.ts";
import { mixed } from "./fixtures/mixed.ts";

const p=(x:number,y:number)=>({x,y});
const camera={ offset:p(0,0),zoom:1 };
const snap=(editor:EditorSession)=>({document:editor.doc,generation:editor.generation,revision:editor.history.revision});

test("continuous edits publish each sample and keep one undo boundary across autosave",()=>{
  const editor=new EditorSession(mixed,camera),id="shape-start";
  const original=editor.doc.objects[id];
  assert(original.kind==="shape");
  const originalWidth=original.width;
  const width=()=>(editor.doc.objects[id] as typeof original).width;
  const series=()=>({start:editor.history,head:editor.history});
  const widths:number[]=[];
  editor.listen(change=>{if(change?.updated.includes(id))widths.push(width());});
  const edit=(width:number,gesture:ReturnType<typeof series>)=>editor.commitEdit({
    label:"调整宽度",patches:[{op:"putObject",value:{...original,width}}]
  },editor.generation,undefined,undefined,gesture);
  const first=series();
  assert(edit(42,first));
  editor.markSaved(editor.generation,editor.history.revision);
  assert(edit(81,first));
  assert.equal(editor.history.past.length,1);
  assert.deepEqual(widths,[42,81]);
  editor.undo();
  assert.equal(width(),originalWidth);
  assert.equal(editor.canRedo,true);
  const second=series();
  assert(edit(43,second));
  assert(edit(originalWidth,second));
  assert.equal(editor.history.past.length,0);
  assert.equal(editor.canRedo,true);
  assert(!edit(75,first));
  editor.redo();
  assert.equal(width(),81);
  assert.deepEqual(widths,[42,81,originalWidth,43,originalWidth,81]);
});

test("drag preview attaches the endpoint without mutating the document; drop is one history item",()=>{
  const e=new EditorSession(mixed,camera);
  e.down(1,"mouse",p(-138,-25),"shape-start",false);
  e.move(1,p(-102,-7));
  e.move(1,p(-100,-5));
  assert.equal(e.history.revision,0);
  assert.equal(e.history.past.length,0);
  assert.deepEqual(e.doc.objects["shape-start"],mixed.objects["shape-start"]);
  const item=buildScene(e.doc,e.preview).find(g=>g.id==="link-main")?.items[0];
  assert(item?.kind==="path");
  assert.deepEqual(item.points[0],p(-22,8));
  for(const w of mixed.objects["link-main"].waypoints)assert(item.points.some(q=>q.x===w.x&&q.y===w.y));
  e.up(1,p(-100,-5));
  assert.equal(e.history.past.length,1);
  assert.equal(e.selection,"shape-start");
  assert.equal(e.preview,undefined);
  const moved=e.doc.objects["shape-start"];
  assert(moved.kind==="shape");
  assert.deepEqual(moved.at,p(-142,-20));
  e.undo(); assert.deepEqual(e.doc.objects["shape-start"],mixed.objects["shape-start"]);
  e.redo(); assert.deepEqual(e.doc.objects["shape-start"],moved);
});
test("lost capture, Escape and window reset discard a drag and its speculative selection",()=>{
  for(const interrupt of [(e:EditorSession)=>e.pointerCancelled(1),(e:EditorSession)=>e.cancel(),(e:EditorSession)=>e.resetPointers()]){
    const e=new EditorSession(mixed,camera);
    e.select("map-b");
    e.down(1,"mouse",p(-150,-20),"shape-start",false);
    e.move(1,p(-120,-20));
    assert(e.preview);
    interrupt(e);
    e.move(1,p(-100,-20)); e.up(1,p(-100,-20));
    assert(!e.preview);assert(!e.busy);assert.equal(e.history.past.length,0);
    assert.equal(e.selection,"map-b");assert.deepEqual(e.doc,mixed);
  }
});
test("touch taps select, then a selected object can move; unselected swipes only pan",()=>{
  const e=new EditorSession(mixed,camera);
  e.down(1,"touch",p(10,20),"shape-start",false);
  e.move(1,p(30,20));e.up(1,p(30,20));
  assert.deepEqual(e.camera.offset,p(20,0));assert(!e.selection);
  e.down(2,"touch",p(10,20),"shape-start",false);e.up(2,p(11,20));
  assert.equal(e.selection,"shape-start");assert.equal(e.history.past.length,0);
  e.down(3,"touch",p(10,20),"shape-start",false);
  e.move(3,p(29,30));e.up(3,p(29,30));
  assert.equal(e.history.past.length,1);
});
test("second finger cancels one-finger preview, anchors pinch, and blocks remaining finger",()=>{
  const e=new EditorSession(mixed,camera);
  e.select("shape-start");
  e.down(1,"touch",p(10,10),"shape-start",false);
  e.move(1,p(20,20));assert(e.preview);
  e.down(2,"touch",p(80,20),undefined,false);assert(!e.preview);
  const under=screenToWorld(p(50,20),e.camera);
  e.move(2,p(100,40));
  const center=worldToScreen(under,e.camera);
  assert(Math.abs(center.x-60)<1e-9 && Math.abs(center.y-30)<1e-9);
  const cameraAfter=e.camera;
  e.up(2,p(100,40));
  e.move(1,p(500,500));e.up(1,p(500,500));
  assert.strictEqual(cameraAfter,e.camera);assert.equal(e.history.past.length,0);assert(!e.busy);
  e.down(4,"touch",p(10,10),undefined,false);e.move(4,p(35,15));e.up(4,p(35,15));
  assert.notDeepEqual(e.camera,cameraAfter);
});
test("wheel panning and zoom change only session state; held gesture ignores wheel",()=>{
  const e=new EditorSession(mixed,camera);
  e.wheel(p(10,20),p(3,9),false);
  assert.deepEqual(e.camera.offset,p(-3,-9));
  const focus=screenToWorld(p(10,20),e.camera);
  e.wheel(p(10,20),p(0,-90),true);
  const after=worldToScreen(focus,e.camera);
  assert(Math.abs(after.x-10)<1e-10 && Math.abs(after.y-20)<1e-10);
  const zoomed=e.camera;
  e.down(1,"mouse",p(0,0),undefined,false);e.wheel(p(0,0),p(0,5),false);
  assert.strictEqual(e.camera,zoomed);assert.equal(e.history.revision,0);
});
test("one map fold changes only that map, and moving its group reuses internal layout",()=>{
  const e=new EditorSession(mixed,camera);
  const a=e.doc.objects["map-a"], b=e.doc.objects["map-b"];
  assert(a.kind==="mindmap" && b.kind==="mindmap");
  const layA=layoutMap(a),layB=layoutMap(b),flow=e.doc.objects["link-main"];
  e.down(1,"mouse",p(400,0),"map-a",false);e.move(1,p(420,40));e.up(1,p(420,40));
  const moved=e.doc.objects["map-a"];
  assert(moved.kind==="mindmap");
  assert.strictEqual(layoutMap(moved),layA);
  e.toggleRootFold("map-a");
  const folded=e.doc.objects["map-a"];
  assert(folded.kind==="mindmap");
  assert.equal(layoutMap(folded).length,1);assert.equal(layA.length,3);
  assert.strictEqual(layoutMap(b),layB);assert.strictEqual(e.doc.objects["map-b"],b);assert.strictEqual(e.doc.objects["link-main"],flow);
  e.undo();assert.strictEqual(e.doc.objects["map-a"],moved);
});
test("scene hit testing uses geometry, and fit keeps scene bounds inside viewport",()=>{
  const scene=buildScene(mixed);
  assert.equal(hitTest(scene,p(-130,-20),3),"shape-start");
  assert.equal(hitTest(scene,p(103,24),3),undefined); // diamond bounds corner is not shape
  assert.equal(hitTest(scene,p(0,40),3),"link-main"); // manual interior segment 
  for(const viewport of [p(800,500),p(390,650)]){
    const fitted=fitScene(scene,viewport.x,viewport.y);
    for(const g of scene){
      const min=worldToScreen(g.bounds.min,fitted),max=worldToScreen(g.bounds.max,fitted);
      assert(min.x>=0&&min.y>=0&&max.x<=viewport.x&&max.y<=viewport.y);
    }
  }
});
test("overlapping saves write in destination order and reopen yields latest snapshot",async()=>{
  const memory=new MemoryDocumentStore();
  const started:number[]=[];
  let releaseA!:()=>void;
  const waitA = new Promise<void>(res=>{releaseA=res;});
  const store:DocumentStore={
    read:key=>memory.read(key),
    write:async(key,encoded)=>{
      const board=parseDocument(encoded), map=board.objects["map-a"];
      started.push(map?.kind==="mindmap" && map.topics["root-a"].collapsed ? 1 : 0);
      if(started.length===1) await waitA;
      await memory.write(key,encoded);
    },
  };
  const coord=new SaveCoordinator(store), e=new EditorSession(mixed,camera);
  const first=coord.save("x",snap(e));await Promise.resolve();await Promise.resolve();
  e.toggleRootFold("map-a");const second=coord.save("x",snap(e));
  const reopening=coord.reopen("x");
  await Promise.resolve();assert.deepEqual(started,[0]);
  releaseA();
  const a=await first;e.markSaved(a.generation,a.revision);
  assert(e.dirty);
  const b=await second;e.markSaved(b.generation,b.revision);
  assert(!e.dirty);assert.deepEqual(started,[0,1]);assert.deepEqual(await reopening,parseDocument(JSON.stringify(e.doc)));
  e.open(mixed,false);e.markSaved(b.generation,0);assert(e.dirty);
});
test("a failed write does not mark a document or block the next commit",async()=>{
  const memory=new MemoryDocumentStore();let attempts=0;
  const coord=new SaveCoordinator({
    read:key=>memory.read(key),
    write:async(key,data)=>{if(++attempts===1)throw new Error("quota");await memory.write(key,data);},
  });
  const e=new EditorSession(mixed,camera);
  const a=coord.save("x",snap(e));
  const b=coord.save("x",snap(e));
  await assert.rejects(a,/quota/);
  assert(e.dirty);
  const saved=await b;
  e.markSaved(saved.generation,saved.revision);
  assert(!e.dirty);
});

test("Shift-click toggles objects and a plain click reduces selection without history",()=>{
  const e=new EditorSession(mixed,camera);
  const click=(id:string|undefined,shift=false)=>{ e.down(1,"mouse",p(1,1),id,false,shift);e.up(1,p(1,1)); };
  click("shape-start");click("shape-choice",true);
  assert.deepEqual(e.selectedIds,["shape-start","shape-choice"]);
  click("shape-start",true);assert.deepEqual(e.selectedIds,["shape-choice"]);
  click("map-a",true);assert.deepEqual(e.selectedIds,["shape-choice","map-a"]);
  click("map-a");assert.deepEqual(e.selectedIds,["map-a"]);
  click(undefined,true);assert.deepEqual(e.selectedIds,["map-a"]);
  click(undefined);assert.deepEqual(e.selectedIds,[]);
  assert.equal(e.history.revision,0);
});

test("camera-normalized marquee intersects geometry, supports additive selection and cancels without ghost selection",()=>{
  const e=new EditorSession(mixed,{offset:p(190,198),zoom:1.8});
  const a=worldToScreen(p(-190,-50),e.camera), b=worldToScreen(p(-70,-30),e.camera);
  const hit=(rect:ReturnType<typeof rectBetween>)=>marqueeHit(buildScene(e.doc),rect);
  e.select("map-b");
  e.down(1,"mouse",a,undefined,false,true);e.move(1,b);
  assert(e.marquee);assert.deepEqual(e.selectedIds,["map-b"]);
  e.up(1,b,hit);assert.deepEqual(e.selectedIds,["map-b","shape-start"]);assert(!e.marquee);
  e.down(1,"mouse",a,undefined,false);e.move(1,b);e.pointerCancelled(1);e.up(1,b,hit);
  assert.deepEqual(e.selectedIds,["map-b","shape-start"]);assert(!e.marquee);
  e.down(1,"mouse",b,undefined,false);e.move(1,a);e.up(1,a,hit);
  assert.deepEqual(e.selectedIds,["shape-start"]);
  assert.equal(e.history.revision,0);
  // The cut-off corner of a diamond and empty space between map nodes do not select.
  const board=buildScene(e.doc);
  assert.deepEqual(marqueeHit(board,rectBetween(p(101,21),p(112,28))),[]);
  assert.equal(marqueeHit(board,rectBetween(p(388,52),p(401,62))).includes("map-a"),false);
  assert.equal(marqueeHit(board,rectBetween(p(-2,30),p(2,45))).includes("link-main"),true);
});

test("live marquee counts follow the latest pointer without committing until release",()=>{
  const e=new EditorSession(mixed,{offset:p(0,0),zoom:1});
  let queries=0,commits=0;
  e.onMarqueeCommit=()=>{commits++;};
  const hit=(area:ReturnType<typeof rectBetween>)=>{
    queries++;
    return area.max.x>=40?["link-main","shape-start","shape-start"]:["shape-start"];
  };
  e.select("map-b");e.down(1,"mouse",p(0,0),undefined,false,true);
  e.move(1,p(50,30));assert.equal(e.marqueeElementCount(hit),3);
  e.move(1,p(50,30));assert.equal(e.marqueeElementCount(hit),3);assert.equal(queries,1);
  e.move(1,p(20,30));assert.equal(e.marqueeElementCount(hit),2);
  assert.deepEqual(e.selectedIds,["map-b"]);assert.equal(e.selectedElementCount,1);
  e.up(1,p(20,30),hit);assert.equal(queries,2);assert.equal(commits,1);
  assert.equal(e.selectedElementCount,2);
  e.down(2,"mouse",p(0,0),undefined,false);e.move(2,p(45,30));assert.equal(e.marqueeElementCount(hit),2);
  e.up(2,p(10,30),hit);assert.deepEqual(e.selectedIds,["shape-start"]);assert.equal(commits,2);
  e.down(3,"mouse",p(0,0),undefined,false);e.move(3,p(60,30));assert.equal(e.marqueeElementCount(hit),2);
  e.pointerCancelled(3);assert.equal(commits,2);assert.equal(e.selectedElementCount,1);
  e.select(undefined);assert.equal(e.selectedElementCount,0);assert.equal(e.history.revision,0);
});

test("one group drag shifts internal waypoints, only changes the moved endpoint of a crossing line and moves explicit free line",()=>{
  const third = {...mixed.objects["shape-start"],id:"shape-third",at:p(240,240)};
  const crossing={...mixed.objects["link-main"],id:"cross",to:{kind:"anchor",objectId:third.id,portId:"west"} as const,waypoints:[p(-30,-25),p(122,90)]};
  const doc={...mixed,order:[...mixed.order,third.id,crossing.id],objects:{...mixed.objects,[third.id]:third,[crossing.id]:crossing}};
  const e=new EditorSession(doc,camera);
  e.select("shape-start");e.select("shape-choice",true);e.select("free-line",true);
  e.down(1,"mouse",p(-128,-20),"shape-start",false);e.move(1,p(-98,-5));
  assert(e.preview);
  const stable=e.doc;
  const external=e.preview.objects.get("cross");
  assert.equal(external,undefined);
  const internal=e.preview.objects.get("link-main");
  assert(internal?.kind==="connector");
  assert.deepEqual(internal.waypoints,[p(30,3),p(30,80)]);
  const [line]=buildScene(e.doc,e.preview).find(g=>g.id==="cross")!.items;
  assert(line.kind==="path");assert.deepEqual(line.points[0],p(-30,3));assert.deepEqual(line.points.at(-1),p(240,268));
  assert.equal(e.history.revision,0);
  e.up(1,p(-98,-5));
  assert.equal(e.history.past.length,1);assert.deepEqual(e.selectedIds,["shape-start","shape-choice","free-line"]);
  assert.strictEqual(e.doc.objects.cross,stable.objects.cross);
  assert.strictEqual(e.doc.objects["shape-third"],stable.objects["shape-third"]);
  assert.strictEqual(e.doc.objects["map-a"],stable.objects["map-a"]);
  const movedLine=e.doc.objects["free-line"];
  assert(movedLine.kind==="connector");assert.deepEqual(movedLine.from,{kind:"free",point:p(30,315)});
  const moved=e.doc;
  e.undo();assert.strictEqual(e.doc,stable);
  e.redo();assert.strictEqual(e.doc,moved);
});

test("nudge and numerical transform are atomic and respect bound geometry",()=>{
  const e=new EditorSession(mixed,camera);
  e.select("shape-start");e.select("shape-choice",true);
  assert(e.moveSelection(p(10,0)));
  assert.equal(e.history.past.length,1);
  assert.equal(e.transformSelection({x:0,y:0}),false);
  e.select("shape-start");
  const anchor=(doc:typeof e.doc)=>{const q=buildScene(doc).find(g=>g.id==="link-main")?.items[0];assert(q?.kind==="path");return q.points[0];};
  const previous=anchor(e.doc);
  assert.equal(e.transformSelection({x:-170,y:-40,width:0}),false);
  assert.equal(e.history.past.length,1);
  assert(e.transformSelection({x:-163,y:-40,width:160,height:88}));
  assert.equal(e.history.past.length,2);
  assert.deepEqual(anchor(e.doc),p(-3,4));
  e.undo();assert.deepEqual(anchor(e.doc),previous);
  e.select("link-main");assert.equal(e.moveSelection(p(10,0)),false);
});
