import {DEFAULT_SHAPE_STROKE,MAX_SHAPE_STROKE,isBox,isHexPaint,isPoint,resolveEndpoint,zeroLengthConnector} from "../core/document.ts";
import type {BoardDocument,BoardObject,Connector,Endpoint,Id,ShapeObject} from "../core/document.ts";
import {boxBounds,gridPoint,gridSize,portWorld} from "../core/geometry.ts";
import {incidentConnectorIds} from "../core/history.ts";
import {moveObjects} from "./transform.ts";

export type ShapeTransform=Readonly<{
  x:number;y:number;width?:number;height?:number;
  shapeStyle?:Readonly<{rotation:number;radius?:number;fill?:string;stroke?:string;strokeWidth:number}>;
}>;

/** An empty patch is a valid no-op; undefined means the entire edit is invalid. */
export function planShapeTransform(doc:BoardDocument,item:ShapeObject,values:ShapeTransform,hidden?:ReadonlySet<Id>):ReadonlyMap<Id,BoardObject>|undefined{
  if(doc.objects[item.id]!==item)return;
  const style=values.shapeStyle;
  const width=gridSize(values.width??item.width),height=gridSize(values.height??item.height);
  const at=gridPoint({x:values.x,y:values.y}),rotation=style?style.rotation:item.rotation;
  const cornerRadius=style?.radius??item.cornerRadius;
  const strokeWidth=style?style.strokeWidth:item.strokeWidth??DEFAULT_SHAPE_STROKE;
  if(!isBox({at,width,height,rotation})||!Number.isFinite(strokeWidth)||strokeWidth<0||strokeWidth>MAX_SHAPE_STROKE||
    (style?.radius!==undefined&&(item.shape!=="rect"||!Number.isFinite(cornerRadius)||cornerRadius<0))||
    (style?.fill!==undefined&&style.fill!=="transparent"&&!isHexPaint(style.fill))||(style?.stroke!==undefined&&!isHexPaint(style.stroke)))return;
  const fill=style?.fill??item.fill,stroke=style?.stroke??item.stroke;
  const position=at.x!==item.at.x||at.y!==item.at.y;
  const geometry=position||width!==item.width||height!==item.height||rotation!==item.rotation;
  const changed=new Map<Id,BoardObject>();
  if(!geometry&&fill===item.fill&&stroke===item.stroke&&cornerRadius===item.cornerRadius&&strokeWidth===(item.strokeWidth??DEFAULT_SHAPE_STROKE))return changed;
  const next:ShapeObject={...item,at,width,height,rotation,cornerRadius,fill,stroke,
    ...(item.strokeWidth===undefined&&strokeWidth===DEFAULT_SHAPE_STROKE?{}:{strokeWidth})};
  changed.set(item.id,next);
  if(!geometry)return changed;
  const bounds=boxBounds(next);
  if(!isPoint(bounds.min)||!isPoint(bounds.max))return;
  const endpoint=(end:Endpoint)=>end.kind==="anchor"&&end.objectId===item.id?portWorld(next,next.shape,end.portId):resolveEndpoint(doc,end);
  const loops:Connector[]=[];
  for(const id of incidentConnectorIds(doc,item.id)){
    const line=doc.objects[id];
    if(line.kind!=="connector")return;
    const from=endpoint(line.from),to=endpoint(line.to);
    if(!isPoint(from)||!isPoint(to))return;
    const movingLoop=position&&!hidden?.has(id)&&line.from.kind==="anchor"&&line.from.objectId===item.id&&line.to.kind==="anchor"&&line.to.objectId===item.id&&line.waypoints.length>0;
    if(movingLoop)loops.push(line);
    else if(zeroLengthConnector(from,to,line.routing,line.waypoints))return;
  }
  // Translating both ends of a self-loop retains the existing whole-move waypoint rule.
  const delta={x:at.x-item.at.x,y:at.y-item.at.y};
  if(loops.length&&!isPoint(delta))return;
  if(loops.length)for(const [id,moved] of moveObjects({movers:[],connectors:loops},delta)){
    if(moved.kind!=="connector"||!moved.waypoints.every(isPoint))return;
    const from=endpoint(moved.from),to=endpoint(moved.to);
    if(!from||!to||zeroLengthConnector(from,to,moved.routing,moved.waypoints))return;
    changed.set(id,moved);
  }
  return changed;
}
