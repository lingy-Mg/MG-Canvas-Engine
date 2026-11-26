import type {BoardDocument,ShapeObject} from "../../core/document.ts";
import {largeBoard} from "./large-board.ts";

/** Same 241-layer pagination seed as the frozen negative control, with two homonymous nodes. */
export function layerSearchBoard():BoardDocument{
  const doc=largeBoard(241).document;
  const shape=(id:string)=>({...doc.objects[id] as ShapeObject,label:"Review 东区"});
  return {...doc,objects:{...doc.objects,"s-10":shape("s-10"),"s-240":shape("s-240")}};
}
export function numberedLayers(count:number):BoardDocument{
  const doc=largeBoard(1).document,seed=doc.objects["s-0"] as ShapeObject;
  const order=Array.from({length:count},(_,i)=>"s-"+i);
  const objects=Object.fromEntries(order.map((id,i)=>[id,{...seed,id,label:"Batch "+String(i).padStart(5,"0"),
    at:{x:(i%100)*900,y:Math.floor(i/100)*900}}]));
  return {...doc,id:"layer-rows-"+count,order,objects};
}
