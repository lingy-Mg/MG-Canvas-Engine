import { test } from "node:test";
import assert from "node:assert/strict";
import { demo } from "../app/demo.ts";
import { EditorSession } from "../session/editor.ts";
import { addDownstream, downstreamCenter,planDownstream } from "../features/flow-keyboard.ts";
import { boxBounds,portWorld } from "../core/geometry.ts";
import { SceneProjection } from "../scene/projector.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import type {BoardDocument,Connector} from "../core/document.ts";

test("diamond Tab creates opposite labelled branches, fills either missing answer and preserves incoming and custom edges",()=>{
  const source=demo.objects["flow-decision"];assert(source.kind==="shape");
  const fixture=demo.objects["flow-arrow"] as Connector;
  const custom:Connector={...fixture,id:"manual",label:"稍后重试",from:{kind:"anchor",objectId:source.id,portId:"south"},to:{kind:"free",point:{x:80,y:190}}};
  const doc:BoardDocument={...demo,order:[...demo.order,custom.id],objects:{...demo.objects,[custom.id]:custom}};
  const editor=new EditorSession(doc),before=editor.doc,vault=new AssetVault();
  const create=()=>addDownstream(editor,source,()=>false);
  const yes=create()!;assert.equal(yes.routing,"curve");assert.equal(yes.portCurve,true);assert.equal(yes.label,"Yes");assert.deepEqual(yes.from,{kind:"anchor",objectId:source.id,portId:"east"});
  const yn=editor.doc.objects[editor.selection!];assert(yn.kind==="shape"&&yn.at.x>source.at.x+source.width);
  const one=editor.doc,no=create()!;assert.equal(no.routing,"curve");assert.equal(no.portCurve,true);assert.equal(no.label,"No");assert.deepEqual(no.from,{kind:"anchor",objectId:source.id,portId:"west"});
  const nn=editor.doc.objects[editor.selection!];assert(nn.kind==="shape"&&nn.at.x+nn.width<source.at.x);
  assert.deepEqual(editor.doc.objects[custom.id],custom);assert.deepEqual(editor.doc.objects[fixture.id],fixture);
  assert.equal(create(),undefined);const both=editor.doc;
  assert.deepEqual(decodeProject(encodeProject(both,vault)).document,JSON.parse(JSON.stringify(both)));
  editor.undo();assert.strictEqual(editor.doc,one);editor.undo();assert.strictEqual(editor.doc,before);
  editor.redo();editor.redo();assert.strictEqual(editor.doc,both);
  const reverse:Connector={...custom,id:"reject",from:{kind:"anchor",objectId:source.id,portId:"north"},label:" no "};
  const seeded=new EditorSession({...doc,objects:{...doc.objects,reject:reverse},order:[...doc.order,"reject"]});
  const added=addDownstream(seeded,source,()=>false)!;assert.equal(added.label,"Yes");assert.deepEqual(added.from,{kind:"anchor",objectId:source.id,portId:"south"});
  const target=seeded.doc.objects[seeded.selection!];assert(target.kind==="shape"&&target.at.y>source.at.y+source.height);
});

test("Tab downstream fills nearby empty space, selects the new node, and fully undoes in one step",()=>{
  const before=new EditorSession(demo).doc;
  const editor=new EditorSession(before);
  const source=editor.doc.objects["flow-source"];assert(source.kind==="shape");
  editor.select(source.id);
  const scene=new SceneProjection(editor.doc);
  const occupied=(area:ReturnType<typeof boxBounds>)=>scene.query(area).some(g=>editor.doc.objects[g.id].kind!=="connector");
  const line=addDownstream(editor,source,occupied);assert(line);
  assert.equal(editor.history.past.length,1);
  const node=editor.doc.objects[editor.selection!];assert(node.kind==="shape");
  assert.notEqual(node.id,source.id);
  assert.equal(occupied(boxBounds(node)),false);
  assert.deepEqual(line.from,{kind:"anchor",objectId:source.id,portId:"east"});
  assert.equal(line.to.kind==="anchor"&&line.to.objectId,node.id);
  editor.undo();
  assert.equal(editor.doc.objects[node.id],undefined);
  assert.equal(editor.doc.objects[line.id],undefined);
  editor.redo();
  assert(editor.doc.objects[node.id]&&editor.doc.objects[line.id]);
});

test("downstream placement is rightward and aligned if unblocked, scans bounded alternatives",()=>{
  const source=demo.objects["flow-source"];assert(source.kind==="shape");
  const box=boxBounds(source),size={width:136,height:62};
  const first=downstreamCenter(source,size,()=>false)!;
  assert(first.x-size.width/2>box.max.x);
  assert.equal(first.y,(box.max.y+box.min.y)/2);
  let attempts=0;
  const next=downstreamCenter(source,size,()=>++attempts===1)!;
  assert.notDeepEqual(next,first);
  assert.equal(downstreamCenter(source,size,()=>true),undefined);
});

test("pointer-directed Tab uses local ports on straight and rotated nodes and places each child outwards",()=>{
  const seed=demo.objects["flow-source"];assert(seed.kind==="shape");
  for(const rotation of [0,.57,Math.PI/2]){
    const shape={...seed,rotation};
    const doc={...demo,objects:{[shape.id]:shape},order:[shape.id]};
    const center={x:shape.at.x+shape.width/2,y:shape.at.y+shape.height/2};
    for(const side of ["west","north","east","south"] as const){
      const aim=portWorld(shape,shape.shape,side);
      const plan=planDownstream(doc,shape,()=>false,"child","link",aim)!;
      assert.equal(plan.line.routing,"curve");assert.equal(plan.line.portCurve,true);
      assert.equal(plan.line.from.kind==="anchor"&&plan.line.from.portId,side);
      const delta={x:plan.node.at.x+plan.node.width/2-aim.x,y:plan.node.at.y+plan.node.height/2-aim.y};
      assert(delta.x*(aim.x-center.x)+delta.y*(aim.y-center.y)>0);
      assert(Math.abs(delta.x*(aim.y-center.y)-delta.y*(aim.x-center.x))<Math.max(shape.width,shape.height));
    }
    for(const aim of [undefined,center])assert.equal((planDownstream(doc,shape,()=>false,"child","link",aim)!.line.from as {portId:string}).portId,"east");
  }
});

test("first Yes follows the chosen exit and the missing No always takes its opposite",()=>{
  const shape=demo.objects["flow-decision"];assert(shape.kind==="shape");
  const editor=new EditorSession(demo),aim=portWorld(shape,"diamond","north");
  const yes=addDownstream(editor,shape,()=>false,aim)!,no=addDownstream(editor,shape,()=>false,aim)!;
  assert.deepEqual([yes.label,yes.from.kind==="anchor"&&yes.from.portId,no.label,no.from.kind==="anchor"&&no.from.portId],["Yes","north","No","south"]);
});
