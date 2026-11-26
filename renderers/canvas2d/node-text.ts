import type {Primitive} from "../../scene/board.ts";
import {estimatedTextWidth,textRows} from "../../features/text-layout.ts";
import {inkWidth,nodeFont} from "../../platform/text-metrics.ts";
import type {InkMetrics} from "../../platform/text-metrics.ts";

type NodeLabel=Extract<Primitive,{kind:"nodeLabel"}>;
type Metric=InkMetrics;
type Measure=(text:string)=>Metric;
type Run=Readonly<{text:string;x:number;baseline:number}>;
/** Flow labels retain measured advances, overhang, safe bounds and their line cap. */
export function nodeTextRows(input:string,width:number,maxLines:number,measure:Measure):string[]{
  return textRows(input,width,1,{measure:text=>inkWidth(measure(text)),maxLines,flowLabel:true});
}
function fallbackBounds(size:number){return {ascent:size*.79,descent:size*.21};}
function bounds(m:Metric,size:number){
  if(Number.isFinite(m.actualBoundingBoxAscent)&&Number.isFinite(m.actualBoundingBoxDescent)&&
    m.actualBoundingBoxAscent+m.actualBoundingBoxDescent>0)
    return {ascent:m.actualBoundingBoxAscent,descent:m.actualBoundingBoxDescent};
  return fallbackBounds(size);
}
/** Center the union of visible ink around both axes, independent of em/OS baseline conventions. */
export function centeredNodeRuns(rows:readonly string[],fontSize:number,lineHeight:number,measure:Measure):Run[]{
  const measured=rows.map((text,i)=>({text,metrics:measure(text),y:i*lineHeight}));
  const visible=measured.filter(({text})=>text.length>0);
  if(!visible.length)return [];
  const top=Math.min(...measured.map(({metrics,y})=>y-bounds(metrics,fontSize).ascent));
  const bottom=Math.max(...measured.map(({metrics,y})=>y+bounds(metrics,fontSize).descent));
  return visible.map(({text,metrics,y})=>{
    const {actualBoundingBoxLeft:left,actualBoundingBoxRight:right}=metrics;
    const shift=Number.isFinite(left)&&Number.isFinite(right)&&left+right>0?(left-right)/2:0;
    return {text,x:shift,baseline:y-(top+bottom)/2};
  });
}
export class NodeLabelPainter{
  private cache=new Map<string,readonly Run[]>();
  draw(c:CanvasRenderingContext2D,item:NodeLabel,color=item.color){
    const {box:b,fontSize,weight,text,maxLines}=item;
    if(b.width<=0||b.height<fontSize*.8)return;
    const font=nodeFont(fontSize,weight);
    c.font=font;c.textBaseline="alphabetic";c.textAlign="center";c.fillStyle=color;
    const key=JSON.stringify([font,item.rows??text,b.width,b.height,maxLines]);
    let runs=this.cache.get(key);
    if(!runs){
      const measure=(s:string)=>c.measureText(s)??{width:estimatedTextWidth(s,fontSize),actualBoundingBoxAscent:0,actualBoundingBoxDescent:0,actualBoundingBoxLeft:0,actualBoundingBoxRight:0};
      if(item.rows){
        runs=centeredNodeRuns(item.rows,fontSize,fontSize*1.35,measure);
      }else{
        const lineHeight=fontSize*1.28;
        let cap=Math.min(maxLines,Math.max(1,Math.floor((b.height-fontSize)/lineHeight)+1));
        do{
          runs=centeredNodeRuns(nodeTextRows(text,b.width,cap,measure),fontSize,lineHeight,measure);
          if(runs.every(({text,baseline})=>{const m=bounds(measure(text),fontSize);return baseline-m.ascent>=-b.height/2&&baseline+m.descent<=b.height/2;}))break;
          if(--cap<1)runs=[];
        }while(cap>0);
      }
      if(this.cache.size>=1024)this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key,runs);
    }
    const cx=b.at.x+b.width/2,cy=b.at.y+b.height/2;
    if(b.rotation){
      c.save();c.translate(cx,cy);c.rotate(b.rotation);
      for(const run of runs)c.fillText(run.text,run.x,run.baseline);
      c.restore();
    }else for(const run of runs)c.fillText(run.text,cx+run.x,cy+run.baseline);
  }
}
