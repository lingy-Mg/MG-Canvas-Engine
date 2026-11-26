import type {BoardDocument,BoardObject,Id} from "../core/document.ts";
import type {History} from "../core/history.ts";
import type {EditorSession} from "../session/editor.ts";
import {movePatches} from "../session/transform.ts";
import {bindPropertyForm,propertyWidget} from "./property-view.ts";

export type PropertyResult=BoardObject|ReadonlyMap<Id,BoardObject>|undefined;
type Plan=(doc:BoardDocument)=>PropertyResult;
type Field=HTMLElement;
type Gesture={field:Field;start:History;head:History;affected:Set<Id>};
type Panel={sync:Set<(skip?:Field)=>void>;gesture?:Gesture;publishing:boolean};
const panels=new WeakMap<EditorSession,Panel>();
const synchronizedValues=new WeakMap<Element,string>();
export const propertyInputSelector="input,textarea,select,[contenteditable=true]";
export function propertyInputValue(el:Element):string {
  if(el.tagName==="INPUT"){
    const input=el as HTMLInputElement;
    if(input.type==="checkbox"||input.type==="radio")return String(input.checked);
  }
  return "value" in el?String(el.value):el.textContent??"";
}
export function synchronizedPropertyValue(el:Element){return synchronizedValues.get(el);}
export function resetPropertyPanel(editor:EditorSession){
  const old=panels.get(editor);if(old){old.gesture=undefined;old.sync.clear();}
  panels.set(editor,{sync:new Set(),publishing:false});
}
export function publishingProperty(editor:EditorSession){return panels.get(editor)?.publishing===true;}
export function draftNumber(grid:HTMLElement,name:string,caption:string,value:number|undefined,min?:number,max?:number,form?:HTMLFormElement){
  return propertyWidget(grid,{kind:"number",name,caption,value,min,max},form).querySelector("input")!;
}
export function integerFields(...inputs:HTMLInputElement[]){
  for(const input of inputs){input.step="1";input.inputMode="numeric";}
}
export function inspectorDegrees(radians:number):number{
  const raw=radians*(180/Math.PI);
  return Number((Number.isFinite(raw)?raw:radians%(2*Math.PI)*(180/Math.PI)).toFixed(6));
}
export function numericInput(input:HTMLInputElement,integer=input.step==="1"):number|undefined{
  if(input.validity?.badInput)return NaN;
  const raw=input.value.trim();
  if(!raw)return;
  const value=/^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(raw)?Number(raw):NaN;
  return integer&&!Number.isInteger(value)?NaN:value;
}

/** A field plans from the start of its own gesture. The document remains current between samples. */
export function liveProperties(editor:EditorSession,form:HTMLFormElement,enabled:()=>boolean){
  if(!panels.has(editor))resetPropertyPanel(editor);
  const panel=panels.get(editor)!,generation=editor.generation,selection=editor.selectedIds;
  const release=bindPropertyForm(editor,form);
  const watchers=new Set<(skip?:Field)=>void>();
  let active=true,composing=false;
  form.noValidate=true;
  const sync=(skip?:Field)=>{
    for(const watch of watchers)watch(skip);
    // A full refresh restores every field from the document and ends its draft.
    if(!skip&&!composing)for(const field of form.querySelectorAll(propertyInputSelector)){
      synchronizedValues.set(field,propertyInputValue(field));
    }
  };
  panel.sync.add(sync);
  const current=()=>active&&panels.get(editor)===panel&&editor.generation===generation&&editor.selectedIds===selection&&!editor.busy&&!editor.selectionLocked&&enabled();
  function finish(field?:Field){
    const gesture=panel.gesture;
    if(!gesture||field&&gesture.field!==field)return false;
    panel.gesture=undefined;gesture.field.setAttribute("aria-invalid","false");
    for(const update of panel.sync)update();
    return true;
  }
  function write(field:Field,label:string,plan:Plan,continuous=true){
    if(!current()||composing)return false;
    let gesture=panel.gesture;
    if(!gesture||gesture.field!==field||gesture.head!==editor.history||!continuous){
      if(gesture)gesture.field.setAttribute("aria-invalid","false");
      gesture={field,start:editor.history,head:editor.history,affected:new Set()};panel.gesture=gesture;
    }
    const base=gesture.start.doc,result=plan(base);
    const incomplete=(field as HTMLInputElement).value===""&&!(field as HTMLInputElement).validity?.badInput;
    field.setAttribute("aria-invalid",String(!result&&!incomplete));
    if(!result){
      if(!continuous)panel.gesture=undefined;
      for(const update of panel.sync)update(continuous?field:undefined);
      return false;
    }
    const objects=new Map<Id,BoardObject>("kind" in result?[[result.id,result]]:result);
    for(const id of gesture.affected)if(!objects.has(id))objects.set(id,base.objects[id]);
    panel.publishing=true;
    let committed=false;
    try{
      committed=editor.commitEdit({label,patches:movePatches(objects)},generation,undefined,undefined,gesture);
      if(committed)for(const id of objects.keys())gesture.affected.add(id);
    }finally{panel.publishing=false;}
    if(!continuous)panel.gesture=undefined;
    for(const update of panel.sync)update(continuous?field:undefined);
    return committed;
  }
  function watch(fn:(skip?:Field)=>void){watchers.add(fn);fn();}
  function input(field:HTMLInputElement,label:string,read:(doc:BoardDocument)=>string|number|undefined,plan:Plan,clear?:Plan){
    watch(skip=>{if(skip!==field){const value=String(read(editor.doc)??"");if(field.value!==value)field.value=value;}});
    const apply=()=>write(field,label,plan);
    field.addEventListener("input",apply);
    field.addEventListener("compositionstart",()=>{composing=true;});
    field.addEventListener("compositionend",()=>{composing=false;apply();});
    field.addEventListener("blur",()=>{
      if(composing)return;
      if(clear&&panel.gesture?.field===field&&!field.value.trim()&&!field.validity?.badInput)write(field,label,clear);
      finish(field);
    });
    if(field.type==="range"||field.type==="number"){
      if(field.type==="range")field.addEventListener("pointerdown",()=>finish(field));
      field.addEventListener("pointerup",()=>{if(field.value)finish(field);});
      field.addEventListener("pointercancel",()=>finish(field));
    }
  }
  function number(grid:HTMLElement,name:string,caption:string,read:(doc:BoardDocument)=>number|undefined,
    plan:(doc:BoardDocument,value:number)=>PropertyResult,min?:number,max?:number,integer=false){
    const field=draftNumber(grid,name,caption,read(editor.doc),min,max,form);
    if(integer)integerFields(field);
    input(field,"修改"+caption,read,d=>{
      const n=numericInput(field);
      if(n===undefined||!Number.isFinite(n)||min!==undefined&&n<min||max!==undefined&&n>max)return;
      return plan(d,n);
    });
    return field;
  }
  form.addEventListener("submit",e=>e.preventDefault());
  form.addEventListener("keydown",event=>{
    if(!current()||composing||event.isComposing||event.keyCode===229)return;
    const key=event.key.toLowerCase();
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&(key==="z"||key==="y")){
      event.preventDefault();event.stopPropagation();finish();
      const field=event.target as HTMLInputElement,root=form.closest("#inspector");
      const attr=field?.getAttribute("aria-label"),name=field?.name;
      if(key==="y"||event.shiftKey)editor.redo();else editor.undo();
      const controls=root?.querySelectorAll?.<HTMLInputElement>("input");
      if(controls)Array.from(controls).find(i=>i.name===name&&i.getAttribute("aria-label")===attr&&
        (field.type!=="radio"||i.value===field.value))?.focus({preventScroll:true});
    }else if((key==="enter"||key==="escape")&&(event.target as HTMLElement)?.tagName==="INPUT"){
      event.preventDefault();event.stopPropagation();finish();
    }
  });
  return {form,write,input,number,watch,sync,current,finish,reset:()=>finish(),dispose(){active=false;panel.sync.delete(sync);release();}};
}
export type LiveProperties=ReturnType<typeof liveProperties>;
