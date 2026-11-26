import {blockSize,cardBlocks} from "../features/card-content.ts";
import type {InlineMark} from "../features/card-content.ts";

type Delimiters={open:string;close:string};
export type SourceRange={start:number;end:number};
type Stop={node:Node;at:number;length:number};
const inlineTag={bold:"strong",italic:"em",strike:"s",code:"code",link:"a"} as const;

/** Source delimiters belong to the displayed DOM nodes. Browser selections, native edits and IME
 * operate on their visible text; the writer restores the original delimiters around those edits. */
export class MarkdownField{
  readonly root:HTMLDivElement;
  private syntax=new WeakMap<Node,Delimiters>();
  private stops:Stop[]=[];
  private offsets=new WeakMap<Node,number>();
  constructor(root:HTMLDivElement){
    this.root=root;
    this.root.addEventListener("click",e=>{
      const link=e.target instanceof Element&&e.target.closest("a");
      if(link&&!e.ctrlKey&&!e.metaKey)e.preventDefault();
    });
  }
  render(source:string,size:number){
    this.root.toggleAttribute("data-empty",!source);
    this.stops=[];this.offsets=new WeakMap();
    const all=document.createDocumentFragment();
    for(const block of cardBlocks(source)){
      const el=document.createElement(block.kind==="heading"?"h"+block.level:block.kind==="quote"?"blockquote":block.kind==="code"?"pre":"p");
      el.className="card-block";el.dataset.block=block.kind;el.style.fontSize=blockSize(block,size)+"px";
      if(block.marker){el.dataset.marker=block.marker;el.style.paddingInlineStart=(1.5+(block.level??0))+"em";}
      this.syntax.set(el,{open:source.slice(block.start,block.bodyStart),close:source.slice(block.bodyEnd,block.end)});
      this.offsets.set(el,block.bodyStart);
      const stack:{mark:InlineMark;el:HTMLElement}[]=[];
      for(const run of block.runs){
        const marks=run.marks??[];
        let shared=0;while(shared<stack.length&&stack[shared].mark===marks[shared])shared++;
        stack.length=shared;
        let parent=stack.at(-1)?.el??el;
        for(const mark of marks.slice(shared)){
          const inline=document.createElement(inlineTag[mark.kind]);
          if(mark.url){
            inline.title=mark.url;
            if(/^(https?:\/\/|mailto:)/i.test(mark.url)){inline.setAttribute("href",mark.url);inline.setAttribute("target","_blank");inline.setAttribute("rel","noopener noreferrer");}
          }
          this.syntax.set(inline,mark);parent.append(inline);parent=inline;stack.push({mark,el:inline});
        }
        const at=run.at??block.bodyStart,text=document.createTextNode(run.text);
        parent.append(text);this.offsets.set(text,at);
        this.stops.push({node:run.text?text:parent,at,length:run.text.length});
      }
      if(!el.textContent)el.append(document.createElement("br"));
      all.append(el);
    }
    this.root.replaceChildren(all);
  }
  setRange(start:number,end=start){
    const locate=(n:number)=>{
      let previous=this.stops[0];
      if(n<=previous.at)return {node:previous.node,index:0};
      for(const stop of this.stops){
        if(n<stop.at)return n-previous.at-previous.length<stop.at-n?{node:previous.node,index:previous.length}:{node:stop.node,index:0};
        if(n<=stop.at+stop.length)return {node:stop.node,index:n-stop.at};
        previous=stop;
      }
      return {node:previous.node,index:previous.length};
    };
    const a=locate(start),b=locate(end),r=document.createRange();
    r.setStart(a.node,Math.max(0,a.index));r.setEnd(b.node,Math.max(0,b.index));const s=window.getSelection();
    s?.removeAllRanges();s?.addRange(r);
  }
  selection():SourceRange|undefined{
    const r=this.range();if(!r)return;
    const a=this.offsets.get(r.startContainer),b=this.offsets.get(r.endContainer);
    if(r.startContainer.nodeType===Node.TEXT_NODE&&r.endContainer.nodeType===Node.TEXT_NODE&&a!==undefined&&b!==undefined){
      return {start:a+r.startOffset,end:b+r.endOffset};
    }
    return this.read().selection;
  }
  private range(){
    const sel=window.getSelection();if(!sel?.rangeCount)return;
    const r=sel.getRangeAt(0);if(this.root.contains(r.commonAncestorContainer))return r;
  }
  selectsDocument(){
    const range=this.range(),first=this.stops[0],last=this.stops.at(-1);
    return Boolean(range&&!range.collapsed&&first&&last&&this.root.contains(first.node)&&this.root.contains(last.node)&&
      range.comparePoint(first.node,0)===0&&range.comparePoint(last.node,last.length)===0);
  }
  /** Used after browser-native replacement, deletion, cut or composition. Text is never parsed as HTML. */
  read(){
    const range=this.range(),parts:string[]=[];let offset=0,start=0,end=0;
    const write=(s:string)=>{parts.push(s);offset+=s.length;};
    const point=(node:Node,i:number)=>{
      if(range?.startContainer===node&&range.startOffset===i)start=offset;
      if(range?.endContainer===node&&range.endOffset===i)end=offset;
    };
    const visit=(node:Node)=>{
      if(node.nodeType===Node.TEXT_NODE){
        if(range?.startContainer===node)start=offset+range.startOffset;
        if(range?.endContainer===node)end=offset+range.endOffset;
        write(node.textContent??"");return;
      }
      if(!(node instanceof HTMLElement))return;
      const tag=node.tagName;
      if(tag==="BR"){point(node,0);if(node.nextSibling)write("\n");return;}
      let syntax=this.syntax.get(node);
      if(!syntax&&(tag==="B"||tag==="STRONG"||tag==="I"||tag==="EM")){
        const mark=tag==="I"||tag==="EM"?"*":"**";syntax={open:mark,close:mark};
      }
      if(syntax&&(node.dataset.block||node.textContent)){
        write(syntax.open);
        if(node.dataset.block==="code"&&node.textContent&&!syntax.open.endsWith("\n"))write("\n");
      }
      const children=Array.from(node.childNodes);
      children.forEach((child,i)=>{
        if(i&&(node===this.root||child instanceof HTMLElement&&child.tagName==="DIV"))write("\n");
        point(node,i);visit(child);
      });
      point(node,children.length);
      if(syntax&&(node.dataset.block||node.textContent)){
        if(node.dataset.block==="code"&&syntax.close&&!syntax.close.startsWith("\n")&&node.textContent)write("\n");
        write(syntax.close);
      }
    };
    visit(this.root);
    return {source:parts.join(""),selection:{start,end}};
  }
  replaceVisible(value:string){
    const r=this.range();if(!r)return;
    r.deleteContents();const text=document.createTextNode(value);r.insertNode(text);r.setStartAfter(text);r.collapse(true);
    const s=window.getSelection();s?.removeAllRanges();s?.addRange(r);
  }
  /** Split with balanced inline marks. List/quote structure continues on the new line. */
  lineBreak(source:string,at:number){
    const block=cardBlocks(source).find(b=>at<=b.end)!;
    if(!block||block.kind==="code")return {text:"\n",start:at+1,from:at,to:at};
    let prefix="";
    if(block.kind==="list"||block.kind==="quote"){
      if(!block.runs.some(r=>r.text.length))return {text:"",from:block.start,to:block.end,start:block.start};
      prefix=source.slice(block.start,block.bodyStart).replace(/\d+(?=[.)]\s)/,s=>String(Number(s)+1));
    }
    const last=block.runs.at(-1)!;
    if(at>=(last.at??at)+last.text.length){
      const text="\n"+prefix;
      return {text,from:block.end,to:block.end,start:block.end+text.length};
    }
    const marks=block.runs.find(run=>run.at!==undefined&&at>=run.at&&at<=run.at+run.text.length)?.marks??[];
    const spanning:InlineMark[]=[];let split=at;
    for(const mark of marks){
      const leaves=block.runs.filter(run=>run.marks?.includes(mark)),first=leaves[0],last=leaves.at(-1)!;
      if(at===first.at)split-=mark.open.length;
      else if(at===last.at!+last.text.length)split+=mark.close.length;
      else spanning.push(mark);
    }
    const close=[...spanning].reverse().map(m=>m.close).join(""),open=spanning.map(m=>m.open).join("");
    const text=close+"\n"+prefix+open;return {text,from:split,to:split,start:split+text.length};
  }
}
