import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {DEFAULT_SHAPE_STROKE,resolveEndpoint} from "../core/document.ts";
import type {BoardDocument,Connector,ShapeObject} from "../core/document.ts";
import {captureClipboard,encodeClipboard} from "../features/clipboard.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {buildScene,hitTest} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";
import {EditorSession} from "../session/editor.ts";
import {planShapeTransform} from "../session/shape-properties.ts";
import type {ShapeTransform} from "../session/shape-properties.ts";

const base=decodeProject(readFileSync(new URL("../docs/fixtures/M5Z-Shape-Properties.mgcanvas",import.meta.url),"utf8")).document;
const camera={offset:{x:0,y:0},zoom:1};
const shape=(doc:BoardDocument,id="review")=>{const s=doc.objects[id];assert(s.kind==="shape");return s;};
const values=(s:ShapeObject):ShapeTransform=>({x:s.at.x,y:s.at.y,width:164,height:80,shapeStyle:{
  rotation:Math.PI/6,...(s.shape==="rect"?{radius:8}:{}),fill:"#b4ddcf",stroke:"#146858",strokeWidth:5}});
const bytes=(doc:BoardDocument)=>encodeProject(doc,new AssetVault());
const clip=(doc:BoardDocument)=>encodeClipboard(captureClipboard(doc,doc.order,new AssetVault())!);

test("rectangle preview and commit share geometry, paint, port attachment and manual pins without changing any draft bytes",()=>{
  const e=new EditorSession(base,camera);e.select("review");
  const history=e.history,s=shape(e.doc),v=values(s),source=bytes(e.doc),wire=clip(e.doc),index=new SceneProjection(e.doc);
  const changed=planShapeTransform(e.doc,s,v)!;assert.deepEqual([...changed.keys()],[s.id]);
  const overlay=index.overlay({objects:changed}),scene=index.all(overlay);
  assert.deepEqual([...overlay.keys()].sort(),["arrival","review","route"]);
  for(let i=0;i<40;i++)assert(planShapeTransform(e.doc,s,{...v,width:120+i})?.size);
  assert.equal(e.history,history);assert.equal(bytes(e.doc),source);assert.equal(clip(e.doc),wire);
  assert(e.transformSelection(v));assert.equal(e.history.past.length,1);assert.deepEqual(scene,buildScene(e.doc));
  for(const id of ["arrival","route"]){
    const line=e.doc.objects[id];assert(line.kind==="connector");assert.deepEqual(line,base.objects[id]);
    const route=overlay.get(id)!.items.find(p=>p.kind==="path");assert(route?.kind==="path");
    assert.deepEqual(route.points[0],resolveEndpoint(e.doc,line.from));assert.deepEqual(route.points.at(-1),resolveEndpoint(e.doc,line.to));
    for(const pin of line.waypoints)assert(route.points.some(p=>p.x===pin.x&&p.y===pin.y));
  }
  const final=bytes(e.doc);assert.equal(bytes(decodeProject(final).document),final);
  assert.deepEqual(decodeProject(final).document.objects.review,changed.get(s.id));
  e.undo();assert.equal(bytes(e.doc),source);assert.equal(clip(e.doc),wire);e.redo();assert.equal(bytes(e.doc),final);
});

test("absent stroke width, original short / named paints and sub-degree angles survive unrelated shape properties",()=>{
  const original={...shape(base),fill:"#ABC",stroke:"navy",rotation:Math.PI/13};
  const e=new EditorSession({...base,objects:{...base.objects,review:original}},camera);e.select(original.id);
  const s=shape(e.doc),style={rotation:s.rotation,radius:s.cornerRadius,strokeWidth:DEFAULT_SHAPE_STROKE};
  const edit={x:s.at.x,y:s.at.y,shapeStyle:style};assert.equal(planShapeTransform(e.doc,s,edit)?.size,0);assert(!e.transformSelection(edit));
  assert(e.transformSelection({...edit,height:84}));assert.deepEqual(shape(e.doc),{...original,height:84});
  assert(!Object.hasOwn(shape(e.doc),"strokeWidth"));e.undo();assert.equal(e.history.past.length,0);
});

test("invalid dimensions, partial colors, non-finite input and a negative radius invalidate the entire candidate",()=>{
  const e=new EditorSession(base,camera);e.select("review");const s=shape(e.doc),v=values(s),style=v.shapeStyle!,before=e.history;
  for(const change of [{width:0},{height:-1},{height:NaN},{x:Infinity},{shapeStyle:{...style,rotation:NaN}},
    {shapeStyle:{...style,radius:-1}},{shapeStyle:{...style,strokeWidth:257}},{shapeStyle:{...style,strokeWidth:NaN}},
    {shapeStyle:{...style,stroke:"#ab"}},{shapeStyle:{...style,fill:"#123456ff"}},{x:Number.MAX_VALUE,width:Number.MAX_VALUE}]){
    assert.equal(planShapeTransform(e.doc,s,{...v,...change}),undefined);assert(!e.transformSelection({...v,...change}));assert.equal(e.history,before);
  }
});

test("zero rotation, rectangular radius and border are real edits; diamond and triangle never accept a radius",()=>{
  for(const id of ["review","decision","archive"]){
    const e=new EditorSession(base,camera);e.select(id);const s=shape(e.doc,id);assert(e.transformSelection(values(s)));
    const current=shape(e.doc,id),v={x:0,y:0,shapeStyle:{rotation:0,strokeWidth:0,...(s.shape==="rect"?{radius:0}:{})}};
    if(s.shape!=="rect")assert.equal(planShapeTransform(e.doc,current,{...v,shapeStyle:{...v.shapeStyle,radius:0}}),undefined);
    const patch=planShapeTransform(e.doc,current,v)!;assert(e.transformSelection(v));assert.deepEqual(shape(e.doc,id),patch.get(id));
    assert.equal(shape(e.doc,id).strokeWidth,0);assert.equal(shape(e.doc,id).rotation,0);assert.equal(shape(e.doc,id).cornerRadius,0);
    const box=buildScene(e.doc,undefined,[id])[0].items.find(p=>p.kind==="box");assert(box?.kind==="box"&&box.strokeWidth===0);
    e.undo();assert.deepEqual(shape(e.doc,id),current);
  }
});

test("a collapsed straight bound line rejects a valid-looking geometry and color together before preview",()=>{
  const line:Connector={kind:"connector",id:"guard",from:{kind:"anchor",objectId:"review",portId:"east"},
    to:{kind:"free",point:{x:208,y:92}},waypoints:[],routing:"straight",stroke:"#013456",label:"",arrow:"end"};
  const e=new EditorSession({...base,objects:{...base.objects,guard:line},order:[...base.order,line.id]},camera);e.select("review");
  const s=shape(e.doc),v={x:s.at.x,y:s.at.y,width:168,shapeStyle:{rotation:0,fill:"#654321",strokeWidth:7}};
  assert.equal(planShapeTransform(e.doc,s,v),undefined);assert(!e.transformSelection(v));assert.equal(e.history.past.length,0);
  assert(!e.transformSelection({...v,width:167.5}));
  assert(e.transformSelection({...v,width:167.49}));assert.equal(shape(e.doc).width,167);assert.equal(shape(e.doc).fill,"#654321");
});

test("a self-loop retains world pins for resize or rotation and translates both pins only for an explicit position edit",()=>{
  const line:Connector={kind:"connector",id:"loop",from:{kind:"anchor",objectId:"review",portId:"east"},
    to:{kind:"anchor",objectId:"review",portId:"east"},routing:"orthogonal",waypoints:[{x:170,y:92}],label:"",arrow:"end",stroke:"#085567"};
  const e=new EditorSession({...base,objects:{...base.objects,loop:line},order:[...base.order,"loop"]},camera);e.select("review");
  const s=shape(e.doc),v=values(s);assert.deepEqual([...planShapeTransform(e.doc,s,v)!.keys()],[s.id]);
  const move={x:50,y:60};const shown=planShapeTransform(e.doc,s,move)!;assert(e.transformSelection(move));
  assert.deepEqual(e.doc.objects.loop,{...line,waypoints:[{x:180,y:92}]});assert.deepEqual(e.doc.objects.loop,shown.get("loop"));
  assert.deepEqual(e.doc.objects.route,base.objects.route);e.undo();assert.deepEqual(e.doc.objects.loop,line);
});

test("newly visible shape geometry enters the next scene cell on preview, commit and redo, and leaves it on cancel and undo",()=>{
  const e=new EditorSession(base,camera);e.select("review");const idx=new SceneProjection(e.doc),s=shape(e.doc),area={min:{x:555,y:82},max:{x:558,y:86}};
  const v={x:40,y:60,width:600},shown=planShapeTransform(e.doc,s,v)!,patch=idx.overlay({objects:shown});
  assert.equal(hitTest(idx.query(area,patch),area.min,0),"review");assert.equal(hitTest(idx.query(area),area.min,0),undefined);
  e.listen(change=>idx.update(e.doc,change));assert(e.transformSelection(v));assert.equal(hitTest(idx.query(area),area.min,0),"review");
  e.undo();assert.equal(hitTest(idx.query(area),area.min,0),undefined);e.redo();assert.equal(hitTest(idx.query(area),area.min,0),"review");
});

test("the original member reference expires across reopen, and a group requires member-level selection for a single edit",()=>{
  const grouped:BoardDocument={...base,schemaVersion:5,flowGroups:{baseVersion:1,members:{flow:["review","decision"]}}};
  const e=new EditorSession(grouped,camera);e.select("review");const s=shape(e.doc);assert(!e.transformSelection(values(s)));
  assert(e.enterGroup("review"));assert(e.transformSelection(values(s)));assert.deepEqual(e.doc.flowGroups,grouped.flowGroups);
  const other=shape(e.doc,"decision");assert.deepEqual(other,shape(base,"decision"));e.open(grouped,true);
  assert.equal(planShapeTransform(e.doc,s,values(s)),undefined);assert.equal(e.history.past.length,0);
});
