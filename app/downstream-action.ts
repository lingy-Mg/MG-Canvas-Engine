import {applyDownstreamLayout,planDownstreamLayout} from "../features/downstream-layout.ts";
import type {DownstreamPlan} from "../features/downstream-layout.ts";
import type {EditorSession} from "../session/editor.ts";
import type {DrawGroup} from "../scene/board.ts";
import type {SceneProjection} from "../scene/projector.ts";

/** The preview is painted only on screen. The selected anchor and the document stay authoritative for other commands. */
export class DownstreamAction{
  readonly button:HTMLButtonElement;
  private plan?:DownstreamPlan;
  private refresh:()=>void;
  patch?:ReadonlyMap<string,DrawGroup>;
  get scope(){return this.plan?.scope;}
  get poses(){return this.plan?.state==="planned"?[...this.plan.nodes,...this.plan.lines]:undefined;}
  get hint(){
    if(this.plan?.state==="planned")return "预览 "+this.plan.scope.length+" 个后续节点 · 起点固定 · 点按应用 · Esc 取消";
    return this.plan?.message;
  }
  constructor(editor:EditorSession,scene:SceneProjection,prepare:(fromHover:boolean)=>boolean,refresh:()=>void,
    finish:(message:string)=>void,signal:AbortSignal,button:HTMLButtonElement){
    this.refresh=refresh;
    const b=this.button=button;
    const preview=(fromHover=false)=>{
      if(this.plan||!prepare(fromHover))return;
      this.plan=planDownstreamLayout(editor,scene);
      if(this.plan.state==="planned")this.patch=scene.overlay({objects:new Map([...this.plan.nodes,...this.plan.lines].map(item=>[item.id,item]))});
      b.dataset.preview=String(Boolean(this.scope));this.refresh();
    };
    let firstTap=false;
    b.addEventListener("pointerenter",event=>{if(event.pointerType!=="touch")preview(true);},{signal});
    b.addEventListener("pointerleave",event=>{if(event.pointerType!=="touch"&&document.activeElement!==b)this.cancel();},{signal});
    b.addEventListener("pointerdown",event=>{
      firstTap=event.pointerType==="touch"&&!this.plan;
      if(firstTap)preview();
    },{signal});
    b.addEventListener("pointercancel",()=>{firstTap=false;this.cancel();},{signal});
    b.addEventListener("focus",()=>preview(),{signal});
    b.addEventListener("blur",()=>this.cancel(),{signal});
    b.addEventListener("click",()=>{
      if(firstTap){firstTap=false;return;}
      preview();
      const plan=this.plan;if(!plan)return;
      this.cancel();finish(applyDownstreamLayout(editor,plan).message);
    },{signal});
    document.addEventListener("pointerdown",event=>{if(event.target!==b)this.cancel();},{capture:true,signal});
    document.addEventListener("keydown",event=>{
      if(!this.plan||event.isComposing)return;
      if(event.key==="Escape"){
        event.preventDefault();event.stopImmediatePropagation();this.cancel();return;
      }
      if(event.target!==b||!["Enter"," "].includes(event.key))this.cancel();
    },{capture:true,signal});
    window.addEventListener("blur",()=>this.cancel(),{signal});
  }
  cancel(){
    if(!this.plan)return;
    this.plan=undefined;this.patch=undefined;delete this.button.dataset.preview;this.refresh();
  }
}
