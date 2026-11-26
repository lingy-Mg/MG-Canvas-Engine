import type {BoardDocument,Id} from "./document.ts";

type Index={owners:Map<Id,Id>;units:Map<Id,Id[]>};
const cache=new WeakMap<BoardDocument,Index>();
/** Explicit node references determine group ownership. Only links with both
 * endpoints inside the same group belong to its whole-group selection. */
function index(doc:BoardDocument):Index{
  let result=cache.get(doc);if(result)return result;
  const owners=new Map<Id,Id>(),units=new Map<Id,Id[]>();
  for(const [id,nodes] of Object.entries(doc.flowGroups!.members)){
    units.set(id,[]);
    for(const node of nodes)owners.set(node,id);
  }
  for(const id of doc.order){
    const item=doc.objects[id];
    if(item.kind==="connector"&&item.from.kind==="anchor"&&item.to.kind==="anchor"){
      const group=owners.get(item.from.objectId);
      if(group&&group===owners.get(item.to.objectId))owners.set(id,group);
    }
    const group=owners.get(id);if(group)units.get(group)!.push(id);
  }
  result={owners,units};cache.set(doc,result);return result;
}
export const flowGroupOf=(doc:BoardDocument,id?:Id)=>doc.flowGroups&&id?index(doc).owners.get(id):undefined;
export const groupUnit=(doc:BoardDocument,group:Id):readonly Id[]=>doc.flowGroups?index(doc).units.get(group)??[]:[];
export function expandGroupSelection(doc:BoardDocument,ids:readonly Id[],editing?:Id):readonly Id[]{
  if(!doc.flowGroups)return ids;
  const seen=new Set<Id>(),out=new Set<Id>();
  for(const id of ids){
    const group=flowGroupOf(doc,id);
    if(!group||group===editing)out.add(id);
    else if(!seen.has(group)){seen.add(group);for(const child of groupUnit(doc,group))out.add(child);}
  }
  return [...out];
}
export function groupableNodes(doc:BoardDocument,ids:readonly Id[]):Id[]|undefined{
  if(ids.length<2)return;
  const picked=new Set(ids),nodes:Id[]=[];
  for(const id of picked){
    const item=doc.objects[id];if(!item||flowGroupOf(doc,id))return;
    if(item.kind==="shape")nodes.push(id);
    else if(item.kind!=="connector"||item.from.kind!=="anchor"||item.to.kind!=="anchor"||
      !picked.has(item.from.objectId)||!picked.has(item.to.objectId))return;
  }
  return nodes.length>=2?nodes:undefined;
}
