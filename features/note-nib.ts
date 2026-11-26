import type {InkPoint} from "./ink.ts";

const distance=(a:InkPoint,b:InkPoint)=>Math.hypot(b.x-a.x,b.y-a.y);
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
function ease(value:number):number {
  const t=Math.max(0,Math.min(1,value));
  return t*t*(3-2*t);
}

/** Round gentle changes of direction with a local quadratic. A right angle,
 * reversal, or the current contact point stays exactly where the writer put it. */
function roundJoins(raw:readonly InkPoint[],width:number):InkPoint[] {
  const line:InkPoint[]=[raw[0]];
  let a=raw[0];
  for(let i=1;i<raw.length-1;i++){
    const b=raw[i],c=raw[i+1],incoming=distance(a,b),outgoing=distance(b,c);
    if(!incoming)continue;
    if(!outgoing)continue;
    const ux=(b.x-a.x)/incoming,uy=(b.y-a.y)/incoming,vx=(c.x-b.x)/outgoing,vy=(c.y-b.y)/outgoing;
    const cosine=ux*vx+uy*vy;
    const trim=Math.min(incoming*.45,outgoing*.45,width*1.5)*ease((cosine-.27)/.35);
    const bend=trim*Math.sqrt(Math.max(0,(1-cosine)/2));
    if(bend>width*.025){
      const left={x:b.x-trim*ux,y:b.y-trim*uy,radius:mix(b.radius,a.radius,trim/incoming)};
      const right={x:b.x+trim*vx,y:b.y+trim*vy,radius:mix(b.radius,c.radius,trim/outgoing)};
      line.push(left);
      const steps=Math.min(5,Math.max(2,Math.ceil(Math.sqrt(bend/(width*.025)))));
      for(let j=1;j<steps;j++){
        const t=j/steps,s=1-t;
        line.push({x:s*s*left.x+2*s*t*b.x+t*t*right.x,y:s*s*left.y+2*s*t*b.y+t*t*right.y,
          radius:s*s*left.radius+2*s*t*b.radius+t*t*right.radius});
      }
      line.push(right);
    }else line.push(b);
    a=b;
  }
  line.push(raw[raw.length-1]);
  return line;
}

/** Reproduce the outline of saved version-3 strokes from their recorded
 * pressures. New input uses the ordinary pen or highlighter. */
export function noteNib(raw:readonly InkPoint[],width:number,endPressure:number):readonly InkPoint[] {
  if(raw.length<2)return raw;
  const line=roundJoins(raw,width);
  let length=0;
  const lengths=line.map((p,i)=>length+=i?distance(line[i-1],p):0);
  const strength=ease((length/width-.8)/1.6);
  if(!strength)return line;
  const flick=ease((.56-endPressure)/.115);
  const entry=Math.min(width*1.25,length*.18),exit=Math.min(width*(1.1+2.6*flick),length*.36);
  // Explicit cap sections keep even a long two-event flick from tapering
  // across its entire body. Interior centerline samples stay untouched.
  const cuts=[entry/3,2*entry/3,entry,length-exit,length-exit*2/3,length-exit/3];
  function shape(point:InkPoint,arc:number):InkPoint {
    const start=.30*(1-ease(arc/entry)),end=(.20+.65*flick)*(1-ease((length-arc)/exit));
    return {...point,radius:point.radius*(1-strength*Math.max(start,end))};
  }
  const result=[shape(line[0],0)];
  let cut=0;
  for(let i=1;i<line.length;i++){
    const a=line[i-1],b=line[i],begin=lengths[i-1],finish=lengths[i];
    while(cut<cuts.length&&cuts[cut]<=finish){
      const arc=cuts[cut++];
      if(arc<=begin||arc>=finish)continue;
      const t=(arc-begin)/(finish-begin);
      result.push(shape({x:mix(a.x,b.x,t),y:mix(a.y,b.y,t),radius:mix(a.radius,b.radius,t)},arc));
    }
    result.push(shape(b,finish));
  }
  return result;
}
