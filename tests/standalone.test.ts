import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,readFile,rename,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorSession } from "../session/editor.ts";
import { AssetVault,inspectImage,MAX_IMAGE_BYTES } from "../features/image-assets.ts";
import type { ImageHeader } from "../features/image-assets.ts";
import { createText,deleteStandalone,duplicateStandalone,importStandalone,moveStandaloneLayer,referencedAssetIds,saveText,setTextStyle } from "../features/standalone.ts";
import { editKey,plainText,textFrame,textHeight,wrapPlainText } from "../features/plain-text.ts";
import {placementBox} from "../app/text-placement.ts";
import {localToWorld} from "../core/geometry.ts";
import { decodeProject, encodeProject } from "../platform/project.ts";
import { MemoryDocumentStore,SaveCoordinator } from "../platform/store.ts";
import type { DocumentStore } from "../platform/store.ts";
import { buildScene } from "../scene/board.ts";
import { demo } from "../app/demo.ts";
import * as images from "./fixtures/images.ts";

const point=(x:number,y:number)=>({x,y});
const newEditor=()=>new EditorSession(demo,{offset:point(0,0),zoom:1});
const bytes=(value:string)=>new Uint8Array(Buffer.from(value,"base64"));
const pretendDecode=async (_data:Uint8Array, header:ImageHeader)=>({width:header.width,height:header.height,handle:{id:Symbol()}});
const importSample=(editor:EditorSession,vault:AssetVault)=>importStandalone({editor,vault,expected:editor.generation,at:point(-12,20),
  read:async()=>bytes(images.png),decode:pretendDecode,dispose:()=>{}});
const snapshot=(e:EditorSession)=>({document:e.doc,generation:e.generation,revision:e.history.revision});

test("placing an empty text box is immediately durable and only its uninterrupted first edit joins the insertion",()=>{
  const e=newEditor(),before=e.doc,generation=e.generation,note=createText(point(-5,12));
  assert(e.commitEdit({label:"放置文字",patches:[{op:"putObject",value:note}]},generation,[note.id]));
  const placed=e.history;
  assert.equal(placed.doc.objects[note.id].kind,"text");
  assert(saveText(e,generation,note,"第一行",false,true,placed));
  assert.equal(e.history.past.length,1);assert(e.history.revision>placed.revision);
  const complete=e.doc;e.undo();assert.strictEqual(e.doc,before);e.redo();assert.strictEqual(e.doc,complete);
  const next=createText(point(30,44));
  e.commitEdit({label:"放置文字",patches:[{op:"putObject",value:next}]},generation);
  const earlier=e.history;
  e.commitEdit({label:"其他变更",patches:[{op:"setTheme",theme:"ink"}]},generation);
  const separate=e.doc;
  assert(saveText(e,generation,next,"稍后输入",false,true,earlier));
  e.undo();assert.strictEqual(e.doc,separate);
});

test("a T text box keeps its preview width for short, multiline and wrapped input, then respects manual width",()=>{
  const e=newEditor(),box=placementBox("text",point(274,182),{zoom:1.65,offset:point(74,-52)}),item=createText(box.at);
  assert.deepEqual([item.width,item.height],[box.width,box.height]);
  assert(e.commitEdit({label:"放置文字",patches:[{op:"putObject",value:item}]},e.generation,[item.id]));
  assert(saveText(e,e.generation,item,"中文短句",false,true,e.history));
  const short=e.doc.objects[item.id];assert(short.kind==="text");assert.equal(short.width,360);
  const first="这是一段正常宽度的中文文本",second="English words with spaces ".repeat(6),value=first+"\n"+second;
  assert(saveText(e,e.generation,short,value));
  const long=e.doc.objects[item.id];assert(long.kind==="text");assert.equal(long.width,box.width);
  const rows=wrapPlainText(value,long.width,long.fontSize,long);
  assert.equal(rows[0],first);assert.equal(rows.slice(1).join(""),second);assert(rows.length>2);
  assert.equal(long.height,textHeight(value,long.width,long.fontSize,long));
  assert(setTextStyle(e,long,{fontSize:long.fontSize,color:long.color,align:"left",width:145}));
  const thinner=e.doc.objects[item.id];assert(thinner.kind==="text");assert(thinner.height>long.height);
  assert(saveText(e,e.generation,thinner,"一行"));assert.equal((e.doc.objects[item.id] as typeof thinner).width,145);
});

test("plain text creation, newlines and edit are independent commands; cancelled/blank draft has no history",()=>{
  const e=newEditor(), draft=createText(point(-3,5));
  assert.equal(saveText(e,e.generation,draft,"    \r\n"),false);
  assert.equal(e.history.revision,0);
  assert(saveText(e,e.generation,draft,"今天 17:00\r\n准备会议室"));
  assert.equal(e.history.past.length,1);
  let text=e.doc.objects[draft.id];
  assert(text.kind==="text");assert.equal(text.text,"今天 17:00\n准备会议室");
  assert.deepEqual(wrapPlainText("A\r\n\rB",999,18),["A","","B"]);
  assert.equal(plainText("a".repeat(13000)).length,12000);
  const map=e.doc.objects["mind-room"];
  assert(setTextStyle(e,text,{fontSize:20,color:"#1166bb",align:"right",width:110}));
  text=e.doc.objects[draft.id];
  assert(text.kind==="text");assert.equal(text.fontSize,20);assert.equal(text.align,"right");
  const block=buildScene(e.doc).find(group=>group.id===draft.id)?.items[0];
  assert(block?.kind==="textBlock");assert(block.lines.length>=2);
  assert.strictEqual(e.doc.objects["mind-room"],map);
  e.undo();e.undo();assert(!Object.hasOwn(e.doc.objects,draft.id));
  e.redo();assert.equal(e.doc.objects[draft.id].kind,"text");
});

test("new digits fit their first line and editing retains manual widths, styles and fixed heights",()=>{
  const e=newEditor(),draft=createText(point(80,75));
  assert(saveText(e,e.generation,draft,"123123"));
  const fitted=e.doc.objects[draft.id];assert(fitted.kind==="text");
  assert(fitted.width>24&&fitted.width<draft.width/2);assert.equal(fitted.height,textHeight(fitted.text,fitted.width,fitted.fontSize));
  const legacy={...fitted,width:211,height:108,rotation:.47,align:"right" as const,color:"#334455"};
  assert(e.commitEdit({label:"载入旧文本框",patches:[{op:"putObject",value:legacy}]},e.generation));
  const frame=textFrame(legacy),block=buildScene(e.doc,undefined,[legacy.id])[0];
  const draw=block.items[0];assert(draw.kind==="textBlock");assert.deepEqual(draw.box,frame);
  const stored=e.doc.objects[legacy.id];assert(stored.kind==="text");
  assert.equal(frame.width,211);assert.equal(frame.height,fitted.height);assert.equal(stored.height,108);
  const before=localToWorld(point(0,0),legacy),after=localToWorld(point(0,0),frame);
  assert(Math.hypot(before.x-after.x,before.y-after.y)<1e-8);
  assert(saveText(e,e.generation,legacy,"12\n34"));const two=e.doc.objects[legacy.id];assert(two.kind==="text");
  assert.deepEqual([two.width,two.color,two.align,two.rotation],[211,legacy.color,"right",.47]);
  assert.equal(two.height,textHeight(two.text,two.width,two.fontSize));
  const fixed={...two,heightMode:"fixed" as const,height:82};
  assert(e.commitEdit({label:"手动高度",patches:[{op:"putObject",value:fixed}]},e.generation));
  assert(saveText(e,e.generation,fixed,"123123"));const saved=e.doc.objects[fixed.id];assert(saved.kind==="text");
  assert.equal(textFrame(saved).height,82);assert.equal(saved.width,211);assert.equal(saved.color,legacy.color);
});

test("native text keys leave Enter for newline and candidate confirmation unhandled",()=>{
  const base={key:"Enter",ctrlKey:false,metaKey:false,isComposing:false};
  assert.equal(editKey(base,false,false),undefined);
  assert.equal(editKey({...base,ctrlKey:true,isComposing:true},false,false),undefined);
  assert.equal(editKey({...base,ctrlKey:true,keyCode:229},false,false),undefined);
  assert.equal(editKey({...base,ctrlKey:true},true,false),undefined);
  assert.equal(editKey({...base,ctrlKey:true},false,true),undefined);
  assert.equal(editKey({...base,ctrlKey:true},false,false),"commit");
  assert.equal(editKey({...base,metaKey:true},false,false),"commit");
  assert.equal(editKey({...base,key:"Escape"},true,false),undefined);
  assert.equal(editKey({...base,key:"Escape"},false,false),"cancel");
});
test("real static PNG, JPEG and WebP fixture headers pass; APNG, animated WebP, invalid and oversized bytes fail",()=>{
  for(const [name,mime] of [["png","image/png"],["jpeg","image/jpeg"],["webp","image/webp"]] as const)
    assert.deepEqual(inspectImage(bytes(images[name])),{mime,width:8,height:5});
  assert.throws(()=>inspectImage(bytes(images.apng)),/动态 PNG/);
  assert.throws(()=>inspectImage(bytes(images.animatedWebp)),/动态 WebP/);
  assert.throws(()=>inspectImage(bytes(images.png).slice(0,35)),/无效|不完整/);
  assert.throws(()=>inspectImage(new Uint8Array(MAX_IMAGE_BYTES+1)),/最多 8 MiB/);
  const header=bytes(images.png);new DataView(header.buffer).setUint32(16,24_001_000,false);
  assert.throws(()=>inspectImage(header),/2400 万像素/);
});
test("same original bytes reuse one asset, independent image drag/resize/reorder/delete preserve other objects",async()=>{
  const e=newEditor(),vault=new AssetVault();
  const first=await importSample(e,vault),second=await importSample(e,vault);
  assert(first&&second);
  assert.notEqual(first.image.id,second.image.id);assert.equal(first.asset.id,second.asset.id);
  assert.equal(Object.keys(e.doc.assets).length,1);
  assert(moveStandaloneLayer(e,-1));assert.equal(e.doc.order.at(-2),second.image.id);
  const flow=e.doc.objects["flow-arrow"];
  const beforeDrag=e.history.past.length;
  e.down(1,"mouse",point(0,25),second.image.id,false);
  e.move(1,point(19,23));assert(e.preview);
  assert.equal(e.history.past.length,beforeDrag);
  e.up(1,point(19,23));
  assert.equal(e.history.past.length,beforeDrag+1);
  let image=e.doc.objects[second.image.id];assert(image.kind==="image");assert.deepEqual(image.at,point(7,18));
  assert(e.transformSelection({x:image.at.x,y:image.at.y,width:120,height:image.height}));
  image=e.doc.objects[second.image.id];assert(image.kind==="image");assert.equal(image.width,120);assert.equal(image.height,75);
  assert.strictEqual(e.doc.objects["flow-arrow"],flow);
  assert(duplicateStandalone(e));assert.equal(Object.keys(e.doc.assets).length,1);
  assert(deleteStandalone(e));assert(Object.hasOwn(e.doc.assets,first.asset.id));
  e.select(first.image.id);assert(deleteStandalone(e));assert(Object.hasOwn(e.doc.assets,first.asset.id));
  e.select(second.image.id);assert(deleteStandalone(e));assert(!Object.hasOwn(e.doc.assets,first.asset.id));
  vault.retain(referencedAssetIds(e));assert(vault.get(first.asset.id));
  e.undo();assert(e.doc.objects[second.image.id]);assert(Object.hasOwn(e.doc.assets,first.asset.id));
  e.redo();assert(!e.doc.objects[second.image.id]);
});
test("async import is disposed when switching board, reopening same file or cancelling the import",async()=>{
  for(const action of ["other","same","cancel"]){
    const e=newEditor(),old=new AssetVault(),generation=e.generation;
    let running=true,disposed=0,finish!:()=>void,started!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const gate=new Promise<void>(resolve=>{finish=resolve;});
    const pending=importStandalone({editor:e,vault:old,expected:generation,at:point(0,0),read:async()=>bytes(images.png),
      decode:async (_raw,header)=>{started();await gate;return pretendDecode(_raw,header);},
      dispose:()=>{disposed++;},isCurrent:()=>running});
    await entered;
    if(action==="other")e.open({...demo,id:"another-board"},false);
    else if(action==="same")e.open(demo,true);
    else running=false;
    finish();
    assert.equal(await pending,undefined);assert.equal(disposed,1);
    assert.equal(e.history.past.length,0);assert.equal(Object.keys(e.doc.assets).length,0);
  }
});
test("invalid data or decoder failure leaves no document/history entry",async()=>{
  const e=newEditor(),vault=new AssetVault();
  for(const isInvalidHeader of [true,false]){
    await assert.rejects(importStandalone({editor:e,vault,expected:e.generation,at:point(0,0),
      read:async()=>isInvalidHeader?new Uint8Array(5):bytes(images.png),
      decode:async()=>{throw new Error("decoder error");},dispose:()=>{}}));
    assert.equal(e.history.past.length,0);assert.equal(Object.keys(e.doc.assets).length,0);
  }
});
test("portable save/reopen keeps exact original bytes after source path moves and rejects project tampering",async()=>{
  const temp=await mkdtemp(join(tmpdir(),"mg-canvas-image-"));
  try{
    const original=bytes(images.jpeg),path=join(temp,"source.jpg");
    await writeFile(path,original);
    const e=newEditor(),vault=new AssetVault();
    const imported=await importStandalone({editor:e,vault,expected:e.generation,at:point(1,1),
      read:async()=>new Uint8Array(await readFile(path)),decode:pretendDecode,dispose:()=>{}});
    assert(imported);
    const serial=encodeProject(e.doc,vault);
    assert(!serial.includes(path));
    await rename(path,join(temp,"moved.jpg"));
    await assert.rejects(readFile(path),{ code:"ENOENT" });
    const reopened=decodeProject(serial), rebuilt=new AssetVault(reopened.assets);
    assert.deepEqual(reopened.assets[0].bytes,original);
    assert.equal(encodeProject(reopened.document,rebuilt),serial);
    for(const kind of ["base64","missing","mismatch"]){
      const bad=JSON.parse(serial);
      if(kind==="base64")bad.assets[imported.asset.id]="abc?";
      if(kind==="missing")delete bad.assets[imported.asset.id];
      if(kind==="mismatch")bad.document.assets[imported.asset.id].pixelHeight++;
      assert.throws(()=>decodeProject(JSON.stringify(bad)));
    }
  }finally{await rm(temp,{recursive:true,force:true});}
});
test("queued save A retains captured asset bytes across pruning, later save B wins destination ordering",async()=>{
  const e=newEditor(),vault=new AssetVault(), memory=new MemoryDocumentStore();
  const result=await importSample(e,vault);assert(result);
  const seen:string[]=[];let release!:()=>void, started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const store:DocumentStore={ read:key=>memory.read(key),write:async(key,data)=>{
    seen.push(data);
    if(seen.length===1){started();await gate;}
    await memory.write(key,data);
  }};
  const coord=new SaveCoordinator(store),a=coord.saveProject("board",snapshot(e),vault);
  await ready;
  e.undo();assert(!e.doc.assets[result.asset.id]);vault.retain(new Set());
  assert(!vault.get(result.asset.id));
  const b=coord.saveProject("board",snapshot(e),vault);
  await Promise.resolve();assert.equal(seen.length,1);
  release();await a;await b;
  assert.deepEqual(decodeProject(seen[0]).assets[0].bytes,bytes(images.png));
  assert.equal((await coord.reopenProject("board"))?.assets.length,0);
});
