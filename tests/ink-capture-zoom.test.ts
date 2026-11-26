import test from "node:test";
import assert from "node:assert/strict";
import { InkInput } from "../features/ink-input.ts";
import { inkPoints,MAX_INK_COORDINATE,validInkGeometry } from "../features/ink.ts";
import { brush,capture,deviation,offset,traces,zooms } from "../scripts/ink-zoom-traces.mjs";

test("one-pixel input stairs settle while the newest sample stays exact at every capture zoom",()=>{
  for(const zoom of zooms)for(const trace of traces)for(const spacing of [1,8]){
    const {draft,stroke,maxTipError}=capture({InkInput},trace,zoom,{spacing});
    assert(maxTipError<1e-8);
    assert.deepEqual(stroke,draft);
    assert(validInkGeometry(stroke));
    assert(inkPoints(stroke).every(p=>p.radius===brush.baseWidth/2));
    if(trace!==traces[2]){
      assert(deviation(stroke,trace)*zoom<.21,"slow straight and curved centerlines stay inside a fraction of a CSS pixel RMS");
    }
  }
});

test("fractional low-zoom input retains shallow bends that are smaller than a screen pixel",()=>{
  for(const zoom of [.05,.25]){
    for(const trace of traces){
      const {stroke}=capture({InkInput},trace,zoom,{fractional:true});
      assert(deviation(stroke,trace)<.055,"fitting and simplifying cannot flatten the arc over several world units");
    }
  }
});

test("device-pixel mouse samples at fractional Windows scaling retain a smooth low-zoom centerline",()=>{
  for(const deviceStep of [2/3,.8,.5])for(const zoom of [.05,.25]){
    const {stroke,maxTipError}=capture({InkInput},traces[0],zoom,{deviceStep});
    assert(maxTipError<1e-8);
    assert(deviation(stroke,traces[0])*zoom/deviceStep<.16);
  }
});

test("fine jitter on a slow line or arc is bounded when inspected at maximum view zoom",()=>{
  for(const zoom of [1,4])for(const trace of traces.slice(0,2)){
    const {stroke}=capture({InkInput},trace,zoom,{noise:true});
    assert(deviation(stroke,trace)*zoom<.12);
  }
});

test("long straight runs compact after fitting and boundary strokes remain portable",()=>{
  const tool=new InkInput(64),camera={zoom:.05,offset:{x:0,y:0}};
  tool.down({id:1,device:"mouse",primaryTip:true,at:{x:0,y:0}},{brush,camera,fingerInk:true});
  for(let x=1;x<=500;x++)tool.move(1,[{at:{x,y:0}}]);
  const [commit]=tool.up(1);
  assert(commit.kind==="stroke-commit");
  assert(commit.stroke.samples.length<=64);
  assert.deepEqual(commit.stroke.samples.at(-1),[10000,0,.5]);
  const edge=new InkInput(),limit=MAX_INK_COORDINATE;
  edge.down({id:1,device:"pen",primaryTip:true,at:{x:0,y:limit-2},pressure:.2},
    {brush,camera:{zoom:1,offset:{x:0,y:0}},fingerInk:true});
  for(let x=1;x<80;x++)edge.move(1,[{at:{x,y:limit-Math.round(1+Math.cos(x/3))},pressure:.8}]);
  const [result]=edge.up(1);assert(result.kind==="stroke-commit"&&validInkGeometry(result.stroke));
});

test("a low-zoom stroke retains the turn, pressure-only readings, exact pin and device widths",()=>{
  for(const zoom of zooms){
    const tool=new InkInput(),camera={zoom,offset},start={x:180,y:140};
    tool.down({id:7,device:"pen",primaryTip:true,at:start,pressure:.2},{brush,camera,fingerInk:true});
    const turn={x:212,y:140};
    for(let x=start.x+1;x<=turn.x;x++)tool.move(7,[{at:{x,y:140},pressure:.2}]);
    for(let y=141;y<=168;y++)tool.move(7,[{at:{x:turn.x,y},pressure:.8}]);
    const end={x:turn.x,y:168};
    tool.move(7,[{at:end,pressure:.3}]);
    const preview=structuredClone(tool.draft),[result]=tool.up(7,end);
    assert(result.kind==="stroke-commit");
    assert.deepEqual(preview,result.stroke);
    const points=inkPoints(result.stroke);
    assert(points.some(p=>Math.hypot(p.x*zoom+offset.x-turn.x,p.y*zoom+offset.y-turn.y)<1e-8));
    assert(points.at(-2)!.radius>points[0].radius);
    assert(points.at(-1)!.radius<points.at(-2)!.radius);
    assert.deepEqual(result.stroke.samples.at(-1)!.slice(0,2),result.stroke.samples.at(-2)!.slice(0,2));
    assert.deepEqual(result.stroke.samples.map(s=>s[2]),[...Array(33).fill(.2),...Array(28).fill(.8),.3]);
  }
});
