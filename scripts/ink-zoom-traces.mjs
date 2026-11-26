// A common world-space target, projected and sampled anew at each capture zoom.
// Use the same canvas offset, device, width and clock in both revisions.
export const zooms=[.05,.25,1,4];
export const brush={color:"#223344",baseWidth:3};
export const offset={x:113.375,y:91.625};
export const traces=[
  {name:"慢斜线",count:4481,length:560,y:x=>24+.34*x},
  {name:"长弧",count:4481,length:560,y:x=>36+.18*x+78*Math.sin(x/560*Math.PI)},
  {name:"快速长划",count:45,length:560,y:x=>30+.21*x+15*Math.sin(x/560*Math.PI*2)},
];
export function motions(trace,zoom,{fractional=false,spacing=1,noise=false,deviceStep=1}={}){
  const count=Math.ceil((trace.count-1)/spacing)+1;
  return Array.from({length:count},(_,i)=>{
    const x=trace.length*i/(count-1);
    const jitter=noise ? .31*Math.sin(x*zoom*1.33)+.22*Math.cos(x*zoom*.73) : 0;
    const screen={x:x*zoom+offset.x,y:trace.y(x)*zoom+offset.y+jitter};
    const snap=value=>Math.fround(Math.round(value/deviceStep)*deviceStep);
    return {at:fractional?screen:{x:snap(screen.x),y:snap(screen.y)},pressure:.5,timeStamp:4*i};
  });
}
export function capture(api,trace,zoom,options){
  const input=new api.InkInput(),events=motions(trace,zoom,options);
  input.down({id:1,device:"mouse",primaryTip:true,...events[0]},{brush,camera:{zoom,offset},fingerInk:true});
  let maxTipError=0;
  for(const event of events.slice(1)){
    input.move(1,[event]);
    const {at,samples}=input.draft,[x,y]=samples.at(-1);
    maxTipError=Math.max(maxTipError,Math.hypot((at.x+x)*zoom+offset.x-event.at.x,(at.y+y)*zoom+offset.y-event.at.y));
  }
  const draft=structuredClone(input.draft),[action]=input.up(1,events.at(-1).at);
  if(action.kind!=="stroke-commit")throw new Error("ink contact failed");
  return {draft,stroke:action.stroke,maxTipError};
}
// Measure at equal world-x intervals inside the same trace, independently of
// how many centerline points each version kept. Distance is normal to the target.
export function deviation(stroke,trace){
  const {at,samples}=stroke;
  let sum=0,count=0,i=0;
  for(let x=trace.length*.1;x<trace.length*.9;x+=.25){
    while(i+1<samples.length-1&&at.x+samples[i+1][0]<=x)i++;
    const [ax,ay]=samples[i],[bx,by]=samples[i+1];
    const y=at.y+ay+(x-at.x-ax)*(by-ay)/(bx-ax);
    const slope=(trace.y(x+.01)-trace.y(x-.01))/.02;
    sum+=(y-trace.y(x))**2/(1+slope*slope);count++;
  }
  return Math.sqrt(sum/count);
}
