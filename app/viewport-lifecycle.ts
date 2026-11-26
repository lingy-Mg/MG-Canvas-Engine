/** Native input and Canvas2D stay outside React's render cycle. One pending frame belongs to each mount. */
export function createViewportFrameRequest(draw:FrameRequestCallback,signal:AbortSignal){
  let frame:number|undefined;
  function tick(timestamp:number){
    frame=undefined;
    if(!signal.aborted)draw(timestamp);
  }
  signal.addEventListener("abort",()=>{
    if(frame!==undefined)cancelAnimationFrame(frame);
    frame=undefined;
  },{once:true});
  return ()=>{
    if(!signal.aborted&&frame===undefined)frame=requestAnimationFrame(tick);
  };
}

/** The caller performs its first size() after the rest of the editor is ready. */
export function observeViewportSize(viewport:HTMLElement,resize:()=>void,signal:AbortSignal){
  if(signal.aborted)return;
  const win=viewport.ownerDocument?.defaultView??window;
  const onResize=()=>{if(!signal.aborted)resize();};
  const observer=new ResizeObserver(onResize);
  const deviceBox=typeof ResizeObserverEntry!=="undefined"&&"devicePixelContentBoxSize" in ResizeObserverEntry.prototype;
  observer.observe(viewport,deviceBox?{box:"device-pixel-content-box"}:undefined);
  win.addEventListener("resize",onResize,{signal});
  function watchPixelRatio(){
    const ratio=win.devicePixelRatio||1;
    win.matchMedia?.("(resolution: "+ratio+"dppx)")?.addEventListener?.("change",()=>{
      if(signal.aborted)return;
      if((win.devicePixelRatio||1)!==ratio)resize();
      watchPixelRatio();
    },{once:true,signal});
  }
  watchPixelRatio();
  signal.addEventListener("abort",()=>observer.disconnect(),{once:true});
}
