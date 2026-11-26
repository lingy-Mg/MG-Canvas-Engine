import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import type {BoardDocument,ShapeObject} from "../../core/document.ts";
import {SceneProjection} from "../../scene/projector.ts";
import type {Point} from "../../core/geometry.ts";
import type {AlignmentGuide} from "../../session/drag-alignment.ts";
import type {AlignmentQueryWork} from "../../scene/projector.ts";

const zoom=.05,viewport={min:{x:0,y:0},max:{x:1920/zoom,y:1080/zoom}};
const shape=(id:string,x:number,y:number,w:number,h:number):ShapeObject=>({
  kind:"shape",id,shape:"rect",at:{x,y},width:w,height:h,rotation:0,cornerRadius:4,fill:"#eaf1ff",stroke:"#305999",label:""
});
// Include an empty row and column as well as the densely spaced anchors at 5%.
const deltas=Array.from({length:192},(_,i)=>i%24===23?{x:5200,y:3000}:
  {x:980+((i*13)%25-12)*20,y:220+((i*5)%19-9)*20});
const keys=["cells","memberships","spanning","objects","returned"] as const;
function run(farObjects:number){
  const rows=[shape("moving",6100,5400,320,200),shape("neighbor",7400,5820,600,250),
    shape("above",7900,4930,330,410),shape("left",5580,5610,220,220),shape("in-view-elsewhere",25100,14000,120,80),
    shape("spanning",-10000,13800,65000,440)];
  for(let i=0;i<farObjects;i++)rows.push(shape("far-"+i,100000+(i%200)*240,100000+Math.floor(i/200)*180,80,40));
  let measuring=false,documentLookups=0,farLookups=0;
  const objects=new Proxy(Object.fromEntries(rows.map(o=>[o.id,o])),{
    ownKeys(target){assert(!measuring,"full board enumeration in a warm snap query");return Reflect.ownKeys(target);},
    get(target,name){if(measuring){documentLookups++;if(String(name).startsWith("far-"))farLookups++;}return Reflect.get(target,name);}
  });
  const doc:BoardDocument={schemaVersion:1,id:"alignment-access",theme:"paper",objects,order:rows.map(o=>o.id),assets:{}};
  const projection=new SceneProjection(doc),work:AlignmentQueryWork[]=[],outcomes:[Point,readonly AlignmentGuide[]][]=[];
  const drag=projection.prepareDrag(["moving"],viewport,zoom,w=>{if(measuring)work.push(w);}).alignment!;
  for(const delta of deltas)drag.resolve(delta);
  drag.resolve({x:0,y:0});measuring=true;
  for(const raw of deltas){
    const resolved=drag.resolve(raw);outcomes.push([resolved,drag.guides]);
  }
  measuring=false;
  assert.equal(work.length,deltas.length);assert(farLookups===0);
  assert.equal(documentLookups,work.reduce((s,w)=>s+w.objects,0));
  assert(work.every(w=>!w.limited&&w.cells>0&&w.cells<=256&&w.memberships+w.spanning<=512));
  const guided=outcomes.filter(([,guides])=>guides.length).length;assert(guided>0&&guided<deltas.length);
  const counts=Object.fromEntries(keys.map(key=>{
    const values=work.map(w=>w[key]);return [key,{min:Math.min(...values),max:Math.max(...values),sum:values.reduce((a,b)=>a+b,0)}];
  }));
  return {work,outcomes,summary:{objects:rows.length,farObjects,queries:work.length,guided,farLookups,counts}};
}
/** Measured after building both the scene index and the connection movement plan.
 * The instrumented pass counts real bucket lookups and entries iterated, including repeats. */
export function verifyLowZoomAccess(){
  const local=run(0),extended=run(20000);
  assert.deepEqual(local.work,extended.work);assert.deepEqual(local.outcomes,extended.outcomes);
  const hash=(data:unknown)=>createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return {zoom,viewportCSS:[1920,1080],warmup:deltas.length,samples:deltas.length,
    measured:"alignment.resolve only, after gesture setup; no movement patches, drawing, DOM or CPU timer",
    baseline:local.summary,extended:extended.summary,workSHA256:hash(local.work),outcomesSHA256:hash(local.outcomes)};
}
