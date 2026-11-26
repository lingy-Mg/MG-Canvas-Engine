import assert from "node:assert/strict";
import test from "node:test";
import type {TestContext} from "node:test";
import {createViewportFrameRequest,observeViewportSize} from "../app/viewport-lifecycle.ts";

function browserGlobal(t:TestContext,name:string,value:unknown){
  const original=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{configurable:true,value});
  t.after(()=>{if(original)Object.defineProperty(globalThis,name,original);else Reflect.deleteProperty(globalThis,name);});
}

test("pointer bursts share a frame; an unmount cancels only its own outstanding draw",t=>{
  let next=0;
  const callbacks=new Map<number,FrameRequestCallback>(),cancelled:number[]=[],drawn:number[]=[];
  browserGlobal(t,"requestAnimationFrame",(draw:FrameRequestCallback)=>{
    const id=next++;callbacks.set(id,draw);return id;
  });
  browserGlobal(t,"cancelAnimationFrame",(id:number)=>{cancelled.push(id);});
  const first=new AbortController();
  const request=createViewportFrameRequest(timestamp=>{drawn.push(timestamp);request();},first.signal);
  for(let i=0;i<100;i++)request();
  assert.deepEqual([...callbacks.keys()],[0]);
  callbacks.get(0)!(16);
  assert.deepEqual([...callbacks.keys()],[0,1]);
  first.abort();
  const second=new AbortController();
  const requestAgain=createViewportFrameRequest(timestamp=>drawn.push(timestamp),second.signal);
  request();requestAgain();requestAgain();
  callbacks.get(1)!(22);callbacks.get(2)!(32);
  assert.deepEqual(drawn,[16,32]);assert.deepEqual(cancelled,[1]);
  second.abort();assert.deepEqual(cancelled,[1]);
});

test("each viewport owns its resize observer and DPR listeners, including after display changes",t=>{
  const windowEvents=new EventTarget(),media=new Map<string,EventTarget>();
  const win=Object.assign(windowEvents,{devicePixelRatio:1,matchMedia(query:string){
    const value=new EventTarget();media.set(query,value);return value;
  }});
  const viewport={ownerDocument:{defaultView:win}} as unknown as HTMLElement;
  const watched:unknown[]=[],disconnected:number[]=[];
  let observerCallback!:()=>void;
  class Observer{
    constructor(callback:()=>void){observerCallback=callback;}
    observe(...args:unknown[]){watched.push(args);}
    disconnect(){disconnected.push(1);}
  }
  class Entry{get devicePixelContentBoxSize(){return [];}}
  browserGlobal(t,"ResizeObserver",Observer);
  browserGlobal(t,"ResizeObserverEntry",Entry);
  const first=new AbortController();let calls=0;
  observeViewportSize(viewport,()=>calls++,first.signal);
  assert.deepEqual(watched,[[viewport,{box:"device-pixel-content-box"}]]);
  observerCallback();win.dispatchEvent(new Event("resize"));
  const original=media.get("(resolution: 1dppx)")!;
  win.devicePixelRatio=2;original.dispatchEvent(new Event("change"));original.dispatchEvent(new Event("change"));
  assert.equal(calls,3);
  const current=media.get("(resolution: 2dppx)")!;
  first.abort();win.devicePixelRatio=3;current.dispatchEvent(new Event("change"));observerCallback();win.dispatchEvent(new Event("resize"));
  assert.equal(calls,3);assert.deepEqual(disconnected,[1]);
  observeViewportSize(viewport,()=>calls++,first.signal);assert.equal(watched.length,1);
  const next=new AbortController();observeViewportSize(viewport,()=>calls++,next.signal);
  win.dispatchEvent(new Event("resize"));assert.equal(calls,4);next.abort();assert.equal(disconnected.length,2);
});
