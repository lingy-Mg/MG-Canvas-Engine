import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { demo } from "../app/demo.ts";
import type { InkObject } from "../core/document.ts";
import { resolveEndpoint } from "../core/document.ts";
import { EditorSession } from "../session/editor.ts";
import { SelectionAppearance } from "../features/selection-appearance.ts";
import type { AppearanceKey } from "../features/selection-appearance.ts";
import { AssetVault } from "../features/image-assets.ts";
import { captureClipboard } from "../features/clipboard.ts";
import { decodeProject, encodeProject } from "../platform/project.ts";
import { SceneProjection } from "../scene/projector.ts";

const camera={offset:{x:0,y:0},zoom:1};
const edits=(...pairs:[AppearanceKey,string|number][])=>new Map(pairs);
function pick(editor:EditorSession,...ids:string[]){
  editor.select(ids[0]);for(const id of ids.slice(1))editor.select(id,true);
  return new SelectionAppearance(editor);
}
const keys=(form:SelectionAppearance)=>form.fields.map(f=>f.key);
const ink:InkObject={kind:"ink",id:"pressure",at:{x:5,y:8},color:"#908877",brushVersion:1,baseWidth:6,
  samples:[[0,0,.14],[10,3,.81],[21,2,.39]]};

test("multi-edit intersects actual field capabilities, rectangle-only radii and effective width limits",()=>{
  const doc=decodeProject(readFileSync(new URL("../docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas",import.meta.url),"utf8")).document;
  const editor=new EditorSession(doc,camera),rect=doc.objects["flow-submit"];assert(rect.kind==="shape");
  assert(editor.commitEdit({label:"fixture",patches:[{op:"putObject",value:{...rect,id:"rect2",cornerRadius:13}},
    {op:"putObject",value:{...rect,id:"diamond",shape:"diamond"}},{op:"putObject",value:ink}]},editor.generation));
  assert.deepEqual(keys(pick(editor,rect.id,"rect2")),["lineColor","lineWidth","fill","radius"]);
  assert.deepEqual(keys(pick(editor,rect.id,"diamond")),["lineColor","lineWidth","fill"]);
  const form=pick(editor,rect.id,"flow-first",ink.id);
  assert.deepEqual(keys(form),["lineColor","lineWidth"]);
  assert.deepEqual(form.fields.map(f=>f.value),[undefined,undefined]);
  assert.deepEqual([form.fields[1].min,form.fields[1].max],[.25,64]);
  for(const id of ["qa-picture","qa-label","mind-booking"])assert.deepEqual(keys(pick(editor,rect.id,id)),[]);
  assert.deepEqual(keys(pick(editor,rect.id)),[]);
});

test("render-only mixed drafts leave export and clipboard unchanged; two fields commit and undo together",()=>{
  const original=decodeProject(readFileSync(new URL("../docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas",import.meta.url),"utf8"));
  const editor=new EditorSession(original.document,camera),vault=new AssetVault(original.assets);
  assert(editor.commitEdit({label:"fixture",patches:[{op:"putObject",value:ink}]},editor.generation));
  const ids=["flow-submit","flow-first",ink.id],form=pick(editor,...ids);
  const doc=editor.doc,history=editor.history,bytes=encodeProject(doc,vault),copy=captureClipboard(doc,ids,vault);
  const edge=doc.objects[ids[1]];assert(edge.kind==="connector");
  const input=edits(["lineColor","#663399"],["lineWidth",8.5]),shown=form.preview(input);assert(shown);
  const projection=new SceneProjection(doc),overlay=projection.overlay({objects:shown});
  assert.equal(overlay.size,3);
  assert(overlay.get(ink.id)?.items.some(p=>p.kind==="ink"&&p.color==="#663399"));
  assert.deepEqual(projection.all().find(g=>g.id===ink.id)?.items.find(p=>p.kind==="ink")?.color,ink.color);
  assert.equal(editor.history,history);assert.equal(editor.doc,doc);assert.equal(encodeProject(editor.doc,vault),bytes);
  assert.deepEqual(captureClipboard(editor.doc,ids,vault),copy);
  const stroke=shown.get(ink.id),sourceInk=doc.objects[ink.id];assert(stroke?.kind==="ink"&&sourceInk.kind==="ink");assert.equal(stroke.samples,sourceInk.samples);
  assert(form.apply(input));assert.equal(editor.history.past.length,history.past.length+1);
  for(const id of ids){
    const before=doc.objects[id],expected=before.kind==="ink"?{...before,color:"#663399",baseWidth:8.5}:{...before,stroke:"#663399",strokeWidth:8.5};
    assert.deepEqual(editor.doc.objects[id],expected);
  }
  for(const id of doc.order.filter(id=>!ids.includes(id)))assert.equal(editor.doc.objects[id],doc.objects[id]);
  assert.deepEqual(resolveEndpoint(editor.doc,edge.from),resolveEndpoint(doc,edge.from));
  assert.deepEqual(encodeProject(editor.doc,vault),encodeProject(decodeProject(encodeProject(editor.doc,vault)).document,vault));
  assert.deepEqual(decodeProject(encodeProject(editor.doc,vault)).assets,original.assets);
  const applied=editor.doc;editor.undo();assert.deepEqual(editor.doc,doc);
  editor.redo();assert.deepEqual(editor.doc,applied);
});

test("equal colors preserve legacy spelling and optional keys; invalid mixed input never partially commits",()=>{
  const editor=new EditorSession(demo,camera),s=demo.objects["flow-source"];assert(s.kind==="shape");
  const legacy={...s,id:"short",stroke:"#ABC",fill:"papayawhip"};
  const other={...s,id:"hex",stroke:"#aabbcc",fill:"rgb(10, 12, 14)"};
  assert(editor.commitEdit({label:"fixtures",patches:[{op:"putObject",value:legacy},{op:"putObject",value:other}]},editor.generation));
  const form=pick(editor,legacy.id,other.id),history=editor.history;
  assert.equal(form.fields.find(f=>f.key==="lineColor")?.value,"#ABC");
  assert.equal(form.fields.find(f=>f.key==="fill")?.value,undefined);
  assert(!form.apply(edits(["lineColor","#AABBCC"],["lineWidth",1.3])));
  for(const invalid of [edits(["fill","#443355"],["radius",-1]),edits(["lineWidth",NaN]),edits(["textColor","#ABCDEF"]),edits(["fill","invalid"])]){
    assert.equal(form.preview(invalid),undefined);assert(!form.apply(invalid));assert.equal(editor.history,history);
  }
  assert(form.apply(edits(["lineColor","#ABC"],["radius",23])));
  for(const before of [legacy,other])assert.deepEqual(editor.doc.objects[before.id],{...before,cornerRadius:23});
  const again=new SelectionAppearance(editor);assert(again.apply(edits(["fill","#113355"])));
  for(const before of [legacy,other])assert.deepEqual(editor.doc.objects[before.id],{...before,cornerRadius:23,fill:"#113355"});
});

test("text color preserves content, formatting and layout, and a draft cannot survive selection, undo or reopening",()=>{
  const editor=new EditorSession(demo,camera),ids=["flow-heading","mind-heading"];
  let form=pick(editor,...ids);assert.deepEqual(keys(form),["textColor"]);
  const color=edits(["textColor","#123abc"]),old=editor.doc;
  editor.pan({x:12,y:4});assert(form.preview(color)?.size===2);
  editor.select("flow-source");pick(editor,...ids);assert(!form.apply(color));
  form=new SelectionAppearance(editor);assert(form.apply(color));
  for(const id of ids){
    const before=old.objects[id];assert(before.kind==="text");
    const {colorMode,...format}=before;assert.equal(colorMode,"auto");
    assert.deepEqual(editor.doc.objects[id],{...format,color:"#123abc"});
  }
  const applied=editor.doc;form=new SelectionAppearance(editor);
  editor.undo();editor.redo();assert.deepEqual(editor.doc,applied);assert(!form.apply(edits(["textColor","#070707"])));
  form=new SelectionAppearance(editor);editor.open(applied,true);pick(editor,...ids);
  assert(!form.apply(edits(["textColor","#070707"])));assert.equal(editor.history.past.length,0);
  assert.equal(encodeProject(editor.doc,new AssetVault()),encodeProject(applied,new AssetVault()));
});
