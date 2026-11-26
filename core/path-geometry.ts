import type {CubicHandles,VectorPath} from "./document.ts";
import type {Point,Rect} from "./geometry.ts";

export type PathSegment=Readonly<{from:Point;to:Point;controls?:Readonly<{c1:Point;c2:Point}>}>;
const add=(a:Point,b:Point):Point=>({x:a.x+b.x,y:a.y+b.y});
const lerp=(a:Point,b:Point,t:number):Point=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
export function segmentBetween(from:Point,to:Point,handles?:CubicHandles):PathSegment{
  return handles?{from,to,controls:{c1:add(from,handles.out),c2:add(to,handles.in)}}:{from,to};
}
export function pathSegments(path:VectorPath):PathSegment[]{
  const vertices=path.vertices.map(p=>add(path.at,p));
  return Array.from({length:vertices.length-(path.closed?0:1)},(_,i)=>{
    return segmentBetween(vertices[i],vertices[(i+1)%vertices.length],path.curves?.[i]);
  });
}
export function segmentPoint(s:PathSegment,t:number):Point{
  if(!s.controls)return lerp(s.from,s.to,t);
  const {c1,c2}=s.controls,mid=lerp(c1,c2,t);
  return lerp(lerp(lerp(s.from,c1,t),mid,t),lerp(mid,lerp(c2,s.to,t),t),t);
}
/** de Casteljau subdivision. Both segments share the same point at the split. */
export function splitSegment(s:PathSegment,t:number):readonly [PathSegment,PathSegment]{
  const {from,to,controls}=s;
  if(!controls){
    const point=lerp(from,to,t);
    return [{from,to:point},{from:point,to}];
  }
  const a=lerp(from,controls.c1,t),b=lerp(controls.c1,controls.c2,t),c=lerp(controls.c2,to,t);
  const d=lerp(a,b,t),e=lerp(b,c,t),point=lerp(d,e,t);
  return [{from,to:point,controls:{c1:a,c2:d}},{from:point,to,controls:{c1:e,c2:c}}];
}
// The derivative is a quadratic in the three successive coordinate differences.
function extrema(s:PathSegment,axis:"x"|"y"):number[]{
  if(!s.controls)return [];
  const d0=s.controls.c1[axis]-s.from[axis],d1=s.controls.c2[axis]-s.controls.c1[axis],d2=s.to[axis]-s.controls.c2[axis];
  const scale=Math.max(Math.abs(d0),Math.abs(d1),Math.abs(d2));
  if(!scale)return [];
  const a=(d0-2*d1+d2)/scale,b=2*(d1-d0)/scale,c=d0/scale;
  const interior=(t:number)=>t>0&&t<1;
  if(Math.abs(a)<Number.EPSILON*8)return b?[-c/b].filter(interior):[];
  const disc=b*b-4*a*c;
  if(disc<0)return [];
  if(!disc)return [-b/(2*a)].filter(interior);
  const q=-.5*(b+(b>=0?1:-1)*Math.sqrt(disc));
  return [q/a,c/q].filter(interior).sort((x,y)=>x-y);
}
export function vectorBounds(segments:readonly PathSegment[]):Rect{
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  const include=(p:Point)=>{left=Math.min(left,p.x);top=Math.min(top,p.y);right=Math.max(right,p.x);bottom=Math.max(bottom,p.y);};
  for(const s of segments){
    include(s.from);include(s.to);
    for(const axis of ["x","y"] as const)for(const t of extrema(s,axis))include(segmentPoint(s,t));
  }
  return {min:{x:left,y:top},max:{x:right,y:bottom}};
}
export function insideVector(segments:readonly PathSegment[],p:Point):boolean{
  let inside=false;
  for(const s of segments){
    if(!s.controls){
      if((s.from.y>p.y)!==(s.to.y>p.y)&&p.x<s.from.x+(s.to.x-s.from.x)*(p.y-s.from.y)/(s.to.y-s.from.y))inside=!inside;
      continue;
    }
    // Split at vertical extrema. The half-open crossing rule counts shared vertices once.
    let start=0,a=s.from;
    for(const end of [...extrema(s,"y"),1]){
      const b=end===1?s.to:segmentPoint(s,end);
      if((a.y>p.y)!==(b.y>p.y)){
        let low=start,high=end;
        for(let i=0;i<50;i++){
          const mid=(low+high)/2;
          if((segmentPoint(s,mid).y>p.y)===(a.y>p.y))low=mid;else high=mid;
        }
        if(segmentPoint(s,(low+high)/2).x>p.x)inside=!inside;
      }
      start=end;a=b;
    }
  }
  return inside;
}
function chordParameter(p:Point,a:Point,b:Point):number{
  const x=b.x-a.x,y=b.y-a.y,den=x*x+y*y;
  return den?Math.max(0,Math.min(1,((p.x-a.x)*x+(p.y-a.y)*y)/den)):0;
}
function pointLine(p:Point,a:Point,b:Point):number{
  const t=chordParameter(p,a,b);
  return Math.hypot(p.x-a.x-t*(b.x-a.x),p.y-a.y-t*(b.y-a.y));
}
/** Append a polyline shared by connector paint, picking, and arrowheads. */
export function appendFlattenedSegment(points:Point[],segment:PathSegment,depth=0):void{
  const {from,to,controls}=segment;
  if(!controls||depth>=8||Math.max(pointLine(controls.c1,from,to),pointLine(controls.c2,from,to))<=.06){
    points.push(to);return;
  }
  const [left,right]=splitSegment(segment,.5);
  appendFlattenedSegment(points,left,depth+1);appendFlattenedSegment(points,right,depth+1);
}
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
/** Find a click position on the actual cubic. Collinear handles can give it nonuniform speed. */
export function nearestParameter(s:PathSegment,p:Point):number{
  if(!s.controls)return chordParameter(p,s.from,s.to);
  let best=distance(p,s.from),time=0;
  const consider=(t:number,point:Point)=>{
    const d=distance(p,point);
    if(d<best||d===best&&t<time){best=d;time=t;}
  };
  consider(1,s.to);
  const visit=(part:PathSegment,lo:number,hi:number,depth:number)=>{
    const {from,to,controls}=part;
    if(!controls||best===0)return;
    const u=chordParameter(p,from,to),chord=lerp(from,to,u);
    // An elevated linear Bézier has controls at thirds. Their largest displacement
    // bounds the error at the same parameter anywhere within this subinterval.
    const error=Math.max(distance(controls.c1,lerp(from,to,1/3)),distance(controls.c2,lerp(from,to,2/3)));
    if(distance(chord,p)>best+error)return;
    if(error<=.0001||depth>=36){consider(lo+(hi-lo)*u,segmentPoint(part,u));return;}
    const [left,right]=splitSegment(part,.5),mid=(lo+hi)/2;
    consider(mid,left.to);
    if(u<=.5){visit(left,lo,mid,depth+1);visit(right,mid,hi,depth+1);}
    else{visit(right,mid,hi,depth+1);visit(left,lo,mid,depth+1);}
  };
  visit(s,0,1,0);return time;
}
function pointRect(p:Point,r:Rect):number{
  return Math.hypot(Math.max(0,r.min.x-p.x,p.x-r.max.x),Math.max(0,r.min.y-p.y,p.y-r.max.y));
}
function chordDistance(a:Point,b:Point,r:Rect):number{
  if(r.min.x===r.max.x&&r.min.y===r.max.y)return pointLine(r.min,a,b);
  let lo=0,hi=1;
  for(const axis of ["x","y"] as const){
    const d=b[axis]-a[axis];
    if(!d){if(a[axis]<r.min[axis]||a[axis]>r.max[axis]){lo=2;break;}continue;}
    const one=(r.min[axis]-a[axis])/d,two=(r.max[axis]-a[axis])/d;
    lo=Math.max(lo,Math.min(one,two));hi=Math.min(hi,Math.max(one,two));
  }
  if(lo<=hi)return 0;
  return Math.min(pointRect(a,r),pointRect(b,r),pointLine(r.min,a,b),pointLine(r.max,a,b),
    pointLine({x:r.min.x,y:r.max.y},a,b),pointLine({x:r.max.x,y:r.min.y},a,b));
}
/** Compare against a finite chord, including collinear handles beyond either endpoint.
 * Prune disjoint hulls. Maximum flattening error is 0.0016 CSS px at zoom 16. */
export function segmentDistance(segment:PathSegment,region:Rect,limit:number):number{
  let best=Infinity;
  const visit=(s:PathSegment,depth:number)=>{
    if(best===0)return;
    const {from:a,to:b,controls}=s;
    if(!controls){const d=chordDistance(a,b,region);if(d<=limit)best=Math.min(best,d);return;}
    const {c1,c2}=controls,cutoff=Math.min(best,limit);
    const dx=Math.max(0,region.min.x-Math.max(a.x,b.x,c1.x,c2.x),Math.min(a.x,b.x,c1.x,c2.x)-region.max.x);
    const dy=Math.max(0,region.min.y-Math.max(a.y,b.y,c1.y,c2.y),Math.min(a.y,b.y,c1.y,c2.y)-region.max.y);
    if(Math.hypot(dx,dy)>cutoff)return;
    const flat=Math.max(pointLine(c1,a,b),pointLine(c2,a,b));
    const chord=chordDistance(a,b,region);
    if(chord-flat>cutoff)return;
    if(flat<=.0001||depth>=36){if(chord<=limit)best=Math.min(best,chord);return;}
    const [left,right]=splitSegment(s,.5);visit(left,depth+1);visit(right,depth+1);
  };
  visit(segment,0);return best;
}
export function closestSegment(segments:readonly PathSegment[],p:Point,radius:number,preferred?:number):number|undefined{
  const region={min:p,max:p};
  let best=preferred!==undefined&&segments[preferred]?segmentDistance(segments[preferred],region,radius):Infinity;
  let index=Number.isFinite(best)?preferred:undefined;
  segments.forEach((s,i)=>{
    if(i===preferred)return;
    const d=segmentDistance(s,region,Math.min(best,radius));
    if(d<best){best=d;index=i;}
  });
  return index;
}
