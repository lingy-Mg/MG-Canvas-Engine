import {loadBrush,paint,pixels,requireSame,surface} from "./replay-ink.mjs";
import {brush,capture,deviation,motions,offset,traces,zooms} from "./ink-zoom-traces.mjs";

const camera=(z,f,w,h)=>({zoom:z,offset:{x:w/2-f.x*z,y:h/2-f.y*z}});
const focus=(t,x)=>({x,y:t.y(x)});
const docFor=stroke=>({schemaVersion:2,id:"zoom",theme:"paper",order:["s"],objects:{s:{kind:"ink",id:"s",...stroke}},assets:{}});
const round=n=>+n.toFixed(4);
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));

function verify(api,{draft,stroke,maxTipError},trace,z){
  if(maxTipError>1e-8||JSON.stringify(stroke)!==JSON.stringify(draft))throw Error("tip or lift changed");
  const bytes=api.encodeProject(docFor(stroke),new api.AssetVault());
  const reopened=api.decodeProject(bytes).document;
  if(api.encodeProject(reopened,new api.AssetVault())!==bytes)throw Error("reopen changed project");
  const f=focus(trace,244),w=238,h=88;
  const scene=api.buildScene(reopened),{view,el}=surface(api,w,h,1.5);
  view.draw(scene,camera(z,f,w,h));
  for(const viewZoom of [z,1,16]){
    view.draw(scene,camera(viewZoom,f,w,h));
    requireSame(pixels(el),pixels(paint(api,draft,viewZoom,f,1.5)),trace.name+" preview / lift / reopen / zoom");
  }
}

function figure(title,subtitle,width,height){
  const el=document.createElement("canvas");el.width=width*2;el.height=height*2;
  const g=el.getContext("2d");g.scale(2,2);
  g.fillStyle="#fbfcfd";g.fillRect(0,0,width,height);
  const label=(s,x,y,size=14,weight=400,color="#344650")=>{
    g.font=weight+' '+size+'px "Microsoft YaHei",sans-serif';g.fillStyle=color;g.fillText(s,x,y);
  };
  label(title,26,39,25,650);label(subtitle,26,68,15);
  return {el,g,label};
}

function captureFigure(apis,runs){
  const w=266,h=104,left=98,gap=10;
  const {el,g,label}=figure("不同倍率落笔，然后统一到 100% 查看",
    "同一鼠标输入模型、同一目标轨迹、笔宽 3。每格均由画布按 100% 重新绘制同一段。",1208,833);
  zooms.forEach((z,c)=>label("落笔 "+z*100+"%",left+(w+gap)*c,106,17,600));
  traces.forEach((t,row)=>{
    const top=120+row*235;
    for(let c=0;c<zooms.length;c++)for(let v=0;v<2;v++){
      const x=left+c*(w+gap),y=top+v*(h+3);
      g.drawImage(paint(apis[v],runs[v][c][row].stroke,1,focus(t,260),2,true,w,h),x,y,w,h);
    }
    label(t.name,13,top+25,16,600);
    label("修改前",13,top+64);label("本次",13,top+h+64,14,600,"#167263");
  });
  return el.toDataURL().split(",")[1];
}

// Locate the two half-coverage crossings on each device-pixel column. Convert
// the vertical intercepts to normal distances from the analytical target.
function edges(el,t,f,z,dpr){
  const data=pixels(el),w=el.width,h=el.height,scale=z*dpr;
  const red=(i,j)=>data[4*(j*w+i)],threshold=(243+34)/2;
  const deviations=[[],[],[]];
  for(let i=8;i<w-8;i++){
    const x=f.x+(i+.5-w/2)/scale,y=(t.y(x)-f.y)*scale+h/2;
    const slope=(t.y(x+.01)-t.y(x-.01))/.02,normal=Math.hypot(1,slope);
    let top=0,bottom=h-1;
    while(top<h&&red(i,top)>threshold)top++;
    while(bottom>top&&red(i,bottom)>threshold)bottom--;
    if(top===0||bottom>=h-1||bottom<=top)continue;
    const cross=(j,k)=>j+.5+(k-j)*(threshold-red(i,j))/(red(i,k)-red(i,j));
    const a=(cross(top,top-1)-y)/normal/dpr,b=(cross(bottom,bottom+1)-y)/normal/dpr;
    deviations[0].push(a+brush.baseWidth*z/2);deviations[1].push(b-brush.baseWidth*z/2);
    deviations[2].push(b-a-brush.baseWidth*z);
  }
  if(deviations[0].length<w/2)throw Error("edge region clipped");
  return deviations.map(values=>round(Math.sqrt(values.reduce((s,v)=>s+v*v,0)/values.length)));
}

function detailFigure(apis){
  const w=266,h=163,left=98,z=16,dpr=2,metrics=[];
  const {el,g,label}=figure("慢斜线与长弧的两侧轮廓",
    "统一以 1600% 重绘。深色为实际等宽笔迹，青线标出保存的中心线。输入含不足 1 个屏幕像素的横向扰动。",1208,495);
  for(const [row,t] of traces.slice(0,2).entries()){
    const top=104+row*(h+17),f=focus(t,183);
    label(t.name,13,top+h/2,16,600);
    for(const [group,zoom] of [1,4].entries())for(let v=0;v<2;v++){
      const api=apis[v],result=capture(api,t,zoom,{noise:true}),{stroke}=result;
      verify(api,result,t,zoom);
      const actual=paint(api,stroke,z,f,dpr,true,w,h);
      const reopened=api.decodeProject(api.encodeProject(docFor(stroke),new api.AssetVault())).document.objects.s;
      requireSame(pixels(actual),pixels(paint(api,result.draft,z,f,dpr,false,w,h)),"detail preview/lift");
      requireSame(pixels(actual),pixels(paint(api,reopened,z,f,dpr,true,w,h)),"detail project reopen");
      const [upper,lower,width]=edges(actual,t,f,z,dpr);
      metrics.push({capture:zoom,trace:t.name,version:v?"after":"before",upper,lower,width});
      const x=left+(2*group+v)*(w+10);
      if(!row)label("落笔 "+zoom*100+"%  ·  "+(v?"本次":"修改前"),x,92,15,600,v?"#167263":"#475561");
      g.drawImage(actual,x,top,w,h);
      g.save();g.beginPath();g.rect(x,top,w,h);g.clip();g.beginPath();
      for(const [i,p] of api.inkPoints(stroke).entries()){
        const px=x+w/2+(p.x-f.x)*z,py=top+h/2+(p.y-f.y)*z;
        if(i===0)g.moveTo(px,py);else g.lineTo(px,py);
      }
      g.lineWidth=1;g.strokeStyle="#56ceb8";g.stroke();g.restore();
    }
  }
  for(let i=1;i<metrics.length;i+=2){
    if(metrics[i].upper>=metrics[i-1].upper||metrics[i].lower>=metrics[i-1].lower)throw Error("edge regression "+JSON.stringify(metrics.slice(i-1,i+1)));
  }
  return {detail:el.toDataURL().split(",")[1],edges:metrics};
}

function pressureControl(api,z){
  const t=traces[0],input=new api.InkInput(),events=motions(t,z,{spacing:8});
  input.down({id:2,device:"pen",primaryTip:true,...events[0],pressure:.2},{brush,camera:{zoom:z,offset},fingerInk:true});
  for(const [i,e] of events.slice(1).entries())input.move(2,[{...e,pressure:i<events.length/2 ? .2 : .82}]);
  const end=events.at(-1).at;
  input.move(2,[{at:end,pressure:.34}]);
  const draft=structuredClone(input.draft),[commit]=input.up(2,end),stroke=commit.stroke;
  const radii=api.inkPoints(stroke).map(p=>p.radius);
  if(Math.max(...radii)<=radii[0]||radii.at(-1)>=radii.at(-2))throw Error("pressure response");
  const tip=api.inkPoints(draft).at(-1);
  verify(api,{stroke,draft,maxTipError:Math.hypot(tip.x*z+offset.x-end.x,tip.y*z+offset.y-end.y)},t,z);
}

async function timing(apis,zoom){
  const w=720,h=180,cam={zoom,offset},runs=apis.map(api=>({...surface(api,w,h,1),api,input:new api.InkInput(),paint:[],total:[],err:0}));
  const sample=i=>({at:{x:Math.round(47+(1-Math.cos(i/39))*291),y:Math.round(88+42*Math.sin(i/13)+11*Math.sin(i/21))},pressure:.5,timeStamp:i*4});
  for(const run of runs)run.input.down({id:1,device:"mouse",primaryTip:true,...sample(0)},{brush,camera:cam,fingerInk:true});
  for(let frame=1;frame<=150;frame++){
    await nextFrame();
    const batch=Array.from({length:4},(_,i)=>sample((frame-1)*4+i+1)),tip=batch.at(-1).at;
    for(const r of frame%2?runs:[...runs].reverse()){
      const t0=performance.now();r.input.move(1,batch);
      const draft=r.input.draft,t1=performance.now();
      r.view.draw([],cam,[],undefined,undefined,undefined,undefined,undefined,undefined,draft);
      r.ctx.getImageData(tip.x,tip.y,1,1);
      const t2=performance.now();
      if(frame>20){r.paint.push(t2-t1);r.total.push(t2-t0);}
      const end=r.api.inkPoints(draft).at(-1);
      r.err=Math.max(r.err,Math.hypot(end.x*zoom+offset.x-tip.x,end.y*zoom+offset.y-tip.y));
    }
  }
  const p95=a=>round(a.sort((a,b)=>a-b)[Math.ceil(.95*a.length)-1]);
  return runs.map(r=>({frames:r.total.length,paintP95ms:p95(r.paint),inputAndPaintP95ms:p95(r.total),maxTipCss:round(r.err)}));
}

export async function replayInkZoom(groups){
  const apis=await Promise.all(groups.map(loadBrush));
  const runs=apis.map(api=>zooms.map(z=>traces.map(t=>capture(api,t,z))));
  const rms=[],times=[];
  for(const [c,z] of zooms.entries()){
    pressureControl(apis[1],z);
    for(const [i,t] of traces.entries()){
      const [old,now]=runs.map(r=>r[c][i]);
      verify(apis[1],now,t,z);
      // Reopen the old geometry under the new renderer, including its joins.
      const reopened=apis[1].decodeProject(apis[0].encodeProject(docFor(old.stroke),new apis[0].AssetVault())).document;
      for(const vz of [1,16])requireSame(pixels(paint(apis[0],old.stroke,vz,focus(t,244),2,true)),
        pixels(paint(apis[1],reopened.objects.s,vz,focus(t,244),2,true)),"archived ink changed");
      rms.push({capture:z,trace:t.name,before:round(deviation(old.stroke,t)),after:round(deviation(now.stroke,t))});
    }
    times.push({capture:z,runs:await timing(apis,z)});
  }
  const t=traces[0],f=focus(t,183),sample=step=>Array.from({length:560/step+1},(_,i)=>[i*step,.34*i*step,.5]);
  const straight={...brush,at:{x:0,y:24},subpixel:true,brushVersion:1,samples:sample(1)};
  const control=paint(apis[0],straight,16,f,2,true,266,163);
  requireSame(pixels(control),pixels(paint(apis[1],straight,16,f,2,true,266,163)),"same centerline across renderers");
  // A single straight segment has the same target edges as 560 collinear
  // round joins. Bound the raster floor independently of input fitting.
  const single=paint(apis[1],{...straight,samples:sample(560)},16,f,2,true,266,163);
  const denseEdges=edges(control,t,f,16,2),oneSegment=edges(single,t,f,16,2);
  if(denseEdges.some((v,i)=>Math.abs(v-oneSegment[i])>.5))throw Error("collinear join error");
  return {png:captureFigure(apis,runs),...detailFigure(apis),rms,times,straightControl:{denseEdges,oneSegment}};
}

// Exercise the editor's DOM, coalesced-event adapter, wheel camera and RAF.
// The driver checks the actual exported project after these twelve contacts.
export async function editorZoom(){
  const el=document.querySelector("#canvas"),qa=window.inkQA;
  const rect=el.getBoundingClientRect(),frames=[],ends=[];
  const wheel=dy=>el.dispatchEvent(new WheelEvent("wheel",{clientX:rect.left+offset.x,clientY:rect.top+offset.y,
    ctrlKey:true,deltaY:dy,bubbles:true,cancelable:true}));
  for(let i=0;i<8;i++)wheel(1000);
  let from=.05;
  for(const zoom of zooms){
    const log=Math.log(zoom/from),steps=Math.max(1,Math.ceil(log));
    for(let i=0;i<steps;i++)wheel(-log/(steps*.003));
    from=zoom;await nextFrame();
    if(document.querySelector("#zoom-read").textContent!==zoom*100+"%")throw Error("capture camera "+zoom);
    qa.errors=[];qa.track=true;
    for(const t of traces){
      const events=motions(t,zoom),count=t===traces[2]?2:160;
      const pointer=(type,{at})=>new PointerEvent(type,{clientX:rect.left+at.x,clientY:rect.top+at.y,
        pointerType:"mouse",pointerId:7,button:type==="pointermove"?-1:0,buttons:type==="pointerup"?0:1,
        pressure:type==="pointerup"?0:.5,isPrimary:true,bubbles:true,cancelable:true});
      el.dispatchEvent(pointer("pointerdown",events[0]));
      for(let i=1;i<events.length;i+=count){
        const batch=events.slice(i,i+count).map(e=>pointer("pointermove",e));
        const parent=batch.at(-1);
        Object.defineProperty(parent,"getCoalescedEvents",{value:()=>batch});
        el.dispatchEvent(parent);await nextFrame();
      }
      el.dispatchEvent(pointer("pointerup",events.at(-1)));await nextFrame();
      const a=events[0].at,b=events.at(-1).at;ends.push([(b.x-a.x)/zoom,(b.y-a.y)/zoom]);
    }
    qa.track=false;
    const error=Math.max(...qa.errors);
    if(qa.errors.length<35||error>.02)throw Error("editor RAF at "+zoom+" "+qa.errors.length+" frames, "+error+" px");
    frames.push({capture:zoom,checks:qa.errors.length,maxPaintedTipCss:+error.toFixed(6)});
  }
  return {frames,ends};
}
