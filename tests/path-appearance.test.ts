import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {BoardDocument,VectorPath} from "../core/document.ts";
import {pathFrame,pathHandleBox,pathStrokeBox} from "../core/path-transform.ts";
import {withPathAppearance,stylePath} from "../features/vector-path.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {buildScene,hitTest,marqueeHit} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";
import {EditorSession} from "../session/editor.ts";

const project=decodeProject(readFileSync(new URL("../docs/fixtures/M5S-Cubic-Paths.mgcanvas",import.meta.url),"utf8"));
const doc=project.document,loop=doc.objects["closed-path"] as VectorPath,open=doc.objects["open-path"] as VectorPath;
const camera={zoom:1,offset:{x:0,y:0}};
test("open and closed appearance plans preserve every anchor and owned cubic handle, including the closing edge",()=>{
  for(const path of [loop,open]){
    const value=withPathAppearance(path,"#000000",10,path.fill)!;
    for(const field of ["id","at","vertices","curves","closed"] as const)assert.equal(value[field],path[field]);
    assert.deepEqual(Object.keys(value),Object.keys(path));assert.equal(value.strokeWidth,10);assert.equal(value.stroke,"#000000");assert.equal(value.fill,path.fill);
    assert.equal(withPathAppearance(path,path.stroke,path.strokeWidth,path.fill),path);
  }
  const clear=withPathAppearance(loop,loop.stroke,4)!;assert(!("fill" in clear)&&clear.closed);
  assert.equal(withPathAppearance(clear,clear.stroke,4,"#000000")?.fill,"#000000");
  assert.equal(withPathAppearance(open,open.stroke,4,"#000000"),undefined);
});
test("the same appearance planner validates the preview width, document command, and existing opaque hex format",()=>{
  const e=new EditorSession(doc,camera);e.select(loop.id);const current=e.doc.objects[loop.id] as VectorPath;
  for(const width of [NaN,Infinity,-1,0,.2499,64.001]){
    assert.equal(withPathAppearance(loop,loop.stroke,width,loop.fill),undefined);
    assert(!stylePath(e,current,loop.stroke,width,loop.fill));
  }
  for(const token of ["","transparent","black","#000","#000000ff","invalid"]){
    assert.equal(withPathAppearance(loop,token,4,loop.fill),undefined);assert.equal(withPathAppearance(loop,loop.stroke,4,token),undefined);
  }
  assert.equal(e.history.past.length,0);assert(!stylePath(e,current,loop.stroke,4,loop.fill));
  for(const limit of [.25,64])assert.equal(withPathAppearance(loop,loop.stroke,limit)?.strokeWidth,limit);
});
test("a wider path appears in the neighboring cell for drawing, edge picks and box selection, then disappears on undo",()=>{
  const path:VectorPath={kind:"path",id:"border",at:{x:10,y:509},vertices:[{x:0,y:0},{x:85,y:0}],closed:false,stroke:"#301245",strokeWidth:4};
  const board:BoardDocument={schemaVersion:3,id:"crossing",theme:"paper",assets:{},objects:{border:path},order:["border"]};
  const e=new EditorSession(board,camera),projector=new SceneProjection(board);e.select(path.id);
  const rect={min:{x:37,y:512.5},max:{x:39,y:513.5}},point={x:38,y:513};
  const wide=withPathAppearance(path,path.stroke,10)!,patch=projector.overlay({objects:new Map([[path.id,wide]])});
  assert.deepEqual(projector.query(rect),[]);const visible=projector.query(rect,patch);
  assert.equal(hitTest(visible,point,0),path.id);assert.deepEqual(marqueeHit(visible,rect),[path.id]);
  assert.equal(hitTest(visible,{x:38,y:514.01},0),undefined);
  assert(stylePath(e,e.doc.objects[path.id] as VectorPath,path.stroke,10));projector.update(e.doc);assert.deepEqual(projector.query(rect),visible);
  e.undo();projector.update(e.doc);assert.deepEqual(projector.query(rect),[]);
});
test("opaque black and unfilled paths project distinct interior hits without disturbing layer order or pressure points",()=>{
  const e=new EditorSession(doc,camera),proj=new SceneProjection(doc);e.select(loop.id);
  const clear=withPathAppearance(loop,"#000000",10)!,black=withPathAppearance(loop,"#000000",10,"#000000")!;
  const p={x:88,y:234},bytes=encodeProject(doc,new AssetVault(project.assets)),inkGroup=proj.all().find(g=>g.id==="sample-ink");
  for(const [value,expected] of [[clear,undefined],[black,loop.id]] as const){
    const scene=proj.all(proj.overlay({objects:new Map([[loop.id,value]])}));
    assert.deepEqual(scene.map(g=>g.id),doc.order);assert.equal(scene.find(g=>g.id==="sample-ink"),inkGroup);
    assert.equal(hitTest(scene,p,0),expected);assert.equal(e.history.past.length,0);assert.equal(encodeProject(e.doc,new AssetVault(project.assets)),bytes);
  }
  assert(stylePath(e,e.doc.objects[loop.id] as VectorPath,"#000000",10,"#000000"));assert.equal(e.history.past.length,1);assert.deepEqual(e.doc.order,doc.order);
  assert.deepEqual(buildScene(e.doc),proj.all(proj.overlay({objects:new Map([[loop.id,black]])})));
  e.undo();assert.equal(encodeProject(e.doc,new AssetVault(project.assets)),bytes);assert(!stylePath(e,black,"#ffffff",1));
});
test("rotated painted selection expands by one stroke width while the centerline pivot and transform targets stay fixed",()=>{
  for(const path of [loop,open]){
    const next=withPathAppearance(path,path.stroke,25,path.fill)!,frame=pathFrame(path);
    const box=pathStrokeBox(pathFrame(next),25),base=pathStrokeBox(frame,path.strokeWidth);
    assert.deepEqual(pathFrame(next),frame);assert.equal(box.rotation,frame.rotation);
    assert.equal(box.width,frame.width+25);assert.equal(box.height,frame.height+25);
    assert.equal(box.at.x+box.width/2,base.at.x+base.width/2);
    for(const zoom of [.05,1,16])assert.deepEqual(pathHandleBox(frame,{...camera,zoom}),pathHandleBox(pathFrame(next),{...camera,zoom}));
  }
});
