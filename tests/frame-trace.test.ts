import {test} from "node:test";
import assert from "node:assert/strict";
import {FrameTrace,longFramePrefix} from "../app/frame-trace.ts";

test("long frame records retain phase costs and the preceding frame, without unbounded history",()=>{
  const trace=new FrameTrace();
  const info={phase:"zoom",paint:"bitmap",cache:"rebuild",zoom:.24,canvasGroups:0,cacheGroups:500,selected:0};
  const entries=()=>performance.getEntriesByType("measure").filter(entry=>entry.name.startsWith(longFramePrefix));
  function record(start:number,work:number){
    trace.record(start,start-2,{start,scene:start+2,cache:start+work-4,query:start+work-3,canvas:start+work-2,end:start+work},info);
  }
  try{
    record(100,65);record(166,12);
    const follow=entries()[1] as PerformanceMeasure;
    assert.equal(follow.detail.gapMs,66);
    assert.equal(follow.detail.previous.cacheMs,59);
    assert.equal(follow.detail.current.workMs,12);
    for(let frame=0;frame<20;frame++)record(200+frame*100,70);
    assert.equal(entries().length,16);
    trace.pause();
    record(2400,12);
    assert.equal(entries().length,16);
  }finally{
    for(const entry of entries())performance.clearMeasures(entry.name);
  }
});
