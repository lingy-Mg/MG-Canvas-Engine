export const frameRates=["30","60","120","140","170","unlimited"] as const;
export type FrameRate=typeof frameRates[number];

export function frameRate(value:unknown):FrameRate{
  return frameRates.find(rate=>rate===value)??"unlimited";
}

/** Keep a fractional deadline so non-divisible display clocks alternate frame spacings. */
export class FramePace{
  private period=0;
  private next?:number;
  private tick?:number;
  private refresh=0;
  set(rate:FrameRate){
    this.period=rate==="unlimited"?0:1000/Number(rate);
    this.next=undefined;
  }
  ready(at:number):boolean{
    const elapsed=at-(this.tick??at);
    this.tick=at;
    if(elapsed>=3&&elapsed<=25){
      this.refresh=this.refresh?this.refresh*.85+elapsed*.15:elapsed;
    }
    const period=this.period;
    if(!period)return true;
    const next=this.next;
    const jitter=.35;
    if(next===undefined||at-next>period*3){this.next=at+period;return true;}
    if(at+jitter<next)return false;
    this.next=next+Math.max(1,Math.floor((at+jitter-next)/period)+1)*period;
    return true;
  }

  expectedGap():number|undefined{
    if(!this.period)return;
    const refresh=this.refresh;
    return refresh?Math.max(1,Math.ceil((this.period-.1)/refresh))*refresh:this.period;
  }
}
