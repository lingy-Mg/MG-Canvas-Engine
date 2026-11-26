import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {TextObject} from "../core/document.ts";
import {EditorSession} from "../session/editor.ts";
import {planTextStyle,setTextStyle} from "../features/standalone.ts";
import {SceneProjection} from "../scene/projector.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {captureClipboard} from "../features/clipboard.ts";
const fixture=readFileSync(new URL("../docs/fixtures/M5Y-Text-Layout.mgcanvas",import.meta.url),"utf8");
const {document:doc}=decodeProject(fixture),item=doc.objects.approval as TextObject,fixed=doc.objects.fixed as TextObject;
const values=(text:TextObject)=>({fontSize:text.fontSize,color:text.color,align:text.align,width:text.width});
const vault=new AssetVault();

test("standalone text style plan projects CJK reflow and exactly matches the single committed edit",()=>{
  const e=new EditorSession(doc),base=e.doc,item=base.objects.approval as TextObject;e.select(item.id);
  const original=e.history,projector=new SceneProjection(base);
  const input={...values(item),fontSize:24,width:72,align:"right" as const,color:"#af1438",rotation:Math.PI/6,x:0,y:-10};
  const next=planTextStyle(item,input)!;assert(next&&next!==item);
  const group=projector.overlay({objects:new Map([[item.id,next]])}).get(item.id)!,block=group.items[0];
  assert(block.kind==="textBlock");assert.deepEqual(block.lines,["审批","（复","核）"]);
  assert.equal(next.height,101);assert.equal(next.heightMode,undefined);assert.equal(next.text,item.text);
  assert.deepEqual(block.box,next);assert.equal(block.clip,undefined);assert.equal(block.textAlign,"right");
  assert.strictEqual(e.history,original);assert.strictEqual(e.doc,base);
  assert.equal(encodeProject(e.doc,vault),encodeProject(doc,vault));assert.deepEqual(captureClipboard(e.doc,[item.id],vault)!.document.objects[item.id],item);
  assert(setTextStyle(e,item,input));assert.deepEqual(e.doc.objects[item.id],next);assert.equal(e.history.past.length,1);
  assert.deepEqual(new SceneProjection(e.doc).all().find(g=>g.id===item.id),group);
  assert(!setTextStyle(e,item,input));e.undo();assert.strictEqual(e.doc,base);e.redo();assert.deepEqual(e.doc.objects[item.id],next);
  assert.deepEqual(decodeProject(encodeProject(e.doc,vault)).document.objects[item.id],next);
});

test("fixed text clips overflow across type size and rotation, then recovers every row on returning to fit",()=>{
  const input={...values(fixed),fontSize:24,height:22,heightMode:"fixed" as const,rotation:-Math.PI/5};
  const next=planTextStyle(fixed,input)!;assert.equal(next.height,22);assert.equal(next.text,fixed.text);
  const project=new SceneProjection(doc);const frame=project.overlay({objects:new Map([[fixed.id,next]])}).get(fixed.id)!;
  const block=frame.items[0];assert(block.kind==="textBlock"&&block.clip);assert.deepEqual(block.lines,["审批","通","过，","归档","第三","行已","裁切"]);
  const fit=planTextStyle(next,{...values(next),heightMode:"fit",height:NaN})!;
  assert.equal(fit.height,236);assert(!("heightMode" in fit));assert.equal(fit.text,next.text);
  assert.equal(fit.at.x,fixed.at.x);assert.equal(fit.rotation,next.rotation);
});

test("text no-op and unrelated styling preserve a legacy frame, full rotation and CSS color token",()=>{
  const legacy={...item,height:7,width:18,rotation:.1234567891234,color:"rebeccapurple"};
  assert.strictEqual(planTextStyle(legacy,values(legacy)),legacy);
  const aligned=planTextStyle(legacy,{...values(legacy),align:"right"})!;
  assert.deepEqual(aligned,{...legacy,align:"right"});
  const moved=planTextStyle(legacy,{...values(legacy),x:0,y:0})!;assert.deepEqual(moved,{...legacy,at:{x:0,y:0}});
  const black=planTextStyle(legacy,{...values(legacy),color:"#000000"})!;assert.deepEqual(black,{...legacy,color:"#000000"});
  const enlarged=planTextStyle(legacy,{...values(legacy),fontSize:32})!;assert(enlarged.height>legacy.height&&!enlarged.heightMode);
});

test("invalid single-text fields invalidate the whole edit while complete zero positions and angles are legal",()=>{
  const e=new EditorSession(doc),fixed=e.doc.objects.fixed as TextObject;e.select(fixed.id);const history=e.history;
  const baseline={...values(fixed),heightMode:"fixed" as const,x:0,y:0,rotation:0};
  for(const change of [{fontSize:NaN},{fontSize:0},{fontSize:161},{width:0},{width:23.9},{width:5001},{x:NaN},{y:Infinity},
    {rotation:NaN},{height:0},{height:NaN},{height:.0009},{color:""},{color:"#abc"},{align:"bad"},{heightMode:"bad"}]){
    const input={...baseline,...change} as Parameters<typeof planTextStyle>[1];
    assert.equal(planTextStyle(fixed,input),undefined);assert(!setTextStyle(e,fixed,input));assert.strictEqual(e.history,history);
  }
  const proposed=planTextStyle(fixed,baseline)!;assert.deepEqual(proposed.at,{x:0,y:0});assert.equal(proposed.rotation,0);
});

test("single-text commands reject locked, hidden, mixed, and stale text from another document",()=>{
  const e=new EditorSession(doc),item=e.doc.objects.approval as TextObject;e.select(item.id);const change={...values(item),fontSize:24};
  e.setLayerLocks([item.id],true);assert(!setTextStyle(e,item,change));e.setLayerLocks([item.id],false);
  e.select(fixed.id,true);assert(!setTextStyle(e,item,change));
  e.select(item.id);e.setLayerVisibility([item.id],false);assert(!setTextStyle(e,item,change));
  e.open(decodeProject(fixture).document,true);e.select(item.id);assert(!setTextStyle(e,item,change));assert.equal(e.history.past.length,0);
});
