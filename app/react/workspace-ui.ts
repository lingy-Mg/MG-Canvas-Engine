import {initialMeter} from "../frame-meter.ts";
import type {CSSProperties} from "react";
import type {TopicTreeView} from "../topic-tree.ts";

export type ControlState = {
  caption?:string; selected?:boolean; hidden?:boolean; disabled?:boolean; inert?:boolean;
  title?:string; value?:string; checked?:boolean; max?:string; tabIndex?:number;
  placeholder?:string; href?:string; style?:CSSProperties; shortcut?:boolean;
  [attribute:`aria-${string}`]:string|boolean|undefined;
  [attribute:`data-${string}`]:string|undefined;
};
const empty:Readonly<ControlState>=Object.freeze({});

/** Per-view subscriptions keep camera/selection changes local to affected controls. */
export class ViewState<T>{
  private value:T;
  private listeners=new Set<()=>void>();
  constructor(initial:T){this.value=initial;}
  read=()=>this.value;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};};
  set(next:T){if(Object.is(next,this.value))return;this.value=next;for(const fn of this.listeners)fn();}
}
export type LayerEntry={id:string;key:number;kind:string;glyph:string;label:string;title:string;group?:string;
  accessible:string;locked:boolean;hidden:boolean;visibility:string;selected:boolean};
export type MenuEntry={key:string;label?:string;shortcut?:string;disabled?:boolean;hidden?:boolean;description?:string;
  dropNode?:string;arrange?:string;group?:string;flowLayout?:string;separator?:boolean;status?:boolean;run?:()=>void};
export class WorkspaceUI {
  readonly frameMeter=new ViewState(initialMeter);
  readonly layers=new ViewState<readonly LayerEntry[]>([]);
  readonly searchVersion=new ViewState(0);
  readonly topics=new ViewState<TopicTreeView|undefined>(undefined);
  readonly menu=new ViewState<readonly MenuEntry[]>([]);
  private controls=new Map<string,ViewState<Readonly<ControlState>>>();
  private actions=new Map<string,Map<string,(event:Event)=>void>>();
  control(id:string){
    let entry=this.controls.get(id);
    if(!entry){entry=new ViewState(empty);this.controls.set(id,entry);}
    return entry;
  }
  patch(id:string,changes:ControlState){
    const entry=this.control(id),before=entry.read();
    if(Object.keys(changes).some(key=>!Object.is(Reflect.get(before,key),Reflect.get(changes,key))))entry.set({...before,...changes});
  }
  on<K extends keyof HTMLElementEventMap>(id:string,event:K,action:(e:HTMLElementEventMap[K])=>void){
    let events=this.actions.get(id);if(!events){events=new Map();this.actions.set(id,events);}
    events.set(event,action as (e:Event)=>void);
  }
  dispatch(id:string,event:string,native:Event){this.actions.get(id)?.get(event)?.(native);}
  reset(){this.actions.clear();}
}
