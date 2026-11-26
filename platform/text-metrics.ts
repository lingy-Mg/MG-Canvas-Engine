import type {TextFace,TextFamily} from "../core/text-style.ts";

export const textFallback='system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const serifFallback='Georgia, "Times New Roman", "Songti SC", SimSun, "Noto Serif CJK SC", "Noto Serif SC", "Droid Serif", serif';
export const fontChoices:Record<TextFamily,Readonly<{label:string;serif:boolean;stack:string}>>={
  system:{label:"系统无衬线",serif:false,stack:textFallback},
  arial:{label:"Arial",serif:false,stack:"Arial, "+textFallback},
  roboto:{label:"Roboto",serif:false,stack:"Roboto, "+textFallback},
  yahei:{label:"微软雅黑",serif:false,stack:'"Microsoft YaHei", '+textFallback},
  pingfang:{label:"苹方",serif:false,stack:'"PingFang SC", '+textFallback},
  "noto-sans":{label:"思源黑体",serif:false,stack:'"Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", '+textFallback},
  serif:{label:"系统衬线",serif:true,stack:serifFallback},
  georgia:{label:"Georgia",serif:true,stack:"Georgia, "+serifFallback},
  times:{label:"Times New Roman",serif:true,stack:'"Times New Roman", '+serifFallback},
  songti:{label:"宋体（华文）",serif:true,stack:'"Songti SC", STSong, '+serifFallback},
  simsun:{label:"宋体（中易）",serif:true,stack:'SimSun, '+serifFallback},
  "noto-serif":{label:"思源宋体",serif:true,stack:'"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", '+serifFallback},
};
export const nodeFont=(size:number,weight:number)=>weight+" "+size+"px "+textFallback;
export const standaloneFont=(size:number,face:TextFace={})=>(face.italic?"italic ":"")+(face.fontWeight??500)+" "+size+"px "+fontChoices[face.fontFamily??"system"].stack;
export type InkMetrics=Pick<TextMetrics,"width"|"actualBoundingBoxAscent"|"actualBoundingBoxDescent"|"actualBoundingBoxLeft"|"actualBoundingBoxRight">;
export const inkWidth=(m:InkMetrics)=>Math.max(m.width,(m.actualBoundingBoxLeft??0)+(m.actualBoundingBoxRight??0));
const surfaces=new WeakMap<Document,CanvasRenderingContext2D|null>();
/** A dedicated, untransformed measuring context is shared by scene, hit testing
 * and topic layout. Pure model callers can use the deterministic width estimate. */
export function topicMeasureContext():CanvasRenderingContext2D|undefined{
  if(typeof document==="undefined")return;
  if(!surfaces.has(document)){
    let surface:CanvasRenderingContext2D|null=null;
    try{
      const ctx=document.createElement("canvas").getContext("2d");
      if(ctx&&ctx.measureText("M")?.width>0){ctx.textAlign="center";ctx.textBaseline="alphabetic";surface=ctx;}
    }catch{}
    surfaces.set(document,surface);
  }
  return surfaces.get(document)??undefined;
}
