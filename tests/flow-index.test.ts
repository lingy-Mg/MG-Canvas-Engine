import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEndpoint } from "../core/document.ts";
import type { BoardDocument, Endpoint, ShapeObject } from "../core/document.ts";
import { screenToWorld,worldToScreen } from "../core/geometry.ts";
import type { Camera,Point,Rect } from "../core/geometry.ts";
import { FlowInput } from "../features/flow-input.ts";
import { pickPort } from "../features/flow.ts";
import { SceneProjection } from "../scene/projector.ts";
import { EditorSession } from "../session/editor.ts";
const p=(x:number,y:number)=>({x,y});
const a=(id:string,portId:"north"|"east"|"south"|"west"):Endpoint=>({kind:"anchor",objectId:id,portId});
const shape=(id:string,x:number,y:number,rotation=0):ShapeObject=>({id,kind:"shape",at:p(x,y),width:30,height:24,rotation,shape:"rect",cornerRadius:4,fill:"#fff",stroke:"#345",label:id});
function fixture(n=0,camera:Camera={offset:p(0,0),zoom:1}){
  const nodes=[shape("first",20,30),shape("lower",90,30),shape("upper",90,30),shape("edge",-41,90),shape("rotated",170,30,Math.PI/4)];
  for(let i=0;i<n;i++)nodes.push(shape("off-"+i,4_000+i*500,10_000));
  const doc:BoardDocument={schemaVersion:1,id:"flow-index",theme:"paper",order:nodes.map(n=>n.id),objects:Object.fromEntries(nodes.map(n=>[n.id,n])),assets:{}};
  const editor=new EditorSession(doc,camera);
  let indexedDoc=editor.doc,scene=new SceneProjection(indexedDoc);
  const counts:number[]=[];
  const candidates=(r:Rect)=>{
    if(indexedDoc!==editor.doc){scene.update(editor.doc);indexedDoc=editor.doc;}
    const ordered=scene.query(r).flatMap(({id})=>editor.doc.objects[id]?.kind==="shape"?[id]:[]);
    counts.push(ordered.length);
    return ordered;
  };
  const flow=new FlowInput(editor,()=>undefined,candidates);
  const screen=(end:Endpoint)=>worldToScreen(resolveEndpoint(editor.doc,end)!,editor.camera);
  return {doc,editor,flow,screen,candidates,counts};
}

test("indexed port hit matches full document at extreme zoom and preserves top z on equal distance",()=>{
  for(const zoom of [0.15,1,4]){
    const {doc,screen,editor,candidates}=fixture(20,{offset:p(117,-203),zoom});
    for(const id of ["first","lower","upper","edge","rotated"])for(const port of ["north","east","south","west"] as const){
      const pos=screen(a(id,port));
      for(const radius of [9,17])for(const dx of [0,radius-.001,radius+.001]){
        const world=screenToWorld(p(pos.x+dx,pos.y),editor.camera), r=radius/zoom;
        const local=candidates({min:p(world.x-r,world.y-r),max:p(world.x+r,world.y+r)});
        assert.deepEqual(pickPort(doc,world,r,undefined,local),pickPort(doc,world,r));
      }
    }
    const w=resolveEndpoint(doc,a("lower","east"))!;
    assert.equal(pickPort(doc,w,0,undefined,candidates({min:w,max:w}))?.end.objectId,"upper");
  }
});

test("touch two taps keep edge target and source/draft, rebind and undo with the same index",()=>{
  const {flow,screen,editor}=fixture(70);
  const from=a("first","east"),to=a("edge","east"), replacement=a("upper","west");
  const start=screen(from), edge=screen(to);
  const inside=p(2,edge.y); // Port center x=-11, within touch 17, outside mouse 9.
  const firstRevision=editor.history.revision;
  flow.setMode("connect");
  assert(flow.down(1,"touch",start));assert(flow.up(1,start));
  assert.equal(editor.history.revision,firstRevision);
  assert(flow.decor({width:240,height:150}).markers.some(m=>m.kind==="origin"));
  assert(flow.down(2,"touch",inside));
  const live=flow.decor({width:240,height:150});
  assert(live.markers.some(m=>m.active&&m.point.x===edge.x&&m.point.y===edge.y));
  assert.deepEqual(live.draft?.at(-1),edge);
  assert(flow.up(2,inside));
  const id=editor.selection!;
  const line=editor.doc.objects[id];
  assert(line.kind==="connector");assert.deepEqual(line.from,from);assert.deepEqual(line.to,to);
  assert(flow.beginRebind(id,"to"));
  const target=screen(replacement);
  assert(flow.down(3,"touch",target));assert(flow.up(3,target));
  const rebound=editor.doc.objects[id];
  assert(rebound.kind==="connector");assert.deepEqual(rebound.to,replacement);
  editor.undo(); const restored=editor.doc.objects[id];
  assert(restored.kind==="connector");assert.deepEqual(restored.to,to);
});

test("viewport port work does not increase when adding 10,000 distributed offscreen shapes",()=>{
  function sample(n:number){
    const {doc,editor,flow,counts,screen}=fixture(n);
    const pointer=screen(a("first","east"));
    const previous=new FlowInput(editor,()=>undefined);
    previous.setMode("connect");previous.move(1,pointer);
    const oldMarkers=previous.decor().markers.length;
    let pseudoOldScans=0;
    const counted={...doc,objects:new Proxy(doc.objects,{get(obj,key){++pseudoOldScans;return Reflect.get(obj,key);}})};
    pickPort(counted,pointer,9);
    flow.setMode("connect");flow.move(1,pointer);
    const optimized=flow.decor({width:240,height:150});
    assert(!optimized.markers.some(m=>m.point.x< -17||m.point.x>257));
    return {oldMarkers,pseudoOldScans,markers:optimized.markers.length,counts};
  }
  const small=sample(0),big=sample(10_000);
  assert.equal(small.oldMarkers,20);
  assert.equal(big.oldMarkers,40_020);
  assert.equal(small.pseudoOldScans,5);
  assert.equal(big.pseudoOldScans,10_005);
  assert.deepEqual(big.counts,small.counts);
  assert.deepEqual(big.counts,[1,5,5]); // Source handle, directional suggestion, visible markers.
  assert.equal(small.markers,17);
  assert.equal(big.markers,17);
});

test("panning a pending touch source out of view preserves the draft anchor without an offscreen marker",()=>{
  const {flow,screen,editor}=fixture();
  const from=a("first","east"),to=a("upper","west");
  const source=screen(from);
  flow.setMode("connect");
  assert(flow.down(1,"touch",source));assert(flow.up(1,source));
  editor.setCamera({offset:p(-68,0),zoom:1});
  const target=screen(to);
  assert(flow.down(2,"touch",target));
  const live=flow.decor({width:240,height:150});
  assert(!live.markers.some(m=>m.kind==="origin"));
  assert.deepEqual(live.draft?.[0],resolveEndpoint(editor.doc,from));
  assert.deepEqual(live.draft?.at(-1),resolveEndpoint(editor.doc,to));
  const revision=editor.history.revision;
  flow.cancel();
  assert(!flow.up(2,target));
  assert.equal(editor.history.revision,revision);
});
