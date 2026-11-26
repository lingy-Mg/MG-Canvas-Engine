import {performance} from "node:perf_hooks";
import {createHistory,dispatch,undo} from "../core/history.ts";
import {SceneProjection} from "../scene/projector.ts";
import {largeBoard} from "../tests/fixtures/large-board.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
const sizes=(process.argv.find(a=>a.startsWith("--sizes="))?.slice(8)??"1500,30000,100000").split(",").map(Number);
const round=(n:number)=>Math.round(n*1000)/1000;
const stats=(times:number[])=>{const order=[...times].sort((a,b)=>a-b);return {p50:round(order[Math.ceil(order.length*.5)-1]),p95:round(order[Math.ceil(order.length*.95)-1])};};
const records=[];
for(const size of sizes){
  const sample=largeBoard(size),state=createHistory(sample.document),shape=state.doc.objects[sample.dragId];
  if(shape?.kind!=="shape")throw new Error("benchmark needs at least one shape");
  const times={history:[],projectionFull:[],fullCommit:[],projectionIncremental:[],incrementalCommit:[],undoIndexed:[],encode:[],decode:[]} as Record<string,number[]>;
  const live=new SceneProjection(state.doc);
  let groups=0;
  const n=size>=100000?4:size>=30000?8:20;
  for(let i=-1;i<n;i++){
    const t0=performance.now();
    const edit=dispatch(state,{label:"move+resize",patches:[{op:"putObject",value:{...shape,at:{x:18+i*3,y:12},width:shape.width+6}}]});
    const t1=performance.now();
    const update=live.update(edit.state.doc,edit.changeSet), t2=performance.now();
    if(update.mode!=="incremental")throw new Error("unexpected full fallback");
    groups=update.projected;
    const undone=undo(edit.state);live.update(undone.state.doc,undone.changeSet);
    const t3=performance.now();
    new SceneProjection(edit.state.doc);
    const t4=performance.now();
    if(i<0)continue;
    times.history.push(t1-t0);times.projectionFull.push(t4-t3);times.fullCommit.push(t1-t0+t4-t3);
    times.projectionIncremental.push(t2-t1);times.incrementalCommit.push(t2-t0);times.undoIndexed.push(t3-t2);
  }
  const cache=new AssetVault();
  for(let i=0;i<(size===100000?3:6);i++){
    const t0=performance.now(),snapshot=encodeProject(state.doc,cache),t1=performance.now();
    decodeProject(snapshot);const t2=performance.now();
    times.encode.push(t1-t0);times.decode.push(t2-t1);
  }
  if(globalThis.gc)globalThis.gc();
  records.push({objects:size,samples:n,projectedPerEdit:groups,metrics:Object.fromEntries(Object.entries(times).map(([name,values])=>[name,stats(values)]))});
}
console.log(JSON.stringify({ref:"M5B actual history dispatch and incremental projector, same-run full comparator",node:process.version,platform:process.platform,metric:"milliseconds, JS-only, no Canvas/DOM/device/IO/image bytes",records},null,2));
