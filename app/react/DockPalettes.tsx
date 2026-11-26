import {useLayoutEffect,useRef,useState} from "react";
import type {ReactNode} from "react";
import {inkColors} from "../ink-toolbar.ts";
import {paperSwatches} from "../text-placement.ts";
import {Control} from "./Controls.tsx";

export function InkSwatches(){
  return inkColors.map(([name,hex])=><Control as="button" key={hex} id={"ink-swatch-"+hex.slice(1)} className="ink-swatch" type="button" title={name} aria-label={name}>
    <span style={{backgroundColor:hex}}/>
  </Control>);
}
export function PaperSwatches(){
  return paperSwatches.map(([name,hex])=><Control as="button" key={hex} id={"paper-"+hex.slice(1)} className="sticky-swatch" role="radio" data-color={hex} type="button" title={name} aria-label={name}>
    <span style={{backgroundColor:hex}}/>
  </Control>);
}
export function DockRail({children}:{children:ReactNode}){
  const rail=useRef<HTMLDivElement>(null),hint=useRef<HTMLDivElement>(null);
  const [button,setButton]=useState<HTMLButtonElement|null>(null);
  useLayoutEffect(()=>{
    if(!button||!rail.current||!hint.current)return;
    const node=hint.current,strip=rail.current;
    function place(){
      const face=button!.getBoundingClientRect(),bar=strip.getBoundingClientRect();
      node.hidden=face.right<=bar.left||face.left>=bar.right||button!==document.activeElement;
      if(node.hidden)return;
      const left=Math.max(8,Math.min(window.innerWidth-node.offsetWidth-8,face.left+(face.width-node.offsetWidth)/2));
      const secondary=strip.parentElement?.querySelector(".secondary-tools:not([hidden])")?.getBoundingClientRect();
      const top=secondary&&left+node.offsetWidth>secondary.left&&left<secondary.right?secondary.top:bar.top;
      node.style.left=left+"px";node.style.top=Math.max(4,top-node.offsetHeight-4)+"px";
    }
    button.setAttribute("aria-describedby","dock-hint");place();
    const lifetime=new AbortController();
    strip.addEventListener("scroll",place,{signal:lifetime.signal,passive:true});
    window.addEventListener("resize",place,{signal:lifetime.signal});
    return ()=>{button.removeAttribute("aria-describedby");lifetime.abort();};
  },[button]);
  return <>
    <div id="main-tools" ref={rail} className="tool-strip main-tools" role="group" aria-label="画布工具"
      onFocus={e=>setButton(e.target instanceof HTMLButtonElement&&e.target.matches(":focus-visible")&&!e.target.closest("[data-open]")?e.target:null)}
      onBlur={()=>setButton(null)} onPointerDown={()=>setButton(null)} onKeyDown={e=>{if(e.key==="Escape")setButton(null);}}>
      {children}
    </div>
    <div id="dock-hint" ref={hint} role="tooltip" hidden={!button}>{button?.title}</div>
  </>;
}
