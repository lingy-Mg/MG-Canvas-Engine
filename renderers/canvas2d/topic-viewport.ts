import {localRect,topicPlacement} from "../../scene/topic-placement.ts";
import {DEFAULT_SHAPE_STROKE} from "../../core/document.ts";
import type {Rect} from "../../core/geometry.ts";
import {nodeFont} from "../../platform/text-metrics.ts";
import type {DrawGroup,Primitive} from "../../scene/board.ts";
import {centeredNodeRuns} from "./node-text.ts";

export const MIN_INDEXED_TOPICS=64;
type Extent={left:number;top:number;right:number;bottom:number};
type Span=Extent&{first:number;end:number};
type Branch=Extent&{start:number;limit:number;lo?:Branch;hi?:Branch};
type Index={spans:Span[];root:Branch};
type TopicLabel=Extract<Primitive,{kind:"nodeLabel"}>;
type Marker=Extract<Primitive,{kind:"text"}>;
export type TopicPaintWork={mode:"full"|"indexed"|"fallback";built:boolean;branches:number;spans:number;primitives:number};
const rect=(left:number,top:number,right:number,bottom:number):Extent=>({left,top,right,bottom});
const empty=()=>rect(Infinity,Infinity,-Infinity,-Infinity);
function include(a:Extent,b:Extent){
  a.left=Math.min(a.left,b.left);a.right=Math.max(a.right,b.right);
  a.top=Math.min(a.top,b.top);a.bottom=Math.max(a.bottom,b.bottom);
}
const finite=(b:Extent)=>Number.isFinite(b.left)&&Number.isFinite(b.right)&&Number.isFinite(b.top)&&Number.isFinite(b.bottom);
const inside=(a:Extent,b:Extent)=>a.left<=b.left&&a.top<=b.top&&a.right>=b.right&&a.bottom>=b.bottom;
const overlaps=(a:Extent,b:Extent)=>a.left<=b.right&&a.top<=b.bottom&&a.right>=b.left&&a.bottom>=b.top;
const translate=(b:Extent,x:number,y:number)=>rect(b.left+x,b.top+y,b.right+x,b.bottom+y);
function hierarchy(spans:readonly Span[],start:number,limit:number):Branch{
  const branch:Branch={...empty(),start,limit};
  if(limit-start<=8){for(let i=start;i<limit;i++)include(branch,spans[i]);}
  else{
    const mid=start+Math.floor((limit-start)/2);
    branch.lo=hierarchy(spans,start,mid);branch.hi=hierarchy(spans,mid,limit);
    include(branch,branch.lo);include(branch,branch.hi);
  }
  return branch;
}
function ink(m:TextMetrics|undefined):Extent|undefined{
  if(!m)return;
  const bounds=rect(-m.actualBoundingBoxLeft,-m.actualBoundingBoxAscent,m.actualBoundingBoxRight,m.actualBoundingBoxDescent);
  if(finite(bounds))return bounds;
}

/** Contiguous paint spans keep all branches behind topic boxes, labels and fold markers. */
export class TopicViewport{
  private indexes=new WeakMap<DrawGroup,Index|null>();
  private labels=new WeakMap<readonly string[],{font:string;bounds:Extent}>();
  private plus?:Extent;
  private context:CanvasRenderingContext2D;
  constructor(context:CanvasRenderingContext2D){this.context=context;}

  private labelBounds(label:TopicLabel):Extent|undefined{
    if(!label.rows)return;
    const font=nodeFont(label.fontSize,label.weight),cached=this.labels.get(label.rows);
    const x=label.box.at.x+label.box.width/2,y=label.box.at.y+label.box.height/2;
    if(cached?.font===font)return translate(cached.bounds,x,y);
    const c=this.context,rows=label.rows,measured=new Map<string,TextMetrics>();
    c.font=font;c.textAlign="center";c.textBaseline="alphabetic";
    for(const row of rows){
      const metrics=c.measureText(row);
      if(!ink(metrics))return;
      measured.set(row,metrics);
    }
    const bounds=rect(0,0,0,0);
    // Use the same overhang shift and baseline as the painter, including oversized graphemes.
    for(const run of centeredNodeRuns(rows,label.fontSize,label.fontSize*1.35,t=>measured.get(t)!))
      include(bounds,translate(ink(measured.get(run.text))!,run.x,run.baseline));
    this.labels.set(rows,{font,bounds});return translate(bounds,x,y);
  }
  private markerBounds(mark:Marker):Extent|undefined{
    if(mark.text!=="+"||mark.size!==10||mark.weight!==700||mark.align!=="center"||mark.maxWidth)return;
    if(!this.plus){
      const c=this.context;c.font=nodeFont(mark.size,mark.weight);c.textAlign="center";c.textBaseline="middle";
      this.plus=ink(c.measureText("+"));
    }
    if(this.plus)return translate(this.plus,mark.at.x,mark.at.y);
  }
  private build(items:readonly Primitive[]):Index|null{
    const spans:Span[]=[];
    for(let i=0;i<items.length;){
      const first=i,item=items[i++];let bounds:Extent;
      if(item.kind==="path"&&item.curved&&item.points.length===4&&!item.segments&&!item.arrow&&!item.closed){
        // A cubic remains inside its control hull. Include its round stroke and the dark-theme halo.
        const pad=Math.max(item.width,item.junction?.end??0)/2+1;bounds=empty();
        for(const p of item.points)include(bounds,rect(p.x-pad,p.y-pad,p.x+pad,p.y+pad));
      }else if(item.kind==="box"&&item.box.rotation===0){
        const {at,width,height}=item.box,pad=(item.strokeWidth??DEFAULT_SHAPE_STROKE)/2;
        bounds=rect(at.x-pad,at.y-pad,at.x+width+pad,at.y+height+pad);
        const label=items[i++];if(label?.kind!=="nodeLabel")return null;
        const text=this.labelBounds(label);if(!text)return null;include(bounds,text);
        const marker=items[i];if(marker?.kind==="text"){
          const mark=this.markerBounds(marker);if(!mark)return null;include(bounds,mark);i++;
        }
      }else return null;
      if(!finite(bounds))return null;
      spans.push({...bounds,first,end:i});
    }
    return spans.length?{spans,root:hierarchy(spans,0,spans.length)}:null;
  }

  items(group:DrawGroup,view:Rect,audit?:(work:TopicPaintWork)=>void):readonly Primitive[]{
    const pose=topicPlacement(group);
    if(!pose)return this.localItems(group,view,audit);
    const visible=this.localItems(pose.local,localRect(view,pose.origin),audit);
    return visible===pose.local.items?group.items:visible.map(pose.worldItem);
  }
  private localItems(group:DrawGroup,view:Rect,audit?:(work:TopicPaintWork)=>void):readonly Primitive[]{
    const area=rect(view.min.x,view.min.y,view.max.x,view.max.y),items=group.items;
    if((group.topicCount??0)<MIN_INDEXED_TOPICS||inside(area,rect(group.bounds.min.x,group.bounds.min.y,group.bounds.max.x,group.bounds.max.y))){
      audit?.({mode:"full",built:false,branches:0,spans:0,primitives:items.length});return items;
    }
    let index=this.indexes.get(group);const built=index===undefined;
    if(built){
      const c=this.context;c.save();
      try{index=this.build(items);}finally{c.restore();}
      this.indexes.set(group,index);
    }
    // Without trustworthy text ink metrics keep the original complete painter.
    if(!index){audit?.({mode:"fallback",built,branches:0,spans:0,primitives:items.length});return items;}
    const {root,spans}=index,visible:Primitive[]=[];let branches=0,visited=0;
    const append=(first:number,end:number)=>{for(let i=first;i<end;i++)visible.push(items[i]);};
    function visit(n:Branch){
      branches++;if(!overlaps(area,n))return;
      if(inside(area,n)){append(spans[n.start].first,spans[n.limit-1].end);return;}
      if(n.lo&&n.hi){visit(n.lo);visit(n.hi);return;}
      for(let i=n.start;i<n.limit;i++){visited++;const s=spans[i];if(overlaps(area,s))append(s.first,s.end);}
    }
    visit(root);audit?.({mode:"indexed",built,branches,spans:visited,primitives:visible.length});return visible;
  }
}
