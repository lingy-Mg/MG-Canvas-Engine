import type {BoardDocument,CardObject} from "../core/document.ts";
import type {TableObject} from "../core/table.ts";
import {cardLayout,minimumCardWidth} from "../features/card-content.ts";
import {planShapeTransform} from "../session/shape-properties.ts";
import type {EditorSession} from "../session/editor.ts";
import {propertySection} from "./property-choices.ts";
import {liveProperties} from "./property-draft.ts";

/** Exact frame geometry shares the drag constraints of each object. */
export function contentProperties(editor:EditorSession,item:CardObject|TableObject,enabled:()=>boolean){
  const form=document.createElement("form");form.className="transform";
  const live=liveProperties(editor,form,enabled),get=(d:BoardDocument)=>d.objects[item.id] as typeof item;
  const box=propertySection(form,"位置与尺寸");
  for(const [key,title] of [["x","X"],["y","Y"],["width","W 宽度"],["height","H 高度"]] as const){
    const pos=key==="x"||key==="y";
    const min=pos?undefined:item.kind==="shape"?(key==="width"?minimumCardWidth(item.content.kind):48):1;
    live.number(box,key,title,d=>pos?get(d).at[key]:get(d)[key],(d,n)=>{
      const obj=get(d);
      if(obj.kind==="table")return pos?{...obj,at:{...obj.at,[key]:n}}:{...obj,[key]:n};
      const width=key==="width"?n:obj.width,height=Math.max(key==="height"?n:obj.height,cardLayout({...obj,width}).height);
      return planShapeTransform(d,obj,{...obj.at,[key]:n,width,height},editor.hiddenIds);
    },min,undefined,true);
  }
  return live;
}
