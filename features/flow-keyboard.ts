import { boxBounds,portWorld,worldToLocal } from "../core/geometry.ts";
import type { Point,PortId,Rect } from "../core/geometry.ts";
import type { BoardDocument, Id, ShapeObject } from "../core/document.ts";
import type { EditorSession } from "../session/editor.ts";
import { commitConnectedNode, planConnectedNode, shapePreset } from "./flow.ts";

type Occupied=(area:Rect)=>boolean;

/** Prefer aligned left-to-right flow; step around nearby occupied objects without moving them. */
export function downstreamCenter(source:ShapeObject,size:{width:number;height:number},occupied:Occupied):Point|undefined {
  const a=boxBounds(source);
  return searchSide({x:a.max.x,y:(a.min.y+a.max.y)/2},{x:1,y:0},size,occupied);
}
function searchSide(port:Point,direction:Point,{width,height}:{width:number;height:number},occupied:Occupied):Point|undefined{
  const inset=10,across=Math.abs(direction.y)*width+Math.abs(direction.x)*height;
  const along=Math.abs(direction.x)*width+Math.abs(direction.y)*height;
  for(let ring=0;ring<=12;ring++){
    for(let column=0;column<=ring;column++){
      const row=ring-column;
      for(const sign of row?[1,-1]:[0]){
        const forward=62+along/2+column*(along+48),side=sign*row*(across+26);
        const center={x:port.x+direction.x*forward-direction.y*side,y:port.y+direction.y*forward+direction.x*side};
        const rect={min:{x:center.x-width/2-inset,y:center.y-height/2-inset},
          max:{x:center.x+width/2+inset,y:center.y+height/2+inset}};
        if(!occupied(rect))return center;
      }
    }
  }
}

export function addDownstream(editor:EditorSession,source:ShapeObject,occupied:Occupied,aim?:Point){
  if(editor.isLocked(source.id))return;
  const plan=planDownstream(editor.doc,source,occupied,undefined,undefined,aim);
  if(plan)return commitConnectedNode(editor,plan);
}
export function planDownstream(doc:BoardDocument,source:ShapeObject,occupied:Occupied,nodeId?:Id,connectorId?:Id,aim?:Point){
  if(source.content)return;
  const size=shapePreset("process",{x:0,y:0},"size");
  const relative=aim&&worldToLocal(aim,source),x=relative?relative.x-source.width/2:0,y=relative?relative.y-source.height/2:0;
  const directed=Math.hypot(x,y)>1e-6,decision=source.shape==="diamond";
  if(directed||decision){
    const outgoing=new Set<PortId>(),branches=new Map<string,PortId>();
    for(const line of Object.values(doc.objects)){
      if(line.kind!=="connector")continue;
      const end=line.arrow==="start"?line.to:line.from;
      if(end.kind!=="anchor"||end.objectId!==source.id)continue;
      outgoing.add(end.portId);
      if(decision){
        const name=line.label.trim().toLowerCase();
        if(["yes","是"].includes(name))branches.set("Yes",end.portId);
        if(["no","否"].includes(name))branches.set("No",end.portId);
      }
    }
    if(branches.size===2)return;
    const label=decision?(branches.has("Yes")?"No":"Yes"):"",other=branches.get(label==="Yes"?"No":"Yes");
    const opposite:Record<PortId,PortId>={east:"west",west:"east",north:"south",south:"north"};
    const scores:Record<PortId,number>={east:x,west:-x,north:-y,south:y};
    const sides=(Object.keys(scores) as PortId[]).sort((a,b)=>scores[b]-scores[a]);
    const preferred=directed?sides.find(side=>!outgoing.has(side))??sides[0]:outgoing.has("east")&&!outgoing.has("west")?"west":"east";
    const portId=other?opposite[other]:preferred;
    const port=portWorld(source,source.shape,portId);
    const dx=port.x-source.at.x-source.width/2,dy=port.y-source.at.y-source.height/2,d=Math.hypot(dx,dy);
    const center=searchSide(port,{x:dx/d,y:dy/d},size,occupied);
    const plan=center&&planConnectedNode(doc,{kind:"anchor",objectId:source.id,portId},center,"process",nodeId,connectorId);
    if(plan)return {...plan,line:{...plan.line,label,autoPorts:decision?"to" as const:"both" as const}};
    return;
  }
  // Use the same process geometry for obstacle search and for the committed node.
  const center=downstreamCenter(source,size,occupied);
  const plan=center&&planConnectedNode(doc,{kind:"anchor",objectId:source.id,portId:"east"},center,"process",nodeId,connectorId);
  if(plan)return {...plan,line:{...plan.line,autoPorts:"both" as const}};
}
