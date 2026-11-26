import { test } from "node:test";
import assert from "node:assert/strict";
import { demo } from "../app/demo.ts";
import { EditorSession } from "../session/editor.ts";
import { AssetVault } from "../features/image-assets.ts";
import { DEFAULT_SHAPE_STROKE,resolveEndpoint,validateDocument } from "../core/document.ts";
import { buildScene,hitTest } from "../scene/board.ts";
import { encodeProject,decodeProject } from "../platform/project.ts";

test("existing document without persisted stroke retains defaults and old exact bytes",()=>{
  const legacy=encodeProject(demo,new AssetVault());
  const restored=decodeProject(legacy).document;
  const item=restored.objects["flow-source"];assert(item.kind==="shape");
  assert.equal(item.strokeWidth,undefined);
  assert.equal(encodeProject(restored,new AssetVault()),legacy);
  const e=new EditorSession(restored);e.select(item.id);
  assert(!e.transformSelection({x:item.at.x,y:item.at.y,width:item.width,height:item.height,
    shapeStyle:{rotation:item.rotation,radius:item.cornerRadius,strokeWidth:DEFAULT_SHAPE_STROKE}}));
  assert.equal(e.history.past.length,0);
});

test("combined transform and shape appearance is one undo, persists, and bound line follows",()=>{
  const e=new EditorSession(demo), old=e.doc.objects["flow-source"];assert(old.kind==="shape");
  e.select(old.id);
  assert(e.transformSelection({x:old.at.x-31,y:old.at.y+18,width:170,height:72,
    shapeStyle:{rotation:Math.PI/6,radius:27,fill:"#bbe0fe",stroke:"#173390",strokeWidth:12}}));
  const now=e.doc.objects[old.id];assert(now.kind==="shape");
  assert.deepEqual([now.width,now.height,now.rotation,now.cornerRadius,now.fill,now.stroke,now.strokeWidth],
    [170,72,Math.PI/6,27,"#bbe0fe","#173390",12]);
  const next=decodeProject(encodeProject(e.doc,new AssetVault())).document.objects[old.id];
  assert.deepEqual(next,now);
  const scene=buildScene(e.doc), group=scene.find(g=>g.id===old.id)!;
  const element=group.items.find(i=>i.kind==="box");assert(element?.kind==="box");assert.equal(element.strokeWidth,12);
  assert.equal(hitTest([group],{x:now.at.x+85,y:now.at.y+36},0),old.id);
  const bound=Object.values(e.doc.objects).find(i=>i.kind==="connector"&&i.from.kind==="anchor"&&i.from.objectId===old.id);
  assert(bound?.kind==="connector");
  const line=scene.find(g=>g.id===bound.id)?.items.find(i=>i.kind==="path");assert(line?.kind==="path");
  assert.deepEqual(line.points[0],resolveEndpoint(e.doc,bound.from));
  assert.equal(e.history.past.length,1);
  e.undo();assert.deepEqual(e.doc.objects[old.id],old);
  e.redo();assert.deepEqual(e.doc.objects[old.id],now);
});

test("zero width hides stroke; bad values and unsupported radius reject atomically",()=>{
  const e=new EditorSession(demo), rect=e.doc.objects["flow-source"], diamond=e.doc.objects["flow-decision"];
  assert(rect.kind==="shape"&&diamond.kind==="shape");
  e.select(rect.id);
  const initial=e.doc;
  assert(!e.transformSelection({x:1,y:1,shapeStyle:{rotation:0,strokeWidth:-1}}));
  assert(!e.transformSelection({x:1,y:1,shapeStyle:{rotation:Infinity,strokeWidth:12}}));
  assert(!e.transformSelection({x:1,y:1,shapeStyle:{rotation:0,strokeWidth:999}}));
  assert(!e.transformSelection({x:1,y:1,shapeStyle:{rotation:0,strokeWidth:12,fill:"not color"}}));
  assert.equal(initial,e.doc);
  assert(e.transformSelection({x:1,y:1,shapeStyle:{rotation:0,strokeWidth:0}}));
  const item=e.doc.objects[rect.id];assert(item.kind==="shape");assert.equal(item.strokeWidth,0);
  const malformed={...e.doc,objects:{...e.doc.objects,[rect.id]:{...item,strokeWidth:257}}};
  assert(validateDocument(malformed).length>0);
  e.select(diamond.id);
  assert(!e.transformSelection({x:1,y:1,shapeStyle:{rotation:0,strokeWidth:4,radius:8}}));
});
