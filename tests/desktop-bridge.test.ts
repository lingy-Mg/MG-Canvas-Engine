import assert from "node:assert/strict";
import {setImmediate} from "node:timers/promises";
import {test} from "node:test";
import {createDesktopBridge} from "../app/desktop-bridge.ts";
import type {CanvasTools} from "../platform/canvas-tools.ts";

test("desktop delivery waits for a ready mount and acknowledges a pulled job once",async()=>{
  const next=Promise.withResolvers<unknown>(),done=Promise.withResolvers<unknown>();
  const firstReady=Promise.withResolvers<void>(),secondReady=Promise.withResolvers<void>();
  const first=new AbortController(),second=new AbortController();
  let polls=0,dispatches=0;
  const attach=createDesktopBridge(async<T>(command:string,args?:unknown)=>{
    if(command==="desktop_next"){polls++;return await next.promise as T;}
    assert.equal(command,"desktop_complete");
    second.abort();
    done.resolve(args);
    return undefined as T;
  });
  const callbacks={
    tools:{} as CanvasTools,
    open:async()=>{throw new Error("Unexpected open");},
    snapshot:()=>{dispatches++;return {ok:true,revision:"second"};},
  };
  attach({...callbacks,signal:first.signal,ready:firstReady.promise,snapshot:()=>{throw new Error("Unmounted receiver");}});
  await setImmediate();
  assert.equal(polls,0);
  firstReady.resolve();
  await setImmediate();
  assert.equal(polls,1);
  first.abort();
  attach({...callbacks,signal:second.signal,ready:secondReady.promise});
  next.resolve({id:"in-flight",action:"snapshot",args:{}});
  await setImmediate();
  assert.equal(dispatches,0);
  secondReady.resolve();
  assert.deepEqual(await done.promise,{id:"in-flight",result:{ok:true,revision:"second"}});
  assert.equal(polls,1);
  assert.equal(dispatches,1);
});

test("an interrupted import can resume after remount without repeating a completed job",async()=>{
  const first=new AbortController(),second=new AbortController();
  const opening=Promise.withResolvers<void>(),done=Promise.withResolvers<void>();
  const completions:unknown[]=[];
  let attempts=0;
  const attach=createDesktopBridge(async<T>(command:string,args?:unknown)=>{
    if(command==="desktop_next")return {id:"open",action:"open",args:{fileName:"C:\\board.mgcanvas",encoded:"fixture"}} as T;
    completions.push(args);
    if(completions.length===1)throw Error("Acknowledgement interrupted");
    second.abort();
    done.resolve();
    return undefined as T;
  });
  const callbacks={ready:Promise.resolve(),tools:{} as CanvasTools,snapshot:()=>({ok:true})};
  attach({...callbacks,signal:first.signal,open:async()=>{
    attempts++;
    opening.resolve();
    await new Promise<void>(resolve=>first.signal.addEventListener("abort",()=>resolve(),{once:true}));
    first.signal.throwIfAborted();
    return {ok:true};
  }});
  await opening.promise;
  first.abort();
  attach({...callbacks,signal:second.signal,open:async(fileName,encoded)=>{
    attempts++;
    assert.equal(fileName,"board.mgcanvas");
    assert.equal(encoded,"fixture");
    return {ok:true};
  }});
  await done.promise;
  assert.equal(attempts,2);
  assert.deepEqual(completions,[{id:"open",result:{ok:true}},{id:"open",result:{ok:true}}]);
});
