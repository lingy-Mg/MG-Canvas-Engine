import type { BoardDocument, BoardObject, Connector, Endpoint, Id, MindMap } from "../core/document.ts";
import type { Point } from "../core/geometry.ts";
import { gridPoint } from "../core/geometry.ts";
import type { Patch } from "../core/history.ts";

export type MovePlan = Readonly<{ movers: readonly BoardObject[]; connectors: readonly Connector[] }>;
export type MovePreview = Readonly<{ ids: readonly Id[]; objects: ReadonlyMap<Id, BoardObject> }>;
export type ObjectCopies = MovePreview & {groupPatch?:Extract<Patch,{op:"setFlowGroups"}>};
const shifted=(p:Point,d:Point):Point=>({x:p.x+d.x,y:p.y+d.y});

export function objectOrigin(object:BoardObject):Point|undefined {
  return object.kind==="connector"?undefined:object.kind==="mindmap"?object.origin:object.at;
}

/** An indexed caller supplies its incident and explicitly selected connectors.
 * Other callers use the same eligibility rules against the document. */
export function planMove(document:BoardDocument, selected: readonly Id[],related?:Iterable<Connector>,hidden?:ReadonlySet<Id>):MovePlan {
  const selectedIds = new Set(selected);
  const movers: BoardObject[]=[];
  const shapes=new Set<Id>();
  let selectedLine=false;
  for(const id of selectedIds){
    const object=document.objects[id];
    if(!object||hidden?.has(id))continue;
    if(object.kind==="connector"){selectedLine=true;continue;}
    if(object.kind==="shape")shapes.add(id);
    movers.push(object);
  }
  const connectors:Connector[]=[];
  if(!shapes.size&&!selectedLine)return {movers,connectors};
  for(const object of related??Object.values(document.objects)){
    if(object.kind!=="connector"||hidden?.has(object.id))continue;
    const anchored=[object.from,object.to].filter(e=>e.kind==="anchor");
    if(anchored.some(e=>!shapes.has(e.objectId)))continue; // cross-selection pins stay put
    if(anchored.length===2 || selectedIds.has(object.id))connectors.push(object);
  }
  return {movers,connectors};
}

export function moveObjects(plan:MovePlan, delta:Point):ReadonlyMap<Id,BoardObject>{
  const out=new Map<Id,BoardObject>();
  delta=gridPoint(delta);
  if(!Number.isFinite(delta.x)||!Number.isFinite(delta.y)||(!delta.x&&!delta.y))return out;
  for(const item of plan.movers){
    if(item.kind==="mindmap")out.set(item.id,{...item,origin:shifted(item.origin,delta)});
    else if(item.kind!=="connector")out.set(item.id,{...item,at:shifted(item.at,delta)});
  }
  const endpoint=(e:Endpoint):Endpoint=>e.kind==="free"?{...e,point:shifted(e.point,delta)}:e;
  for(const line of plan.connectors){
    if(line.from.kind!=="free"&&line.to.kind!=="free"&&!line.waypoints.length)continue;
    out.set(line.id,{...line,from:endpoint(line.from),to:endpoint(line.to),waypoints:line.waypoints.map(p=>shifted(p,delta))});
  }
  return out;
}

/** Position fields specify the root center in world coordinates. Keep all topic data shared. */
export function planMapOrigin(map:MindMap,x:number|undefined,y:number|undefined):ReadonlyMap<Id,BoardObject>|undefined{
  if(x===undefined||y===undefined||!Number.isFinite(x)||!Number.isFinite(y))return;
  const origin=gridPoint({x,y});
  return new Map(origin.x===map.origin.x&&origin.y===map.origin.y?[]:[[map.id,{...map,origin}]]);
}

export function movePatches(objects:ReadonlyMap<Id,BoardObject>): readonly Patch[]{
  return [...objects.values()].map(value=>({op:"putObject",value}));
}
