/** Row breaks are display data. Original graphemes (including whitespace) stay intact. */
const segmenter=new Intl.Segmenter("zh",{granularity:"grapheme"});
const opening=new Set([..."（《〈【「『〔［｛“‘"]);
const closing=new Set([..."），。、！？；：》〉】」』〕］｝”’…"]);
const ideographic=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Extended_Pictographic}\u3000-\u303f\uff01-\uff60]/u;
const BACKTRACK=8;
export const normalizeBreaks=(text:string)=>text.replace(/\r\n?/g,"\n");
export const isTextKey=(key:string):boolean=>Boolean(key)&&!/[\u0000-\u001f\u007f]/u.test(key)&&segmenter.segment(key).containing(0)?.segment===key;

/** Keep the existing UTF-16 budget but never cut inside a grapheme. */
export function graphemePrefix(text:string,budget:number):string{
  if(text.length<=budget)return text;
  if(budget<=0)return "";
  const boundary=segmenter.segment(text).containing(budget);
  return text.slice(0,boundary?.index??text.length);
}
/** Keep the unchanged suffix on a paste or composition in the middle of a full
 * field. Only the overflow path compares strings, bounded by the previous value. */
export function overflowEdit(previous:string,next:string,budget:number){
  if(next.length<=budget)return;
  let prefix=0,tail=0;
  const shared=Math.min(previous.length,next.length);
  while(prefix<shared&&previous.charCodeAt(prefix)===next.charCodeAt(prefix))prefix++;
  while(tail<shared-prefix&&previous.charCodeAt(previous.length-tail-1)===next.charCodeAt(next.length-tail-1))tail++;
  const old=segmenter.segment(previous),fresh=segmenter.segment(next);
  const floor=(parts:Intl.Segments,index:number)=>parts.containing(index)?.index??index;
  const ceil=(parts:Intl.Segments,index:number)=>{
    const part=parts.containing(index);
    return part&&part.index<index?part.index+part.segment.length:index;
  };
  const start=Math.min(floor(old,prefix),floor(fresh,prefix));
  const suffix=Math.min(previous.length-ceil(old,previous.length-tail),next.length-ceil(fresh,next.length-tail));
  const oldEnd=previous.length-suffix,end=next.length-suffix;
  // Regional-indicator parity can shift boundaries on both sides of a changed run.
  if(floor(old,start)!==start||floor(fresh,start)!==start||floor(old,oldEnd)!==oldEnd||floor(fresh,end)!==end)
    return {start:0,end:next.length,text:previous};
  const cut=floor(fresh,budget-suffix);
  if(cut<=start)return {start,end,text:previous.slice(start,oldEnd)};
  return {start:cut,end,text:""};
}
export function boundedTextEdit(previous:string,next:string,budget:number):string{
  const patch=overflowEdit(previous,next,budget);
  return patch?next.slice(0,patch.start)+patch.text+next.slice(patch.end):next;
}
function advance(glyph:string,size:number):number{
  const first=glyph.codePointAt(0)!;
  if(first>255||glyph.includes("\ufe0f")||glyph.includes("\u20e3"))return size;
  return size*(" .,:;ilI".includes(glyph[0]) ? 0.35 : 0.62);
}
export function estimatedTextWidth(text:string,size:number):number{
  let width=0;
  for(const {segment} of segmenter.segment(text))width+=advance(segment,size);
  return width;
}
export type MeasureWidth=(text:string)=>number;
type RowOptions=Readonly<{measure?:MeasureWidth;maxLines?:number;truncated?:boolean;flowLabel?:boolean;wordWrap?:boolean}>;

/** A measured prefix includes kerning and overhang. Probe within the current
 * row, so a narrow label never measures each successively shorter paragraph. */
function measuredEnd(start:number,limit:number,fits:(end:number)=>boolean):number{
  let low=start,step=1;
  while(low<limit){
    const probe=Math.min(limit,start+step);
    if(fits(probe)){low=probe;step*=2;continue;}
    let high=probe-1;
    while(low<high){
      const middle=Math.ceil((low+high)/2);
      if(fits(middle))low=middle;else high=middle-1;
    }
    break;
  }
  return low;
}
function lineBreak(glyphs:readonly string[],start:number,fit:number,wordWrap:boolean):number{
  if(fit===glyphs.length)return fit;
  const allowed=(end:number)=>!opening.has(glyphs[end-1][0])&&!closing.has(glyphs[end][0]);
  if(wordWrap){
    // A pre-wrapped field leaves trailing spaces on the current row. CJK can
    // break beside a Latin word or between characters, even after an earlier space.
    let end=fit;
    while(glyphs[end]===" ")end++;
    if(end>fit)return end;
    for(;end>start;end--){
      const before=glyphs[end-1],after=glyphs[end];
      if(allowed(end)&&(before===" "||before==="-"||ideographic.test(before)||ideographic.test(after)))return end;
    }
  }
  if(fit<=start+1)return fit;
  const minimum=Math.max(start+1,fit-BACKTRACK);
  let end=fit;
  while(end>=minimum&&!allowed(end))end--;
  if(end<minimum)return fit;
  const nearEnd=Math.max(minimum,start+Math.ceil((fit-start)*.55));
  for(let i=end;i>=nearEnd;i--)if(glyphs[i-1]===" "&&allowed(i))return i;
  return end;
}
export function textRows(input:string,width:number,fontSize:number,options:RowOptions={}):string[]{
  const {measure,maxLines=Infinity,truncated=false,flowLabel=false}=options;
  if(maxLines<1||flowLabel&&!(width>0))return [];
  const limit=Math.max(0,width),rows:string[]=[],paragraphs=normalizeBreaks(input).split("\n");
  for(let i=0;i<paragraphs.length;i++){
    const paragraph=paragraphs[i],glyphs:string[]=[],offsets=[0],advances=[0];
    for(const {index,segment} of segmenter.segment(paragraph)){
      glyphs.push(segment);offsets.push(index+segment.length);
      if(!measure)advances.push(advances.at(-1)!+advance(segment,fontSize));
    }
    let start=0;
    do{
      const slice=(end:number)=>paragraph.slice(offsets[start],offsets[end]);
      const fitEnd=(until:number,suffix:string)=>{
        if(measure)return measuredEnd(start,until,end=>measure(slice(end)+suffix)<=limit);
        const available=limit-(suffix?advance(suffix,fontSize):0),initial=advances[start];
        let end=start;
        while(end<until&&advances[end+1]-initial<=available+1e-9)end++;
        return end;
      };
      const fit=fitEnd(glyphs.length,"");
      if(flowLabel&&fit===start&&start<glyphs.length){
        if((measure?measure("…"):fontSize)<=limit)rows.push("…");
        return rows;
      }
      // With no fitting glyph, ordinary text puts one complete glyph on its own row.
      const end=lineBreak(glyphs,start,Math.min(glyphs.length,Math.max(start+1,fit)),options.wordWrap===true);
      const lastInput=end===glyphs.length&&i===paragraphs.length-1;
      if((rows.length+1===maxLines&&(!lastInput||truncated))||(lastInput&&truncated)){
        if(flowLabel&&(measure?measure("…"):fontSize)>limit)return rows;
        rows.push(slice(fitEnd(end,"…"))+"…");return rows;
      }
      rows.push(slice(end));start=end;
    }while(start<glyphs.length);
  }
  return rows;
}
