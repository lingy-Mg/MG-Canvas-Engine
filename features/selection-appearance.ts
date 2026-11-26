import { DEFAULT_CONNECTOR_STROKE, DEFAULT_SHAPE_STROKE, MAX_CONNECTOR_STROKE, MAX_PATH_STROKE, MAX_SHAPE_STROKE, isHexPaint, isPoint } from "../core/document.ts";
import type { BoardDocument, BoardObject, Id } from "../core/document.ts";
import {automaticTextColor} from "../core/text-style.ts";
import type { Point } from "../core/geometry.ts";
import { MIN_INK_WIDTH, MAX_INK_WIDTH, validInkGeometry } from "./ink.ts";
import type { EditorSession } from "../session/editor.ts";
import { moveObjects, movePatches, planMove } from "../session/transform.ts";
import type { MovePlan } from "../session/transform.ts";

type PaintValue = string | number;
type StorageKey = "stroke" | "strokeWidth" | "baseWidth" | "color" | "fill" | "cornerRadius";
type Member = {key:StorageKey; value:PaintValue; min?:number; max?:number};
const captions = {lineColor:"线条颜色", lineWidth:"线条粗细", fill:"填充颜色", radius:"圆角", textColor:"文字颜色"} as const;
export type AppearanceKey = keyof typeof captions;
export type AppearanceField = Readonly<{key:AppearanceKey; label:string; numeric:boolean; value?:PaintValue; min?:number; max?:number}>;
type Edits = ReadonlyMap<AppearanceKey, PaintValue>;

function member(item:BoardObject, field:AppearanceKey):Member|undefined {
  switch(field){
    case "lineColor":
      if(item.kind==="shape"||item.kind==="connector"||item.kind==="path")return {key:"stroke",value:item.stroke};
      if(item.kind==="ink")return {key:"color",value:item.color};
      break;
    case "lineWidth":
      if(item.kind==="shape")return {key:"strokeWidth",value:item.strokeWidth??DEFAULT_SHAPE_STROKE,min:0,max:MAX_SHAPE_STROKE};
      if(item.kind==="connector")return {key:"strokeWidth",value:item.strokeWidth??DEFAULT_CONNECTOR_STROKE,min:.25,max:MAX_CONNECTOR_STROKE};
      if(item.kind==="path")return {key:"strokeWidth",value:item.strokeWidth,min:.25,max:MAX_PATH_STROKE};
      if(item.kind==="ink")return {key:"baseWidth",value:item.baseWidth,min:MIN_INK_WIDTH,max:MAX_INK_WIDTH};
      break;
    case "fill": if(item.kind==="shape"||item.kind==="path"&&item.closed&&item.fill)return {key:"fill",value:item.fill}; break;
    case "radius": if(item.kind==="shape"&&item.shape==="rect")return {key:"cornerRadius",value:item.cornerRadius,min:0}; break;
    case "textColor": if(item.kind==="text")return {key:"color",value:item.color}; break;
  }
}

function comparable(value:PaintValue):PaintValue{
  if(typeof value!=="string")return value;
  if(/^#[0-9a-f]{3}$/i.test(value))return "#"+Array.from(value.slice(1),digit=>digit.toLowerCase().repeat(2)).join("");
  return isHexPaint(value)?value.toLowerCase():value;
}

function validTranslation(item:BoardObject):boolean{
  if(item.kind==="connector")return (item.from.kind==="anchor"||isPoint(item.from.point))&&
    (item.to.kind==="anchor"||isPoint(item.to.point))&&item.waypoints.every(isPoint);
  if(item.kind==="ink")return validInkGeometry(item);
  return isPoint(item.kind==="mindmap"?item.origin:item.at);
}

export class SelectionProperties {
  readonly fields:AppearanceField[]=[];
  private readonly movePlan?:MovePlan;
  private readonly editor:EditorSession;
  private readonly history:EditorSession["history"];
  private readonly generation:symbol;
  private readonly locks:number;
  private readonly visibility:number;
  private readonly ids:readonly Id[];

  private readonly doc:BoardDocument;
  constructor(editor:EditorSession,doc=editor.doc){
    this.doc=doc;
    this.editor=editor;this.locks=editor.lockRevision;this.visibility=editor.visibilityRevision;this.history=editor.history;this.generation=editor.generation;this.ids=editor.selectedIds;
    if(this.ids.length<2)return;
    this.movePlan=planMove(doc,this.ids,undefined,editor.hiddenIds);
    for(const key of Object.keys(captions) as AppearanceKey[]){
      const first=member(doc.objects[this.ids[0]],key);
      if(!first)continue;
      let common=true,mixed=false,min=first.min,max=first.max;
      for(const id of this.ids.slice(1)){
        const next=member(doc.objects[id],key);
        if(!next){common=false;break;}
        if(comparable(first.value)!==comparable(next.value))mixed=true;
        if(next.min!==undefined)min=Math.max(min??-Infinity,next.min);
        if(next.max!==undefined)max=Math.min(max??Infinity,next.max);
      }
      if(common)this.fields.push({key,label:captions[key],numeric:typeof first.value==="number",value:mixed?undefined:first.value,min,max});
    }
  }
  get current():boolean{
    return this.visibility===this.editor.visibilityRevision&&this.locks===this.editor.lockRevision&&!this.editor.selectionLocked&&this.history===this.editor.history&&this.generation===this.editor.generation&&this.ids===this.editor.selectedIds;
  }
  get canTranslate():boolean{
    return Boolean(this.movePlan&&(this.movePlan.movers.length||this.movePlan.connectors.length));
  }
  preview(edits:Edits,offset:Partial<Point>={}):ReadonlyMap<Id,BoardObject>|undefined{
    if(!this.current||this.editor.busy)return;
    return this.plan(edits,offset);
  }
  plan(edits:Edits,offset:Partial<Point>={}):ReadonlyMap<Id,BoardObject>|undefined{
    const delta={x:offset.x??0,y:offset.y??0};
    if(!Number.isFinite(delta.x)||!Number.isFinite(delta.y))return;
    for(const [key,value] of edits){
      const field=this.fields.find(field=>field.key===key);
      if(!field)return;
      if(field.numeric){
        if(typeof value!=="number"||!Number.isFinite(value)||value<(field.min??-Infinity)||value>(field.max??Infinity))return;
      }else if(!isHexPaint(value)&&(typeof value!=="string"||value!==field.value))return;
    }
    const changed=new Map<Id,BoardObject>();
    if(delta.x||delta.y){
      if(!this.canTranslate||!this.movePlan)return;
      for(const [id,item] of moveObjects(this.movePlan,delta)){
        if(!validTranslation(item))return;
        changed.set(id,item);
      }
    }
    if(edits.size)for(const id of this.ids){
      const original=this.doc.objects[id];
      let updated=changed.get(id)??original;
      for(const [key,value] of edits){
        const spec=member(original,key)!;
        if(key==="textColor"&&updated.kind==="text"&&typeof value==="string"){
          if(comparable(updated.color)!==comparable(value)||automaticTextColor(updated)){
            const next={...updated,color:value};
            if(automaticTextColor({id:next.id,color:value}))next.colorMode="custom";else delete next.colorMode;
            updated=next;
          }
        }else if(comparable(spec.value)!==comparable(value))updated={...updated,[spec.key]:value};
      }
      if(updated!==original)changed.set(id,updated);
    }
    return this.editor.anyLocked(changed.keys())?undefined:changed;
  }
  apply(edits:Edits,offset:Partial<Point>={}):boolean{
    const updated=this.preview(edits,offset);
    const label=offset.x||offset.y?(edits.size?"移动并修改多选对象":"整体位移"):"修改共同外观";
    return Boolean(updated?.size&&this.editor.commitEdit({label,patches:movePatches(updated)},this.generation));
  }
}

// Preserve the M5O appearance-only entry point for existing callers.
export { SelectionProperties as SelectionAppearance };
