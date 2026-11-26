import type {WorkspaceUI} from "./react/workspace-ui.ts";
import {DEFAULT_SHAPE_STROKE} from "../core/document.ts";
import {worldToScreen} from "../core/geometry.ts";
import type {Camera,Point} from "../core/geometry.ts";
import {cardPadding,cardPlaceholders,defaultStickyFill,initialCardFontSizes} from "../features/card-content.ts";
import {flowPresets,isFlowPreset} from "../features/flow.ts";
import {placementBox} from "../features/placement.ts";
import type {PlacementTool} from "../features/placement.ts";
export {placementBox} from "../features/placement.ts";
export type {PlacementTool} from "../features/placement.ts";
export const paperSwatches=[
  ["纸白","#ffffff"],["雾灰","#e4e5ee"],["珊瑚红","#f5b9ad"],["杏橙","#ffceaa"],["浅黄",defaultStickyFill],
  ["草绿","#bfe5b9"],["薄荷","#c2ebd9"],["天蓝","#cde5fd"],["淡紫","#ded5fa"],["粉红","#fac9d8"],
] as const;
export const quickPaperColors=paperSwatches.filter(([name])=>["浅黄","薄荷","天蓝","粉红"].includes(name));
export const stickyColors=[...paperSwatches.map(([,color])=>color),"#14785a","#34445c"];
export class TextPlacement{
  color:string=defaultStickyFill;
  private tool?:PlacementTool;
  private hover?:Point;
  private frame:HTMLElement;
  private rounded:SVGRectElement|null;
  private ui:WorkspaceUI;
  constructor(frame:HTMLElement,ui:WorkspaceUI,returnFocus:()=>void){
    this.frame=frame;this.ui=ui;this.rounded=frame.querySelector("rect");
    for(const [i,[,color]] of paperSwatches.entries()){
      const id="paper-"+color.slice(1);
      ui.on(id,"click",()=>{this.choose(color);returnFocus();});
      ui.on(id,"keydown",event=>{
        if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
        event.preventDefault();
        const n=paperSwatches.length,next=event.key==="Home"?0:event.key==="End"?n-1:(i+(event.key==="ArrowLeft"?-1:1)+n)%n;
        const hex=paperSwatches[next][1];this.choose(hex);
        frame.parentElement?.querySelector<HTMLElement>("#paper-"+hex.slice(1))?.focus({preventScroll:true});
      });
    }
    this.choose(this.color);
  }
  private choose(color:string){
    this.color=color;
    for(const [,hex] of paperSwatches)this.ui.patch("paper-"+hex.slice(1),{"aria-checked":hex===color,tabIndex:hex===color?0:-1});
    if(this.tool==="sticky")this.frame.style.backgroundColor=color;
  }
  arm(tool?:PlacementTool){
    if(tool===this.tool)return;
    this.tool=tool;this.ui.patch("sticky-palette",{hidden:tool!=="sticky"});
    if(tool==="sticky"||tool==="markdown")this.frame.dataset.hint=cardPlaceholders[tool];
    else{delete this.frame.dataset.hint;this.frame.style.padding="";this.frame.style.fontSize="";}
    if(tool){this.frame.dataset.kind=tool;this.frame.style.backgroundColor=tool==="sticky"?this.color:"";}
    else this.frame.hidden=true;
    if(isFlowPreset(tool)){
      const {fill,stroke}=flowPresets[tool];this.frame.style.fill=fill;this.frame.style.stroke=stroke;
    }
  }
  track(point?:Point){this.hover=point;if(!point)this.frame.hidden=true;}
  paint(camera:Camera,suspended=false,gesture?:{current:Point;start:Point;dragged:boolean}){
    const point=gesture?.current??this.hover,tool=this.tool;
    this.frame.hidden=!point||!tool||suspended;
    if(!tool||!point||suspended)return;
    const box=placementBox(tool,point,camera,gesture?.dragged?gesture.start:undefined),screen=worldToScreen(box.at,camera);
    const style=this.frame.style;style.left=screen.x+"px";style.top=screen.y+"px";
    style.width=box.width*camera.zoom+"px";style.height=box.height*camera.zoom+"px";
    if(isFlowPreset(tool)){
      style.strokeWidth=Math.max(1,DEFAULT_SHAPE_STROKE*camera.zoom)+"px";
      if(tool==="process"){
        const radius=Math.min(flowPresets.process.cornerRadius,box.width/2,box.height/2);
        this.rounded?.setAttribute("rx",String(100*radius/box.width));this.rounded?.setAttribute("ry",String(100*radius/box.height));
      }
    }else if(tool==="sticky"||tool==="markdown"){
      const size=initialCardFontSizes[tool];style.fontSize=size*camera.zoom+"px";style.padding=cardPadding(tool,box.width,size)*camera.zoom+"px";
    }
  }
}
