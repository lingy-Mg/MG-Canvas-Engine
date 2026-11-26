import {test} from "node:test";
import assert from "node:assert/strict";
import type {BoardDocument,BoardObject,ShapeObject,VectorPath} from "../core/document.ts";
import {assertDocument} from "../core/document.ts";
import type {Rect} from "../core/geometry.ts";
import {createHistory,dispatch,redo,undo} from "../core/history.ts";
import {buildScene,hitTest,marqueeHit} from "../scene/board.ts";
import type {DrawGroup,Scene} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";
import {cellRange,SceneGrid} from "../scene/spatial-grid.ts";
import type {GridQueryWork} from "../scene/spatial-grid.ts";
import {box,bruteScene,denseBoard,observeViewport,views,viewportBoard,viewportRect} from "./fixtures/viewport-access.ts";

const rect=(x:number,y:number,x2:number,y2:number):Rect=>({min:{x,y},max:{x:x2,y:y2}});
const ids=(s:Scene)=>s.map(g=>g.id);
const documentOf=(rows:readonly BoardObject[]):BoardDocument=>({id:"viewport-probe",schemaVersion:1,theme:"paper",assets:{},
  objects:Object.fromEntries(rows.map(o=>[o.id,o])),order:rows.map(o=>o.id)});
const expected=["span","edge","back","glass","review","curve","note"];
function checked(index:SceneProjection,scene:Scene,area:Rect,patch?:ReadonlyMap<string,DrawGroup>,include?:string[]){
  let work:GridQueryWork|undefined;
  const result=index.query(area,patch,include,w=>{work=w;});
  assert.deepEqual(ids(result),ids(bruteScene(scene,area,patch,include)));assert(work);
  return {result,work};
}

test("warm padded low-zoom paint queries have the same ordered groups and bounds visits with 20,000 far or neighboring-tile objects",()=>{
  assert.equal(cellRange(views[0]).count,3634);
  function probe(far:number,edge=false){
    const doc=viewportBoard(far,edge),index=new SceneProjection(doc);for(const r of views)index.query(r);
    return observeViewport(index,views);
  }
  const local=probe(0),extended=probe(20000),boundary=probe(20000,true);
  assert.deepEqual(local,extended);
  for(const sample of [...local,...boundary]){
    assert.deepEqual(sample.ids,expected);assert.equal(sample.boundsReads,7);assert.equal(sample.offscreenReads,0);
    assert.equal(sample.grid?.mode,"indexed");assert(sample.grid.tiles<=30);assert(sample.grid.fineProbes<140);assert(sample.grid.memberships<200);
  }
  assert.deepEqual(boundary.map(r=>r.grid?.memberships),local.map(r=>r.grid?.memberships));
});

test("signed tile/fine boundaries and inclusive edge touches agree with brute drawing, topmost hit and cross-cell marquee",()=>{
  const rows=[box("below",-8260,-8220,150,120),box("above",-8192,-8192,109,95,"rgba(215,65,45,.52)"),
    box("fine",490,-543,44,77),box("zero",-5,-5,10,10),box("east",8192,8192,170,90)];
  const doc=documentOf(rows),index=new SceneProjection(doc),scene=buildScene(doc);
  for(const area of [rect(-8192,-8192,-8192,-8192),rect(512,-512,512,-512),rect(-8193,-8193,-8191,-8191),
    rect(-40960,-14000,8200,8500),rect(8191,8191,8192,8192),rect(-8,-8,8,8)]){
    const {result}=checked(index,scene,area);assert.equal(hitTest(result,area.min,0),hitTest(scene,area.min,0));
    assert.deepEqual(marqueeHit(result,area),marqueeHit(scene,area));
  }
  const spot={x:-8160,y:-8160};assert.equal(hitTest(index.query(rect(spot.x,spot.y,spot.x,spot.y)),spot,0),"above");
});

test("a viewport and hit entirely beyond a coarse tile boundary see only the cubic bulge through preview, commit and undo",()=>{
  const path:VectorPath={kind:"path",id:"bulge",at:{x:100,y:8150},vertices:[{x:0,y:0},{x:160,y:0}],closed:false,
    curves:{"0":{out:{x:0,y:120},in:{x:0,y:120}}},stroke:"#215788",strokeWidth:2};
  const h=createHistory({...documentOf([path]),schemaVersion:4}),index=new SceneProjection(h.doc);
  const narrow=rect(177,8238,183,8242),wide=rect(-19000,8236,20680,31116),tip={x:180,y:8240};
  const check=(visible:boolean,patch?:ReadonlyMap<string,DrawGroup>)=>{
    assert.deepEqual(ids(index.query(wide,patch)),visible?["bulge"]:[]);
    const near=index.query(narrow,patch);
    assert.equal(hitTest(near,tip,0),visible?"bulge":undefined);
    assert.deepEqual(marqueeHit(near,narrow),visible?["bulge"]:[]);
  };
  check(true);
  const low={...path,curves:{"0":{out:{x:0,y:24},in:{x:0,y:24}}}};
  check(false,index.overlay({objects:new Map([[path.id,low]])}));check(true);
  const edit=dispatch(h,{label:"lower curve",patches:[{op:"putObject",value:low}]});
  index.update(edit.state.doc,edit.changeSet);check(false);
  const before=undo(edit.state);index.update(before.state.doc,before.changeSet);check(true);
});

test("re-ranking overlapping transparent groups changes paint and hit order without reindexing their bounds",()=>{
  const doc=viewportBoard(0),h=createHistory(doc),idx=new SceneProjection(h.doc),p={x:7100,y:5700};
  assert.equal(hitTest(idx.query(views[0]),p,0),"glass");
  const order=doc.order.filter(id=>id!=="back").concat("back");
  const edit=dispatch(h,{label:"raise",patches:[{op:"setOrder",ids:order}]});
  assert.deepEqual(idx.update(edit.state.doc,edit.changeSet),{mode:"incremental",projected:0});
  assert.equal(hitTest(checked(idx,buildScene(edit.state.doc),views[0]).result,p,0),"back");
  const back=undo(edit.state);idx.update(back.state.doc,back.changeSet);
  assert.equal(hitTest(checked(idx,buildScene(back.state.doc),views[0]).result,p,0),"glass");
});

test("preview, commit, undo, and redo move a bound group across tiles; include, preview-only objects and manual pins match full projection",()=>{
  const h=createHistory(viewportBoard(0)),idx=new SceneProjection(h.doc),base=buildScene(h.doc);
  const old=h.doc.objects.review as ShapeObject,changed={...old,at:{x:78600,y:-31800}},ghost=box("preview-only",2100,13500);
  const patch=idx.overlay({objects:new Map([[old.id,changed],[ghost.id,ghost]])});
  assert.deepEqual([...patch.keys()].sort(),["edge","preview-only","review"]);
  for(const area of [views[0],rect(70000,-35500,83200,-27500),rect(-1e8,-1e8,1e8,1e8)]){
    checked(idx,base,area,patch,[old.id,"missing"]);checked(idx,base,area,patch);checked(idx,base,area);
  }
  assert(!idx.query(views[0],patch).some(g=>g.id===old.id));assert.equal(idx.query(views[0],patch,["review"]).at(-1)?.id,ghost.id);
  const edit=dispatch(h,{label:"move",patches:[{op:"putObject",value:changed}]});
  idx.update(edit.state.doc,edit.changeSet);const newScene=buildScene(edit.state.doc);
  assert.deepEqual(checked(idx,newScene,views[0]).result,idx.query(views[0]));
  const path=patch.get("edge")?.items.find(i=>i.kind==="path");
  assert.deepEqual(path,newScene.find(g=>g.id==="edge")?.items.find(i=>i.kind==="path"));
  assert.deepEqual(edit.state.doc.objects.edge,h.doc.objects.edge);
  const back=undo(edit.state);idx.update(back.state.doc,back.changeSet);checked(idx,base,views[0]);
  const again=redo(back.state);idx.update(again.state.doc,again.changeSet);checked(idx,newScene,views[0]);assertDocument(again.state.doc);
});

test("updating and deleting at all three footprint sizes prune former bucket references, including negative long and board-spanning groups",()=>{
  const make=(x:number,width:number)=>box("changing",x,-230,width,100);
  let h=createHistory(documentOf([make(-4090,76)]));const index=new SceneProjection(h.doc);
  const regions=[rect(-4200,-300,-3900,-50),rect(8100,-310,9000,-70),rect(220000,-800,345000,700),rect(2e6,-700,2.01e6,500)];
  function check(){for(const r of regions)checked(index,buildScene(h.doc),r);}
  for(const next of [make(8200,120000),make(-1e5,3e6),make(225000,100)]){
    const edit=dispatch(h,{label:"resize",patches:[{op:"putObject",value:next}]});h=edit.state;index.update(h.doc,edit.changeSet);check();
  }
  const del=dispatch(h,{label:"remove",patches:[{op:"removeObject",id:"changing"}]});h=del.state;index.update(h.doc,del.changeSet);check();
  const obs=observeViewport(index,regions);assert(obs.every(r=>r.grid?.fineProbes===0&&r.grid.memberships===0));
  const restore=undo(h);h=restore.state;index.update(h.doc,restore.changeSet);check();
  const replacement=documentOf([box("replacement",0,0)]);index.update({...replacement,id:"new-board"});
  assert.deepEqual(ids(index.query(views[0])),["replacement"]);
});

test("a truly crowded view uses a complete paint-order result for drawing, overlays, forced inclusion and marquee",()=>{
  const doc=denseBoard(4200),idx=new SceneProjection(doc),scene=buildScene(doc),area=viewportRect();
  const result=checked(idx,scene,area);assert.equal(result.work.mode,"density");assert.equal(result.result.length,4200);
  const old=doc.objects["dense-0"] as ShapeObject,moved={...old,at:{x:80000,y:-90000}};
  const add=box("extra",7300,8100),patch=idx.overlay({objects:new Map([[old.id,moved],[add.id,add]])});
  const overlay=checked(idx,scene,area,patch,["unknown"]);
  assert.equal(overlay.result.length,4200);assert.equal(overlay.result.at(-1)?.id,"extra");
  assert.equal(checked(idx,scene,area,patch,[old.id]).result.length,4201);
  assert.deepEqual(marqueeHit(result.result,area),doc.order);
});

test("very broad marquee and unsafe cell coordinates fall back to exact ordered scanning and preserve inclusions",()=>{
  const doc=viewportBoard(400),idx=new SceneProjection(doc),scene=buildScene(doc),area=rect(-1e9,-1e9,1e9,1e9);
  const wide=checked(idx,scene,area);assert.equal(wide.work.mode,"extent");assert.equal(wide.work.tiles,0);
  assert.deepEqual(marqueeHit(wide.result,area),marqueeHit(scene,area));assert.deepEqual(ids(wide.result),doc.order);
  const enormous=checked(idx,scene,rect(2**64,2**64,2**65,2**65),undefined,["glass"]);assert.equal(enormous.work.mode,"extent");
  assert.deepEqual(ids(enormous.result),["glass"]);
});

test("fine occupancy and membership budgets bound speculative work; neither drops a partial group set into output",()=>{
  const near=17000,remote=16000,grid=new SceneGrid();
  for(let i=0;i<near;i++){const x=i%144*512,y=Math.floor(i/144)*512;grid.add("n"+i,rect(x+1,y+1,x+5,y+5));}
  for(let i=0;i<remote;i++)grid.add("f"+i,rect(1e6+3,1e6+2,1e6+6,1e6+4));
  let read:GridQueryWork|undefined;
  assert.equal(grid.collect(rect(0,0,144*512,119*512),near+remote,new Set(),w=>{read=w;}),false);
  assert.equal(read?.mode,"fine-limit");assert(read.fineProbes<=16384&&read.memberships<=32768);
  // Exercise the public query with an identically populated scene. The ordered fallback supplies every local group.
  const rows=Array.from({length:near},(_,i)=>box("n"+i,i%144*512+1,Math.floor(i/144)*512+1,4,4));
  rows.push(...Array.from({length:remote},(_,i)=>box("f"+i,1e6+3,1e6+2,3,2)));
  const idx=new SceneProjection(documentOf(rows)),area=rect(0,0,144*512,119*512);
  const view=idx.query(area,undefined,undefined,w=>{read=w;});assert.equal(read?.mode,"fine-limit");
  assert.deepEqual(ids(view),rows.slice(0,near).map(r=>r.id));
});

test("seeded mixed-scale queries agree with a fresh brute scene after insert, move, removal, broad marquee and overlapping reload",()=>{
  let seed=0x6b82a781;
  function random(n:number){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;}
  const rows=Array.from({length:250},(_,i)=>({
    ...box("r"+i,random(200000)-100000,random(180000)-90000,i%25===0?500000:i%7===0?8000:45+random(690),70+random(2800)),
    rotation:(random(17)-8)*Math.PI/16
  }));
  let history=createHistory(documentOf(rows));const index=new SceneProjection(history.doc);
  for(let step=0;step<12;step++){
    const scene=buildScene(history.doc);
    for(let i=0;i<15;i++){
      const x=random(190000)-95000,y=random(160000)-80000;
      const area=rect(x,y,x+[5,512,39700,1e8][i%4],y+[6,1200,22900,1e8][i%4]);
      const {result}=checked(index,scene,area);
      assert.equal(hitTest(result,area.min,0),hitTest(scene,area.min,0));
      if(i%3===0)assert.deepEqual(marqueeHit(result,area),marqueeHit(scene,area));
    }
    const id=history.doc.order[random(history.doc.order.length)],obj=history.doc.objects[id] as ShapeObject;
    const edit=dispatch(history,{label:"vary scene",patches:step%3===0?[{op:"removeObject",id}]:
      [{op:"putObject",value:{...obj,id:step%3===1?"added-"+step:id,at:{x:random(120000)-60000,y:random(80000)-40000}}}]});
    history=edit.state;index.update(history.doc,edit.changeSet);
  }
});

test("fine slots remain exact at the largest safe cell coordinates with negative and positive tile origins",()=>{
  const grid=new SceneGrid(),x=(Number.MAX_SAFE_INTEGER-10)*512,y=9*512;
  for(const sign of [-1,1]){
    const b=rect(sign*x,y,sign*x,y),near=rect(sign*x+512,y,sign*x+512,y);
    grid.add("point",b);const result=new Set<string>();assert(grid.collect(b,1,result));assert(result.has("point"));
    const empty=new Set<string>();assert(grid.collect(near,1,empty));assert.equal(empty.size,0);
    grid.remove("point",b);const removed=new Set<string>();grid.collect(b,0,removed);assert.equal(removed.size,0);
  }
});
