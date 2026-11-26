import {objectEditingView} from "./object-editing-view.ts";
import type {ObjectEditingView} from "./object-editing-view.ts";
import {formatMarkdown} from "../features/markdown-format.ts";
import type {MarkdownAction} from "../features/markdown-format.ts";
import {MAX_CARD_TEXT} from "../core/card.ts";
import type {CardObject} from "../core/document.ts";
import {worldToScreen} from "../core/geometry.ts";
import type {Camera} from "../core/geometry.ts";
import {cardInk,cardLayout,cardPadding,cardPlaceholderInk,fittedCard} from "../features/card-content.ts";
import {boundedTextEdit,normalizeBreaks} from "../features/text-layout.ts";
import {MarkdownField} from "./markdown-field.ts";
import type {SourceRange} from "./markdown-field.ts";
import {fontChoices} from "../platform/text-metrics.ts";
import {labelSurface} from "../platform/theme.ts";
import type {WorkspaceTheme} from "../platform/theme.ts";
import type {FormatCapability,FormatChange,FormatGesture,ScreenArea} from "./text-format-bar.ts";

export const cardCapabilities:readonly FormatCapability[]=["background","ink","family","size","bold","italic","strike","underline","align","list","link"];
export const stickyCapabilities:readonly FormatCapability[]=["size","background","bold","align"];
export function styledCard(item:CardObject,change:FormatChange):CardObject{
  if(item.content.kind==="sticky"){
    const {fontSize,fontWeight,align,background}=change,content={...item.content};
    if(fontSize!==undefined)content.fontSize=fontSize;
    if(fontWeight!==undefined)content.fontWeight=fontWeight;
    if(align!==undefined)content.align=align;
    return {...item,content,fill:background??item.fill};
  }
  const {colorMode,background,list:_list,link:_link,...face}=change;
  const content={...item.content,...face};
  if(colorMode==="auto")delete content.color;
  return {...item,fill:background??item.fill,content};
}
type Snapshot={item:CardObject;start:number;end:number};
/** Rich clipboard producers normally supply text/plain. Read HTML-only selections as inert text. */
function clipboardText(data:DataTransfer){
  const plain=data.getData("text/plain");
  if(plain||!data.types.includes("text/html"))return normalizeBreaks(plain);
  const html=data.getData("text/html");
  const template=document.createElement("template");template.innerHTML=html;
  const lines:string[]=[];let row="";
  const visit=(node:Node,pre=false)=>{
    if(node.nodeType===Node.TEXT_NODE){
      const text=node.textContent??"",value=pre?text:text.replace(/[\t\n\r\f ]+/g," ");
      row+=!pre&&(!row||row.endsWith(" "))?value.replace(/^ /,""):value;return;
    }
    if(!(node instanceof HTMLElement)||node.hidden||node.style.display==="none"||node.style.visibility==="hidden"||["SCRIPT","STYLE","TEMPLATE"].includes(node.tagName))return;
    if(node.tagName==="BR"){lines.push(row);row="";return;}
    const block=/^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|TR)$/.test(node.tagName);
    if(block&&row){lines.push(row);row="";}
    const before=lines.length;
    node.childNodes.forEach(child=>visit(child,pre||node.tagName==="PRE"));
    if(block&&(row||lines.length===before)){lines.push(row);row="";}
  };
  template.content.childNodes.forEach(child=>visit(child));if(row)lines.push(row);
  return normalizeBreaks(lines.join("\n"));
}
export class CardEditor{
  readonly frame:HTMLElement;
  private plain:HTMLTextAreaElement;
  private rich:MarkdownField;
  private sheet:HTMLElement;
  private view:ReturnType<ObjectEditingView["card"]>;
  private sourceMode=false;
  private revealField=true;
  private clippedTop=0;
  private past:Snapshot[]=[];private future:Snapshot[]=[];
  private last:Snapshot;
  private gesture?:FormatGesture;
  composing=false;private endedAt=-Infinity;
  item:CardObject;
  private changed:()=>void;
  private finish:(save:boolean,outside:boolean)=>void;
  private rememberSelection=()=>{
    if(!this.formatted||this.composing||!this.frame.isConnected)return;
    const pos=this.rich.selection();
    if(pos&&(pos.start!==this.last.start||pos.end!==this.last.end)){this.last={item:this.item,...pos};this.changed();}
  };
  constructor(mount:HTMLElement,item:CardObject,changed:()=>void,finish:(save:boolean,outside:boolean)=>void,at=0){
    this.item=item;this.last={item,start:at,end:at};this.changed=changed;this.finish=finish;
    const host=objectEditingView(mount);
    this.view=host.card({kind:item.content.kind,changeMode:()=>{
      if(this.composing)return;
      const pos=this.selection();this.sourceMode=!this.sourceMode;this.render(pos.start,pos.end);this.changed();
    }});
    const {frame,plain}=this.view;
    this.frame=frame;this.plain=plain;this.sheet=this.view.sheet;this.rich=new MarkdownField(this.view.rich);
    for(const field of [plain,this.rich.root]){
      field.addEventListener("compositionstart",()=>{this.last={item:this.item,...this.selection()};this.composing=true;frame.dataset.composing="true";});
      field.addEventListener("compositionend",()=>{this.composing=false;delete frame.dataset.composing;this.endedAt=performance.now();this.sync();});
      field.addEventListener("input",event=>{if(!this.composing&&!(event as InputEvent).isComposing)this.sync();});
    }
    plain.addEventListener("select",()=>{
      if(this.composing||this.formatted)return;
      const pos=this.selection();if(pos.start!==this.last.start||pos.end!==this.last.end){this.last={item:this.item,...pos};this.changed();}
    });
    plain.addEventListener("paste",e=>{
      if(this.item.content.kind!=="sticky"||this.composing||!e.clipboardData)return;
      e.preventDefault();const value=clipboardText(e.clipboardData);if(!value)return;
      plain.setRangeText(value,plain.selectionStart,plain.selectionEnd,"end");this.sync();
    });
    this.rich.root.addEventListener("paste",e=>{
      if(this.composing||!e.clipboardData)return;
      const data=e.clipboardData;
      e.preventDefault();const value=normalizeBreaks((data.types.includes("text/markdown")&&data.getData("text/markdown"))||clipboardText(data));
      if(value)this.replaceRich(value);
    });
    this.rich.root.addEventListener("drop",e=>{
      if(!e.dataTransfer||e.dataTransfer.files.length)return;
      e.preventDefault();if(!this.composing)this.replaceRich(normalizeBreaks(e.dataTransfer.getData("text/plain")));
    });
    this.rich.root.addEventListener("beforeinput",event=>{
      const e=event as InputEvent;
      if(this.composing||e.isComposing)return;
      if(e.inputType.startsWith("delete")&&this.rich.selectsDocument()){
        e.preventDefault();this.edit(0,this.item.label.length,"",0);return;
      }
      if(e.inputType==="historyUndo"||e.inputType==="historyRedo"){e.preventDefault();this.history(e.inputType==="historyRedo");}
      if(e.inputType==="insertParagraph"||e.inputType==="insertLineBreak"){
        e.preventDefault();let pos=this.selection();
        if(pos.start!==pos.end){this.replaceRich("");pos=this.selection();}
        const next=this.rich.lineBreak(this.item.label,pos.start);
        this.edit(next.from,next.to,next.text,next.start);
      }
    });
    document.addEventListener("selectionchange",this.rememberSelection,{signal:host.signal});
    frame.addEventListener("keydown",e=>this.key(e));this.render(at);
  }
  private get formatted(){return this.item.content.kind==="markdown"&&!this.sourceMode;}
  get input(){return this.formatted?this.rich.root:this.plain;}
  get editingSource(){return this.sourceMode;}
  selection():SourceRange{
    return this.formatted?this.rich.selection()??{start:this.last.start,end:this.last.end}:{start:this.plain.selectionStart,end:this.plain.selectionEnd};
  }
  get snapshot():Snapshot{return this.composing?this.last:{item:this.item,...this.selection()};}
  private record(item:CardObject,range:SourceRange,gesture?:FormatGesture){
    if(!gesture||this.gesture!==gesture)this.past.push(this.last);
    this.gesture=gesture;if(this.past.length>80)this.past.shift();this.future=[];
    this.item=item;this.last={item,...range};
  }
  private sync(){
    const data=this.formatted?this.rich.read():{source:this.plain.value,selection:this.selection()};
    const text=boundedTextEdit(this.item.label,data.source,MAX_CARD_TEXT);
    if(text===this.item.label&&text===data.source)return;
    const start=Math.min(data.selection.start,text.length),end=Math.min(data.selection.end,text.length);
    this.record({...this.item,label:text},{start,end});
    if(this.formatted||text!==data.source)this.render(start,end);else this.fitInput();
    this.changed();
  }
  private edit(from:number,to:number,insert:string,start:number,end=start){
    const label=boundedTextEdit(this.item.label,this.item.label.slice(0,from)+insert+this.item.label.slice(to),MAX_CARD_TEXT);
    if(label!==this.item.label)this.record({...this.item,label},{start,end});
    this.render(Math.min(start,label.length),Math.min(end,label.length));this.changed();
  }
  private replaceRich(value:string){
    const pos=this.selection(),text=this.item.label;
    if(!text||pos.start===0&&pos.end===text.length){this.edit(0,text.length,value,value.length);return;}
    this.rich.replaceVisible(value);this.sync();
  }
  private fitInput(){
    if(this.formatted)return;
    const el=this.plain;el.style.height="auto";el.style.height=Math.max(el.scrollHeight||0,this.item.content.fontSize)+"px";
  }
  focus(){
    if(document.activeElement===this.input)return;
    const {start,end}=this.last;
    this.input.focus({preventScroll:true});
    if(this.formatted)this.rich.setRange(start,end);else this.plain.setSelectionRange(start,end);
  }
  private render(start:number,end=start,takeFocus=true){
    this.revealField=true;
    const {item,plain}=this,field=this.input;
    this.view.mode(this.sourceMode);
    if(this.formatted){
      this.rich.render(item.label,item.content.fontSize);
      if(takeFocus){field.focus({preventScroll:true});this.rich.setRange(start,end);}
    }else{
      plain.value=item.label;plain.style.fontSize=item.content.fontSize+"px";if(takeFocus)field.focus({preventScroll:true});
      plain.setSelectionRange(start,end);this.fitInput();
    }
    this.last={item,start,end};
  }
  restore(text:string,start:number,end:number,sourceMode=false){
    this.item={...this.item,label:text};this.sourceMode=sourceMode;this.render(start,end);
  }
  beginTyping(first?:string){
    if(first!==undefined)this.edit(0,this.item.label.length,first,first.length);
    else this.render(0,this.item.label.length);
    return true;
  }
  history(redo:boolean){
    const from=redo?this.future:this.past,to=redo?this.past:this.future;
    const last=from.pop();if(last){to.push(this.snapshot);this.item=last.item;this.render(last.start,last.end);this.changed();}
  }
  private key(e:KeyboardEvent){
    const cmd=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();
    if(cmd&&key==="s")return;
    e.stopPropagation();
    if(this.composing||e.isComposing||e.keyCode===229||!cmd&&["enter","escape"].includes(key)&&performance.now()-this.endedAt<45)return;
    if(key==="escape"||cmd&&key==="enter"){e.preventDefault();this.finish(key==="enter",false);return;}
    if(cmd&&(key==="z"||key==="y")){e.preventDefault();this.history(key==="y"||e.shiftKey);return;}
    if(cmd&&(key==="b"||key==="i")){
      e.preventDefault();
      if(this.item.content.kind==="markdown")this.markdown({mark:key==="b"?"bold":"italic"});
      else if(key==="b")this.apply({fontWeight:this.item.content.fontWeight===700?400:700});
    }
  }
  markdown(action:MarkdownAction){
    if(this.composing||this.item.content.kind!=="markdown")return;
    const next=formatMarkdown(this.item.label,this.selection(),action);
    if(!next||next.source===this.item.label||next.source.length>MAX_CARD_TEXT)return;
    this.edit(0,this.item.label.length,next.source,next.start,next.end);
  }
  apply(change:FormatChange,gesture?:FormatGesture){
    if(this.composing)return;
    const pos=this.selection();
    this.record(styledCard(this.item,change),pos,gesture);this.render(pos.start,pos.end,!gesture);this.changed();
  }
  dispose(){document.removeEventListener("selectionchange",this.rememberSelection);this.view.close();}
  place(camera:Camera,area:ScreenArea,theme:WorkspaceTheme,backdrop?:string){
    const item=this.item,{frame,sheet}=this,p=worldToScreen(item.at,camera),z=camera.zoom;
    const h=Math.max(item.height,cardLayout(item).height);
    // A visible card keeps the canvas scale, wrap width and origin. Only its scrollport is clipped.
    const readable=Math.min(1,14/item.content.fontSize);
    const anchored=!this.sourceMode&&p.x+item.width*z>area.left&&p.x<area.right&&p.y+h*z>area.top&&p.y<area.bottom;
    const scale=anchored?z:Math.max(readable,Math.min(z,(area.right-area.left-12)/item.width));
    const w=anchored?item.width:Math.max(1,Math.min(item.width,(area.right-area.left-12)/scale));
    const clip=anchored&&!item.rotation?Math.max(0,(area.top-p.y)/scale):0;
    const visibleH=anchored?(item.rotation?h:Math.max(1,Math.min(h-clip,(area.bottom-Math.max(p.y,area.top))/scale))):
      Math.max(72,Math.min(h,(area.bottom-area.top-24)/scale));
    const x=anchored?p.x:Math.max(area.left+4,Math.min(p.x,area.right-w*scale-4));
    const y=anchored?p.y+clip*scale:Math.max(area.top+4,Math.min(p.y,area.bottom-visibleH*scale-4));
    frame.style.left=x+"px";frame.style.top=y+"px";frame.style.width=w+"px";frame.style.height=visibleH+"px";
    frame.style.transform="scale("+scale+")";
    if(item.rotation&&visibleH===h&&Math.abs(x-p.x)<1&&Math.abs(y-p.y)<1)frame.style.transform+=" translate("+w/2+"px,"+h/2+"px) rotate("+item.rotation+"rad) translate("+(-w/2)+"px,"+(-h/2)+"px)";
    frame.style.color=cardInk(item,theme,backdrop);frame.style.backgroundColor=item.fill==="transparent"&&anchored?"transparent":labelSurface(item.fill,theme);
    frame.style.setProperty("--card-placeholder-ink",cardPlaceholderInk(item,theme,backdrop));
    frame.style.fontFamily=fontChoices[item.content.fontFamily??"system"].stack;frame.style.fontStyle=item.content.italic?"italic":"normal";
    frame.style.fontWeight=String(item.content.fontWeight??400);frame.style.fontSize=item.content.fontSize+"px";
    frame.style.textAlign=item.content.align??"left";sheet.style.textDecoration=[item.content.strike?"line-through":"",item.content.underline?"underline":""].filter(Boolean).join(" ");
    sheet.style.padding=cardPadding(item.content.kind,w,item.content.fontSize)+"px";this.fitInput();
    if(clip!==this.clippedTop){sheet.scrollTop+=clip-this.clippedTop;this.clippedTop=clip;}
    if(this.revealField){
      const selection=this.formatted?window.getSelection():undefined;
      const range=selection?.rangeCount?selection.getRangeAt(0).cloneRange():undefined;range?.collapse(false);
      const caret=range?.getBoundingClientRect(),field=caret?.height?caret:this.input.getBoundingClientRect(),paper=sheet.getBoundingClientRect();
      if(field.top<paper.top)sheet.scrollTop+=(field.top-paper.top)/scale;
      else if(field.height<=paper.height&&field.bottom>paper.bottom)sheet.scrollTop+=(field.bottom-paper.bottom)/scale;
      this.revealField=false;
    }
  }
  outside(target:EventTarget|null){
    if(target instanceof Node&&this.frame.contains(target))return false;
    if(this.composing)this.input.blur();
    this.finish(true,true);return true;
  }
  result(){return fittedCard(this.item);}
}
