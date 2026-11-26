import type {FormatChange,FormatGesture,FormatTarget,ObjectSection} from "./text-format-bar.ts";
import type {MarkdownAction} from "../features/markdown-format.ts";
import type {PropertyOutlet} from "./property-view.ts";

export type ShapePaintTarget=Readonly<{id:string;fill:string;stroke:string;apply:(key:"fill"|"stroke",color:string,gesture?:FormatGesture)=>void;focus:()=>void}>;
export type TableAction="whole"|"row"|"col"|"addRow"|"addCol";
export type TableMenuChoice={label:string;disabled?:boolean;run:()=>void};
export type TextFieldSpec={mode:"text"|"topic"|"label"|"cell";text:string;autoWidth?:boolean;finish:(save:boolean)=>void};
export type CardFieldSpec={kind:"sticky"|"markdown";changeMode:()=>void};
export type ToolbarModel={
  target?:FormatTarget;shape?:ShapePaintTarget;sections:readonly ObjectSection[];actions:readonly HTMLElement[];
  open?:string;fieldsOpen:boolean;
  apply:(change:FormatChange,gesture?:FormatGesture)=>void;
  markdown:(command:MarkdownAction)=>void;
  paintShape:(key:"fill"|"stroke",color:string,gesture?:FormatGesture)=>void;
  menu:(button:HTMLButtonElement,key:string,fields:boolean,keyboard:boolean)=>void;
  history:(redo:boolean)=>boolean;
};
export interface ObjectEditingView{
  readonly layer:HTMLElement;
  readonly signal:AbortSignal;
  readonly properties:PropertyOutlet;
  toolbar(model:ToolbarModel):void;
  tableActions(action:(key:TableAction)=>void):void;
  tableMenu(choices:readonly TableMenuChoice[]):void;
  text(spec:TextFieldSpec):{frame:HTMLElement;input:HTMLTextAreaElement;actions:HTMLElement|null;close:()=>void};
  card(spec:CardFieldSpec):{frame:HTMLElement;plain:HTMLTextAreaElement;rich:HTMLDivElement;sheet:HTMLElement;mode:(source:boolean)=>void;close:()=>void};
}

// Each running canvas has its own view. A second editor cannot take over another editor's input.
const views=new WeakMap<HTMLElement,ObjectEditingView>();
export function bindObjectEditingView(view:ObjectEditingView){
  views.set(view.layer,view);
  return ()=>{if(views.get(view.layer)===view)views.delete(view.layer);};
}
export function objectEditingView(viewport:HTMLElement){
  const layer=viewport.querySelector<HTMLElement>("[data-object-editing-layer]");
  const view=layer&&views.get(layer);
  if(!view)throw new Error("Mount ObjectEditingLayer in the canvas viewport before binding the editor runtime.");
  return view;
}
