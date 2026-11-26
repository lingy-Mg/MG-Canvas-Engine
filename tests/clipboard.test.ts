import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEndpoint } from "../core/document.ts";
import type { BoardDocument, Connector, ImageAsset, ImageObject, MindMap, ShapeObject } from "../core/document.ts";
import { captureClipboard, cutClipboardSelection, decodeClipboard, duplicateClipboardSelection, encodeClipboard, pasteClipboard } from "../features/clipboard.ts";
import { AssetVault } from "../features/image-assets.ts";
import { buildScene, groupBounds } from "../scene/board.ts";
import { EditorSession } from "../session/editor.ts";
import { mixed } from "./fixtures/mixed.ts";
import { jpeg, png, webp } from "./fixtures/images.ts";

const p=(x:number,y:number)=>({x,y});
const bytes=(text:string)=>new Uint8Array(Buffer.from(text,"base64"));
function fixture(mime:ImageAsset["mime"]="image/png"){
  const asset:ImageAsset={...mixed.assets["asset-1"],mime,pixelWidth:8,pixelHeight:5};
  const original=bytes(mime==="image/png"?png:jpeg);
  const source={...mixed,assets:{[asset.id]:asset}} satisfies BoardDocument;
  return {editor:new EditorSession(source,{offset:p(0,0),zoom:1}),vault:new AssetVault([{meta:asset,bytes:original}]),original,asset};
}
const select=(editor:EditorSession,ids:readonly string[])=>ids.forEach((id,index)=>editor.select(id,index>0));
const pick=(editor:EditorSession,id:string)=>editor.doc.objects[id];

test("mixed fragment neither leaks other objects/assets nor retains anchors outside the copied subset",()=>{
  const {editor,vault,original}=fixture();
  const selected=["picture","link-main","shape-start","map-a"];
  const fragment=captureClipboard(editor.doc,selected,vault);assert(fragment);
  assert.deepEqual(fragment.document.order,["shape-start","link-main","map-a","picture"]);
  assert.equal(fragment.document.objects["shape-choice"],undefined);
  assert.equal(fragment.document.objects.note,undefined);
  const line=fragment.document.objects["link-main"] as Connector,source=editor.doc.objects["link-main"] as Connector;
  assert.deepEqual(line.from,source.from);
  assert.deepEqual(line.to,{kind:"free",point:resolveEndpoint(editor.doc,source.to)});
  assert.equal(fragment.assets.length,1);
  assert.deepEqual(fragment.assets[0].bytes,original);
  const encoded=encodeClipboard(fragment);
  assert(!encoded.includes(mixed.objects.note.text));
  assert.equal(decodeClipboard("普通剪贴板文本"),undefined);
  const roundtrip=decodeClipboard(encoded);assert(roundtrip);
  assert.deepEqual(roundtrip.document,fragment.document);assert.deepEqual(roundtrip.assets,fragment.assets);
  assert.throws(()=>decodeClipboard(encoded.slice(0,-9)));
});

test("paste remaps all new identities and anchored/waypoint geometry across documents in one undo",()=>{
  const source=fixture(),destination=fixture("image/jpeg");
  const chosen=["shape-start","shape-choice","link-main","map-a","picture"];
  const fragment=captureClipboard(source.editor.doc,chosen,source.vault);assert(fragment);
  const {editor,vault}=destination,before=editor.doc;
  assert(pasteClipboard(editor,vault,fragment,{delta:p(45,-80)}));
  const ids=editor.selectedIds;
  assert.deepEqual(editor.doc.order.slice(-chosen.length),ids);
  assert(ids.every(id=>!before.objects[id]));
  const [a,b,line,map,image]=ids.map(id=>pick(editor,id)) as [ShapeObject,ShapeObject,Connector,MindMap,ImageObject];
  assert.deepEqual(a.at,p(source.editor.doc.objects["shape-start"].at.x+45,source.editor.doc.objects["shape-start"].at.y-80));
  assert.deepEqual(b.at,p(source.editor.doc.objects["shape-choice"].at.x+45,source.editor.doc.objects["shape-choice"].at.y-80));
  assert.deepEqual(line.from,{kind:"anchor",objectId:a.id,portId:"east"});
  assert.deepEqual(line.to,{kind:"anchor",objectId:b.id,portId:"west"});
  assert.deepEqual(line.waypoints,mixed.objects["link-main"].waypoints.map(point=>p(point.x+45,point.y-80)));
  const originalMap=mixed.objects["map-a"];
  assert(!Object.hasOwn(originalMap.topics,map.rootId));
  assert.deepEqual(map.origin,p(originalMap.origin.x+45,originalMap.origin.y-80));
  assert.equal(map.topics[map.rootId].text,originalMap.topics[originalMap.rootId].text);
  const children=map.topics[map.rootId].childIds;
  assert(children.every(id=>!Object.hasOwn(originalMap.topics,id)));
  assert.deepEqual(children.map(id=>map.topics[id].text),originalMap.topics[originalMap.rootId].childIds.map(id=>originalMap.topics[id as keyof typeof originalMap.topics].text));
  assert.notEqual(image.assetId,destination.asset.id);
  assert.deepEqual(vault.get(image.assetId)?.bytes,source.original);
  assert.deepEqual(vault.get(destination.asset.id)?.bytes,destination.original);
  assert.equal(editor.history.past.length,1);
  editor.undo();assert.strictEqual(editor.doc,before);
  editor.redo();assert.deepEqual(vault.get(image.assetId)?.bytes,source.original);
});

test("same-board duplicate reuses image bytes; explicit paste anchor centers a fragment",()=>{
  const {editor,vault,asset}=fixture();
  select(editor,["picture","note"]);
  const before=editor.doc;
  assert(duplicateClipboardSelection(editor,vault));
  const [,copy]=editor.selectedIds.map(id=>pick(editor,id));
  assert(copy.kind==="image");
  assert.equal(copy.assetId,asset.id);
  assert.deepEqual(copy.at,p(mixed.objects.picture.at.x+18,mixed.objects.picture.at.y+18));
  assert.equal(Object.keys(editor.doc.assets).length,1);
  editor.undo();assert.strictEqual(editor.doc,before);
  const fragment=captureClipboard(editor.doc,["picture","note"],vault);assert(fragment);
  assert(pasteClipboard(editor,vault,fragment,{anchor:p(1024,-256)}));
  const pasted=groupBounds(buildScene(editor.doc,undefined,editor.selectedIds));assert(pasted);
  assert.deepEqual(p((pasted.min.x+pasted.max.x)/2,(pasted.min.y+pasted.max.y)/2),p(1024,-256));
  const generation=editor.generation;
  editor.open(editor.doc,false);
  assert(!pasteClipboard(editor,vault,fragment,{expected:generation}));
});

test("malformed binary fragment or invalid placement does not partially edit the board",()=>{
  const {editor,vault}=fixture();
  const fragment=captureClipboard(editor.doc,["picture"],vault);assert(fragment);
  const before=editor.doc;
  assert.throws(()=>pasteClipboard(editor,vault,{document:fragment.document,assets:[]}));
  assert.throws(()=>pasteClipboard(editor,vault,{document:fragment.document,assets:[{...fragment.assets[0],bytes:new Uint8Array(6)}]}));
  assert(!pasteClipboard(editor,vault,fragment,{delta:p(Infinity,0)}));
  assert.strictEqual(editor.doc,before);assert.equal(editor.history.past.length,0);
});

test("failed placement rolls back staged assets without deleting unrelated vault bytes",()=>{
  const src=fixture(),dst=fixture("image/jpeg");
  const sourceImage=src.editor.doc.objects.picture;
  assert(sourceImage.kind==="image");
  const overflowAt={...sourceImage,at:p(Number.MAX_VALUE,0)};
  assert(src.editor.commitEdit({label:"proof",patches:[{op:"putObject",value:overflowAt}]},src.editor.generation));
  const fragment=captureClipboard(src.editor.doc,["picture"],src.vault);assert(fragment);
  dst.vault.add({meta:{id:"cached-elsewhere",mime:"image/webp",pixelWidth:8,pixelHeight:5},bytes:bytes(webp)});
  const before=dst.editor.doc,ids=dst.vault.assetIds();
  assert(!pasteClipboard(dst.editor,dst.vault,fragment,{delta:p(Number.MAX_VALUE,0)}));
  assert.strictEqual(dst.editor.doc,before);assert.deepEqual(dst.vault.assetIds(),ids);
  assert.equal(dst.editor.history.past.length,0);
});

test("cut awaits actual write, refuses a stale selection, detaches surviving links and undoes atomically",async()=>{
  const {editor,vault}=fixture();
  select(editor,["shape-start","picture"]);
  const before=editor.doc;
  await assert.rejects(cutClipboardSelection(editor,vault,async()=>{throw Error("clipboard denied");}),/denied/);
  assert.strictEqual(editor.doc,before);
  let allow!:()=>void;
  const pending=cutClipboardSelection(editor,vault,async()=>{await new Promise<void>(resolve=>allow=resolve);});
  editor.select("note");
  allow();assert(!await pending);assert.strictEqual(editor.doc,before);
  select(editor,["shape-start","picture"]);
  let captured="";
  assert(await cutClipboardSelection(editor,vault,async text=>{assert.strictEqual(editor.doc,before);captured=text;}));
  assert.deepEqual(decodeClipboard(captured)?.document.order,["shape-start","picture"]);
  const line=pick(editor,"link-main") as Connector,original=before.objects["link-main"] as Connector;
  assert.deepEqual(line.from,{kind:"free",point:resolveEndpoint(before,original.from)});
  assert.deepEqual(line.to,original.to);
  assert.equal(pick(editor,"shape-start"),undefined);assert.equal(pick(editor,"picture"),undefined);
  assert.equal(Object.keys(editor.doc.assets).length,0);
  assert.equal(editor.history.past.length,1);
  editor.undo();assert.strictEqual(editor.doc,before);assert(vault.get("asset-1"));
});

test("ink mixed clipboard preserves pressure, theme and v1 fragment compatibility",()=>{
  const {editor,vault}=fixture();
  const ink={id:"ink-clipboard",kind:"ink" as const,at:p(25,45),baseWidth:6,color:"#334455",
    brushVersion:1 as const,samples:[[0,0,.1],[6,9,.9]] as const};
  assert(editor.commitEdit({label:"ink",patches:[{op:"putObject",value:ink}]},editor.generation));
  const plain=captureClipboard(editor.doc,["note"],vault);
  assert.equal(plain?.document.schemaVersion,1);
  const fragment=captureClipboard(editor.doc,["ink-clipboard","note"],vault);
  assert(fragment);
  assert.equal(fragment.document.schemaVersion,2);
  assert.equal(fragment.document.theme,editor.doc.theme);
  const roundtrip=decodeClipboard(encodeClipboard(fragment));assert(roundtrip);
  assert(pasteClipboard(editor,vault,roundtrip,{delta:p(80,-35)}));
  const copy=editor.selectedIds.map(id=>pick(editor,id)).find(item=>item?.kind==="ink");
  assert(copy?.kind==="ink");
  assert.notEqual(copy.id,ink.id);
  assert.deepEqual(copy.at,p(105,10));
  assert.deepEqual(copy.samples,ink.samples);
  assert.equal(copy.color,ink.color);
});

test("successful asynchronous clipboard write does not cut when a transient stroke claims the canvas",async()=>{
  const {editor,vault}=fixture();
  editor.select("note");
  const before=editor.doc;
  let release!:()=>void,busy=false;
  const cut=cutClipboardSelection(editor,vault,()=>new Promise<void>(resolve=>release=resolve),()=>!busy);
  busy=true;release();
  assert.equal(await cut,false);
  assert.strictEqual(editor.doc,before);
});
