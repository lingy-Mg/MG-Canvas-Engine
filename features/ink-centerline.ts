import type { InkSample } from "./ink.ts";
import type { Rect } from "../core/geometry.ts";

type Knot={x:number;y:number;s:number;corner:boolean};
const MAX_SIDE_KNOTS=16;

// Estimate the common device step in CSS pixels. Fractional display scaling
// can produce, for example, 2/3 or 4/5 CSS pixel per physical pixel. Allow
// float32 event-coordinate noise; below 1/16 CSS pixel use the fine path.
function commonStep(known:number|undefined,delta:number):number|undefined {
  if(delta<1e-5||known===0)return known;
  if(known===undefined)return delta>=1/16?delta:0;
  let a=Math.max(known,delta),b=Math.min(known,delta);
  while(b>=1/16-1e-5){
    const count=Math.round(a/b),remainder=Math.abs(a-count*b);
    if(remainder<=Math.min(.01*b,.0002*(1+count)))return b;
    a=b;b=remainder;
  }
  return 0;
}

// Measure direction over a physical span rather than a pair of grid steps.
function along(raw:Knot[],i:number,end:number,delta:number):{x:number;y:number} {
  const start=raw[i],target=start.s+delta,step=end<i?-1:1;
  while(i!==end){
    const a=raw[i],b=raw[i+step];
    if((b.s-target)*step>=0){
      const f=(target-a.s)/(b.s-a.s);
      return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f};
    }
    i+=step;
  }
  return raw[end];
}

// Integrate the local quadratic regression kernel over each raw line segment.
// Continuous integration avoids aliasing a repeated one-pixel staircase and
// gives a long segment the same weight as the equivalent coalesced samples.
function settle(raw:Knot[],i:number,lo:number,hi:number,r:number,limit:number,gain:number):[number,number] {
  const p=raw[i];
  let mx=0,my=0,qx=0,qy=0;
  for(let j=lo;j<hi;j++){
    const a=raw[j],b=raw[j+1];
    const start=(a.s-p.s)/r,end=(b.s-p.s)/r;
    const u=Math.max(-1,start),v=Math.min(1,end);
    if(v<=u)continue;
    const mid=(u+v)/2,half=(v-u)/2,f=(mid-start)/(end-start);
    const sx=b.x-a.x,sy=b.y-a.y;
    const x=(a.x-p.x)+sx*f,y=(a.y-p.y)+sy*f;
    mx+=half*x;my+=half*y;
    const weight=half*(9-15*mid*mid-5*half*half)/4;
    const slopeWeight=-2.5*mid*half**3/(end-start);
    qx+=weight*x+slopeWeight*sx;qy+=weight*y+slopeWeight*sy;
  }
  // Use the line fit in a subpixel corridor. Where the two fits separate,
  // keep the quadratic term so an intentional curve retains its curvature.
  const curvature=Math.hypot(qx-mx,qy-my);
  const bend=curvature/(curvature+.2*Math.hypot(qx,qy)+1e-12);
  const dx=mx+(qx-mx)*bend,dy=my+(qy-my)*bend;
  const scale=gain*Math.min(1,limit/(Math.hypot(dx,dy)||1));
  return [p.x+dx*scale,p.y+dy*scale];
}

/** Fits the interior of a small moving window. Its first contact and live tip
 * always stay at the measured coordinates. Only the resulting world-space
 * positions enter the document, so replay never depends on a camera or filter. */
export class InkCenterline {
  private readonly raw:Knot[]=[];
  private readonly zoom:number;
  private readonly bounds:Rect;
  private spacing?:number;
  constructor(zoom:number,bounds:Rect){this.zoom=zoom;this.bounds=bounds;}

  append(points:InkSample[],readings:number[]|undefined,mayCompact:boolean):void {
    const raw=this.raw,last=raw.at(-1),[x,y]=points[points.length-1];
    if(last&&x===last.x&&y===last.y){
      // Pressure can change while stationary. Keep all readings at the
      // physical contact and use it as the start of the next moving span.
      raw.length=0;
    }else if(last){
      // A canvas offset can be fractional even on an integer-pixel mouse.
      // Use input deltas to bound correction to the precision actually seen.
      this.spacing=commonStep(this.spacing,Math.abs(x-last.x)*this.zoom);
      this.spacing=commonStep(this.spacing,Math.abs(y-last.y)*this.zoom);
    }
    const distance=last?Math.hypot(x-last.x,y-last.y):0;
    raw.push({x,y,s:(last?.s??0)+distance,corner:false});
    if(raw.length>2*MAX_SIDE_KNOTS+1)raw.shift();
    const offset=points.length-raw.length;
    // A whole CSS pixel at minimum zoom spans twenty world units. Fractional
    // devices need much less room than an integer staircase at that zoom.
    const grid=Math.min(1,this.spacing??1);
    const reach=Math.max(9*grid/this.zoom,Math.min(9,9/this.zoom));
    const limit=Math.max(.8*grid/this.zoom,Math.min(.95,.95/this.zoom));
    const end=raw.length-1;
    let first=Math.max(1,end-1);
    // A long fast move can supply the missing right-hand support to several
    // points behind the *previous* tip in one event.
    while(first>1&&end-first<MAX_SIDE_KNOTS&&(end-first<3||raw[end-1].s-raw[first-1].s<2*reach))first--;
    for(let i=first;i<end;i++){
      const p=raw[i],d=Math.min(reach*.55,p.s-raw[0].s,raw[end].s-p.s);
      const a=along(raw,i,0,-d),b=along(raw,i,end,d);
      const ax=p.x-a.x,ay=p.y-a.y,bx=b.x-p.x,by=b.y-p.y;
      p.corner=ax*bx+ay*by<=.55*Math.hypot(ax,ay)*Math.hypot(bx,by);
      const prev=raw[i-1],next=raw[i+1],l=p.s-prev.s,h=next.s-p.s;
      if(Math.min(l,h)>Math.max(1.5*grid/this.zoom,.5*limit)&&
        (p.x-prev.x)*(next.x-p.x)+(p.y-prev.y)*(next.y-p.y)<.15*l*h)p.corner=true;
    }
    for(let i=first;i<end;i++){
      const p=raw[i];
      // On a fast integer-pixel device, include nearby independent readings
      // even if the spacing is longer. Keep the same subpixel correction cap.
      const gap=Math.min(p.s-raw[i-1].s,raw[i+1].s-p.s);
      const support=grid?Math.max(reach,Math.min(4*reach,3*gap)):reach;
      let lo=i-1,hi=i+1;
      while(lo>0&&!raw[lo].corner&&p.s-raw[lo].s<support)lo--;
      while(hi<end&&!raw[hi].corner&&raw[hi].s-p.s<support)hi++;
      const r=Math.min(support,p.s-raw[lo].s,raw[hi].s-p.s);
      // Two long chords alone supply no independent evidence of jitter.
      const gain=Math.min(1,2-(raw[i+1].s-raw[i-1].s)/support);
      const [fitX,fitY]=!p.corner&&r>0&&gain>0?settle(raw,i,lo,hi,r,limit,gain):[p.x,p.y];
      const nx=Math.max(this.bounds.min.x,Math.min(this.bounds.max.x,fitX));
      const ny=Math.max(this.bounds.min.y,Math.min(this.bounds.max.y,fitY));
      const j=offset+i,was=points[j];
      if(was[0]!==nx||was[1]!==ny)points[j]=Object.freeze([nx,ny,was[2]]);
    }
    // Compact only settled samples, using a world-space accuracy ceiling.
    // Never throw away a staircase's evidence before fitting its centerline.
    const j=offset-1;
    if(mayCompact&&j>0){
      const a=points[j-1],p=points[j],b=points[j+1];
      const ax=p[0]-a[0],ay=p[1]-a[1],bx=b[0]-p[0],by=b[1]-p[1];
      const len=Math.hypot(ax+bx,ay+by);
      const cross=Math.abs(ax*by-ay*bx);
      if(a[2]===p[2]&&p[2]===b[2]&&(!readings||readings[j-1]===readings[j]&&readings[j]===readings[j+1])&&
        ax*bx+ay*by>0&&(cross===0||len<=Math.min(6,3.6/this.zoom)&&cross<=Math.min(.008,.016/this.zoom)*len)){
        points.splice(j,1);readings?.splice(j,1);
      }
    }
  }
}
