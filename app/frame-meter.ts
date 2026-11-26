const idleDelay=650;
const reportInterval=120;
export const frameWindow=6000;
const chartWidth=148,chartHeight=24;

type Frame=Readonly<{at:number;interval:number}>;
type FrameColumn=Readonly<{x:number;interval:number}>;

/** Each column keeps its longest interval, so a short dip survives downsampling. */
export function frameColumns(frames:readonly Frame[],end:number,width:number){
  const start=end-frameWindow,columns:FrameColumn[]=[];
  let lowest:FrameColumn|undefined;
  for(const frame of frames){
    if(frame.at<start||frame.at>end)continue;
    const x=Math.min(width-1,Math.floor((frame.at-start)/frameWindow*width));
    const last=columns.at(-1);
    if(last?.x===x&&last.interval>=frame.interval)continue;
    const column={x,interval:frame.interval};
    if(last?.x===x)columns[columns.length-1]=column;else columns.push(column);
    if(!lowest||column.interval>=lowest.interval)lowest=column;
  }
  return {columns,lowest};
}

export type FrameMeterView={state:string;minimum:string;line:string;marker?:{x:string;y:string;late:boolean};budget?:string};
export const initialMeter:FrameMeterView={state:"空闲",minimum:"—",line:""};

/** Collect timing samples independently of React, publishing only at the reporting cadence. */
export class FrameMeter {
  private publish:(next:FrameMeterView)=>void;
  private view:FrameMeterView=initialMeter;
  private frames:Frame[]=[];
  private requested?:number;
  private lastFrame?:number;
  private lastCompleted?:number;
  private idleTimer?:ReturnType<typeof setTimeout>;
  private plotTimer?:ReturnType<typeof setTimeout>;
  private paused=false;
  private cap="";
  private expected?:number;

  constructor(publish:(next:FrameMeterView)=>void){this.publish=publish;}
  private show(next:FrameMeterView){this.view=next;this.publish(next);}
  dispose(){clearTimeout(this.idleTimer);clearTimeout(this.plotTimer);this.paused=true;}

  setCap(rate:string){
    this.cap=rate==="unlimited"?"":rate+" 上限";
    this.frames.length=0;
    this.requested=this.lastFrame=this.lastCompleted=undefined;
    this.show({...initialMeter,state:this.cap||"空闲"});
  }

  request(){
    if(!this.paused)this.requested??=performance.now();
  }

  started(){
    const requested=this.requested;this.requested=undefined;
    return requested;
  }

  rendered(timestamp:number,requested:number|undefined,expected?:number){
    if(this.paused||requested===undefined)return;
    const completed=performance.now(),at=Number.isFinite(timestamp)?timestamp:completed;
    this.expected=expected;
    if(this.lastFrame===undefined||this.lastCompleted===undefined||requested-this.lastCompleted>=idleDelay){
      this.frames.length=0;
    }else if(at>this.lastFrame&&requested-this.lastCompleted<=Math.max(100,(expected??0)*3)){
      // A queued refresh retains its actual interval, even when the callback arrives late.
      // Time spent waiting for the next independent input is not a slow display frame.
      this.frames.push({at,interval:at-this.lastFrame});
    }
    this.lastFrame=at;this.lastCompleted=completed;
    this.plotTimer??=setTimeout(()=>{
      this.plotTimer=undefined;
      this.paint("实时");
    },reportInterval);
    this.idleTimer??=setTimeout(()=>this.checkIdle(),idleDelay);
  }

  setPaused(paused:boolean){
    this.paused=paused;
    if(paused){
      clearTimeout(this.idleTimer);clearTimeout(this.plotTimer);
      this.idleTimer=this.plotTimer=undefined;
      this.paint("后台暂停");
      this.requested=this.lastFrame=this.lastCompleted=undefined;
    }else this.show({...this.view,state:"空闲"});
  }

  private checkIdle(){
    this.idleTimer=undefined;
    // An already requested frame may arrive late. Keep its preceding timestamp.
    if(this.requested!==undefined){
      this.idleTimer=setTimeout(()=>this.checkIdle(),idleDelay);
      return;
    }
    const elapsed=performance.now()-(this.lastCompleted??0);
    if(elapsed<idleDelay){
      this.idleTimer=setTimeout(()=>this.checkIdle(),Math.ceil(idleDelay-elapsed));
      return;
    }
    this.paint("空闲");
    this.lastCompleted=undefined;
  }

  private paint(state:string){
    const caption=state==="实时"&&this.cap?this.cap:state;
    if(this.lastFrame===undefined){this.show({...this.view,state:caption});return;}
    const start=this.lastFrame-frameWindow;
    const first=this.frames.findIndex(frame=>frame.at>=start);
    if(first>0)this.frames.splice(0,first);
    const {columns,lowest}=frameColumns(this.frames,this.lastFrame,chartWidth);
    if(!lowest){this.show({...initialMeter,state:caption});return;}
    let peak=60;
    for(const column of columns)peak=Math.max(peak,1000/column.interval);
    const y=(interval:number)=>(chartHeight-3-(chartHeight-6)*1000/(interval*peak)).toFixed(2);
    const expected=this.expected;
    this.show({state:caption,minimum:(1000/lowest.interval).toFixed(1)+" FPS · "+lowest.interval.toFixed(1)+" ms",
      line:columns.map((point,i)=>(i?"L":"M")+(point.x+.5)+" "+y(point.interval)).join(""),
      marker:{x:String(lowest.x+.5),y:y(lowest.interval),late:!expected||lowest.interval>expected+Math.max(1,expected*.08)},
      budget:expected?"M0 "+y(expected)+"H"+chartWidth:undefined});
  }
}
