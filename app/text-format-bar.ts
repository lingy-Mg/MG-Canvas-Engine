import type {MarkdownAction,MarkdownState} from "../features/markdown-format.ts";
import type {History} from "../core/history.ts";
import type {TextFamily,TextWeight} from "../core/text-style.ts";
import {objectEditingView} from "./object-editing-view.ts";
import type {ObjectEditingView,ShapePaintTarget,ToolbarModel} from "./object-editing-view.ts";
import {bindPropertyEditor} from "./property-view.ts";
import type {EditorSession} from "../session/editor.ts";

export type FormatCapability="ink"|"background"|"family"|"size"|"bold"|"italic"|"underline"|"strike"|"align"|"list"|"link";
export const standaloneCapabilities:readonly FormatCapability[]=["ink","background","family","size","bold","italic","align"];
export type FormatValues=Readonly<{color:string;autoInk:boolean;background?:string;fontFamily:TextFamily;fontSize:number;fontWeight:TextWeight;italic:boolean;underline?:boolean;strike?:boolean;align:"left"|"center"|"right"}>;
export type FormatChange=Partial<Omit<FormatValues,"autoInk">> & {colorMode?:"auto"|"custom";list?:"bullet"|"number"|"plain";link?:string};
/** Continuous inputs share one undo step until focus or the history head changes. */
export type FormatGesture={series?:{start:History;head:History}};
export function formatSeries(gesture:FormatGesture|undefined,head:History){
  if(!gesture)return;
  if(gesture.series?.head!==head)gesture.series={start:head,head};
  return gesture.series;
}
/** The caller owns selection, its supported properties and the editing transaction. */
type FormatLayout="text"|"sticky"|"markdown"|"table";
export type FormatTarget=Readonly<{id:string;layout?:FormatLayout;markdown?:MarkdownState;command?:(action:MarkdownAction)=>void;capabilities:readonly FormatCapability[];values:FormatValues;apply:(change:FormatChange,gesture?:FormatGesture)=>void;focus:()=>void;composing?:boolean;backgroundColors?:readonly string[]}>;
export type ScreenArea=Readonly<{left:number;top:number;right:number;bottom:number}>;
export type AnchoredFormatTarget=Readonly<{target:FormatTarget;anchor:ScreenArea}>;
/** Adapters return a target only while their own selection or editor is active. */
type FormatReader=()=>AnchoredFormatTarget|undefined;
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(v,max));
export type ObjectSection={key:string;label:string;parts:HTMLElement[]};
export class TextFormatBar{
  readonly downstreamButton:HTMLButtonElement;
  readonly root:HTMLElement;
  private view:ObjectEditingView;
  private strip:HTMLElement;
  private back:HTMLButtonElement;
  private forward:HTMLButtonElement;
  private popup:HTMLElement;
  private extras:HTMLElement;
  private fields:HTMLElement;
  private sheetClose:HTMLButtonElement;
  private sections:ObjectSection[]=[];
  private actions:HTMLElement[]=[];
  private owner="";
  private readers=new Set<FormatReader>();
  private signature="";
  private object=false;
  private open?:{key:string;trigger:HTMLButtonElement;fields:boolean};
  propertiesEnabled=true;
  private shape?:ShapePaintTarget;
  private handles:readonly {x:number;y:number}[]=[];
  private target?:FormatTarget;
  private anchor?:ScreenArea;
  private viewport?:ScreenArea;
  occupied?:ScreenArea;
  docked=false;
  sheet=false;
  sheetRight?:number;
  private history:(redo:boolean)=>boolean;
  constructor(mount:HTMLElement,fields:HTMLElement,history:(redo:boolean)=>boolean){
    this.fields=fields;this.history=history;this.view=objectEditingView(mount);
    this.root=this.view.layer.querySelector<HTMLElement>("#text-format-bar")!;
    const root=this.root,strip=this.strip=root.querySelector<HTMLElement>(".format-strip")!;
    [this.back,this.forward]=Array.from(root.querySelectorAll<HTMLButtonElement>(".format-scroll"));
    this.extras=root.querySelector<HTMLElement>(".format-extras")!;
    this.popup=root.querySelector<HTMLElement>("#format-options")!;
    this.downstreamButton=root.querySelector<HTMLButtonElement>("#downstream-control")!;
    this.sheetClose=root.querySelector<HTMLButtonElement>(".format-sheet-close")!;
    const signal=this.view.signal;
    this.sheetClose.addEventListener("click",()=>{
      const trigger=this.open?.trigger;
      this.close();
      trigger?.focus({preventScroll:true});
    },{signal});
    fields.hidden=true;fields.className="local-options object-properties";fields.setAttribute("role","group");
    document.addEventListener("pointerdown",event=>{if(this.open&&!root.contains(event.target as Node))this.close();},{capture:true,signal});
    document.addEventListener("keydown",event=>{
      if(event.key==="Escape"&&this.open&&!event.isComposing&&!this.target?.composing){
        event.preventDefault();event.stopPropagation();const trigger=this.open.trigger,returnFocus=root.contains(document.activeElement);this.close();
        if(returnFocus)trigger.focus({preventScroll:true});
      }
    },{capture:true,signal});
    // Buttons leave the editor's native selection and composition in place.
    const guard=(event:MouseEvent)=>{
      if(fields.contains(event.target as Node))return;
      if(this.target?.composing||(!(event.target instanceof HTMLInputElement)&&(event.target as HTMLElement).tagName!=="SELECT"))event.preventDefault();
    };
    root.addEventListener("pointerdown",event=>{if(event.pointerType==="mouse"||this.target?.composing)guard(event);},{signal});
    root.addEventListener("mousedown",guard,{signal});
    root.addEventListener("keydown",event=>{
      if(event.isComposing||this.target?.composing||event.keyCode===229||fields.contains(event.target as Node))return;
      if(!(event.target instanceof HTMLInputElement&&event.target.type!=="checkbox")&&this.historyKey(event))return;
      if(event.key==="Escape"||event.key==="Enter"&&event.target instanceof HTMLInputElement&&event.target.type!=="url"){
        event.preventDefault();event.stopPropagation();this.close();(this.target??this.shape)?.focus();return;
      }
      if(event.target instanceof HTMLInputElement||!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
      const scope=this.popup.contains(event.target as Node)?this.popup:strip;
      const controls=Array.from(scope.querySelectorAll<HTMLElement>("button:enabled,input:enabled,select:enabled")).filter(el=>el.getClientRects().length);
      const index=controls.indexOf(event.target as HTMLElement);if(index<0)return;
      event.preventDefault();event.stopPropagation();
      const next=event.key==="Home"?0:event.key==="End"?controls.length-1:(index+(event.key==="ArrowLeft"?-1:1)+controls.length)%controls.length;
      controls[next].focus();
    },{signal});
    strip.addEventListener("wheel",event=>{
      if(event.ctrlKey||event.metaKey||event.shiftKey||Math.abs(event.deltaX)>=Math.abs(event.deltaY))return;
      const before=strip.scrollLeft;
      strip.scrollLeft+=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?strip.clientWidth:1);
      if(strip.scrollLeft!==before)event.preventDefault();
    },{passive:false,signal});
    for(const [control,direction] of [[this.back,-1],[this.forward,1]] as const){
      control.className="format-scroll";control.hidden=true;
      control.addEventListener("click",()=>{strip.scrollLeft+=direction*Math.max(64,strip.clientWidth*.75);},{signal});
    }
    strip.addEventListener("scroll",()=>this.updateScroll(),{signal});
  }
  focus(){
    if(this.root.hidden||this.target?.composing)return false;
    const first=this.strip.querySelector<HTMLElement>("button:enabled,input:enabled,select:enabled");
    first?.focus();return Boolean(first);
  }
  private historyKey(event:KeyboardEvent){
    if(event.isComposing||this.target?.composing||event.keyCode===229||event.altKey||!(event.ctrlKey||event.metaKey))return false;
    const key=event.key.toLowerCase();if(key!=="z"&&key!=="y")return false;
    if(!this.history(key==="y"||event.shiftKey))return false;
    event.preventDefault();event.stopPropagation();return true;
  }
  register(read:FormatReader){this.readers.add(read);return ()=>this.readers.delete(read);}
  bindEditor(editor:EditorSession){bindPropertyEditor(editor,this.view.properties);}
  activeTarget(){for(const read of this.readers){const active=read();if(active)return active;}}
  get hasTools(){return Boolean(this.sections.length||this.actions.length);}
  get hasOpenOptions(){return Boolean(this.open);}
  close(){
    if(!this.open)return;
    this.open=undefined;this.popup.hidden=true;this.fields.hidden=true;this.renderControls();this.place();
  }
  private menu=(trigger:HTMLButtonElement,key:string,fields:boolean,keyboard:boolean)=>{
    if(this.target?.composing)return;
    const same=this.open?.trigger===trigger;
    if(same){this.close();return;}
    this.open={key,trigger,fields};this.popup.hidden=fields;this.fields.hidden=!fields;
    const host=fields?this.fields:this.popup;
    if(fields)for(const section of this.sections)for(const part of section.parts)part.dataset.contextVisible=String(section.key===key);
    host.dataset.options=key;host.setAttribute("aria-label",trigger.title);this.renderControls();this.place();
    if(keyboard)Array.from(host.querySelectorAll<HTMLElement>("button:enabled,input:enabled,select:enabled,summary")).find(el=>el.getClientRects().length)?.focus();
  };
  private apply=(change:FormatChange,gesture?:FormatGesture)=>{
    const t=this.target;if(!t)return;
    if(!gesture&&this.open?.key!=="paper")this.close();
    t.apply(change,gesture);if(!gesture&&!t.composing)t.focus();
  };
  private markdown=(command:MarkdownAction)=>{
    const t=this.target;if(!t||t.composing)return;this.close();t.command?.(command);t.focus();
  };
  private paintShape:ToolbarModel["paintShape"]=(key,color,gesture)=>{
    const s=this.shape;if(!s)return;if(!gesture)this.close();s.apply(key,color,gesture);if(!gesture)s.focus();
  };
  private renderControls(force=false){
    if(this.view.signal.aborted)return;
    const t=this.target,s=this.shape;
    const signature=JSON.stringify([this.object,t?.id,t?.layout,t?.values,t?.capabilities,t?.backgroundColors,t?.markdown,t?.composing,
      s?.id,s?.fill,s?.stroke,this.open?.key,this.open?.fields,this.sections.map(section=>section.parts.every(part=>part.hidden))]);
    if(!force&&this.signature===signature)return;
    this.signature=signature;
    this.view.toolbar({target:t,shape:s,sections:this.sections,actions:this.actions,open:this.open?.key,fieldsOpen:Boolean(this.open?.fields),
      apply:this.apply,markdown:this.markdown,paintShape:this.paintShape,menu:this.menu,history:this.history});
  }
  configure(owner:string,sections:ObjectSection[],actions:HTMLElement[]=[]){
    const previous=this.owner===owner&&this.open?.fields?this.open.key:undefined;
    if(owner!==this.owner||this.open?.fields)this.close();
    this.owner=owner;this.sections=sections;this.actions=actions;this.renderControls(true);
    if(previous){
      const b=Array.from(this.extras.querySelectorAll<HTMLButtonElement>("button[data-menu]")).find(i=>i.dataset.menu===previous);
      if(b)this.menu(b,previous,true,false);
    }
  }
  hide(){this.close();this.target=undefined;this.shape=undefined;this.object=false;this.root.hidden=true;}
  showObject(anchor:ScreenArea,viewport:ScreenArea,handles:readonly {x:number;y:number}[]=[]){
    if(!this.object)this.close();this.target=undefined;this.shape=undefined;this.handles=handles;this.object=true;
    this.present("object","所选对象工具",anchor,viewport);
  }
  showShape(target:ShapePaintTarget,anchor:ScreenArea,viewport:ScreenArea,handles:readonly {x:number;y:number}[]){
    if(this.shape?.id!==target.id)this.close();this.object=false;this.target=undefined;this.shape=target;this.handles=handles;
    this.present("shape","形状外观",anchor,viewport);
  }
  show(target:FormatTarget,anchor:ScreenArea,viewport:ScreenArea){
    if(this.target?.id!==target.id||this.target?.layout!==target.layout){this.close();this.strip.scrollLeft=0;}
    this.object=false;this.shape=undefined;this.target=target;this.handles=[];
    const label=target.layout==="markdown"?"Markdown 文档格式":target.layout==="sticky"?"便签格式":target.layout==="table"?"表格文字格式":"文字格式";
    this.present(target.layout??"generic",label,anchor,viewport);
  }
  private present(layout:string,label:string,anchor:ScreenArea,viewport:ScreenArea){
    this.anchor=anchor;this.viewport=viewport;
    if(this.root.dataset.layout!==layout)this.root.dataset.layout=layout;
    if(this.strip.getAttribute("aria-label")!==label)this.strip.setAttribute("aria-label",label);
    this.root.hidden=!this.docked&&(anchor.right<viewport.left||anchor.left>viewport.right||anchor.bottom<viewport.top||anchor.top>viewport.bottom);
    if(this.root.hidden)return;
    this.extras.hidden=!this.propertiesEnabled||!this.actions.some(a=>!a.hidden)&&!this.sections.some(s=>s.parts.some(p=>!p.hidden));
    if(this.open?.fields&&(this.extras.hidden||this.open.trigger.hidden))this.close();
    if(this.object&&this.extras.hidden){this.root.hidden=true;return;}
    this.renderControls();this.place();
  }
  private placePopup(x:number,y:number,barHeight:number){
    const op=this.open,v=this.viewport;if(!op||!v)return;
    const panel=op.fields?this.fields:this.popup,margin=6;
    const sheet=op.fields&&this.sheet;
    panel.toggleAttribute("data-sheet",sheet);
    const right=sheet?Math.min(v.right,this.sheetRight??v.right):v.right;
    panel.style.maxWidth=Math.max(1,right-v.left-margin*2)+"px";
    panel.style.width=sheet?"440px":"";
    if(sheet){
      const top=v.top+margin;
      panel.style.maxHeight=Math.max(1,y-top-4)+"px";
      panel.style.top=top-y+"px";panel.style.bottom="auto";
      panel.style.left=(v.left+right-panel.offsetWidth)/2-x+"px";
      return;
    }
    const trigger=op.trigger.getBoundingClientRect(),bar=this.root.getBoundingClientRect();
    const left=clamp(x+trigger.left-bar.left,v.left+margin,v.right-margin-panel.offsetWidth);
    const zoom=this.occupied,acrossZoom=zoom&&left<zoom.right+margin&&left+panel.offsetWidth>zoom.left-margin;
    const ceiling=acrossZoom?Math.max(v.top+margin,zoom.bottom+margin):v.top+margin;
    const belowTop=Math.max(y+barHeight+4,ceiling);
    const above=y-4-ceiling,below=v.bottom-margin-belowTop;
    const up=above>=Math.min(panel.scrollHeight,245)||above>below;
    panel.style.maxHeight=Math.max(1,up?above:below)+"px";
    panel.style.top=up?"auto":belowTop-y+"px";panel.style.bottom=up?barHeight+4+"px":"auto";
    panel.style.left=left-x+"px";
  }
  private updateScroll(){
    this.back.disabled=this.strip.scrollLeft<=1;
    this.forward.disabled=this.strip.scrollLeft+this.strip.clientWidth>=this.strip.scrollWidth-1;
  }
  private place(){
    const a=this.anchor,v=this.viewport;if(!a||!v)return;
    const margin=6,gap=12,usable=Math.max(1,v.right-v.left-2*margin);
    this.root.style.maxWidth=Math.min(usable,1040)+"px";
    const sheet=Boolean(this.sheet&&this.open?.fields);
    const docked=this.docked||sheet;
    this.root.toggleAttribute("data-sheet-open",sheet);
    this.root.toggleAttribute("data-docked",docked);
    const scrollCapacity=this.root.clientWidth-this.sheetClose.offsetWidth;
    const overflow=(docked||this.root.dataset.layout==="generic")&&this.strip.scrollWidth>scrollCapacity+1;
    if(this.back.hidden===overflow)this.back.hidden=this.forward.hidden=!overflow;
    if(overflow)this.updateScroll();
    const w=this.root.offsetWidth??270,h=this.root.offsetHeight??38;
    if(docked){
      const x=v.left+margin;
      const y=Math.max(v.top+margin,v.bottom-margin-h);
      this.root.style.left=x+"px";this.root.style.top=y+"px";
      this.placePopup(x,y,h);return;
    }
    const cx=(a.left+a.right-w)/2,cy=(a.top+a.bottom-h)/2;
    const centerX=clamp(cx,v.left+margin,v.right-margin-w),top=clamp(a.top-gap-h,v.top+margin,v.bottom-margin-h),below=clamp(a.bottom+gap,v.top+margin,v.bottom-margin-h);
    let x=centerX,y=a.top-gap-h>=v.top+margin?top:below;
    const occupied=this.occupied;
    const clear=(px:number,py:number)=>!(occupied&&px<occupied.right+4&&px+w>occupied.left-4&&py<occupied.bottom+4&&py+h>occupied.top-4)&&
      this.handles.every(p=>p.x<px-11||p.x>px+w+11||p.y<py-11||p.y>py+h+11);
    if(!clear(x,y)){
      const sideY=clamp(cy,v.top+margin,v.bottom-margin-h);
      const positions=[[centerX,below],[centerX,top],[clamp(a.right+gap,v.left+margin,v.right-margin-w),sideY],
        [clamp(a.left-w-gap,v.left+margin,v.right-margin-w),sideY],[centerX,clamp((occupied?.bottom??v.top)+margin,v.top+margin,v.bottom-margin-h)],
        [v.left+margin,v.top+margin],[v.right-margin-w,v.bottom-margin-h]];
      const free=positions.find(([px,py])=>clear(px,py));
      if(free)[x,y]=free;
    }
    this.root.style.left=x+"px";this.root.style.top=y+"px";
    this.placePopup(x,y,h);
  }
}
