import {MAX_CARD_TEXT} from "../core/card.ts";
import type {CardKind,CardStyle} from "../core/card.ts";
import type {CardObject} from "../core/document.ts";
import {gridPoint} from "../core/geometry.ts";
import type {Point} from "../core/geometry.ts";
import {allocateId} from "../core/id.ts";
import {autoLabelInk,contrastInk,labelSurface} from "../platform/theme.ts";
import type {WorkspaceTheme} from "../platform/theme.ts";
import {standaloneFont,topicMeasureContext} from "../platform/text-metrics.ts";
import {estimatedTextWidth,normalizeBreaks,textRows} from "./text-layout.ts";

export type InlineMark=Readonly<{kind:"bold"|"italic"|"strike"|"code"|"link";open:string;close:string;url?:string}>;
export type Inline=Readonly<{text:string;at?:number;marks?:readonly InlineMark[];bold?:boolean;italic?:boolean;strike?:boolean;code?:boolean;link?:string}>;
export type CardBlock=Readonly<{kind:"heading"|"paragraph"|"list"|"quote"|"code"|"space";start:number;end:number;bodyStart:number;bodyEnd:number;runs:readonly Inline[];level?:number;marker?:string}>;
type Delimiter={char:string;start:number;end:number;length:number;both:boolean};
type InlineSpan={start:number;end:number;mark:InlineMark};
const inlineToken=/\x60([^\x60\n]+)\x60|\[([^[\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*+|_+|~{2,}/g;
const punctuation=/[\p{P}\p{S}]/u;

function inlineRuns(text:string,at:number,inherited:readonly InlineMark[]=[]):Inline[]{
  const open:Delimiter[]=[],spans:InlineSpan[]=[];
  // Closing delimiters match the nearest compatible opener. A run of three
  // asterisks may close both emphasis and strong emphasis at the same boundary.
  const bottoms=new Map<string,number>();
  for(const token of text.matchAll(inlineToken)){
    const raw=token[0],index=token.index;
    if(token[1]||token[2]){
      const mark:InlineMark=token[1]?{kind:"code",open:raw[0],close:raw[0]}:
        {kind:"link",open:"[",close:"]("+token[3]+")",url:token[3]};
      spans.push({start:index,end:index+raw.length,mark});continue;
    }
    const char=raw[0],before=text[index-1]??" ",after=text[index+raw.length]??" ";
    const left=!/\s/.test(after)&&(!punctuation.test(after)||/\s/.test(before)||punctuation.test(before));
    const right=!/\s/.test(before)&&(!punctuation.test(before)||/\s/.test(after)||punctuation.test(after));
    const canOpen=left&&(char!=="_"||!right||punctuation.test(before)),canClose=right&&(char!=="_"||!left||punctuation.test(after));
    let start=index;const end=index+raw.length;
    if(canClose){
      const key=char+Number(canOpen)+raw.length%3;
      while(end-start>=(char==="~"?2:1)){
        let i=open.length-1;
        for(;i>=0&&open[i].start>=(bottoms.get(key)??0);i--){
          const d=open[i];
          if(d.char===char&&!(char!=="~"&&(canOpen||d.both)&&(d.length+raw.length)%3===0&&(raw.length%3!==0||d.length%3!==0)))break;
        }
        if(i<0||open[i].start<(bottoms.get(key)??0)){bottoms.set(key,index);break;}
        const d=open[i],n=Math.min(d.end-d.start,end-start)>=2?2:1,delimiter=char.repeat(n);
        spans.push({start:d.end-n,end:start+n,mark:{kind:char==="~"?"strike":n===2?"bold":"italic",open:delimiter,close:delimiter}});
        d.end-=n;start+=n;open.length=i+(d.end-d.start>=(char==="~"?2:1)?1:0);
      }
    }
    if(canOpen&&end-start>=(char==="~"?2:1))open.push({char,start,end,length:raw.length,both:canClose});
  }
  const marks=[...inherited],runs:Inline[]=[];
  function append(start:number,end:number){
    if(start===end&&text.length)return;
    const flags:Record<string,string|boolean>={};
    for(const m of marks)flags[m.kind]=m.url??true;
    runs.push({text:text.slice(start,end),at:at+start,...(marks.length?{marks:[...marks],...flags}:{})});
  }
  const events=spans.flatMap(s=>[{at:s.start,opening:true,mark:s.mark},{at:s.end-s.mark.close.length,opening:false,mark:s.mark}]).sort((a,b)=>a.at-b.at);
  let cursor=0;
  for(const e of events){
    if(e.at>cursor){
      if(marks.at(-1)?.kind==="link")runs.push(...inlineRuns(text.slice(cursor,e.at),at+cursor,marks));
      else append(cursor,e.at);
    }
    if(e.opening)marks.push(e.mark);else marks.pop();
    cursor=e.at+(e.opening?e.mark.open.length:e.mark.close.length);
  }
  if(cursor<text.length||!runs.length)append(cursor,text.length);
  return runs;
}
const fence=/^ {0,3}(`{3,}|~{3,})(.*)$/;
/** Offsets address the LF-normalized source, including authored prefixes and fence lines. */
export function cardBlocks(source:string):CardBlock[]{
  const lines=source.split("\n"),blocks:CardBlock[]=[];
  let offset=0,i=0;
  while(i<lines.length){
    const line=lines[i++],start=offset;offset+=line.length+1;
    const opening=fence.exec(line);
    if(opening){
      const body:string[]=[],close=new RegExp("^ {0,3}"+opening[1][0]+"{"+opening[1].length+",}\\s*$");
      while(i<lines.length){const row=lines[i++];offset+=row.length+1;if(close.test(row))break;body.push(row);}
      const text=body.join("\n"),bodyStart=Math.min(offset-1,start+line.length+1);
      blocks.push({kind:"code",start,end:offset-1,bodyStart,bodyEnd:bodyStart+text.length,runs:[{text,at:bodyStart,code:true}]});continue;
    }
    const heading=/^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    const list=/^([ \t]*)([-*+]|\d+[.)])[ \t]+(.*)$/.exec(line);
    const quote=/^ {0,3}>[ \t]?(.*)$/.exec(line);
    const body=heading?.[2]??list?.[3]??quote?.[1]??line,end=offset-1,bodyStart=end-body.length;
    const base={start,end,bodyStart,bodyEnd:end,runs:inlineRuns(body,bodyStart)};
    if(heading)blocks.push({...base,kind:"heading",level:heading[1].length});
    else if(list)blocks.push({...base,kind:"list",marker:/^\d/.test(list[2])?list[2]:"•",level:Math.min(8,Math.floor(list[1].replace(/\t/g,"  ").length/2))});
    else if(quote)blocks.push({...base,kind:"quote"});
    else blocks.push({...base,kind:line.trim()?"paragraph":"space"});
  }
  return blocks;
}
export const cardName=(kind:CardKind)=>kind==="sticky"?"便签":"Markdown 文档";
export const cardPlaceholders={sticky:"写点什么…",markdown:"输入或粘贴 Markdown…"} as const;
export function hasMarkdown(source:string){
  if(source.length>MAX_CARD_TEXT)return false;
  return cardBlocks(source).some(b=>!["paragraph","space"].includes(b.kind)||b.runs.some(r=>r.marks?.length));
}
function stickyBlocks(source:string):CardBlock[]{
  let start=0;
  return source.split("\n").map(text=>{
    const at=start,end=at+text.length;start=end+1;
    return {kind:"paragraph",start:at,end,bodyStart:at,bodyEnd:end,runs:[{text,at}]};
  });
}
export function cardTitle(item:CardObject){
  const first=item.label.trimStart().split("\n",1)[0]??"";
  if(item.content.kind==="sticky")return first||cardName("sticky");
  return cardBlocks(first)[0].runs.map(r=>r.text).join("").trim()||cardName(item.content.kind);
}
function cardSurface(item:CardObject,theme:WorkspaceTheme,backdrop?:string){
  return item.fill==="transparent"&&backdrop?backdrop:labelSurface(item.fill,theme);
}
export function cardInk(item:CardObject,theme:WorkspaceTheme,backdrop?:string){
  return (item.content.kind==="markdown"&&item.content.color)||autoLabelInk("#263041",cardSurface(item,theme,backdrop));
}
export function cardPlaceholderInk(item:CardObject,theme:WorkspaceTheme,backdrop?:string){
  const surface=cardSurface(item,theme,backdrop);
  return autoLabelInk(contrastInk(surface)==="#fff"?"#b5becc":"#626d7c",surface);
}
export const cardPadding=(kind:CardKind,width:number,size:number)=>Math.min(width*.14,kind==="markdown"?Math.max(20,size*1.75):Math.max(12,size*.9));
export function blockSize(block:CardBlock,base:number){
  return base*(block.kind==="heading"?[1,2,1.55,1.28,1.13,1.05,1][block.level??1]:block.kind==="code"?.91:1);
}
export function runFont(style:CardStyle,block:CardBlock,run:Inline){
  const size=blockSize(block,style.fontSize),weight=run.bold||block.kind==="heading"?700:style.fontWeight??400;
  if(run.code)return (style.italic||run.italic?"italic ":"")+weight+" "+size+'px Consolas, "Cascadia Mono", monospace';
  return standaloneFont(size,{fontFamily:style.fontFamily,fontWeight:weight,italic:style.italic||run.italic});
}
export type CardGlyphs=Readonly<{text:string;at:number;marker?:true;x:number;baseline:number;width:number;font:string;size:number;link?:boolean;strike?:boolean;underline?:boolean}>;
type Band=Readonly<{kind:"quote"|"code";x:number;y:number;width:number;height:number}>;
export type CardLayout=Readonly<{glyphs:readonly CardGlyphs[];bands:readonly Band[];height:number;blocks:readonly {start:number;top:number;bottom:number}[]}>;
const wordParts=/[A-Za-z0-9_]+|[^\S\n]+|[^\sA-Za-z0-9_]+|\n/gu;
const cache=new WeakMap<CardStyle,{label:string;width:number;context?:CanvasRenderingContext2D;layout:CardLayout}>();
export function cardLayout(item:Pick<CardObject,"content"|"width"|"label">):CardLayout{
  const {width,content:style,label}=item,ctx=topicMeasureContext(),cached=cache.get(style);
  if(cached?.label===label&&cached.width===width&&cached.context===ctx)return cached.layout;
  const pad=cardPadding(style.kind,width,style.fontSize),glyphs:CardGlyphs[]=[],bands:Band[]=[],blocks:{start:number;top:number;bottom:number}[]=[];
  let y=pad;
  for(const block of style.kind==="sticky"?stickyBlocks(label):cardBlocks(label)){
    const size=blockSize(block,style.fontSize),line=size*(block.kind==="heading"?1.28:1.5);
    const indent=block.kind==="list"?size*(1.5+(block.level??0)):block.kind==="quote"||block.kind==="code"?size*.8:0;
    const left=pad+Math.min(indent,Math.max(0,width-2*pad-size)),room=Math.max(1,width-pad-left-(block.kind==="code"?size*.6:0));
    const top=y;
    if(block.kind==="space"){y+=line*.58;blocks.push({start:block.start,top,bottom:y});continue;}
    if(block.kind==="heading"&&y>pad)y+=size*.23;
    if(block.kind==="code")y+=size*.5;
    let x=0,lineStart=glyphs.length;
    function endLine(){
      const shift=style.align==="right"?room-x:style.align==="center"?(room-x)/2:0;
      if(shift>0)for(let j=lineStart;j<glyphs.length;j++)glyphs[j]={...glyphs[j],x:glyphs[j].x+shift};
      y+=line;x=0;lineStart=glyphs.length;
    }
    if(block.marker)glyphs.push({text:block.marker,at:block.bodyStart,marker:true,x:Math.max(pad,left-size*1.4),baseline:y+size*1.05,width:size,font:runFont(style,block,{text:block.marker}),size});
    lineStart=glyphs.length;
    for(const run of block.runs){
      const font=runFont(style,block,run);
      let at=run.at??block.bodyStart;
      if(ctx)ctx.font=font;
      const measure=(s:string)=>ctx?ctx.measureText(s).width:estimatedTextWidth(s,size);
      const add=(s:string,w:number)=>{
        glyphs.push({text:s,at,x:left+x,baseline:y+(line-size)/2+size*.85,width:w,font,size,
          ...(run.link?{link:true}:{}),...(run.strike||style.strike?{strike:true}:{}),...(style.underline?{underline:true}:{})});x+=w;at+=s.length;
      };
      for(const token of run.text.match(wordParts)??[]){
        if(token==="\n"){endLine();at++;continue;}
        const w=measure(token);
        if(x>0&&x+w>room)endLine();
        if(w<=room){add(token,w);continue;}
        const rows=textRows(token,room,size,{measure});
        for(const [i,row] of rows.entries()){if(i)endLine();add(row,measure(row));}
      }
    }
    endLine();
    if(block.kind==="code"){y+=size*.5;bands.push({kind:"code",x:pad,y:top,width:width-2*pad,height:y-top});}
    if(block.kind==="quote")bands.push({kind:"quote",x:pad,y:top,width:Math.max(2,size*.15),height:y-top});
    blocks.push({start:block.start,top,bottom:y});
  }
  const layout={glyphs,bands,blocks,height:Math.ceil(y+pad)};
  cache.set(style,{label,width,context:ctx,layout});return layout;
}
/** Editor hints use normal card wrapping and alignment without changing the object's content or size. */
export function cardDisplayLayout(item:CardObject):CardLayout{
  return cardLayout(item.label?item:{...item,label:cardPlaceholders[item.content.kind]});
}
/** A source position under the painted glyphs, in the card's own coordinates. */
export function cardOffsetAt(item:CardObject,point:Point,inkOnly=false):number|undefined{
  const layout=cardDisplayLayout(item),row=layout.blocks.find(b=>point.y<b.bottom)??layout.blocks.at(-1);
  let nearest:CardGlyphs|undefined,best=Infinity;
  for(const glyph of layout.glyphs){
    if(row&&(glyph.baseline<row.top||glyph.baseline>row.bottom))continue;
    const dx=Math.max(0,glyph.x-point.x,point.x-glyph.x-glyph.width);
    const dy=Math.abs(point.y-(glyph.baseline-glyph.size*.32));
    if(inkOnly&&(dx>2||dy>glyph.size*.7))continue;
    const distance=Math.max(0,dy-glyph.size*.5)*item.width+dx;
    if(distance<best){nearest=glyph;best=distance;}
  }
  if(!nearest)return inkOnly?undefined:row?.start??0;
  if(!item.label)return 0;
  const g=nearest;
  if(g.marker||point.x<=g.x)return g.at;
  if(point.x>=g.x+g.width)return g.at+g.text.length;
  const ctx=topicMeasureContext();if(ctx)ctx.font=g.font;
  const measure=(n:number)=>ctx?ctx.measureText(g.text.slice(0,n)).width:estimatedTextWidth(g.text.slice(0,n),g.size);
  let last=0,left=0;
  for(const {index,segment} of cardGraphemes.segment(g.text)){
    const end=index+segment.length,right=measure(end);
    if(point.x-g.x<(left+right)/2)return g.at+last;
    last=end;left=right;
  }
  return g.at+last;
}
const cardGraphemes=new Intl.Segmenter(undefined,{granularity:"grapheme"});
export const minimumCardWidth=(kind:CardKind)=>kind==="markdown"?160:84;
export const initialStickyBox=Object.freeze({width:216,height:188});
export const initialDocumentBox=Object.freeze({width:470,height:240});
export const initialCardFontSizes={sticky:19,markdown:16} as const;
export const defaultStickyFill="#fff0a6";
export function fittedCard(item:CardObject):CardObject{
  const height=Math.max(item.height,cardLayout(item).height);return height===item.height?item:{...item,height};
}
export function newCard(kind:CardKind,at:Point,source="",fill=kind==="sticky"?defaultStickyFill:"#ffffff"):CardObject{
  const label=normalizeBreaks(source.replace(/^\uFEFF/,""));
  if(label.length>MAX_CARD_TEXT)throw new Error("内容超过 256 Ki 个字符");
  const note=kind==="sticky";
  return fittedCard({id:allocateId(kind),kind:"shape",shape:"rect",at:gridPoint(at),...(note?initialStickyBox:initialDocumentBox),rotation:0,
    cornerRadius:note?3:5,fill,stroke:note?"#dfc773":"#cbd3dd",strokeWidth:1,
    label,content:{kind,fontSize:initialCardFontSizes[kind]}});
}
