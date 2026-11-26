import assert from "node:assert/strict";
import test from "node:test";
import {demo} from "../app/demo.ts";
import type {TextObject} from "../core/document.ts";
import {validateDocument} from "../core/document.ts";
import {automaticTextColor,DEFAULT_TEXT_COLOR} from "../core/text-style.ts";
import {AssetVault} from "../features/image-assets.ts";
import {createText,planTextStyle,saveText,setTextStyle} from "../features/standalone.ts";
import {captureClipboard} from "../features/clipboard.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {fontChoices,standaloneFont,textFallback} from "../platform/text-metrics.ts";
import {canvasThemes,contrastRatio,standaloneInk} from "../platform/theme.ts";
import {EditorSession} from "../session/editor.ts";

test("automatic standalone ink follows the actual background and preserves a deliberately chosen legacy color",()=>{
  const item=createText({x:0,y:0}),values={width:item.width,align:item.align,fontSize:item.fontSize,color:item.color};
  for(const theme of ["light","dark"] as const){
    for(const background of [undefined,"#143047","#f5efe1","#767676"]){
      const ink=standaloneInk({...item,background},theme);
      assert((contrastRatio(ink,background??canvasThemes[theme].bg)??0)>=4.5);
    }
    const pinned=planTextStyle(item,{...values,colorMode:"custom"})!;
    assert(!automaticTextColor(pinned));assert.equal(standaloneInk(pinned,theme),DEFAULT_TEXT_COLOR);
    assert(automaticTextColor(planTextStyle(pinned,{...values,colorMode:"auto"})!));
  }
  const legacy={...item,id:"mind-heading",color:"#52647e"};
  assert(automaticTextColor(legacy));assert(!automaticTextColor({...legacy,id:"user-title"}));
  assert.equal(standaloneInk(legacy,"light"),legacy.color);
  assert.equal(standaloneInk(legacy,"dark"),canvasThemes.dark.ink);
});

test("one style transaction preserves family choice, fixed and fitted geometry, clipboard and saved history",()=>{
  const e=new EditorSession(demo),before=e.doc,item=before.objects["mind-heading"] as TextObject;
  e.select(item.id);
  const values={width:90,align:"right" as const,fontSize:25,fontFamily:"noto-serif" as const,fontWeight:700 as const,italic:true,
    background:"#16283c",color:"#edcc99",colorMode:"custom" as const};
  assert(setTextStyle(e,item,values));const next=e.doc.objects[item.id] as TextObject;
  assert.deepEqual(validateDocument(e.doc),[]);assert.equal(next.fontFamily,"noto-serif");assert.equal(next.background,values.background);
  assert(standaloneFont(25,next).startsWith("italic 700 25px "));assert(standaloneFont(25,next).includes("Noto Serif CJK SC"));
  assert.equal(standaloneFont(16),"500 16px "+textFallback);
  for(const face of Object.values(fontChoices))assert(face.stack.endsWith(face.serif?" serif":" sans-serif"));
  const vault=new AssetVault(),encoded=encodeProject(e.doc,vault);
  assert.deepEqual(decodeProject(encoded).document.objects[item.id],next);
  assert.deepEqual(captureClipboard(e.doc,[item.id],vault)!.document.objects[item.id],next);
  assert(!saveText(e,e.generation,next,next.text,true));
  assert.strictEqual(planTextStyle(next,{...values}),next);
  assert.equal(e.history.past.length,1);e.undo();assert.strictEqual(e.doc,before);e.redo();
  const fixed=planTextStyle(next,{...values,heightMode:"fixed",height:40,background:"transparent",fontFamily:"system"})!;
  assert.equal(fixed.height,40);assert(!("background" in fixed));assert(!("fontFamily" in fixed));
  for(const bad of [{background:"invalid"},{fontFamily:"bad"},{fontWeight:910},{italic:6}]){
    const invalid={...e.doc,objects:{...e.doc.objects,[item.id]:{...next,...bad}}};
    assert(validateDocument(invalid).length);
  }
});
