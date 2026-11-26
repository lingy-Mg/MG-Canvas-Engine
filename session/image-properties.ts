import {isBox,isPoint} from "../core/document.ts";
import type {BoardDocument,BoardObject,Id,ImageAsset,ImageObject} from "../core/document.ts";
import {boxBounds,gridPoint,gridSize} from "../core/geometry.ts";

export type ImageTransform=Readonly<{
  x:number;y:number;width?:number;height?:number;imageRotation?:number;
  lockRatio?:boolean;imageNaturalRatio?:boolean;ratioDriver?:"width"|"height";
}>;

/** Derive the other side from the committed geometry or the original bitmap. */
export function imageCompanion(item:ImageObject,asset:ImageAsset,driver:"width"|"height",value:number,natural:boolean):number{
  if(!natural&&value===item[driver])return driver==="width"?item.height:item.width;
  const ratio=natural?asset.pixelWidth/asset.pixelHeight:item.width/item.height;
  return gridSize(driver==="width"?gridSize(value)/ratio:gridSize(value)*ratio);
}

export function planImageTransform(doc:BoardDocument,item:ImageObject,values:ImageTransform):ReadonlyMap<Id,BoardObject>|undefined{
  if(doc.objects[item.id]!==item)return;
  const asset=doc.assets[item.assetId],at=gridPoint({x:values.x,y:values.y});
  let width=gridSize(values.width??item.width),height=gridSize(values.height??item.height);
  const rotation=values.imageRotation??item.rotation,lock=values.lockRatio??(item.lockAspect!==false);
  if(!asset||!isBox({at,width,height,rotation}))return;
  const natural=values.imageNaturalRatio===true;
  if(natural||lock&&(width!==item.width||height!==item.height)){
    const driver=values.ratioDriver??(!natural&&width===item.width?"height":"width");
    if(driver==="height")width=imageCompanion(item,asset,driver,height,natural);
    else height=imageCompanion(item,asset,driver,width,natural);
  }
  const next={...item,at,width,height,rotation};
  if(!isBox(next))return;
  const bounds=boxBounds(next);
  if(!isPoint(bounds.min)||!isPoint(bounds.max))return;
  if(lock)delete next.lockAspect;
  else next.lockAspect=false;
  const changed=new Map<Id,BoardObject>();
  if(at.x!==item.at.x||at.y!==item.at.y||width!==item.width||height!==item.height||rotation!==item.rotation||next.lockAspect!==item.lockAspect)
    changed.set(item.id,next);
  return changed;
}
