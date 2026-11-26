export const longFramePrefix="MG Canvas long frame";

type FrameInfo=Readonly<{phase:string;paint:string;cache:string;zoom:number;canvasGroups:number;cacheGroups:number;selected:number}>;
type FrameTimes=Readonly<{start:number;scene:number;cache:number;query:number;canvas:number;end:number}>;
const rounded=(value:number)=>Math.round(value*10)/10;

/** Keep a small, local trail of expensive frames in the browser's User Timing track. */
export class FrameTrace{
  private previous?:{timestamp:number;end:number;breakdown:ReturnType<FrameTrace["breakdown"]>};
  private entries:string[]=[];
  private count=0;

  pause(){this.previous=undefined;}

  record(timestamp:number,requested:number|undefined,times:FrameTimes,info:FrameInfo){
    const at=Number.isFinite(timestamp)?timestamp:times.start;
    const previous=this.previous;
    const continuous=requested!==undefined&&previous&&requested-previous.end<=100;
    const gap=continuous?at-previous.timestamp:0;
    const queued=requested===undefined?0:Math.max(0,times.start-requested);
    const work=times.end-times.start;
    const current=this.breakdown(times,info);
    if(requested!==undefined)this.previous={timestamp:at,end:times.end,breakdown:current};
    if(Math.max(gap,queued,work)<50)return;
    const name=longFramePrefix+" "+ ++this.count;
    const start=Math.max(0,Math.min(requested??times.start,continuous?previous.timestamp:times.start));
    performance.measure(name,{start,end:times.end,detail:{
      gapMs:gap?rounded(gap):undefined,queuedMs:queued?rounded(queued):undefined,current,
      previous:continuous?previous.breakdown:undefined
    }});
    this.entries.push(name);
    if(this.entries.length>16)performance.clearMeasures(this.entries.shift()!);
  }

  private breakdown(t:FrameTimes,info:FrameInfo){
    return {...info,workMs:rounded(t.end-t.start),sceneMs:rounded(t.scene-t.start),cacheMs:rounded(t.cache-t.scene),
      queryMs:rounded(t.query-t.cache),canvasMs:rounded(t.canvas-t.query),overlayMs:rounded(t.end-t.canvas)};
  }
}
