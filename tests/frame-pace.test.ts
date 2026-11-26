import {test} from "node:test";
import assert from "node:assert/strict";
import {FramePace,frameRate,frameRates} from "../app/frame-pace.ts";

test("the preference strictly accepts the six supported limits",()=>{
  assert.deepEqual(frameRates,["30","60","120","140","170","unlimited"]);
  for(const value of frameRates)assert.equal(frameRate(value),value);
  for(const value of [null,30,"144","auto"," 60"])assert.equal(frameRate(value),"unlimited");
});

test("fractional refresh schedules sustain their target without callbacks between refreshes",()=>{
  for(const hz of [60,144,240]){
    for(const rate of frameRates){
      const pace=new FramePace();pace.set(rate);
      const refresh=1000/hz,painted=[];
      for(let tick=0;tick<hz*10;tick++){
        const now=tick*refresh;
        if(pace.ready(now))painted.push(now);
      }
      const target=Math.min(hz,rate==="unlimited"?hz:Number(rate));
      assert(Math.abs(painted.length-target*10)<=1,JSON.stringify({hz,rate,painted:painted.length}));
      if(target<hz){
        const gap=pace.expectedGap()!;
        assert(painted.slice(1).every((at,i)=>at-painted[i]<=gap+.001));
      }
    }
  }
});

test("a stall or changed preference starts at the next available refresh",()=>{
  const pace=new FramePace();pace.set("30");
  assert(pace.ready(0));assert(!pace.ready(16));assert(pace.ready(441));assert(!pace.ready(456));
  pace.set("unlimited");assert(pace.ready(457));
});
