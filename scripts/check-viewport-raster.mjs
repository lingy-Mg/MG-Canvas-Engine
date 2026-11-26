// Real CPU-backed Canvas 2D. Keep ordinary query timing in bench-viewport.mjs.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {performance} from "node:perf_hooks";
import {createHistory,dispatch,redo,undo} from "../dist/core/history.js";
import {buildScene} from "../dist/scene/board.js";
import {camera,denseBoard,viewportBoard,viewportRect,viewportSize} from "../tests/fixtures/viewport-access.ts";
import {cpuSince,percentiles,sha,viewportReleases} from "./bench-viewport.mjs";

const require=createRequire(import.meta.url),{createCanvas}=require("@napi-rs/canvas");
const version=require("@napi-rs/canvas/package.json").version,args=process.argv.slice(2),releases=await viewportReleases(args);
const {width,height}=viewportSize,area=viewportRect(),zoom=camera.zoom,pixelWorld={x:7100,y:5700};
const local=viewportBoard(0),extended=viewportBoard(20000),dense=denseBoard(4200),warmups=5,samples=15;
function surface(View){
  const canvas=createCanvas(1,1),view=new View(canvas);view.size(width,height,1);
  const ctx=canvas.getContext("2d");
  return {
    canvas,view,paint(scene){view.draw(scene,camera);ctx.getImageData(0,0,1,1);},
    bytes(){return ctx.getImageData(0,0,width,height).data;},
    sample(){return [...ctx.getImageData(Math.floor(pixelWorld.x*zoom),Math.floor(pixelWorld.y*zoom),1,1).data];}
  };
}
// Optional follow-up control for the native cost that persists with seven groups on screen.
if(args.includes("--background-only")){
  const regular=surface(releases.at(-1).View),plain=createCanvas(width,height),ctx=plain.getContext("2d");
  const actual=()=>regular.paint([]);
  const solid=()=>{ctx.fillStyle="#f3f5f9";ctx.fillRect(0,0,width,height);ctx.getImageData(0,0,1,1);};
  const runs=[{name:"emptyCanvasView",draw:actual,cpu:[],elapsed:[]},{name:"solidFill",draw:solid,cpu:[],elapsed:[]}];
  for(const r of runs)r.draw();
  for(let i=0;i<5;i++)for(const r of i%2?[...runs].reverse():runs){
    const wall=performance.now(),start=process.cpuUsage();r.draw();
    r.cpu.push(cpuSince(start)/1000);r.elapsed.push(performance.now()-wall);
  }
  const timings=Object.fromEntries(runs.map(r=>[r.name,{cpuMs:percentiles(r.cpu),elapsedMs:percentiles(r.elapsed)}]));
  console.log(JSON.stringify({frame:[width,height],zoom,warmups:1,samples:5,timings,
    method:"Same native surface size and readback; ordinary CanvasView.draw([]) with its grid versus an opaque fillRect and 1x1 flush. No queried groups."},null,2));
  process.exit(0);
}
function stateProof(release){
  const raster=surface(release.View),initial=createHistory(extended),idx=new release.Projection(initial.doc);
  const render=scene=>{raster.paint(scene);return sha(raster.bytes());};
  const base=render(idx.query(area)),blended=raster.sample();
  const empty=render([]);assert.notEqual(empty,base);
  assert.deepEqual(base,render(buildScene(initial.doc)),"viewport must match drawing the entire board");
  assert.equal(base,render(new release.Projection(local).query(area)),"distant objects changed painted pixels");
  const proofPNG=raster.canvas.toBuffer("image/png");
  raster.view.setTheme("dark");const dark=render(idx.query(area));assert.notEqual(base,dark);
  assert.equal(dark,render(buildScene(initial.doc)));raster.view.setTheme("light");
  const glass=initial.doc.objects.glass,moved={...glass,at:{x:66000,y:8400}};
  const patch=idx.overlay({objects:new Map([[glass.id,moved]])}),preview=render(idx.query(area,patch));
  assert.notEqual(preview,base);assert.equal(preview,render(buildScene(initial.doc,{objects:new Map([[glass.id,moved]])})));
  const move=dispatch(initial,{label:"move across tiles",patches:[{op:"putObject",value:moved}]});
  idx.update(move.state.doc,move.changeSet);assert.equal(preview,render(idx.query(area)));
  assert.deepEqual(move.state.doc.objects.edge,initial.doc.objects.edge);
  const back=undo(move.state);idx.update(back.state.doc,back.changeSet);assert.equal(base,render(idx.query(area)));
  const again=redo(back.state);idx.update(again.state.doc,again.changeSet);assert.equal(preview,render(idx.query(area)));
  const top=dispatch(initial,{label:"bring opaque rectangle forward",patches:[{op:"setOrder",ids:[...initial.doc.order.filter(id=>id!=="back"),"back"]}]});
  idx.update(top.state.doc);const reordered=render(idx.query(area)),opaque=raster.sample();
  assert.notEqual(base,reordered);assert.notDeepEqual(blended,opaque);assert.deepEqual(opaque,[87,136,178,255]);
  assert.equal(reordered,render(buildScene(top.state.doc)));
  const crowded=new release.Projection(dense),crowdedHash=render(crowded.query(area));assert.equal(crowdedHash,render(buildScene(dense)));
  return {proofPNG,hashes:{base,dark,preview,reordered,dense:crowdedHash},overlapRGB:{blended,opaque},pngSHA256:sha(proofPNG)};
}
const proofs=releases.map(stateProof),reference=proofs.at(-1);
for(const sample of proofs){assert.deepEqual(sample.hashes,reference.hashes);assert.deepEqual(sample.proofPNG,reference.proofPNG);}

function measureRaster(doc){
  const entries=releases.map(r=>{
    const index=new r.Projection(doc);
    return {name:r.name,raster:surface(r.View),scene:index.query(area),cpu:[],elapsed:[]};
  });
  for(let i=0;i<warmups;i++)for(const e of entries)e.raster.paint(e.scene);
  for(let i=0;i<samples;i++)for(const e of i%2?[...entries].reverse():entries){
    const wall=performance.now(),start=process.cpuUsage();e.raster.paint(e.scene);
    e.cpu.push(cpuSince(start)/1000);e.elapsed.push(performance.now()-wall);
  }
  return Object.fromEntries(entries.map(e=>[e.name,{groups:e.scene.length,drawFlushCPUms:percentiles(e.cpu),drawFlushElapsedMs:percentiles(e.elapsed)}]));
}
const pixelsOnly=args.includes("--verify-only");
const timings=pixelsOnly?undefined:{sparse20008:measureRaster(extended),visible4200:measureRaster(dense)};
for(const mode of ["--write","--compare"]){
  const i=args.indexOf(mode);if(i<0)continue;assert(args[i+1]);
  if(mode==="--write")writeFileSync(args[i+1],reference.proofPNG,{flag:"wx"});
  else assert.deepEqual(reference.proofPNG,readFileSync(args[i+1]));
}
console.log(JSON.stringify({engine:"Skia Canvas 2D",version,devicePixelRatio:1,frame:[width,height],zoom,warmups:pixelsOnly?0:warmups,samples:pixelsOnly?0:samples,
  method:"Compiled CanvasView.draw on a prequeried scene, with a 1x1 pixel read to flush; alternating release order. CPU user+system and wall milliseconds per draw+flush. Full-frame RGBA reads and hashes outside timing.",
  timings,rgbaSHA256:reference.hashes,overlapRGB:reference.overlapRGB,pngSHA256:reference.pngSHA256},null,2));
