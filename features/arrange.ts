import {flowGroupOf} from "../core/flow-groups.ts";
import { objectById } from "../core/document.ts";
import type { BoardDocument, BoardObject, Id } from "../core/document.ts";
import type { Point, Rect } from "../core/geometry.ts";
import { roundWorld } from "../core/geometry.ts";
import { alignmentBounds,buildScene,mergeBounds } from "../scene/board.ts";
import type { EditorSession } from "../session/editor.ts";
import { moveObjects, movePatches } from "../session/transform.ts";

type LayerCommand="front"|"back"|"forward"|"backward";
type AlignCommand="left"|"center"|"right"|"top"|"middle"|"bottom";
type DistributeCommand="distribute-x"|"distribute-y";
export type ArrangeCommand=LayerCommand|AlignCommand|DistributeCommand;

const label:Record<ArrangeCommand,string>={
  front:"置于顶层",back:"置于底层",forward:"上移一层",backward:"下移一层",
  left:"左对齐",center:"水平居中",right:"右对齐",top:"上对齐",middle:"垂直居中",bottom:"下对齐",
  "distribute-x":"水平等距","distribute-y":"垂直等距",
};
export const arrangeCommands=Object.keys(label) as ArrangeCommand[];
export const isArrangeCommand=(value:unknown):value is ArrangeCommand=>typeof value==="string"&&Object.hasOwn(label,value);
const layer=(command:ArrangeCommand):command is LayerCommand=>
  command==="front"||command==="back"||command==="forward"||command==="backward";
const distribute=(command:ArrangeCommand):command is DistributeCommand=>
  command==="distribute-x"||command==="distribute-y";

export function arrangeLayerOrder(order:readonly Id[],selected:readonly Id[],command:LayerCommand):readonly Id[]{
  const ids=new Set(selected);
  if(command==="front"||command==="back"){
    const moved=order.filter(id=>ids.has(id)),rest=order.filter(id=>!ids.has(id));
    return command==="front"?[...rest,...moved]:[...moved,...rest];
  }
  const next=[...order];
  // Same-direction selected neighbors rise/fall together without swapping
  // with one another; sweep opposite the direction of motion.
  if(command==="forward"){
    for(let i=next.length-2;i>=0;i--)if(ids.has(next[i])&&!ids.has(next[i+1]))
      [next[i],next[i+1]]=[next[i+1],next[i]];
  }else{
    for(let i=1;i<next.length;i++)if(ids.has(next[i])&&!ids.has(next[i-1]))
      [next[i-1],next[i]]=[next[i],next[i-1]];
  }
  return next;
}
function selectedMovers(doc:BoardDocument,selected:readonly Id[]):BoardObject[]{
  return [...new Set(selected)].flatMap(id=>{
    const item=objectById(doc,id);
    return item&&(item.kind!=="connector"||(item.from.kind==="free"&&item.to.kind==="free"))?[item]:[];
  });
}
type Measure={item:BoardObject;bounds:Rect;rank:number};
function measures(doc:BoardDocument,items:readonly BoardObject[]):Measure[]{
  const indexed=new Map(items.map(item=>[item.id,item]));
  const ranks=new Map(doc.order.map((id,index)=>[id,index]));
  return buildScene(doc,undefined,items.map(item=>item.id)).flatMap(group=>{
    const item=indexed.get(group.id);
    if(!item)return [];
    return [{item,bounds:alignmentBounds(item,group.bounds),rank:ranks.get(item.id)??0}];
  });
}
type Axis="x"|"y";
type Delta=ReadonlyMap<Id,Point>;
const epsilon=1e-9;
const at=(axis:Axis,n:number):Point=>axis==="x"?{x:roundWorld(n),y:0}:{x:0,y:roundWorld(n)};
function alignDelta(items:readonly Measure[],command:AlignCommand):Delta{
  const axis=command==="left"||command==="center"||command==="right"?"x":"y";
  const edge=command==="left"||command==="top"?"min":command==="right"||command==="bottom"?"max":"middle";
  const min=items.reduce((best,i)=>Math.min(best,i.bounds.min[axis]),Infinity);
  const max=items.reduce((best,i)=>Math.max(best,i.bounds.max[axis]),-Infinity);
  const target=edge==="min"?min:edge==="max"?max:(min+max)/2;
  return new Map(items.map(({item,bounds})=>[
    item.id,at(axis,target-(edge==="middle"?(bounds.min[axis]+bounds.max[axis])/2:bounds[edge][axis])),
  ]));
}
function distributeDelta(items:readonly Measure[],axis:Axis):Delta{
  const sorted=[...items].sort((a,b)=>a.bounds.min[axis]-b.bounds.min[axis]||a.rank-b.rank);
  const first=sorted[0].bounds,last=sorted.at(-1)!.bounds;
  const lengths=sorted.map(({bounds})=>bounds.max[axis]-bounds.min[axis]);
  const gap=(last.max[axis]-first.min[axis]-lengths.reduce((a,b)=>a+b,0))/(sorted.length-1);
  // A signed gap can preserve a modest overlap. If equal gaps would
  // actually reverse the spatial order, leave the arrangement untouched.
  if(lengths.slice(0,-1).some(length=>length+gap< -epsilon))return new Map();
  let cursor=first.max[axis]+gap;
  const deltas=new Map<Id,Point>();
  for(let i=1;i<sorted.length-1;i++){
    const {item,bounds}=sorted[i];
    deltas.set(item.id,at(axis,cursor-bounds.min[axis]));
    cursor+=lengths[i]+gap;
  }
  return deltas;
}
const unchanged={x:0,y:0};
const moving=(delta:Point)=>Math.abs(delta.x)>epsilon||Math.abs(delta.y)>epsilon;
function movedObjects(doc:BoardDocument,items:readonly Measure[],deltas:Delta,hidden:ReadonlySet<Id>):ReadonlyMap<Id,BoardObject>{
  const moved=new Map<Id,BoardObject>();
  for(const {item} of items){
    const delta=deltas.get(item.id);
    if(!delta||!moving(delta))continue;
    for(const [id,result] of moveObjects(item.kind==="connector"?{movers:[],connectors:[item]}:{movers:[item],connectors:[]},delta))moved.set(id,result);
  }
  // Bound connector positions are always projected from their anchors.
  // Explicit bends translate only when both anchors moved together.
  for(const id of doc.order){
    const line=doc.objects[id];
    if(hidden.has(id)||line.kind!=="connector"||!line.waypoints.length||line.from.kind!=="anchor"||line.to.kind!=="anchor")continue;
    const from=deltas.get(line.from.objectId)??unchanged,to=deltas.get(line.to.objectId)??unchanged;
    if(moving(from)&&Math.abs(from.x-to.x)<=epsilon&&Math.abs(from.y-to.y)<=epsilon)
      for(const [id,result] of moveObjects({movers:[],connectors:[line]},from))moved.set(id,result);
  }
  return moved;
}
type ArrangeSelection=Pick<EditorSession,"doc"|"editingGroup"|"selectedIds"|"selectionLocked"|"busy"|"hiddenIds"|"permitsOrder">;
type Inactive={kind:"refused";message:string}|{kind:"unchanged"};
type OrderPlan={kind:"order";order:readonly Id[]};
type ArrangePlan=Inactive|OrderPlan|{kind:"move";objects:ReadonlyMap<Id,BoardObject>};
function arrangeUnit(editor:ArrangeSelection,id:Id):Id{
  const group=flowGroupOf(editor.doc,id);return group&&group!==editor.editingGroup?group:id;
}
function candidates(editor:ArrangeSelection,command:ArrangeCommand):Inactive|OrderPlan|{kind:"geometry";command:AlignCommand|DistributeCommand;movers:BoardObject[]}{
  if(editor.busy||!editor.selectedIds.length||editor.selectionLocked)
    return {kind:"refused",message:"The selection is empty, locked or busy"};
  if(layer(command)){
    const order=arrangeLayerOrder(editor.doc.order,editor.selectedIds,command);
    if(order.every((id,index)=>id===editor.doc.order[index]))return {kind:"unchanged"};
    return editor.permitsOrder(order)?{kind:"order",order}:{kind:"refused",message:"Cannot cross a locked or hidden layer"};
  }
  const movers=selectedMovers(editor.doc,editor.selectedIds);
  const count=editor.doc.flowGroups?new Set(movers.map(item=>arrangeUnit(editor,item.id))).size:movers.length;
  if(count<(distribute(command)?3:2))return {kind:"refused",message:"Alignment needs two movable units; distribution needs three"};
  return {kind:"geometry",command,movers};
}
export function canArrange(editor:EditorSession,command:ArrangeCommand):boolean{
  const {kind}=candidates(editor,command);
  return kind==="order"||kind==="geometry";
}
export function planArrange(editor:ArrangeSelection,action:ArrangeCommand):ArrangePlan{
  const chosen=candidates(editor,action);
  if(chosen.kind!=="geometry")return chosen;
  const {command,movers}=chosen,doc=editor.doc;
  const items=measures(doc,movers),units=new Map<Id,Measure>();
  for(const entry of items){
    const id=arrangeUnit(editor,entry.item.id),previous=units.get(id);
    units.set(id,previous?{...previous,bounds:mergeBounds(previous.bounds,entry.bounds)}:entry);
  }
  const boxes=[...units.values()];
  if(boxes.length<(distribute(command)?3:2))return {kind:"refused",message:"Too few measurable units"};
  const offsets=distribute(command)?distributeDelta(boxes,command==="distribute-x"?"x":"y"):alignDelta(boxes,command);
  const deltas=new Map<Id,Point>();
  for(const {item} of items){
    const representative=units.get(arrangeUnit(editor,item.id))!.item.id,delta=offsets.get(representative);
    if(delta)deltas.set(item.id,delta);
  }
  const objects=movedObjects(doc,items,deltas,editor.hiddenIds);
  return objects.size?{kind:"move",objects}:{kind:"unchanged"};
}
export function arrangeSelection(editor:EditorSession,command:ArrangeCommand):boolean{
  const plan=planArrange(editor,command);
  if(plan.kind==="order")return editor.commitEdit({label:label[command],patches:[{op:"setOrder",ids:plan.order}]},editor.generation);
  return plan.kind==="move"&&editor.commitEdit({label:label[command],patches:movePatches(plan.objects)},editor.generation);
}
