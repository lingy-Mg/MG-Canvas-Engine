import {flowGroupOf} from "../core/flow-groups.ts";
import type {BoardDocument,Id} from "../core/document.ts";
import type {ChangeSet} from "../core/history.ts";

/** Unlocked layers may reorder between locked ones. Adding or deleting other
 * layers may change an index without crossing a surviving layer. */
export function preservesLockedOrder(before:readonly Id[],after:readonly Id[],locks:ReadonlySet<Id>):boolean{
  if(!locks.size||before===after)return true;
  const bands=new Map<Id,Id|undefined>(),barriers:Id[]=[];
  let preceding:Id|undefined;
  for(const id of before){
    if(locks.has(id)){barriers.push(id);preceding=id;}
    else bands.set(id,preceding);
  }
  preceding=undefined;let index=0;
  for(const id of after){
    if(locks.has(id)){
      if(barriers[index++]!==id)return false;
      preceding=id;
    }else if(bands.has(id)&&bands.get(id)!==preceding)return false;
  }
  return index===barriers.length;
}
/** Check the completed proposal, including implicit group dissolution and
 * connector detachment. A bound endpoint may still follow its node on screen. */
export function preservesLayerLocks(before:BoardDocument,after:BoardDocument,change:ChangeSet,locks:ReadonlySet<Id>):boolean{
  if(!locks.size)return true;
  for(const ids of [change.updated,change.removed,change.added])if(ids.some(id=>locks.has(id)))return false;
  if(change.groupsChanged||change.assetsChanged.length){
    const assets=new Set(change.assetsChanged),checkedGroups=new Set<Id>();
    for(const id of locks){
      if(change.groupsChanged){
        const group=flowGroupOf(before,id);
        if(group!==flowGroupOf(after,id))return false;
        if(group&&!checkedGroups.has(group)){
          const old=before.flowGroups!.members[group],next=after.flowGroups!.members[group];
          if(old.length!==next.length||old.some((node,i)=>node!==next[i]))return false;
          checkedGroups.add(group);
        }
      }
      const item=before.objects[id];if(item?.kind==="image"&&assets.has(item.assetId))return false;
    }
  }
  return !change.orderChanged||preservesLockedOrder(before.order,after.order,locks);
}
