import assert from "node:assert/strict";
import {cpus} from "node:os";
import {SceneProjection} from "../scene/projector.ts";
import {moveObjects} from "../session/transform.ts";
import type {BoardDocument,ShapeObject} from "../core/document.ts";
import {largeBoard} from "../tests/fixtures/large-board.ts";
import {verifyLowZoomAccess} from "../tests/fixtures/drag-alignment-access.ts";

const batches=31,samples=192,viewport={min:{x:0,y:0},max:{x:800,y:550}},selected=["s-0","s-1"];
const deltas=Array.from({length:samples},(_,i)=>({x:32+i%19,y:9+(i*7)%17}));
const micros=(start:NodeJS.CpuUsage)=>{const used=process.cpuUsage(start);return used.user+used.system;};
const rounded=(v:number)=>Math.round(v*1000)/1000;
let checksum=0;
function measure(fn:()=>void){
  for(let i=0;i<8;i++)fn();
  const values=[];
  for(let i=0;i<batches;i++){const start=process.cpuUsage();fn();values.push(micros(start)/samples);}
  values.sort((a,b)=>a-b);
  return {p50:rounded(values[Math.ceil(.5*batches)-1]),p95:rounded(values[Math.ceil(.95*batches)-1])};
}
function denseBoard():BoardDocument{
  const seed=largeBoard(10).document,base=seed.objects["s-0"] as ShapeObject;
  const items=Array.from({length:4096},(_,i)=>({...base,id:"s-"+i,at:{x:12+i%10,y:8}}));
  return {...seed,id:"dense-alignment",order:items.map(o=>o.id),objects:Object.fromEntries(items.map(o=>[o.id,o]))};
}
const results=[];
for(const [layout,count] of [["mixed",1500],["mixed",30000],["dense",4096]] as const){
  const doc=layout==="mixed"?largeBoard(count).document:denseBoard();
  const before=process.cpuUsage(),projection=new SceneProjection(doc),buildCPUms=rounded(micros(before)/1000);
  const visible=projection.query(viewport).length;
  const prepare=()=>projection.prepareDrag(selected,viewport,1);
  const setup=measure(()=>{for(let i=0;i<samples;i++)checksum+=prepare().plan.movers.length;});
  const batch=(bypass:boolean)=>{
    const {alignment,plan}=prepare();assert(alignment);let guided=0;
    for(const delta of deltas){
      const actual=alignment.resolve(delta,bypass),objects=moveObjects(plan,actual);
      checksum+=(objects.get("s-0") as ShapeObject).at.x;
      if(alignment.guides.length)guided++;
    }
    return guided;
  };
  const guidedPerBatch=batch(false);assert(layout==="dense"?guidedPerBatch===0:guidedPerBatch>0);
  const free=measure(()=>{batch(true);}),snapping=measure(()=>{batch(false);});
  results.push({layout,objects:count,visible,selected:selected.length,buildCPUms,prepareCPUus:setup,bypassCPUus:free,snapCPUus:snapping,guidedPerBatch});
}
console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,
  method:"process.cpuUsage user+system. p50/p95 of batch-average microseconds per operation. One preparation per motion batch. No Canvas2D, DOM, storage, native input or frame measurements.",
  batches,samples,warmupBatches:8,viewport:[800,550],zoom:1,checksum,results,lowZoomAccess:verifyLowZoomAccess()},null,2));
