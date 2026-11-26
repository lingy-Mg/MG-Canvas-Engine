import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {cpus} from "node:os";
import {resolve} from "node:path";
import {previewVersion} from "./release.mjs";
import {pathToFileURL} from "node:url";
import {SceneProjection} from "../dist/scene/projector.js";
import {CanvasView} from "../dist/renderers/canvas2d/canvas.js";
import {bruteScene,denseBoard,observeViewport,viewportBoard,viewportSize,views,zoom,padding} from "../tests/fixtures/viewport-access.ts";

export const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
export const cpuSince=start=>{const u=process.cpuUsage(start);return u.user+u.system;};
export function percentiles(values){
  const v=[...values].sort((a,b)=>a-b),pick=p=>Number(v[Math.ceil(p*v.length)-1].toFixed(3));
  return {p50:pick(.5),p95:pick(.95)};
}

/** The historical implementation and renderer must be the actual modules in its frozen HTML. */
export async function viewportReleases(args){
  const current={name:previewVersion,Projection:SceneProjection,View:CanvasView};
  const at=args.indexOf("--previous");
  if(at<0)return [current];
  assert(args[at+1],"provide an extracted, built M5AA directory");const root=resolve(args[at+1]);
  const html=readFileSync(resolve(root,"preview/Canvas-M5AA-Preview.html"),"utf8");
  assert.equal(sha(html),"d8cbf096c29848070b769293ad9cbd2a523232b37bc5e6fba3ded94748e46af8");
  const units=JSON.parse(html.match(/const units=(.*);\nconst urls=/s)[1]);
  for(const {path,code} of units)assert.equal(readFileSync(resolve(root,"dist",path),"utf8"),code,path);
  const old=file=>import(pathToFileURL(resolve(root,"dist",file)));
  const {SceneProjection:Projection}=await old("scene/projector.js"),{CanvasView:View}=await old("renderers/canvas2d/canvas.js");
  return [{name:"M5AA",Projection,View},current];
}

const batches=31,warmup=8;
function summarize(rows){
  const span=values=>({min:Math.min(...values),max:Math.max(...values),sum:values.reduce((a,b)=>a+b,0)});
  const work={boundsReads:span(rows.map(r=>r.boundsReads)),offscreenReads:span(rows.map(r=>r.offscreenReads)),returned:span(rows.map(r=>r.ids.length))};
  if(rows.every(r=>r.grid)){
    work.modes=[...new Set(rows.map(r=>r.grid.mode))];
    for(const k of ["tiles","fineProbes","memberships"])work[k]=span(rows.map(r=>r.grid[k]));
  }
  return {...work,accessSHA256:sha(JSON.stringify(rows.map(({grid,boundsReads,offscreenReads})=>[grid,boundsReads,offscreenReads]))),
    orderedIdsSHA256:sha(JSON.stringify(rows.map(r=>r.ids)))};
}
function measureCase(releases,doc,requests){
  const runs=releases.map(r=>({name:r.name,index:new r.Projection(doc),elapsed:[],sink:0}));
  const batch=run=>{for(const area of requests)run.sink+=run.index.query(area).length;};
  for(let i=0;i<warmup;i++)for(const run of runs)batch(run);
  for(let i=0;i<batches;i++){
    for(const run of i%2?[...runs].reverse():runs){
      const start=process.cpuUsage();batch(run);run.elapsed.push(cpuSince(start)/requests.length);
    }
  }
  // No getters, diagnostics, assertions, index construction, scene painting or readback inside the CPU samples.
  const truth=requests.map(r=>bruteScene(runs[0].index.all(),r).map(g=>g.id));
  const results={};
  for(const run of runs){
    const observed=observeViewport(run.index,requests);assert.deepEqual(observed.map(r=>r.ids),truth);
    results[run.name]={cpuUsPerQuery:percentiles(run.elapsed),access:summarize(observed)};
  }
  assert(runs.every(r=>r.sink===runs[0].sink));
  return {objects:doc.order.length,queriesPerBatch:requests.length,results};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const releases=await viewportReleases(process.argv.slice(2)),measure=(doc,rs=views)=>measureCase(releases,doc,rs);
  const local=measure(viewportBoard(0)),large=measure(viewportBoard(20000)),adjacent=measure(viewportBoard(20000,true)),dense=measure(denseBoard(4200));
  const near=views.map((_,i)=>({min:{x:5000+i*7,y:5100+i*3},max:{x:6920+i*7,y:6180+i*3}}));
  const normal=measure(viewportBoard(20000),near);
  assert.deepEqual(local.results[previewVersion].access,large.results[previewVersion].access);
  assert.equal(adjacent.results[previewVersion].access.offscreenReads.max,0);assert.equal(adjacent.results[previewVersion].access.boundsReads.max,7);
  assert.deepEqual(dense.results[previewVersion].access.modes,["density"]);assert.equal(dense.results[previewVersion].access.returned.min,4200);
  if(large.results.M5AA){
    assert.equal(large.results.M5AA.access.boundsReads.min,20015);assert.equal(large.results.M5AA.access.offscreenReads.min,20000);
    assert.equal(local.results.M5AA.access.boundsReads.max,15);
  }
  console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,
    viewportCSS:[viewportSize.width,viewportSize.height],sparseZoom:zoom,paddingCSS:padding,warmupBatches:warmup,timedBatches:batches,
    method:"Prebuilt projections, alternating release order, process.cpuUsage user+system. p50/p95 of batch-average microseconds/query. Bounds getters and index counters run separately after timing. Ordinary paint query only.",
    cases:{sparse:local,distant20000:large,boundary20000:adjacent,visible4200:dense,zoom1Control:normal}},null,2));
}
