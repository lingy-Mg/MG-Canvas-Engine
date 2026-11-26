import test from "node:test";
import assert from "node:assert/strict";
import {mindViewportBoard} from "./fixtures/mind-viewport.ts";
import {buildScene} from "../scene/board.ts";
import type {DrawGroup} from "../scene/board.ts";
import {TopicViewport} from "../renderers/canvas2d/topic-viewport.ts";
import type {TopicPaintWork} from "../renderers/canvas2d/topic-viewport.ts";
import {SceneProjection} from "../scene/projector.ts";
import {withTopicAppearance,revealTopicPath} from "../features/mindmap.ts";
import type {MindMap} from "../core/document.ts";
import type {Rect} from "../core/geometry.ts";

const area=(x:number,y:number,w:number,h:number):Rect=>({min:{x,y},max:{x:x+w,y:y+h}});
function setup(metrics=true){
  let measures=0;const ctx={save(){},restore(){},measureText(s:string){measures++;return metrics?{width:s.length*8,
    actualBoundingBoxLeft:s.length*4,actualBoundingBoxRight:s.length*4,actualBoundingBoxAscent:10,actualBoundingBoxDescent:3}:{};}};
  const view=new TopicViewport(ctx as unknown as CanvasRenderingContext2D);
  const query=(g:DrawGroup,r:Rect)=>{let work!:TopicPaintWork;const items=view.items(g,r,s=>{work=s;});return {work,items};};
  return {query,measures:()=>measures};
}
test("partial paint walks a cached hierarchy; growing a right chain leaves submissions local and in original order",()=>{
  const screen=area(-84,-154,648,488);
  for(const n of [1000,4000]){
    const g=buildScene(mindViewportBoard(n))[0],{query,measures}=setup(),first=query(g,screen),measured=measures();
    assert.equal(first.work.mode,"indexed");assert(first.work.built);assert(measured>=n);
    const {items,work}=query(g,screen);assert(!work.built);assert.equal(measures(),measured);
    assert(work.branches<=78&&work.spans<=34);assert.deepEqual(items.filter(i=>i.kind==="nodeLabel").map(i=>i.topicId),["t0","t1","t2","t3"]);
    assert.deepEqual(items.map(i=>g.items.indexOf(i)),items.map(i=>g.items.indexOf(i)).sort((a,b)=>a-b));assert.deepEqual(items,first.items);
    const target=g.picks[Math.floor(n/2)];assert("box" in target);
    const viewport=area(target.box.at.x+target.box.width/2-320,-150,640,480),mid=query(g,viewport);
    const visible=g.picks.flatMap((p,i)=>"box" in p&&p.box.at.x<=viewport.max.x&&p.box.at.x+p.box.width>=viewport.min.x?["t"+i]:[]);
    assert.deepEqual(mid.items.filter(i=>i.kind==="nodeLabel").map(i=>i.topicId),visible);
    assert(mid.items.length<=visible.length*3+2&&mid.work.spans<50);
  }
});
test("small maps, full views and unavailable ink metrics use complete paint lists without repeated builds",()=>{
  const {query,measures}=setup(),g=buildScene(mindViewportBoard(255,"tree"))[0],tiny=buildScene(mindViewportBoard(8))[0];
  assert.equal(query(tiny,area(0,0,1,1)).items,tiny.items);
  const full=query(g,area(-1e6,-1e6,2e6,2e6));assert.equal(full.items,g.items);assert.deepEqual(full.work,{mode:"full",built:false,branches:0,spans:0,primitives:g.items.length});
  assert.equal(measures(),0);const fallback=setup(false),q=area(0,0,640,480);
  assert.equal(fallback.query(g,q).items,g.items);const again=fallback.query(g,q);
  assert.equal(again.work.mode,"fallback");assert(!again.work.built);assert.equal(fallback.measures(),1);
});
test("strokes, fold badges and crossing cubics survive paint culling; picking and selection retain the full canonical scene",()=>{
  const doc=mindViewportBoard(160,"fan"),map=doc.objects.map as MindMap;
  const topics={...map.topics,t1:{...map.topics.t1,collapsed:true,childIds:["deep"],appearance:{width:140,strokeWidth:8}},deep:{id:"deep",text:"深处",collapsed:false,childIds:[]}};
  const base={...doc,objects:{map:{...map,topics}}},projector=new SceneProjection(base),g=projector.all()[0];
  const {query}=setup(),label=g.items.find(i=>i.kind==="nodeLabel"&&i.topicId==="t1")!,index=g.items.indexOf(label);
  const box=g.items[index-1],badge=g.items[index+1];assert(box.kind==="box"&&badge.kind==="text");
  const b=box.box;assert(query(g,area(b.at.x+b.width+1,b.at.y+9,1,2)).items.includes(box));
  assert(query(g,area(badge.at.x-2,badge.at.y-3,5,6)).items.includes(badge));
  const edge=g.items[0];assert(edge.kind==="path");const [a,c,d,z]=edge.points;
  const mid={x:(a.x+3*c.x+3*d.x+z.x)/8,y:(a.y+3*c.y+3*d.y+z.y)/8};
  assert(Math.abs(a.y-mid.y)>100&&Math.abs(z.y-mid.y)>100);assert(query(g,area(mid.x-3,mid.y-3,6,6)).items.includes(edge));
  assert.equal(g.picks.length,160);assert(!g.items.some(i=>i.kind==="nodeLabel"&&i.topicId==="deep"));
  const shown=revealTopicPath(withTopicAppearance(base.objects.map,"deep",{width:180})!,"deep");
  const patch=projector.overlay({objects:new Map([["map",shown]])}),draft=patch.get("map")!;
  assert.equal(draft.topicCount,161);const deep=draft.items.find(i=>i.kind==="nodeLabel"&&i.topicId==="deep")!;
  assert(deep.kind==="nodeLabel");const target=area(deep.box.at.x,deep.box.at.y,3,3);
  assert(query(draft,target).items.includes(deep));assert(!query(g,target).items.includes(deep));assert.equal(projector.all()[0],g);
});
