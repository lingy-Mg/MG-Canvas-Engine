import {portNormal,worldToLocal} from "../core/geometry.ts";
import type {Point,PortId} from "../core/geometry.ts";
import {insideVector,nearestParameter,segmentPoint} from "../core/path-geometry.ts";
import {resolveEndpoint} from "../core/document.ts";
import type {BoardDocument,Endpoint,Id,ShapeObject} from "../core/document.ts";
import {shapePorts} from "./flow.ts";
import type {Port} from "./flow.ts";

const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);

/** Negative inside the painted outline. The AABB used for spatial lookup is
 * deliberately not the final hit surface for a rotated, slanted or rounded node. */
function outlineDistance(shape:ShapeObject,q:Point):number{
  const w=shape.width,h=shape.height;
  if(shape.shape==="rect"){
    const r=Math.min(shape.cornerRadius,w/2,h/2);
    const x=Math.abs(q.x-w/2)-w/2+r,y=Math.abs(q.y-h/2)-h/2+r;
    return Math.hypot(Math.max(0,x),Math.max(0,y))+Math.min(Math.max(x,y),0)-r;
  }
  const points=shape.shape==="diamond"?[{x:w/2,y:0},{x:w,y:h/2},{x:w/2,y:h},{x:0,y:h/2}]:
    [{x:w/2,y:0},{x:w,y:h},{x:0,y:h}];
  const edges=points.map((from,i)=>({from,to:points[(i+1)%points.length]}));
  const gap=Math.min(...edges.map(edge=>distance(q,segmentPoint(edge,nearestParameter(edge,q)))));
  return insideVector(edges,q)?-gap:gap;
}

function facingSide(shape:ShapeObject,local:Point):PortId{
  const x=local.x/shape.width-.5,y=local.y/shape.height-.5;
  if(Math.abs(x)>Math.abs(y))return x>0?"east":"west";
  return y>0?"south":"north";
}

/** A deliberate port hit wins on the same surface. Near the outline use the
 * approached side; inside the node use the side facing the adjoining line. */
export function endpointTarget(doc:BoardDocument,ids:readonly Id[],point:Point,radius:number,portRadius:number,
  fixed:Endpoint,approach:Point,allowCoincident=false):Port|undefined{
  let best:Port|undefined,bestGap=Infinity,bestPortDistance=Infinity;
  const origin=resolveEndpoint(doc,fixed);
  const usable=(port:Port)=>allowCoincident||port.point.x!==origin?.x||port.point.y!==origin?.y;
  for(let i=ids.length-1;i>=0;i--){
    const item=doc.objects[ids[i]];
    if(item?.kind!=="shape")continue;
    const local=worldToLocal(point,item),signed=outlineDistance(item,local),gap=Math.max(0,signed);
    if(gap>radius||gap>bestGap)continue;
    const sameObject=fixed.kind==="anchor"&&fixed.objectId===item.id;
    const ports=shapePorts(item);
    let exact:Port|undefined,portDistance=Infinity;
    for(const port of ports){
      if(!usable(port))continue;
      const d=distance(point,port.point);
      if(d<=portRadius&&d<portDistance){exact=port;portDistance=d;}
    }
    // A source can form an intentional loop at a different explicit port.
    if(sameObject&&!exact)continue;
    if(gap===bestGap&&portDistance>=bestPortDistance)continue;
    const side=facingSide(item,signed< -portRadius?worldToLocal(approach,item):local);
    const candidate=exact??ports.find(p=>p.end.portId===side)!;
    if(!usable(candidate))continue;
    best=candidate;
    bestGap=gap;bestPortDistance=portDistance;
  }
  return best;
}

/** Offer the nearest reachable node in the outward cone of the pressed handle.
 * The receiving anchor must face back toward the origin. Z order breaks exact ties. */
export function directionalTarget(doc:BoardDocument,ids:readonly Id[],source:Port,radius:number):Port|undefined{
  const origin=doc.objects[source.end.objectId];if(origin?.kind!=="shape")return;
  const direction=portNormal(origin,source.end.portId);
  let best:Port|undefined,bestGap=Infinity,bestLength=Infinity;
  for(let i=ids.length-1;i>=0;i--){
    const item=doc.objects[ids[i]];
    if(item?.kind!=="shape"||item.id===origin.id)continue;
    const gap=outlineDistance(item,worldToLocal(source.point,item));
    if(gap<0||gap>radius||gap>bestGap)continue;
    for(const port of shapePorts(item)){
      const dx=port.point.x-source.point.x,dy=port.point.y-source.point.y;
      const forward=dx*direction.x+dy*direction.y,lateral=dx*direction.y-dy*direction.x;
      if(forward<=0||Math.abs(lateral)>forward+1e-8)continue;
      const facing=portNormal(item,port.end.portId),length=Math.hypot(dx,dy);
      if(facing.x*dx+facing.y*dy>=-1e-8||length>radius)continue;
      if(gap<bestGap||length<bestLength){
        best=port;bestGap=gap;bestLength=length;
      }
    }
  }
  return best;
}
