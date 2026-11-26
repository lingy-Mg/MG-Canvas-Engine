import type {Point} from "../../core/geometry.ts";

type XY=readonly [number,number];
type Leg=Readonly<{ms:number;end:XY;c1?:XY;c2?:XY}>;
type Trace=Readonly<{name:string;start:XY;legs:readonly Leg[]}>;
const line=(ms:number,end:XY):Leg=>({ms,end});
const curve=(ms:number,c1:XY,c2:XY,end:XY):Leg=>({ms,c1,c2,end});

// Timed contact paths, in CSS pixels. Both revisions and every sampling rate
// receive these same paths with a constant default pressure of 0.5.
export const handwriting:readonly Trace[]=[
  {name:"点",start:[38,25],legs:[curve(92,[39,26],[43,27],[48,35])]},
  {name:"横折",start:[9,23],legs:[line(94,[66,21]),line(110,[66,21]),curve(74,[65,26],[62,45],[57,65])]},
  {name:"撇",start:[68,12],legs:[curve(116,[67,18],[64,34],[54,46]),curve(42,[45,55],[32,64],[12,69])]},
  {name:"捺",start:[13,16],legs:[curve(125,[25,25],[42,50],[55,60]),curve(55,[61,65],[71,67],[86,67])]},
  {name:"快写连笔",start:[10,25],legs:[curve(58,[18,26],[41,19],[44,23]),curve(74,[42,32],[18,50],[13,53]),
    curve(51,[17,48],[43,31],[43,37]),curve(74,[42,43],[22,68],[29,68]),curve(66,[41,68],[61,43],[73,30]),
    curve(47,[78,26],[83,22],[80,27]),curve(60,[75,37],[53,65],[62,61]),curve(48,[72,56],[86,49],[98,47])]},
];

export function sampleTrace(trace:Trace,hz:number){
  const total=trace.legs.reduce((ms,leg)=>ms+leg.ms,0);
  const times=Array.from({length:Math.ceil(total*hz/1000)},(_,i)=>i*1000/hz);
  const points:{at:Point;pressure:number;timeStamp:number}[]=[];
  let i=0,begin=0,a=trace.start;
  for(const time of [...times,total]){
    while(i<trace.legs.length-1&&time>begin+trace.legs[i].ms){
      begin+=trace.legs[i].ms;a=trace.legs[i++].end;
    }
    const {ms,end,c1,c2}=trace.legs[i],t=(time-begin)/ms,s=1-t;
    const axis=(k:0|1)=>c1&&c2?s*s*s*a[k]+3*s*s*t*c1[k]+3*s*t*t*c2[k]+t*t*t*end[k]:s*a[k]+t*end[k];
    points.push({at:{x:axis(0),y:axis(1)},pressure:.5,timeStamp:time});
  }
  return points;
}
