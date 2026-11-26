import {performance} from "node:perf_hooks";
import {buildScene,hitTest} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";
import {planMove,moveObjects} from "../session/transform.ts";
import {largeBoard} from "../tests/fixtures/large-board.ts";

const countArg=process.argv.slice(2).find(a=>a.startsWith("--sizes="));
const counts=countArg?countArg.slice(8).split(",").map(Number):[0,1500,30000];
let consumed=0;
const round=(n:number)=>Math.round(n*1000)/1000;
function runs(fn:()=>unknown,loops:number):{p50:number;p95:number}{
  fn();
  const times=[];
  for(let i=0;i<loops;i++){const now=performance.now();const result=fn();times.push(performance.now()-now);if(result)consumed++;}
  times.sort((a,b)=>a-b);
  return {p50:round(times[Math.ceil(.5*times.length)-1]),p95:round(times[Math.ceil(.95*times.length)-1])};
}
const records=[];
for(const count of counts){
  const f=largeBoard(count),doc=f.document,steps=count>=100000?4:count>=30000?9:20;
  const projection=runs(()=>buildScene(doc),steps);
  const scene=buildScene(doc),plan=planMove(doc,[f.dragId]);
  let n=0;
  const drag=runs(()=>buildScene(doc,{objects:moveObjects(plan,{x:++n%18+1,y:15})}),steps);
  const hit=runs(()=>hitTest(scene,f.probe,3),steps*8);
  const buildIndex=runs(()=>new SceneProjection(doc),Math.max(3,Math.round(steps/2)));
  const index=new SceneProjection(doc),rect={min:{x:0,y:0},max:{x:800,y:550}};
  const indexedDrag=runs(()=>index.query(rect,index.overlay({objects:moveObjects(plan,{x:++n%18+1,y:15})})),steps*4);
  const q={min:{x:f.probe.x-3,y:f.probe.y-3},max:{x:f.probe.x+3,y:f.probe.y+3}};
  const indexedHit=runs(()=>hitTest(index.query(q),f.probe,3),steps*16);
  if(globalThis.gc)globalThis.gc();
  records.push({objects:count,drawGroups:scene.length,primitives:scene.reduce((n,g)=>n+g.items.length,0),steps,projection,drag,hit,buildIndex,indexedDrag,indexedHit,visible:index.query(rect).length,heapMiB:round(process.memoryUsage().heapUsed/1048576)});
}
console.log(JSON.stringify({node:process.version,platform:process.platform,unit:"ms, JS-only, no canvas/device",consumed,records},null,2));
