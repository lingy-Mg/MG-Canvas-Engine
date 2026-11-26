import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {captureClipboard,encodeClipboard,decodeClipboard,pasteClipboard} from "../features/clipboard.ts";
import {assertDocument,MAX_BOARD_PATH_VERTICES,MAX_PATH_VERTICES} from "../core/document.ts";
import type {VectorPath} from "../core/document.ts";
import {buildScene,hitTest,marqueeHit} from "../scene/board.ts";
import {EditorSession} from "../session/editor.ts";
import {PathInput} from "../features/path-input.ts";
import {finishPath,stylePath} from "../features/vector-path.ts";
import {demo} from "../app/demo.ts";
const read=(name:string)=>decodeProject(readFileSync(new URL("../docs/fixtures/"+name+".mgcanvas",import.meta.url),"utf8"));
const mixed=read("M5R-Vector-Paths"),legacy=read("Meeting-Room-Mobile-QA"),doc=mixed.document,vault=new AssetVault(mixed.assets);
const camera={zoom:1,offset:{x:0,y:0}},at={x:0,y:0};
const vertices=[at,{x:80,y:0},{x:80,y:60}];
const example:VectorPath={kind:"path",id:"path",at,vertices,closed:true,fill:"#c8eee4",stroke:"#245974",strokeWidth:4};
function board(path:VectorPath){return {...doc,order:[path.id],objects:{[path.id]:path},assets:{}};}
test("legacy projects keep their schema, only a completed path promotes its board; history restores exact previous bytes",()=>{
  for(const project of [legacy,{...legacy,document:{...legacy.document,schemaVersion:2 as const}}]){
    const e=new EditorSession(project.document,camera),v=new AssetVault(project.assets),original=encodeProject(e.doc,v);
    assert(!finishPath(e,e.generation,[at],false));assert.equal(encodeProject(e.doc,v),original);
    assert(finishPath(e,e.generation,vertices,false));assert.equal(e.doc.schemaVersion,3);assert.equal(e.history.past.length,1);
    const ink=doc.objects["sample-ink"];assert(e.commitEdit({label:"笔迹",patches:[{op:"putObject",value:ink}]},e.generation));assert.equal(e.doc.schemaVersion,3);
    e.undo();const edited=encodeProject(e.doc,v);e.undo();assert.equal(encodeProject(e.doc,v),original);
    e.redo();assert.equal(encodeProject(e.doc,v),edited);
  }
  const ink=doc.objects["sample-ink"];
  for(const rows of [[ink,example],[example,ink]]){
    const e=new EditorSession(legacy.document,camera);
    assert(e.commitEdit({label:"混排",patches:rows.map(value=>({op:"putObject",value}))},e.generation));
    assert.equal(e.doc.schemaVersion,3);assert.deepEqual(e.doc.objects[ink.id],ink);assert.deepEqual(e.doc.objects.path,example);
    e.undo();assert.deepEqual(e.doc,legacy.document);
  }
});
test("bounds, open edges, closing edge, transparent interior, even-odd fill and thick-stroke marquee agree",()=>{
  const scene=buildScene(board(example));assert.deepEqual(scene[0].bounds,{min:{x:-2,y:-2},max:{x:82,y:62}});
  const hit=(s:ReturnType<typeof buildScene>,x:number,y:number)=>hitTest(s,{x,y},0);
  assert.equal(hit(scene,51,17),"path");assert.equal(hit(scene,40,30),"path");assert.equal(hit(scene,20,40),undefined);
  assert.equal(hit(scene,40,-2),"path");assert.equal(hit(scene,40,-2.01),undefined);
  const {fill,...outline}=example,unfilled=buildScene(board(outline)),open=buildScene(board({...outline,closed:false}));
  assert.equal(hit(unfilled,51,17),undefined);assert.equal(hit(unfilled,40,30),"path");assert.equal(hit(open,40,30),undefined);
  const rect={min:{x:46,y:9},max:{x:49,y:13}};
  assert.deepEqual(marqueeHit(scene,rect),["path"]);assert.deepEqual(marqueeHit(unfilled,rect),[]);
  assert.deepEqual(marqueeHit(open,{min:{x:20,y:-3},max:{x:23,y:-1.9}}),["path"]);
  const bow=buildScene(board({...example,vertices:[at,{x:80,y:60},{x:0,y:60},{x:80,y:0}]}));
  assert.equal(hit(bow,40,10),"path");assert.equal(hit(bow,5,30),undefined);
});
test("v3 mixed image, ink and path fragments round trip original PNG, pressure and local vertices with fresh IDs",()=>{
  const bytes=encodeProject(doc,vault),reopen=decodeProject(bytes);
  assert.deepEqual(reopen.assets,mixed.assets);assert.equal(encodeProject(reopen.document,new AssetVault(reopen.assets)),bytes);
  const complete=captureClipboard(doc,doc.order,vault)!;
  assert.equal(complete.document.schemaVersion,3);
  const wire=encodeClipboard(complete),fragment=decodeClipboard(wire)!;assert.equal(encodeClipboard(fragment),wire);
  assert.equal(captureClipboard(doc,["qa-picture"],vault)!.document.schemaVersion,1);
  assert.equal(captureClipboard(doc,["sample-ink"],vault)!.document.schemaVersion,2);
  const e=new EditorSession(demo,camera),dest=new AssetVault();assert(pasteClipboard(e,dest,fragment,{delta:{x:15,y:-9}}));
  assert.equal(e.doc.schemaVersion,3);assert.equal(e.history.past.length,1);
  const copied=e.selectedIds.map(id=>e.doc.objects[id]);
  const path=copied.find(o=>o.kind==="path"&&o.closed)!;assert(path.kind==="path");assert.notEqual(path.id,"closed-path");
  const source=doc.objects["closed-path"];assert(source.kind==="path");
  assert.deepEqual(path.vertices,source.vertices);assert.deepEqual(path.at,{x:source.at.x+15,y:source.at.y-9});
  const stroke=copied.find(o=>o.kind==="ink")!,ink=doc.objects["sample-ink"];assert(stroke?.kind==="ink"&&ink.kind==="ink");assert.deepEqual(stroke.samples,ink.samples);
  assert.deepEqual(decodeProject(encodeProject(e.doc,dest)).assets[0].bytes,mixed.assets[0].bytes);
  e.undo();assert.equal(e.doc.schemaVersion,1);
});
test("unknown versions, implicit fill on open paths, malformed coordinates and unsupported path segments fail atomic validation",()=>{
  const original=board(example),e=new EditorSession(original,camera),history=e.history;
  for(const change of [{closed:false},{vertices:[at]},{vertices:[at,at,at]},{vertices:[at,{x:NaN,y:0},at]},
      {vertices:[...vertices,at]},{vertices:Array.from({length:MAX_PATH_VERTICES+1},(_,i)=>({x:i,y:i}))},
      {beziers:[]},{fill:"red"},{strokeWidth:0},{at:{x:1e10,y:0}}]){
    assert.equal(e.commitEdit({label:"invalid",patches:[{op:"putObject",value:{...example,...change}}]},e.generation),false);
    assert.equal(e.history,history);
  }
  for(const version of [1,2,4]){
    assert.throws(()=>assertDocument({...original,schemaVersion:version}));
    assert.throws(()=>decodeProject(JSON.stringify({format:"mg-canvas.project",version:1,document:{...original,schemaVersion:version},assets:{}})));
  }
  const full=Array.from({length:MAX_PATH_VERTICES},(_,i)=>({x:i,y:0}));
  const objects:Record<string,VectorPath>={};
  const {fill,...outline}=example;
  for(let used=0;used<MAX_BOARD_PATH_VERTICES;used+=full.length){
    const id="row-"+used;
    objects[id]={...outline,id,closed:false,vertices:full.slice(0,Math.min(full.length,MAX_BOARD_PATH_VERTICES-used))};
  }
  const budget={...original,order:Object.keys(objects),objects};assertDocument(budget);
  const last=budget.order.at(-1)!;
  objects[last]={...objects[last],vertices:[...objects[last].vertices,{x:MAX_PATH_VERTICES+1,y:0}]};
  assert.throws(()=>assertDocument(budget),/budget/);
  assert.throws(()=>decodeClipboard("MG-CANVAS-CLIPBOARD/4\n{}"));assert.equal(decodeClipboard("普通文本"),undefined);
});
test("editing one vertex previews only that coordinate, restores on cancel and commits once without moving other points",()=>{
  const e=new EditorSession(board(example),camera);e.select("path");const input=new PathInput(e);
  const original=e.doc.objects.path as VectorPath;input.start(original);assert(input.down(4,"mouse",{x:82,y:0}));
  input.move(4,{x:92,y:12});assert.equal(e.doc.objects.path,original);assert.equal(e.history.past.length,0);
  const preview=input.preview?.objects.get("path");assert(preview?.kind==="path");assert.deepEqual(preview.vertices[1],{x:90,y:12});
  input.cancel();input.up(4,{x:92,y:12});assert.equal(e.history.past.length,0);
  input.start(original);input.down(4,"mouse",{x:80,y:0});input.up(4,{x:66,y:14});
  const after=e.doc.objects.path;assert(after.kind==="path");assert.deepEqual(after,{...original,vertices:[at,{x:66,y:14},vertices[2]]});
  assert.equal(e.history.past.length,1);e.undo();assert.deepEqual(e.doc.objects.path,original);
  const valid=e.doc.objects.path as VectorPath;assert(stylePath(e,valid,"#765432",7));
  assert.equal((e.doc.objects.path as VectorPath).fill,undefined);assert(!stylePath(e,valid,"#123456",2));
});
test("deleting the last path uses the schema required by the remaining document and undo restores v3 without losing data",()=>{
  const e=new EditorSession(doc,camera);
  assert(e.commitEdit({label:"移除路径",patches:[{op:"removeObject",id:"open-path"},{op:"removeObject",id:"closed-path"}]},e.generation));
  assert.equal(e.doc.schemaVersion,2);const ink=e.doc.objects["sample-ink"];assert.deepEqual(ink,doc.objects["sample-ink"]);
  e.undo();assert.equal(encodeProject(e.doc,vault),encodeProject(doc,vault));
  const bare=new EditorSession(board(example),camera);
  assert(bare.commitEdit({label:"移除路径",patches:[{op:"removeObject",id:"path"}]},bare.generation));assert.equal(bare.doc.schemaVersion,1);
});
