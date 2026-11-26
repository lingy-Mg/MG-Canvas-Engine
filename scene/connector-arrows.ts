import type {Connector} from "../core/document.ts";
import type {Point} from "../core/geometry.ts";

type Triangle=readonly [Point,Point,Point];
export type ConnectorArrows=Readonly<{shaft:readonly Point[];heads:readonly Triangle[]}>;

function arrowAt(points:readonly Point[],start:number,step:1|-1,length:number,width:number){
  const tip=points[start];
  let base=tip,next=start+step,remaining=length;
  let direction:Point|undefined;
  // Curves are sampled polylines. Walk their end samples but stop at a sharp bend.
  while(next>=0&&next<points.length&&remaining>0){
    const a=points[next-step],b=points[next],dx=b.x-a.x,dy=b.y-a.y;
    const distance=Math.hypot(dx,dy);
    if(distance===0){next+=step;continue;}
    if(direction&&dx*direction.x+dy*direction.y<distance*Math.SQRT1_2){
      // Keep the corner in the shaft so a short last leg stays perpendicular.
      next-=step;
      break;
    }
    direction??={x:dx/distance,y:dy/distance};
    if(remaining<=distance){
      base={x:a.x+dx*remaining/distance,y:a.y+dy*remaining/distance};
      break;
    }
    base=b;remaining-=distance;next+=step;
  }
  const depth=Math.hypot(tip.x-base.x,tip.y-base.y);
  if(!depth)return;
  const ux=(tip.x-base.x)/depth,uy=(tip.y-base.y)/depth;
  const halfWidth=Math.max(depth*.44,width*.8);
  const triangle:Triangle=[tip,{x:base.x-uy*halfWidth,y:base.y+ux*halfWidth},{x:base.x+uy*halfWidth,y:base.y-ux*halfWidth}];
  // Tuck the butt cap inside the fill so fractional zoom leaves no hairline at the join.
  const overlap=Math.min(width*.25,depth*.1);
  return {triangle,join:{x:base.x+ux*overlap,y:base.y+uy*overlap},next};
}

/** Keep the route and its bound ports intact while deriving the painted shaft and heads. */
export function connectorArrows(points:readonly Point[],width:number,arrow:Connector["arrow"]):ConnectorArrows|undefined{
  if(arrow==="none"||points.length<2)return;
  let total=0;
  for(let i=1;i<points.length;i++)total+=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);
  const available=total*(arrow==="both" ? .45 : .9);
  const length=Math.min(Math.max(9,4+2*width),available);
  const start=arrow!=="end"?arrowAt(points,0,1,length,width):undefined;
  const end=arrow!=="start"?arrowAt(points,points.length-1,-1,length,width):undefined;
  if(!start&&!end)return;
  const shaft=points.slice(start?.next??0,end?end.next+1:points.length);
  const heads:Triangle[]=[];
  if(start){shaft.unshift(start.join);heads.push(start.triangle);}
  if(end){shaft.push(end.join);heads.push(end.triangle);}
  return {shaft,heads};
}
