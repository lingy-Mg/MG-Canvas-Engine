import {cardBlocks} from "./card-content.ts";
import type {CardBlock,InlineMark} from "./card-content.ts";

export type MarkdownBlock="paragraph"|"h1"|"h2"|"h3"|"h4"|"h5"|"h6"|"quote"|"bullet"|"number";
type Emphasis="bold"|"italic"|"strike";
export type MarkdownAction={block:MarkdownBlock}|{mark:Emphasis}|{link:string};
export type MarkdownRange={start:number;end:number};
type Edit=MarkdownRange & {source:string};
const styles:Record<Emphasis,string>={bold:"**",italic:"*",strike:"~~"};
function style(b:CardBlock):MarkdownBlock|"code"{
  if(b.kind==="heading")return ("h"+b.level) as MarkdownBlock;
  if(b.kind==="list")return b.marker==="•"?"bullet":"number";
  return b.kind==="quote"||b.kind==="code"?b.kind:"paragraph";
}
function covered(blocks:readonly CardBlock[],r:MarkdownRange){
  const last=Math.max(r.start,r.end-1);
  return blocks.filter(b=>b.end>=r.start&&b.start<=last);
}
let lastSource:string|undefined,lastBlocks:CardBlock[]=[];
function parsed(source:string){
  if(lastSource!==source){lastBlocks=cardBlocks(source);lastSource=source;}
  return lastBlocks;
}
function chars(b:CardBlock,r:MarkdownRange){
  return b.runs.filter(run=>run.text&&run.at!<r.end&&run.at!+run.text.length>r.start);
}
function linkAt(row:CardBlock|undefined,r:MarkdownRange){
  if(!row)return;
  const run=row.runs.find(part=>part.link&&part.at!<=r.start&&part.at!+part.text.length>=r.start);
  const mark=run?.marks?.find(m=>m.kind==="link");if(!mark)return;
  const parts=row.runs.filter(part=>part.marks?.includes(mark)),last=parts.at(-1)!;
  const tail=last.marks!,inside=tail.slice(tail.indexOf(mark)+1).reduce((n,m)=>n+m.close.length,0);
  const close=last.at!+last.text.length+inside;
  if(r.end<=close)return {mark,close};
}
function markedRange(row:CardBlock,r:MarkdownRange){
  let start=Infinity,end=-Infinity;
  for(const run of chars(row,r)){
    if(run.code)continue;
    const at=run.at!,offset=Math.max(at,r.start),value=run.text.slice(offset-at,r.end-at);
    const first=value.search(/\S/);if(first<0)continue;
    start=Math.min(start,offset+first);end=offset+value.trimEnd().length;
  }
  return {start,end};
}
export function markdownState(source:string,r:MarkdownRange){
  const rows=covered(parsed(source),r),first=rows[0],block=first&&rows.every(b=>style(b)===style(first))?style(first):"mixed";
  const inline=rows.flatMap(b=>chars(b,r)),selected=inline.filter(run=>!run.code&&/\S/.test(run.text.slice(Math.max(0,r.start-run.at!),r.end-run.at!)));
  const canMark=r.start<r.end&&selected.length>0;
  const on=(key:Emphasis)=>canMark&&selected.every(run=>run[key]);
  const link=linkAt(first,r)?.mark.url;
  return {block,canBlock:rows.some(b=>b.kind!=="code"),canMark,
    canLink:rows.length===1&&first.kind!=="code"&&!inline.some(run=>run.code)&&(!inline.some(run=>run.link)||Boolean(link)),link,
    bold:on("bold"),italic:on("italic"),strike:on("strike")};
}
export type MarkdownState=ReturnType<typeof markdownState>;
function blockEdit(source:string,rows:readonly CardBlock[],r:MarkdownRange,block:MarkdownBlock):Edit{
  let at=0,out="",number=0,start=r.start,end=r.end;
  for(const row of rows){
    if(row.kind==="code"||rows.length>1&&row.kind==="space"){number=0;continue;}
    number++;
    const old=source.slice(row.start,row.bodyStart);
    const indent=old.match(/^[ \t]*/)?.[0]??"";
    const prefix=block==="number"?indent+number+". ":block==="bullet"?indent+"- ":
      block==="quote"?"> ":block==="paragraph"?"":"#".repeat(Number(block[1]))+" ";
    if(style(row)===block&&block!=="number"||prefix===old)continue;
    out+=source.slice(at,row.start)+prefix;at=row.bodyStart;
    const delta=(n:number)=>n<row.start?0:n>=row.bodyStart?prefix.length-old.length:prefix.length-(n-row.start);
    start+=delta(r.start);end+=delta(r.end);
  }
  return {source:out+source.slice(at),start,end};
}
/** Rewrite only affected inline runs. Keep each untouched block and the block's authored prefix verbatim. */
function emphasisEdit(source:string,rows:readonly CardBlock[],r:MarkdownRange,mark:Emphasis):Edit{
  const active=markdownState(source,r)[mark],token=styles[mark],added:InlineMark={kind:mark,open:token,close:token};
  let out="",cursor=0,start:number|undefined,end:number|undefined;
  for(const row of rows){
    if(row.kind==="code"||!chars(row,r).some(run=>!run.code))continue;
    const visible=markedRange(row,r);
    out+=source.slice(cursor,row.bodyStart);cursor=row.bodyEnd;
    let stack:readonly InlineMark[]=[];
    const transition=(next:readonly InlineMark[])=>{
      let common=0;while(common<next.length&&common<stack.length&&next[common]===stack[common])common++;
      for(let i=stack.length-1;i>=common;i--)out+=stack[i].close;
      for(const m of next.slice(common))out+=m.open;
      stack=next;
    };
    for(const run of row.runs){
      const at=run.at!,stop=at+run.text.length,original=run.marks??[];
      const cuts=[at,...new Set([r.start,visible.start,visible.end,r.end].filter(n=>n>at&&n<stop)),stop];
      for(let i=1;i<cuts.length;i++){
        const a=cuts[i-1],b=cuts[i];if(a===b)continue;
        const selected=a>=r.start&&b<=r.end;
        let marks=original;
        if(a>=visible.start&&b<=visible.end&&!run.code)marks=active?original.filter(m=>m.kind!==mark):run[mark]?original:[...original,added];
        transition(marks);
        if(selected&&start===undefined)start=out.length;
        out+=source.slice(a,b);if(selected)end=out.length;
      }
    }
    transition([]);
  }
  return {source:out+source.slice(cursor),start:start??r.start,end:end??r.end};
}
export function formatMarkdown(source:string,r:MarkdownRange,action:MarkdownAction):Edit|undefined{
  const rows=covered(parsed(source),r),state=markdownState(source,r);
  if("block" in action)return state.canBlock?blockEdit(source,rows,r,action.block):undefined;
  if("mark" in action)return state.canMark?emphasisEdit(source,rows,r,action.mark):undefined;
  if(!state.canLink||!/^(https?:\/\/|mailto:)[^\s()]+$/i.test(action.link))return;
  const link=linkAt(rows[0],r);
  if(link){
    const {mark,close}=link;
    return {source:source.slice(0,close)+"]("+action.link+")"+source.slice(close+mark.close.length),...r};
  }
  const label=source.slice(r.start,r.end)||action.link;
  if(/[\[\]\n]/.test(label))return;
  return {source:source.slice(0,r.start)+"["+label+"]("+action.link+")"+source.slice(r.end),start:r.start+1,end:r.start+1+label.length};
}
