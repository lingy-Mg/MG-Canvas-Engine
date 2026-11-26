import {loadBrush} from "./replay-ink.mjs";

const raf=()=>new Promise(requestAnimationFrame);
const wait=async check=>{
  const until=performance.now()+3000;
  while(!check()){
    if(performance.now()>until)throw Error("timed out waiting for an editor paint");
    await raf();
  }
};
const inputs=[
  {name:"fastPen",device:"pen",zoom:1,y:200,fast:true},
  {name:"slowMouse",device:"mouse",zoom:.05,y:275},
  {name:"slowPen",device:"pen",zoom:.05,y:335,pressure:true},
  {name:"plainPen",device:"pen",zoom:.05,y:395},
  {name:"finger",device:"touch",zoom:.05,y:455},
  {name:"pressureTouch",device:"touch",zoom:.05,y:505,pressure:true},
  {name:"betweenPaints",device:"pen",zoom:.05,y:565,quick:true},
];

function fixture(spec){
  const count=spec.quick?12:spec.fast?144:192;
  let previous;
  return Array.from({length:count},(_,i)=>{
    const fast=spec.fast||spec.quick;
    const p=fast ? .12+.76*(i%19)/18 : spec.pressure ? .26+.26*(1+Math.sin(i/8))/2 : spec.device==="mouse" ? .9 : spec.device==="touch" ? 0 : .5;
    const x=235+i*(fast?3.25:.55),y=spec.y+(fast?Math.abs(i%36-18)*1.7:7*Math.sin(i/48)+i*.13);
    // Equal clock readings include both movement and a pressure-only reading.
    const stationary=(spec.fast||spec.pressure)&&i%8===7;
    const at=stationary?previous:{x,y};
    if(spec.device==="mouse"){at.x=Math.round(at.x);at.y=Math.round(at.y);}
    previous=at;
    return {at,pressure:Math.fround(p),timeStamp:(fast?3:8)*Math.floor(i/2)};
  });
}

function pointer(type,spec,s){
  const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:74,pointerType:spec.device,isPrimary:true,
    clientX:s.at.x,clientY:s.at.y,button:type==="pointerdown"||type==="pointerup"?0:-1,
    buttons:type==="pointerup"?0:1,pressure:type==="pointerup"?0:s.pressure});
  Object.defineProperty(e,"timeStamp",{value:s.timeStamp});
  return e;
}
function dispatchBatch(el,type,spec,list){
  const events=list.map(s=>pointer(type,spec,s)),parent=events.at(-1);
  Object.defineProperty(parent,"getCoalescedEvents",{value:()=>events});el.dispatchEvent(parent);
}
function crop(el,spec){
  const d=devicePixelRatio,b=el.getBoundingClientRect(),w=Math.ceil((spec.fast?497:155)*d),h=Math.ceil(63*d);
  // Repeated getImageData on the editor itself can switch Chromium's raster
  // backend between the two frames, changing antialiasing even on its grid.
  const ctx=new OffscreenCanvas(w,h).getContext("2d",{willReadFrequently:true});
  ctx.drawImage(el,Math.floor((225-b.left)*d),Math.floor((spec.y-10-b.top)*d),w,h,0,0,w,h);
  return ctx.getImageData(0,0,w,h).data;
}
function changedPixels(a,b){
  let changed=0;
  for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3])changed++;
  return changed;
}

export async function boardDigest(){
  const el=document.querySelector("#canvas");
  const ctx=new OffscreenCanvas(el.width,el.height).getContext("2d",{willReadFrequently:true});
  ctx.drawImage(el,0,0);
  const pixels=ctx.getImageData(0,0,el.width,el.height).data;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",pixels)));
}

export async function runPacedInk(){
  const el=document.querySelector("#canvas"),q=window.pacedInk,out=[];
  q.views=[];
  function wheel(delta,ctrl=false){el.dispatchEvent(new WheelEvent("wheel",{clientX:520,clientY:360,deltaY:delta,ctrlKey:ctrl,bubbles:true,cancelable:true}));}
  for(const spec of inputs){
    for(let i=0;i<5;i++)wheel(1000,true);
    if(spec.zoom===1)for(let i=0;i<4;i++)wheel(-Math.log(20)/(4*.003),true);
    if(document.querySelector("#zoom-read").textContent!==spec.zoom*100+"%")throw Error("wrong writing zoom");
    let painted=q.paints;await wait(()=>q.paints>painted);
    // Enter on a real camera-cache transfer before its 120 ms settle redraw.
    const hit=q.transfers;wheel(3);await wait(()=>q.transfers>hit);
    const events=fixture(spec),start=q.paints,atCache=q.transfers,savedCount=window.inkQA.savedCount;
    q.observations=[];q.batch=0;q.tip=events[0].at;
    el.dispatchEvent(pointer("pointerdown",spec,events[0]));
    for(let i=1;i<events.length;i+=8){
      const chunk=events.slice(i,i+8);
      const rawCount=Math.min(2,chunk.length);
      dispatchBatch(el,"pointerrawupdate",spec,chunk.slice(0,rawCount));
      dispatchBatch(el,"pointermove",spec,chunk);
      q.tip=chunk.at(-1).at;q.batch++;
      if(!spec.quick)await new Promise(resolve=>setTimeout(resolve,spec.fast?12:32));
    }
    let diff=null;
    if(!spec.quick)await wait(()=>q.observations.at(-1)?.batch===q.batch);
    const latest=events.at(-1),preview=spec.quick?undefined:crop(el,spec);
    const observations=q.observations;const draftPaints=q.paints-start,cacheInStroke=q.transfers-atCache;
    q.tip=undefined;
    const up=spec.quick?{...latest,at:{x:latest.at.x+9,y:latest.at.y+3}}:latest;
    el.dispatchEvent(pointer("pointerup",spec,up));
    painted=q.paints;await wait(()=>q.paints>painted);
    if(preview)diff=changedPixels(preview,crop(el,spec));
    const {left,top}=el.getBoundingClientRect();
    // The recovery snapshot carries the exact camera doubles used for input.
    // Canvas2D's getTransform narrows them, which can affect collinearity.
    await wait(()=>window.inkQA.savedCount===savedCount+1);
    const {zoom,offset}=window.inkQA.savedCamera;
    q.views.push({zoom,x:offset.x,y:offset.y,left,top});
    const gaps=observations.slice(1).map((o,i)=>o.time-observations[i].time).sort((a,b)=>a-b);
    const costs=observations.map(o=>o.cost).sort((a,b)=>a-b);
    out.push({name:spec.name,delivered:events.length+(spec.quick?1:0),batches:q.batch,draftPaints,
      cacheTransfersBefore:atCache-hit,cacheInStroke,
      maxTipCss:observations.length?Math.max(...observations.map(o=>o.error)):null,
      medianPaintGapMs:gaps.length?gaps[Math.floor(gaps.length/2)]:null,
      paintP95Ms:costs.length?costs[Math.ceil(costs.length*.95)-1]:null,liftChangedPixels:diff});
  }
  return out;
}

export async function verifyPacedInk(units,strokes){
  const api=await loadBrush(units),result=[];
  for(const [i,spec] of inputs.entries()){
    const saved=strokes[i],events=fixture(spec).map((s,j)=>{
      const e=pointer(j?"pointermove":"pointerdown",spec,s);return {...s,at:{x:e.clientX,y:e.clientY},pressure:e.pressure};
    }),first=events[0];
    const view=window.pacedInk.views[i];
    const world=at=>({x:(at.x-view.left-view.x)/view.zoom,y:(at.y-view.top-view.y)/view.zoom});
    const ref=new api.InkAccumulator(spec.device,world(first.at),{color:"#116677",baseWidth:6},first.pressure,undefined,{zoom:view.zoom});
    for(const s of events.slice(1))ref.append(world(s.at),s.pressure,s.timeStamp);
    const last=events.at(-1).at,end=spec.quick?{x:last.x+9,y:last.y+3}:last;
    const expected=ref.finish(world(end)),actual=api.inkPoints(saved),ideal=api.inkPoints(expected);
    const errors=actual.length===ideal.length?actual.map((p,j)=>Math.hypot(p.x-ideal[j].x,p.y-ideal[j].y)):undefined;
    const same=errors&&Math.max(...errors)<1e-6&&actual.every((p,j)=>p.radius===ideal[j].radius);
    const widths=actual.map(p=>2*p.radius);
    result.push({matchesAllSamples:Boolean(same),maxWorldError:errors?Math.max(...errors):null,expected:ideal.length,saved:actual.length,width:[Math.min(...widths),Math.max(...widths)]});
  }
  return result;
}
