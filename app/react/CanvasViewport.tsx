import {useLayoutEffect,useRef} from "react";
import type {ReactNode} from "react";

export type CanvasViewportElements=Readonly<{
  viewport:HTMLElement;
  canvas:HTMLCanvasElement;
  feedback:HTMLCanvasElement;
}>;
export type BindCanvasViewport=(elements:CanvasViewportElements)=>()=>void;

export function CanvasViewport({bind,children}:{bind:BindCanvasViewport;children?:ReactNode}){
  const viewport=useRef<HTMLElement>(null);
  const canvas=useRef<HTMLCanvasElement>(null);
  const feedback=useRef<HTMLCanvasElement>(null);
  useLayoutEffect(()=>{
    if(viewport.current&&canvas.current&&feedback.current)
      return bind({viewport:viewport.current,canvas:canvas.current,feedback:feedback.current});
  },[bind]);
  return <main id="viewport" ref={viewport} aria-label="无限画布工作区">
    <canvas id="canvas" ref={canvas} tabIndex={0} aria-label="项目画布。可点选对象，拖动形状或图片的角点缩放，在对象浮栏输入精确数值。"/>
    <canvas id="pointer-feedback" ref={feedback} aria-hidden="true"/>
    {children}
  </main>;
}
