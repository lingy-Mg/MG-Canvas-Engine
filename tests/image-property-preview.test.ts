import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {BoardDocument,ImageObject} from "../core/document.ts";
import {boxBounds} from "../core/geometry.ts";
import {AssetVault} from "../features/image-assets.ts";
import {captureClipboard,encodeClipboard} from "../features/clipboard.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {buildScene,hitTest} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";
import {EditorSession} from "../session/editor.ts";
import {imageCompanion,planImageTransform} from "../session/image-properties.ts";

const file=readFileSync(new URL("../docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas",import.meta.url),"utf8");
function setup(override:Partial<ImageObject>={}){
  const parsed=decodeProject(file),id="qa-picture";
  const item={...parsed.document.objects[id],...override} as ImageObject;
  const doc:BoardDocument={...parsed.document,objects:{...parsed.document.objects,[id]:item}};
  const editor=new EditorSession(doc);editor.select(id);
  return {editor,item:editor.doc.objects[id] as ImageObject,vault:new AssetVault(parsed.assets)};
}

test("image preview uses the same anchored box, projected bounds, and hit as one committed edit",()=>{
  const {editor:e,item,vault}=setup(),before=e.history,idx=new SceneProjection(e.doc);
  const bytes=encodeProject(e.doc,vault),copy=()=>encodeClipboard(captureClipboard(e.doc,[item.id],vault)!);
  const oldClip=copy(),values={...item.at,width:144,ratioDriver:"width" as const},changes=planImageTransform(e.doc,item,values)!;
  const next=changes.get(item.id) as ImageObject,patch=idx.overlay({objects:changes});
  assert.deepEqual([...changes.keys()],[item.id]);assert.deepEqual(next,{...item,width:144,height:90});
  const tip={x:218,y:148},rect={min:tip,max:tip},draft=idx.query(rect,patch);
  assert.notEqual(hitTest(idx.query(rect),tip,0),item.id);assert.equal(hitTest(draft,tip,0),item.id);
  assert.deepEqual(draft.find(g=>g.id===item.id)!.bounds,boxBounds(next));
  assert.equal(e.history,before);assert.equal(e.history.revision,0);assert.equal(copy(),oldClip);assert.equal(encodeProject(e.doc,vault),bytes);
  e.listen(change=>idx.update(e.doc,change));assert(e.transformSelection(values));assert.equal(e.history.past.length,1);assert.equal(e.history.revision,1);
  assert.deepEqual(e.doc.objects[item.id],next);assert.deepEqual(idx.query(rect),draft);
  const saved=encodeProject(e.doc,vault);assert.equal(JSON.parse(saved).assets[item.assetId],JSON.parse(bytes).assets[item.assetId]);
  assert.equal(e.doc.schemaVersion,1);const reopened=decodeProject(saved);assert.equal(encodeProject(reopened.document,new AssetVault(reopened.assets)),saved);
  e.undo();assert.equal(e.history.past.length,0);assert.equal(encodeProject(e.doc,vault),bytes);
  e.redo();assert.equal(encodeProject(e.doc,vault),saved);
});

test("current, original, and unlocked image proportions follow the explicit driving side",()=>{
  const {editor:e,item}=setup({width:112,height:56,rotation:.123456789012345});
  const planned=(values:Parameters<typeof planImageTransform>[2])=>planImageTransform(e.doc,item,values)!.get(item.id) as ImageObject;
  assert.deepEqual(planned({...item.at,height:42,ratioDriver:"height"}),{...item,width:84,height:42});
  assert.deepEqual(planned({...item.at,width:144,ratioDriver:"width"}),{...item,width:144,height:72});
  assert.deepEqual(planned({...item.at,width:144,height:61,lockRatio:false}),{...item,width:144,height:61,lockAspect:false});
  assert.deepEqual(planned({...item.at,width:144,lockRatio:false,imageNaturalRatio:true}),{...item,width:144,height:90,lockAspect:false});
  assert.deepEqual(planned({...item.at,imageNaturalRatio:true,ratioDriver:"height"}),{...item,width:90});
  const moved=planned({x:0,y:-24,imageRotation:0});assert.deepEqual(moved,{...item,at:{x:0,y:-24},rotation:0});
  assert.equal(planImageTransform(e.doc,item,{...item.at,width:112,height:56,lockRatio:true})?.size,0);
  assert.equal(imageCompanion(item,e.doc.assets[item.assetId],"height",56,false),112);
});

test("invalid, stale or overflowing image transforms leave history and revision untouched",()=>{
  const {editor:e,item}=setup(),start=e.history;
  for(const fields of [{x:NaN},{y:Infinity},{width:0},{height:-1},{width:Infinity},{width:144,height:NaN,ratioDriver:"width" as const},
    {imageRotation:NaN},{x:Number.MAX_VALUE,width:Number.MAX_VALUE}]){
    const input={...item.at,...fields};assert.equal(planImageTransform(e.doc,item,input),undefined);
    assert.equal(e.transformSelection(input),false);assert.equal(e.history,start);
  }
  assert.equal(planImageTransform(e.doc,{...item},item.at),undefined);
  assert.equal(e.transformSelection({...item.at,lockRatio:true}),false);assert.equal(e.history,start);
});

test("relocking preserves the migrated one-unit dimensions and exact legacy rotation",()=>{
  const {editor:e,item,vault}=setup({width:.0005,height:.000311,rotation:.123456789012345,lockAspect:false});
  assert.deepEqual([item.width,item.height],[1,1]);
  const plan=planImageTransform(e.doc,item,{...item.at,lockRatio:true})!,next=plan.get(item.id) as ImageObject;
  const {lockAspect,...locked}=item;assert.deepEqual(next,locked);
  assert(e.transformSelection({...item.at,lockRatio:true}));assert.deepEqual(e.doc.objects[item.id],locked);
  assert.equal(decodeProject(encodeProject(e.doc,vault)).document.schemaVersion,1);
  e.undo();assert.deepEqual(e.doc.objects[item.id],item);
});

test("editing an embedded image preserves native v1–v5 envelopes, pressure, curves and group membership",()=>{
  const fixture=(name:string)=>decodeProject(readFileSync(new URL("../docs/fixtures/"+name+".mgcanvas",import.meta.url),"utf8"));
  const base=decodeProject(file),line=fixture("M5R-Vector-Paths"),curve=fixture("M5S-Cubic-Paths"),groups=fixture("M5X-Flow-Groups").document;
  const ink=curve.document.objects["sample-ink"];
  const pressure:BoardDocument={...base.document,schemaVersion:2,order:[...base.document.order,ink.id],objects:{...base.document.objects,[ink.id]:ink}};
  const groupBoard:BoardDocument={...groups,flowGroups:{...groups.flowGroups!,baseVersion:4},assets:base.document.assets,order:[...groups.order,...curve.document.order],
    objects:{...groups.objects,...curve.document.objects}};
  for(const doc of [base.document,pressure,line.document,curve.document,groupBoard]){
    const e=new EditorSession(doc),item=e.doc.objects["qa-picture"] as ImageObject,vault=new AssetVault(base.assets);
    const old=encodeProject(e.doc,vault),input={...item.at,width:144,imageRotation:.5};e.select(item.id);
    assert.equal(planImageTransform(e.doc,item,input)?.size,1);assert.equal(encodeProject(e.doc,vault),old);
    assert(e.transformSelection(input));const saved=encodeProject(e.doc,vault),actual=JSON.parse(saved),expected=JSON.parse(old);
    expected.document.objects[item.id]={...item,width:144,height:90,rotation:.5};assert.deepEqual(actual,expected);
    const reopened=decodeProject(saved);assert.equal(encodeProject(reopened.document,new AssetVault(reopened.assets)),saved);
    assert.equal(e.history.past.length,1);e.undo();assert.equal(encodeProject(e.doc,vault),old);
  }
});

test("per-image shadow survives transform, copy and project round trip with the original embedded bytes",()=>{
  const {editor,item,vault}=setup();
  const wire=JSON.parse(encodeProject(editor.doc,vault));
  const primitive=(d:BoardDocument)=>buildScene(d,undefined,[item.id]).flatMap(g=>g.items).find(v=>v.kind==="image");
  assert.equal(primitive(editor.doc)?.shadow,undefined);
  const change={...item,shadow:false as const};
  assert(editor.commitEdit({label:"关闭阴影",patches:[{op:"putObject",value:change}]},editor.generation));
  assert.equal(primitive(editor.doc)?.shadow,false);
  const packet=encodeProject(editor.doc,vault),reopened=decodeProject(packet);
  const saved=JSON.parse(packet);
  assert.deepEqual(saved.assets,wire.assets);
  assert.deepEqual(saved.document,wire.document);assert.deepEqual(saved.shadowlessImages,[item.id]);
  assert.throws(()=>decodeProject(JSON.stringify({...saved,shadowlessImages:[item.id,item.id]})));
  assert.throws(()=>decodeProject(JSON.stringify({...saved,shadowlessImages:["not-an-image"]})));
  assert.deepEqual(reopened.document.objects[item.id],change);
  assert.equal((captureClipboard(editor.doc,[item.id],vault)!.document.objects[item.id] as ImageObject).shadow,false);
  const resized=planImageTransform(editor.doc,editor.doc.objects[item.id] as ImageObject,{...item.at,width:128,ratioDriver:"width"})!.get(item.id) as ImageObject;
  assert.equal(resized.shadow,false);
  editor.undo();assert.deepEqual(editor.doc.objects[item.id],item);editor.redo();assert.deepEqual(editor.doc.objects[item.id],change);
});
