import {objectEditingView} from "./object-editing-view.ts";
import { autoLabelInk,canvasThemes,contrastInk,labelSurface,standaloneInk } from "../platform/theme.ts";
import type { WorkspaceTheme } from "../platform/theme.ts";
import { nodeFont, standaloneFont } from "../platform/text-metrics.ts";
import { boxBounds,worldToScreen } from "../core/geometry.ts";
import type { Box,Camera } from "../core/geometry.ts";
import type { TextObject } from "../core/document.ts";
import type {CardObject} from "../core/document.ts";
import {CardEditor} from "./card-editor.ts";
import type {DraftTarget,TextDraft} from "../platform/workspace-store.ts";
import {overflowEdit} from "../features/text-layout.ts";
import { editKey, topicEditKey,textBoxWithSize,textHeight,MAX_LABEL_LENGTH,MAX_TOPIC_LENGTH,MAX_TEXT_LENGTH } from "../features/plain-text.ts";
type NodeStyle=Readonly<{fill:string;weight:number}&({kind:"label";backdrop?:()=>string|undefined}|{kind:"topic";autoWidth:boolean;surfaceInk:boolean;layout:(value:string)=>Box;present?:()=>Box|undefined})>
  | Readonly<{kind:"cell";next:(step:number)=>void}>;
type Follow="child"|"sibling";
type Finish=(text?:string,follow?:Follow,outside?:boolean)=>void;

/** Native maxlength can cut a paste before the rest of its grapheme reaches us. */
export function limitTextInput(input:HTMLInputElement|HTMLTextAreaElement,budget:number):()=>void{
  let composing=false,previous=input.value;
  const enforce=()=>{
    if(composing)return;
    const patch=overflowEdit(previous,input.value,budget);
    if(patch)input.setRangeText(patch.text,patch.start,patch.end,"preserve");
    previous=input.value;
  };
  input.addEventListener("compositionstart",()=>{composing=true;});
  input.addEventListener("compositionend",()=>{composing=false;enforce();});
  input.addEventListener("input",event=>{if(!(event as InputEvent).isComposing)enforce();});
  return enforce;
}

export class TextOverlay {
  private mount:HTMLElement;
  card?:CardEditor;
  private lastCardItem?:CardObject;
  private edited=false;
  private endCard?:(save:boolean,outside:boolean)=>void;
  private session?:{item:TextObject;box:Box;layoutValue:string;node?:NodeStyle;frame:HTMLElement;actions?:HTMLElement;input:HTMLTextAreaElement;unmount:()=>void;finish:Finish;target?:DraftTarget;styled?:boolean};
  private composing=false;
  private beforeComposition={value:"",start:0,end:0};
  private endedAt=-Infinity;
  private reflow?:()=>void;
  constructor(mount:HTMLElement,reflow?:()=>void){this.mount=mount;this.reflow=reflow;}
  onDraftChange?:()=>void;
  private editDraft(){this.edited=true;this.onDraftChange?.();}
  private clearDraft(){
    if(this.edited){this.edited=false;this.onDraftChange?.();}
  }
  get recoverable():TextDraft|undefined{
    if(!this.edited)return;
    if(this.card){
      const {item,start,end}=this.card.snapshot;
      return {target:{kind:"card",id:item.id,at:item.at,content:item.content,fill:item.fill,sourceMode:this.card.editingSource},value:item.label,start,end};
    }
    const s=this.session;if(!s?.target)return;
    const value=this.composing?this.beforeComposition.value:s.input.value;
    const {fontSize,align,color,colorMode,background,fontFamily,fontWeight,italic}=s.item;
    const style=s.styled&&s.target.kind==="text"?{fontSize,align,color,colorMode,background,fontFamily,fontWeight,italic}:undefined;
    return {target:s.target,value,start:this.composing?this.beforeComposition.start:s.input.selectionStart??value.length,
      end:this.composing?this.beforeComposition.end:s.input.selectionEnd??value.length,style};
  }
  restoreDraft(draft:TextDraft){
    if(this.card&&draft.target.kind==="card"){
      this.edited=true;this.card.restore(draft.value,draft.start,draft.end,draft.target.sourceMode);
      this.lastCardItem=this.card.item;this.reflow?.();return;
    }
    const input=this.session?.input;if(!input)return;
    this.edited=true;input.value=draft.value;this.refreshInput(input,false);input.setSelectionRange(draft.start,draft.end);
  }
  get active():boolean {return Boolean(this.session||this.card);}
  get worldBox():Box|undefined {return this.card?.item??this.session?.box;}
  get id():string|undefined {return this.session?.item.id??this.card?.item.id;}
  get inComposition():boolean{return this.composing||Boolean(this.card?.composing);}
  get field(){return this.session?.input??this.card?.input;}
  showCard(item:CardObject,finish:(value:CardObject|undefined,outside:boolean)=>void,offset=0,creating=false){
    this.close();
    const end=(save:boolean,outside:boolean)=>{
      const card=this.card;if(!card)return;
      this.card=undefined;this.lastCardItem=undefined;this.endCard=undefined;card.dispose();
      this.clearDraft();finish(save?card.result():undefined,outside);
    };
    this.endCard=end;
    this.lastCardItem=item;
    this.card=new CardEditor(this.mount,item,()=>{
      this.reflow?.();
      const next=this.card?.item;
      if(next&&next!==this.lastCardItem){this.lastCardItem=next;this.editDraft();}
    },end,offset);
    if(creating)this.editDraft();
  }
  restyle(item:TextObject,target?:DraftTarget){
    const current=this.session;if(!current||current.node&&current.node.kind!=="cell"||current.item.id!==item.id)return;
    current.item=item;current.box=item;current.styled=true;
    if(target)current.target=target;
    this.reflow?.();this.editDraft();
  }
  show(item:TextObject,finish:Finish,node?:NodeStyle,replaceAll=false,target?:DraftTarget){
    this.close();
    const mode=node?.kind??"text";
    const view=objectEditingView(this.mount).text({mode,text:item.text,autoWidth:node?.kind==="topic"&&node.autoWidth,
      finish:save=>{if(this.session?.input===input){if(save)this.submit();else this.close();}}});
    const {frame,input}=view,actions=view.actions??undefined;
    const limit=limitTextInput(input,Math.max(item.text.length,mode==="topic"?MAX_TOPIC_LENGTH:mode==="label"?MAX_LABEL_LENGTH:MAX_TEXT_LENGTH));
    if(node){frame.dataset.value=input.value;frame.style.color=item.color;}
    this.composing=false;this.endedAt=-Infinity;
    this.session={item,box:item,layoutValue:input.value,node,frame,actions,input,unmount:view.close,finish,target};
    if(mode==="cell")input.addEventListener("beforeinput",event=>{
      // Some IMEs also send a textarea line break with the candidate-confirmation Enter.
      if((event.inputType==="insertLineBreak"||event.inputType==="insertParagraph")&&
        (this.composing||event.isComposing||performance.now()-this.endedAt<45))event.preventDefault();
    });
    input.addEventListener("input",()=>this.refreshInput(input));
    input.addEventListener("compositionstart",()=>{
      if(this.session?.input===input){
        this.beforeComposition={value:input.value,start:input.selectionStart??input.value.length,end:input.selectionEnd??input.value.length};
        this.composing=true;
      }
    });
    input.addEventListener("compositionend",()=>{
      if(this.session?.input!==input)return;
      this.composing=false;this.endedAt=performance.now();
      this.refreshInput(input,false);
      if(input.value!==this.beforeComposition.value)this.editDraft();
    });
    input.addEventListener("keydown",event=>{
      if(this.session?.input!==input)return;
      const after=performance.now()-this.endedAt<45;
      if(node?.kind==="cell"){
        event.stopPropagation();
        if(this.composing||after||event.isComposing||event.keyCode===229)return;
        if(event.key==="Escape"){event.preventDefault();this.close();}
        else if(event.key==="Tab"&&!event.ctrlKey&&!event.metaKey){
          event.preventDefault();this.submit();node.next(event.shiftKey?-1:1);
        }else if(event.key==="Enter"&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey){event.preventDefault();this.submit();}
        return;
      }
      const action=mode==="topic"?topicEditKey(event,this.composing,after):mode==="label"&&event.key==="Enter"?
        (this.composing||after||event.isComposing||event.keyCode===229?undefined:"commit"):editKey(event,this.composing,after);
      event.stopPropagation();
      if(!action)return;
      event.preventDefault();
      if(action==="newline"){input.setRangeText("\n",input.selectionStart,input.selectionEnd,"end");limit();this.refreshInput(input);return;}
      if(action==="commit"||action==="child"||action==="sibling")this.submit(action==="commit"?undefined:action);else this.close();
    });
    frame.addEventListener("keydown",event=>{
      event.stopPropagation();
      if(this.session?.input===input&&event.target!==input&&event.key==="Escape"&&!this.composing){
        event.preventDefault();this.close();
      }
    });
    input.focus({preventScroll:true});input.setSelectionRange(replaceAll?0:input.value.length,input.value.length);
    if(target?.kind==="map"||target?.kind==="child"||target?.kind==="sibling"||target?.kind==="text"&&target.at)this.editDraft();
  }
  private refreshInput(input:HTMLTextAreaElement,record=true){
    const current=this.session;
    if(!current||current.input!==input||current.layoutValue===input.value)return;
    current.layoutValue=input.value;current.frame.dataset.value=input.value;
    if(current.node?.kind==="topic")current.box=current.node.layout(input.value);
    this.reflow?.();
    if(record&&!this.composing)this.editDraft();
  }
  beginTyping(first?:string){
    if(this.card)return this.card.beginTyping(first);
    const current=this.session;
    if(!current)return false;
    const {input}=current;
    input.setSelectionRange(0,input.value.length);
    if(first!==undefined){
      input.setRangeText(first,0,input.value.length,"end");
      this.refreshInput(input);
    }
    return true;
  }
  finishOutside(target:EventTarget|null){
    if(this.card)return this.card.outside(target);
    const current=this.session;
    if(!current||target instanceof Node&&current.frame.contains(target))return false;
    // Let the native IME resolve its candidate before taking the value. A detached
    // input that never receives compositionend must not publish its preedit string.
    if(this.composing)current.input.blur();
    if(this.session===current)this.close(this.composing?this.beforeComposition.value:current.input.value,undefined,true);
    return true;
  }
  place(camera:Camera,visible:Readonly<{left:number;top:number;right:number;bottom:number}>,theme:WorkspaceTheme="light",backdrop?:string){
    if(this.card){this.card.place(camera,visible,theme,backdrop);return;}
    const current=this.session;
    if(!current)return;
    const {left,top,right,bottom}=visible;
    if(right<=left||bottom<=top)return;
    const width=right-left,height=bottom-top;
    const box=current.node?.kind==="topic"?current.node.present?.()??current.box:current.box;
    const origin=worldToScreen(box.at,camera), narrow=width<600;
    const boxW=box.width*camera.zoom,boxH=box.height*camera.zoom;
    const scaledFont=current.item.fontSize*camera.zoom;
    const freshText=current.target?.kind==="text"&&current.target.at!==undefined;
    const font=current.node?.kind==="label"||freshText?scaledFont:Math.max(narrow?16:12,scaledFont);
    const style=current.frame.style;
    if(current.node?.kind==="cell"){
      const item=current.item,cellW=Math.min(width,Math.max(32,boxW)),cellH=Math.min(height,Math.max(font*1.4+4,boxH));
      const paddingX=Math.min(8*camera.zoom,cellW/6),paddingY=Math.min(4*camera.zoom,cellH/6);
      const wrapWidth=Math.max(1,(cellW-2*paddingX)*item.fontSize/font);
      const linesHeight=textHeight(current.input.value,wrapWidth,item.fontSize,item)*font/item.fontSize;
      Object.assign(style,{left:Math.max(left,Math.min(origin.x,right-cellW))+"px",top:Math.max(top,Math.min(origin.y,bottom-cellH))+"px",
        width:cellW+"px",height:cellH+"px",font:standaloneFont(font,item),lineHeight:"1.4",
        color:standaloneInk(item,theme),backgroundColor:item.background??canvasThemes[theme].handle});
      Object.assign(current.input.style,{textAlign:item.align,paddingLeft:paddingX+"px",paddingRight:paddingX+"px",
        paddingTop:Math.max(paddingY,(cellH-linesHeight)/2)+"px",paddingBottom:paddingY+"px"});
      return;
    }
    if(current.node){
      const lineHeight=current.node.kind==="topic"?1.35:1.28;
      const topic=current.node.kind==="topic";
      const fieldWidth=topic?Math.min(Math.max(1,width-16),Math.max(48,current.box.width*font/current.item.fontSize)):Math.max(1,boxW);
      const maxHeight=topic?Math.max(1,height-16):Math.max(boxH,font*lineHeight+4);
      style.width=fieldWidth+"px";style.maxHeight=maxHeight+"px";
      style.font=nodeFont(font,current.node.weight);style.lineHeight=String(lineHeight);
      const fieldHeight=topic?Math.min(maxHeight,current.frame.offsetHeight||Math.max(boxH,font*lineHeight+4)):maxHeight;
      const x=topic?Math.max(left+8,Math.min(origin.x+(boxW-fieldWidth)/2,right-8-fieldWidth)):origin.x;
      const y=topic?Math.max(top+8+fieldHeight/2,Math.min(origin.y+boxH/2,bottom-8-fieldHeight/2)):origin.y+boxH/2;
      style.left=x+"px";style.top=y+"px";
      if(!topic)style.transform="translateY(-50%) rotate("+current.box.rotation+"rad)";
      // A small or off-screen node needs a legible surface at the clamped position.
      const fits=fieldWidth<=boxW+.5&&font*lineHeight<=boxH&&Math.abs(y-origin.y-boxH/2)<1&&Math.abs(x-origin.x)<1;
      const bg=canvasThemes[theme].bg;
      const surface=(current.node.kind==="label"&&current.node.backdrop?.())||labelSurface(current.node.fill,theme);
      style.backgroundColor=fits?"transparent":surface;
      style.color=current.node.kind==="label"?autoLabelInk("#212735",surface):current.node.surfaceInk?contrastInk(bg):current.item.color;
      return;
    }
    const boxWidth=freshText?boxW:Math.min(Math.max(1,width-18),Math.max(font*1.2,boxW));
    const item=current.item;
    const fitted=item.heightMode==="fixed"?item.height:textHeight(current.input.value,item.width,item.fontSize,item);
    const desiredHeight=Math.max(font*1.4,fitted*camera.zoom);
    const actionsHeight=current.actions!.offsetHeight||(narrow?52:38);
    const maxHeight=Math.max(1,height-actionsHeight-18),input=current.input.style;
    style.width=boxWidth+"px";input.font=standaloneFont(font,item);input.lineHeight="1.4";
    input.overflowY="hidden";input.height=Math.min(desiredHeight,maxHeight)+"px";
    const contentHeight=item.heightMode==="fixed"?desiredHeight:Math.max(desiredHeight,current.input.scrollHeight||0);
    const targetHeight=Math.min(contentHeight,maxHeight);
    const aligned=textBoxWithSize(item,item.width,fitted);
    const projected=worldToScreen(aligned.at,camera);
    let x=Math.max(left+8,Math.min(projected.x,right-boxWidth-10));
    let y=Math.max(top+8,Math.min(projected.y,bottom-targetHeight-actionsHeight-10));
    let rotation=0,actionOffset=0;
    if(item.rotation&&Math.abs(boxWidth-boxW)<1&&Math.abs(targetHeight-fitted*camera.zoom)<1){
      const extent=boxBounds(aligned),min=worldToScreen(extent.min,camera),max=worldToScreen(extent.max,camera);
      if(min.x>=left&&max.x<=right&&min.y>=top&&max.y+actionsHeight<=bottom){
        x=projected.x;y=projected.y;rotation=item.rotation;actionOffset=max.y-y-targetHeight;
      }
    }
    style.left=x+"px";style.top=y+"px";
    input.transform=rotation?"rotate("+rotation+"rad)":"";
    const actionsWidth=current.actions!.offsetWidth||(narrow?110:94);
    current.actions!.style.left=Math.max(left+8-x,Math.min(boxWidth-actionsWidth,right-8-x-actionsWidth))+"px";
    current.actions!.style.marginTop=actionOffset+"px";
    input.height=targetHeight+"px";input.overflowY=item.heightMode==="fixed"||contentHeight>maxHeight?"auto":"hidden";
    input.color=standaloneInk(item,theme);input.textAlign=item.align;
    input.backgroundColor=item.background??"transparent";
  }
  private submit(follow?:Follow){
    if(!this.session||this.composing)return;
    this.close(this.session.input.value,follow);
  }
  close(text?:string,follow?:Follow,outside=false){
    if(this.card){this.endCard?.(text!==undefined,outside);return;}
    const current=this.session;
    if(!current)return;
    this.session=undefined;this.composing=false;
    current.unmount();this.clearDraft();current.finish(text,follow,outside);
  }
}
