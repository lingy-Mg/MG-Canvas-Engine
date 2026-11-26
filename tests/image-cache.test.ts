import test from "node:test";
import type {TestContext} from "node:test";
import assert from "node:assert/strict";
import {setImmediate as tick} from "node:timers/promises";
import {ImageCache,decodeBrowserImage} from "../app/image-cache.ts";
import type {Bitmap} from "../app/image-cache.ts";
import {inspectImage} from "../features/image-assets.ts";
import {cacheFixture,cacheId,cachePNG} from "./fixtures/cache-images.ts";
import {png} from "./fixtures/images.ts";

function handle(width=1500,height=1000){
  let closed=0;return {bitmap:{width,height,close:()=>{closed++;}} as unknown as Bitmap,closes:()=>closed};
}
type Gate={tag:number;resolve:(bitmap:Bitmap)=>void;reject:()=>void};
function setup(t:TestContext){
  const original=globalThis.createImageBitmap,requests:Gate[]=[];let invalidations=0,active=0,peak=0;
  globalThis.createImageBitmap=(async(blob:Blob)=>{
    active++;peak=Math.max(peak,active);
    const bytes=new Uint8Array(await blob.arrayBuffer());
    try{return await new Promise<Bitmap>((resolve,reject)=>requests.push({tag:bytes[41]-48,resolve,reject:()=>reject(new Error("decode failed"))}));}
    finally{active--;}
  }) as typeof createImageBitmap;
  t.after(()=>{for(const request of requests)request.reject();globalThis.createImageBitmap=original;});
  const cache=new ImageCache(()=>{invalidations++;}),{vault}=cacheFixture(),ids=Array.from({length:22},(_,i)=>cacheId(i));
  const paint=(wanted:readonly string[])=>cache.updateVisible(new Set(wanted),vault);
  const fill=(n:number)=>ids.slice(0,n).map(id=>{const image=handle();cache.add(id,image.bitmap);return image;});
  return {cache,vault,ids,paint,fill,requests,frames:()=>invalidations,peak:()=>peak};
}

test("a full cache releases only the oldest offscreen pixels for a new visible image",async t=>{
  const {cache,ids,paint,fill,requests}=setup(t),resident=fill(20);
  cache.retain(new Set(ids));paint([ids[0],ids[20],ids[20]]);await tick();
  assert.equal(resident[0].closes(),0);assert.equal(resident[1].closes(),1);assert.equal(requests.length,1);
  const image=handle();requests[0].resolve(image.bitmap);await tick();
  assert.equal(cache.get(ids[20]),image.bitmap);assert.equal(cache.get(ids[0]),resident[0].bitmap);
  assert.equal(ids.filter(id=>cache.get(id)).length,20);assert.equal(resident.slice(2).reduce((n,i)=>n+i.closes(),0),0);
  cache.reset();assert(resident.every(i=>i.closes()===1));assert.equal(image.closes(),1);
});

test("a dense stationary view keeps its residents and skips oversized misses to serve smaller ones",async t=>{
  const {cache,vault,ids,paint,fill,requests,frames}=setup(t),resident=fill(19);
  const warm=handle(1000,1000);cache.add(ids[19],warm.bitmap);
  const small="small",bytes=Buffer.from(png,"base64");
  vault.add({meta:{id:small,mime:"image/png",pixelWidth:8,pixelHeight:5},bytes});
  const dense=[...ids,small];paint(dense);await tick();assert.equal(requests.length,1);
  const tiny=handle(8,5);requests[0].resolve(tiny.bitmap);await tick();assert.equal(cache.get(small),tiny.bitmap);
  const quiet=frames();for(let i=0;i<100;i++)paint(dense);await tick();
  assert.equal(requests.length,1);assert.equal(frames(),quiet);assert.equal(warm.closes(),0);
  assert(resident.every(i=>i.closes()===0));assert(!cache.get(ids[20]));cache.reset();
});

test("an import respects the active reservation and cannot evict visible residents",async t=>{
  const {cache,ids,paint,fill,requests}=setup(t);const resident=fill(19);
  paint(ids.slice(0,20));await tick();const competing=handle();cache.add(ids[21],competing.bitmap);
  assert.equal(competing.closes(),1);assert(resident.every(i=>i.closes()===0));
  const final=handle();requests[0].resolve(final.bitmap);await tick();
  assert.equal(ids.filter(id=>cache.get(id)).length,20);assert.equal(cache.get(ids[19]),final.bitmap);
  const duplicate=handle();cache.add(ids[19],duplicate.bitmap);assert.equal(duplicate.closes(),1);assert.equal(final.closes(),0);
  cache.reset();
});

test("late successes and rejections cannot populate or blacklist a replacement with the same asset ID",async t=>{
  const {cache,vault,ids,paint,requests,peak}=setup(t),id=ids[20],other=cacheFixture(true);
  paint([id]);await tick();cache.reset();cache.updateVisible(new Set([id]),other.vault);await tick();assert.equal(requests.length,1);
  const stale=handle();requests[0].resolve(stale.bitmap);await tick();assert.equal(stale.closes(),1);assert(!cache.get(id));
  cache.updateVisible(new Set([id]),other.vault);await tick();assert.equal(requests[1].tag,42);
  cache.retain(new Set());cache.updateVisible(new Set([id]),vault);requests[1].reject();await tick();
  paint([id]);await tick();assert.equal(requests[2].tag,20);const live=handle();requests[2].resolve(live.bitmap);await tick();
  assert.equal(cache.get(id),live.bitmap);assert.equal(peak(),1);cache.reset();
});

test("a failed resident request sleeps across pans but removal and reopening allow retries",async t=>{
  const {cache,ids,paint,requests,frames}=setup(t);paint([ids[0]]);await tick();requests[0].reject();await tick();
  const count=frames();for(let i=0;i<20;i++){paint([]);paint([ids[0]]);}await tick();
  assert.equal(requests.length,1);assert.equal(frames(),count);cache.retain(new Set());
  paint([ids[0]]);await tick();const mismatch=handle(100,100);requests[1].resolve(mismatch.bitmap);await tick();
  assert.equal(mismatch.closes(),1);paint([ids[0]]);await tick();assert.equal(requests.length,2);
  cache.reset();paint([ids[0]]);await tick();const good=handle();requests[2].resolve(good.bitmap);await tick();
  assert.equal(cache.get(ids[0]),good.bitmap);cache.reset();
});

test("an offscreen failure is discarded and an in-progress file decode shares the background decoder",async t=>{
  const {cache,ids,paint,requests,peak}=setup(t);paint([ids[3]]);await tick();
  const bytes=cachePNG(42),file=decodeBrowserImage(bytes,inspectImage(bytes));paint([ids[4]]);
  await tick();assert.equal(requests.length,1);requests[0].reject();await tick();
  assert.equal(requests[1].tag,42);paint([ids[3]]);await tick();assert.equal(requests.length,2);
  const verified=handle();requests[1].resolve(verified.bitmap);assert.equal((await file).handle,verified.bitmap);
  await tick();assert.equal(requests[2].tag,3);const wanted=handle();requests[2].resolve(wanted.bitmap);await tick();
  assert.equal(cache.get(ids[3]),wanted.bitmap);assert.equal(peak(),1);cache.reset();
});

test("an extremely thin source stays within the per-preview pixel allowance after integer rounding",async t=>{
  const oldBitmap=globalThis.createImageBitmap,oldDoc=globalThis.document,raw=handle(24_000_000,1);
  const reduced={width:0,height:0,getContext:()=>({drawImage(){}})};
  globalThis.createImageBitmap=(async()=>raw.bitmap) as typeof createImageBitmap;
  globalThis.document={createElement:()=>reduced} as unknown as Document;
  t.after(()=>{globalThis.createImageBitmap=oldBitmap;globalThis.document=oldDoc;});
  const bytes=cachePNG(1),result=await decodeBrowserImage(bytes,{mime:"image/png",width:24_000_000,height:1});
  assert.equal(raw.closes(),1);assert.deepEqual([result.handle.width,result.handle.height],[1_500_000,1]);
});
