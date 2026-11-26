// Browser-side numerical and raster comparison. The driver supplies the two
// offline module graphs so each revision runs its own capture and paint code.
export async function loadBrush(units){
  const urls=new Map();
  for(const {path,code,deps} of units){
    const source=code.replace(/(from\s+["'])([^"'\n]+)(["'])/g,(_,open,key,close)=>open+urls.get(deps[key])+close);
    urls.set(path,URL.createObjectURL(new Blob([source],{type:"text/javascript"})));
  }
  const api={};
  for(const file of ["features/ink.js","features/ink-input.js","renderers/canvas2d/canvas.js","scene/board.js","platform/project.js","features/image-assets.js"])
    Object.assign(api,await import(urls.get(file)));
  for(const url of urls.values())URL.revokeObjectURL(url);
  return api;
}
const brush={baseWidth:2,color:"#223344"},pt=(x,y)=>({x,y});
const atFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const samples=(n,fn)=>Array.from({length:n},(_,i)=>fn(i/(n-1)));
// Integer CSS mouse positions at capture zoom 4, including a slow bend and a
// genuine vertex. The fast, fractional trajectory also models ordinary pens.
const mouse=p=>pt(Math.round(p.x*4)/4,Math.round(p.y*4)/4);
const traces=[
  {name:"慢斜线与弧",focus:pt(70,33.5),points:samples(482,t=>mouse(pt(2+158*t,6+31*t+16*Math.sin(t*Math.PI*.8))))},
  {name:"急转",focus:pt(76,12),points:[...samples(154,t=>mouse(pt(8+68*t,24-12*t))),
    ...samples(128,t=>mouse(pt(76-9*t,12+35*t))),...samples(195,t=>mouse(pt(67+88*t,47-17*t)))]},
  {name:"快速长划",focus:pt(70,31),points:samples(165,t=>pt(-170.37+580*t,31+18*Math.sin((t-.414)*5)))}
];
function capture(api,trace){
  const list=trace.points,path=new api.InkAccumulator("mouse",list[0],brush,.5,2048,{zoom:4});
  for(const p of list.slice(1))path.append(p,.5);
  const draft=structuredClone(path.draft),stroke=path.finish(list.at(-1));
  return {draft,stroke};
}
export function surface(api,w,h,dpr){
  const el=document.createElement("canvas");
  const ctx=el.getContext("2d",{willReadFrequently:true}),view=new api.CanvasView(el);
  view.setTheme("light");view.size(w,h,dpr);
  return {view,el,ctx};
}
export function paint(api,stroke,zoom,focus,dpr=1,committed=false,w=238,h=88){
  const {view,el}=surface(api,w,h,dpr);
  const camera={zoom,offset:pt(w/2-focus.x*zoom,h/2-focus.y*zoom)};
  if(committed){
    const item={id:"line",kind:"ink",...stroke};
    view.draw(api.buildScene({schemaVersion:2,id:"check",theme:"paper",order:["line"],objects:{line:item},assets:{}}),camera);
  }else view.draw([],camera,[],undefined,undefined,undefined,undefined,undefined,undefined,stroke);
  return el;
}
export function pixels(el){return el.getContext("2d").getImageData(0,0,el.width,el.height).data;}
export function requireSame(a,b,label){
  if(a.length!==b.length||a.some((v,i)=>v!==b[i]))throw Error(label);
}
function compareImages(apis,captures){
  const fig=document.createElement("canvas"),w=1124,h=482;
  fig.width=w*2;fig.height=h*2;const g=fig.getContext("2d");g.scale(2,2);
  const label=(s,x,y,size,color,weight=400)=>{g.fillStyle=color;g.font=weight+' '+size+'px "Microsoft YaHei",sans-serif';g.fillText(s,x,y);};
  g.fillStyle="#fbfcfa";g.fillRect(0,0,w,h);
  label("手写轨迹与接头",26,44,28,"#20343d",650);
  label("同一批输入 · 笔宽 2 · 右侧放大区按 800% 重新绘制",26,72,15,"#425d66");
  const cols=[{r:0,z:1},{r:1,z:1},{r:0,z:8},{r:1,z:8}];
  cols.forEach(({r,z},j)=>label((r?"当前":"修改前")+"  ·  "+z*100+"%",116+249*j,112,16,r?"#226b59":"#465966",600));
  traces.forEach((t,i)=>{
    const y=128+114*i;
    label(t.name,15,y+48,15,"#30434c",600);
    cols.forEach(({r,z},j)=>{
      const focus=z===1?pt(80,29):t.focus;
      const el=paint(apis[r],captures[r][i].stroke,z,focus,2,true);
      g.drawImage(el,116+j*249,y,238,88);
    });
  });
  return fig.toDataURL("image/png").split(",")[1];
}
async function measure(apis,zoom){
  const camera={zoom,offset:pt(3.125,-2.375)},frames=150,batch=4;
  const xy=i=>pt(45+(1-Math.cos(i/48))*300,82+42*Math.sin(i/11)+13*Math.sin(i/27));
  const world=p=>pt((p.x-camera.offset.x)/zoom,(p.y-camera.offset.y)/zoom);
  const runs=apis.map(api=>({...surface(api,720,170,1),api,ms:[],error:0,
    path:new api.InkAccumulator("mouse",world(xy(0)),brush,.5,2048,{zoom})}));
  for(let frame=1;frame<=frames;frame++){
    await atFrame();
    for(const run of frame%2?runs:[...runs].reverse()){
      const {path,view,ctx,api}=run;
      for(let i=(frame-1)*batch+1;i<=frame*batch;i++)path.append(world(xy(i)),.5);
      const draft=path.draft,end=xy(frame*batch),start=performance.now();
      view.draw([],camera,[],undefined,undefined,undefined,undefined,undefined,undefined,draft);
      ctx.getImageData(Math.floor(end.x),Math.floor(end.y),1,1); // complete the software raster before stopping the clock
      const elapsed=performance.now()-start;
      if(frame>20)run.ms.push(elapsed);
      const tip=api.inkPoints(draft).at(-1);
      run.error=Math.max(run.error,Math.hypot(tip.x*zoom+camera.offset.x-end.x,tip.y*zoom+camera.offset.y-end.y));
    }
  }
  return runs.map(run=>{
    const sorted=run.ms.sort((a,b)=>a-b),q=f=>+sorted[Math.ceil(sorted.length*f)-1].toFixed(3);
    return {frames:sorted.length,medianMs:q(.5),p95Ms:q(.95),maxTipErrorCss:+run.error.toFixed(6)};
  });
}
export async function replayInk(groups){
  const apis=await Promise.all(groups.map(loadBrush)),captures=apis.map(api=>traces.map(t=>capture(api,t)));
  const [old,current]=apis;
  for(const [i,t] of traces.entries()){
    const {draft,stroke}=captures[1][i],legacy=captures[0][i].stroke;
    if(legacy.subpixel||!stroke.subpixel)throw Error("expected a grid baseline and continuous current input");
    const doc={schemaVersion:2,id:"reopen",theme:"paper",order:["legacy","new"],objects:{
      legacy:{kind:"ink",id:"legacy",...legacy},new:{kind:"ink",id:"new",...stroke}},assets:{}};
    const bytes=current.encodeProject(doc,new current.AssetVault()),reopened=current.decodeProject(bytes).document;
    if(current.encodeProject(reopened,new current.AssetVault())!==bytes)throw Error("unstable project bytes");
    let rejected=false;try{old.decodeProject(bytes);}catch{rejected=true;}
    if(!rejected)throw Error("old reader silently accepted the new sample format");
    for(const dpr of [1,1.5,2])for(const z of [1,8]){
      const now=pixels(paint(current,draft,z,t.focus,dpr));
      requireSame(now,pixels(paint(current,reopened.objects.new,z,t.focus,dpr,true)),t.name+" preview or reopen");
      requireSame(pixels(paint(old,legacy,z,t.focus,dpr,true)),pixels(paint(current,reopened.objects.legacy,z,t.focus,dpr,true)),t.name+" legacy");
      let partial=0;for(let k=0;k<now.length;k+=4)if(now[k]>45&&now[k]<185)partial++;
      if(partial<3)throw Error(t.name+" missing antialiased edge");
    }
  }
  // Keep the centerline and edge coverage even when a small mark is moved far
  // from the origin. This offset is also a whole number of grid periods.
  const shift=22*2**21,local=captures[1][0].stroke,far={...local,at:pt(local.at.x+shift,local.at.y+shift)},f=traces[0].focus;
  requireSame(pixels(paint(current,local,8,f,2,true)),pixels(paint(current,far,8,pt(f.x+shift,f.y+shift),2,true)),"far origin");
  const pen=new current.InkAccumulator("pen",pt(1.25,2.375),brush,.2);
  pen.append(pt(11.75,4.625),.8);
  const preview=structuredClone(pen.draft),pressure=pen.finish(pt(11.75,4.625));
  if(current.inkPoints(pressure).at(-1).radius<=current.inkPoints(pressure)[0].radius)throw Error("lost pressure");
  for(const z of [1,8])requireSame(pixels(paint(current,preview,z,pt(6,3),1.5)),pixels(paint(current,pressure,z,pt(6,3),1.5,true)),"pressure on release");
  const marker=new current.InkAccumulator("mouse",pt(0,0),{...brush,brushVersion:2,baseWidth:8},.5);
  marker.append(pt(50,0),.5);
  const once=paint(current,structuredClone(marker.draft),1,pt(25,0),1);
  marker.append(pt(0,0),.5);
  const folded=paint(current,marker.finish(pt(0,0)),1,pt(25,0),1,true);
  const center=el=>el.getContext("2d").getImageData(119,44,1,1).data;
  requireSame(center(once),center(folded),"marker overlap");
  for(const brushVersion of [1,2,3]){
    const legacy={...captures[0][0].stroke,brushVersion};
    requireSame(pixels(paint(old,legacy,8,f,2,true)),pixels(paint(current,legacy,8,f,2,true)),"old brush "+brushVersion);
  }
  return {png:compareImages(apis,captures),normal:await measure(apis,1),zoomed:await measure(apis,8)};
}
