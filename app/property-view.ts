import type {EditorSession} from "../session/editor.ts";
import type {TextFamily} from "../core/text-style.ts";

export type PropertyWidget=
  | {kind:"number";name:string;caption:string;value?:number;min?:number;max?:number}
  | {kind:"radio";name:string;caption:string;values:readonly (readonly [string,string])[];initial:string;change:(el:HTMLInputElement)=>void}
  | {kind:"color";name:string;caption:string;placeholder?:string;allowTransparent?:boolean}
  | {kind:"font";initial:TextFamily}
  | {kind:"image-options"}
  | {kind:"switch";name:string;caption:string}
  | {kind:"input";name:string;label:string;caption?:string;placeholder?:string;className?:string;inputMode?:"numeric";type?:"range";min?:number;max?:number}
  | {kind:"routes"}
  | {kind:"stepper";name:string;caption:string;min:number;max:number}
  | {kind:"mind-choice";setting:"layout"|"skin"|"theme";name:string;caption:string;values:Record<string,string>}
  | {kind:"disclosure";label:string;className:string;parts:readonly HTMLElement[]}
  | {kind:"action";label:string;disabled?:boolean;className?:string;title?:string;run?:()=>void};

export type PropertyOutlet={widget:(form:HTMLElement,parent:HTMLElement,spec:PropertyWidget)=>HTMLElement;release:(form:HTMLElement)=>void};
const editors=new WeakMap<EditorSession,PropertyOutlet>(),forms=new WeakMap<HTMLElement,PropertyOutlet>();
export function bindPropertyEditor(editor:EditorSession,outlet:PropertyOutlet){editors.set(editor,outlet);}
export function bindPropertyForm(editor:EditorSession,form:HTMLElement){
  const outlet=editors.get(editor);
  if(!outlet)return ()=>{};
  forms.set(form,outlet);
  return ()=>{forms.delete(form);outlet.release(form);};
}
export function propertyWidget(parent:HTMLElement,spec:PropertyWidget,form:HTMLElement|null=parent.closest("form")){
  const outlet=form&&forms.get(form);
  if(!form||!outlet)throw new Error("Property controls require the current editor's property form.");
  return outlet.widget(form,parent,spec);
}
