import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {resolve,join} from "node:path";
import {pathToFileURL} from "node:url";

const require=createRequire(import.meta.url),{createCanvas}=require("@napi-rs/canvas");
const root=process.argv[2],moduleURL=root?pathToFileURL(join(resolve(root),"dist/features/mindmap-layout.js")):new URL("../dist/features/mindmap-layout.js",import.meta.url);
const {layoutMap,topicAt,topicBox}=await import(moduleURL);
const canvas=createCanvas(1,1),ctx=canvas.getContext("2d"),measure=ctx.measureText.bind(ctx);
let metrics=0;
ctx.measureText=text=>{metrics++;return measure(text);};
globalThis.document={createElement:()=>canvas};

const count=2048,ids=Array.from({length:count},(_,i)=>"t"+i),edited=ids[0],topics={root:{id:"root",text:"会议室",collapsed:false,childIds:ids}};
for(const id of ids)topics[id]={id,text:"排期 "+id,collapsed:false,childIds:[]};
const base={id:"map",kind:"mindmap",rootId:"root",origin:{x:0,y:0},layout:"balanced",topics};
const coldStart=performance.now(),coldRows=layoutMap(base),coldMs=performance.now()-coldStart,coldMeasures=metrics;
assert.equal(coldRows.length,count+1);assert(coldMeasures>count);
const measurements=[],times=[];
for(const width of [180,52,64,80,96,112,128,144,160,176,192,196]){
  const before=metrics,start=performance.now();
  const candidate={...base,topics:{...topics,[edited]:{...topics[edited],appearance:{width}}}};
  const rows=layoutMap(candidate),box=topicBox(candidate,edited).box;
  assert.equal(rows.length,count+1);assert.equal(box.width,width);
  assert.equal(topicAt(candidate,{x:box.at.x+4,y:box.at.y+4}).topicId,edited);
  const after=metrics;
  assert.equal(layoutMap(candidate),rows);assert.equal(topicBox(candidate,edited).box.width,width);
  assert.equal(metrics,after,"repeated lookup remeasured text");
  measurements.push(after-before);times.push(performance.now()-start);
}
if(root)assert(measurements.every(n=>n>=count),"expected the frozen M5AM layout");
else assert(measurements.every(n=>n>0&&n<=24),"unaffected topics were remeasured");
const sorted=times.slice(2).sort((x,y)=>x-y),ms=x=>Number(x.toFixed(2));
console.log(JSON.stringify({topics:count+1,samples:times.length,warmup:2,nativeSkia:require("@napi-rs/canvas/package.json").version,
  coldMeasures,coldMs:ms(coldMs),measuresPerEdit:measurements,medianMs:ms((sorted[4]+sorted[5])/2),maxMs:ms(sorted.at(-1)),
  repeatedLayoutMeasures:0,scope:"shallow copy, visible layout, index and hit; excludes canvas paint and DOM"}));
