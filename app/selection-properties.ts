import {propertyWidget} from "./property-view.ts";
import type {BoardDocument} from "../core/document.ts";
import {SelectionProperties} from "../features/selection-appearance.ts";
import type {EditorSession} from "../session/editor.ts";
import {liveColor} from "./property-color.ts";
import {propertySection} from "./property-choices.ts";
import {liveProperties,numericInput} from "./property-draft.ts";

export function selectionProperties(editor:EditorSession){
  const form=document.createElement("form");form.className="transform";
  const live=liveProperties(editor,form,()=>true);
  const models=new WeakMap<BoardDocument,SelectionProperties>();
  function model(d:BoardDocument){
    let value=models.get(d);
    if(!value){value=new SelectionProperties(editor,d);models.set(d,value);}
    return value;
  }
  const original=model(editor.doc);
  if(original.canTranslate){
    const grid=propertySection(form,"整体位移");
    for(const axis of ["x","y"] as const){
      const title="Δ"+axis.toUpperCase(),field=propertyWidget(grid,{kind:"input",name:"delta"+axis.toUpperCase(),
        label:"整体位移 "+title,caption:title,inputMode:"numeric",placeholder:"0"}).querySelector("input")!;
      live.input(field,"整体位移",()=>"",d=>{const n=numericInput(field,true);if(Number.isFinite(n))return model(d).plan(new Map(),{[axis]:n});});
    }
  }
  const grid=propertySection(form,"共同外观");
  for(const field of original.fields){
    const read=(d:BoardDocument)=>model(d).fields.find(f=>f.key===field.key)?.value;
    const change=(d:BoardDocument,value:string|number)=>model(d).plan(new Map([[field.key,value]]));
    if(field.numeric){
      const input=live.number(grid,field.key,field.label,d=>read(d) as number|undefined,change,field.min,field.max);
      live.watch(()=>{input.placeholder=read(editor.doc)===undefined?"不同值":"";});
    }else liveColor(live,()=>editor.doc,grid,field.key,field.label,d=>read(d) as string|undefined,change,{placeholder:"不同值"});
  }
  if(!original.fields.length){const empty=document.createElement("p");empty.textContent="此选区没有共同的外观属性。";grid.append(empty);}
  return live;
}
