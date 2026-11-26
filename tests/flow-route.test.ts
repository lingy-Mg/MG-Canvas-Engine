import assert from "node:assert/strict";
import {test} from "node:test";
import {anchoredFlowPath,connectFlow,flowLabelAnchor,flowPath,styleConnector} from "../features/flow.ts";
import {demo} from "../app/demo.ts";
import {assertDocument,resolveEndpoint} from "../core/document.ts";
import type {BoardDocument,Connector} from "../core/document.ts";
import {portNormal} from "../core/geometry.ts";
import type {PortId} from "../core/geometry.ts";
import {buildScene,hitTest} from "../scene/board.ts";
import {EditorSession} from "../session/editor.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";

test("orthogonal link follows the sides of docked shapes and preserves explicit waypoints",()=>{
  const line=demo.objects["flow-arrow"];
  assert(line.kind==="connector");
  const from=resolveEndpoint(demo,line.from)!,to=resolveEndpoint(demo,line.to)!;
  const lookup=(id:string)=>demo.objects[id];
  for(const pins of [line.waypoints,[]]){
    const points=anchoredFlowPath(from,to,"orthogonal",pins,line.from,line.to,lookup);
    assert.deepEqual(points[0],from);assert.deepEqual(points.at(-1),to);
    assert.equal(points[1].y,from.y);assert(points[1].x>from.x);
    assert.equal(points.at(-2)!.y,to.y);assert(points.at(-2)!.x<to.x);
    for(const [i,p] of points.slice(1).entries())assert(p.x===points[i].x||p.y===points[i].y);
    for(const point of pins)assert(points.some(p=>p.x===point.x&&p.y===point.y));
  }
  const projected=buildScene(demo).find(g=>g.id===line.id)!;
  const path=projected.items.find(p=>p.kind==="path");assert(path);
  const label=projected.items.find(p=>p.kind==="text");assert(label);
  assert.deepEqual(label.at,flowLabelAnchor(path.points)?.point);
  assert.deepEqual(anchoredFlowPath(from,to,"straight",[],line.from,line.to,lookup),flowPath(from,to,"straight",[]));
});

test("connector label is aligned to a suitable segment rather than offset from an arbitrary bend",()=>{
  assert.deepEqual(flowLabelAnchor([{x:0,y:0},{x:80,y:0},{x:80,y:25}]),{point:{x:40,y:-9},align:"center"});
  assert.deepEqual(flowLabelAnchor([{x:90,y:2},{x:90,y:102}]),{point:{x:98,y:52},align:"left"});
  assert.equal(flowLabelAnchor([{x:0,y:0},{x:0,y:0}]),undefined);
});

test("almost aligned process and decision ports share one segment, centered label and exact arrow tips",()=>{
  const source=demo.objects["flow-source"],decision=demo.objects["flow-decision"],line=demo.objects["flow-arrow"];
  assert(source.kind==="shape"&&decision.kind==="shape"&&line.kind==="connector");
  for(const [fromSide,toSide,at] of [
    ["east","west",{x:-84,y:-65}],   // 114 units across and 2 down, as in the screenshot.
    ["south","north",{x:-334,y:136}], // 114 units down and 2 left.
  ] as const){
    const target={...decision,at,width:136,height:122};
    const start={kind:"anchor",objectId:source.id,portId:fromSide} as const;
    const finish={kind:"anchor",objectId:target.id,portId:toSide} as const;
    for(const [from,to] of [[start,finish],[finish,start]]){
      const edge={...line,from,to,waypoints:[],arrow:"both" as const};
      const doc={...demo,objects:{...demo.objects,[target.id]:target,[line.id]:edge}};
      const ends=[resolveEndpoint(doc,from)!,resolveEndpoint(doc,to)!];
      const items=buildScene(doc,undefined,[line.id])[0].items;
      const path=items.find(item=>item.kind==="path"),label=items.find(item=>item.kind==="text");
      assert(path&&label);assert.deepEqual(path.points,ends);
      assert.deepEqual(path.arrows?.heads.map(head=>head[0]),ends);
      const [a,b]=ends,mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      assert.deepEqual(label.at,fromSide==="east"?{x:mid.x,y:mid.y-9}:{x:mid.x+8,y:mid.y});
    }
  }
});

test("manual jogs, port detours, free ends and significant or steep offsets keep their orthogonal segments",()=>{
  const line=demo.objects["flow-arrow"];assert(line.kind==="connector"&&line.to.kind==="anchor");
  const lookup=(id:string)=>demo.objects[id],from={x:0,y:0},toEnd=line.to;
  const port=(portId:PortId)=>({...toEnd,portId});
  const pins=[{x:72,y:0},{x:72,y:2}];
  for(const {to,end,manual} of [
    {to:{x:114,y:2},end:toEnd,manual:pins},
    {to:{x:114,y:2},end:undefined},
    {to:{x:114,y:2},end:port("east")},
    {to:{x:114,y:2},end:port("north")},
    {to:{x:-114,y:2},end:toEnd},
    {to:{x:1,y:0},end:toEnd},
    {to:{x:320,y:7},end:toEnd},
    {to:{x:24,y:3},end:toEnd},
  ]){
    const path=anchoredFlowPath(from,to,"orthogonal",manual??[],line.from,end,lookup);
    assert(path.length>2);
    for(let i=1;i<path.length;i++)assert(path[i].x===path[i-1].x||path[i].y===path[i-1].y);
    for(const pin of manual??[])assert(path.some(q=>q.x===pin.x&&q.y===pin.y));
  }
});

function painted(doc:BoardDocument,id:string){
  const group=buildScene(doc,undefined,[id])[0],path=group.items.find(item=>item.kind==="path");assert(path);
  return {group,path};
}
test("new curves follow rotated port tangents, with matching painted arrows and hits after movement",()=>{
  const a=demo.objects["flow-source"],b=demo.objects["flow-decision"],old=demo.objects["flow-arrow"];
  assert(a.kind==="shape"&&b.kind==="shape"&&old.kind==="connector");
  const source={...a,rotation:.34},target={...b,at:{x:68,y:116},rotation:-.36};
  const e=new EditorSession({...demo,order:[a.id,b.id],objects:{[a.id]:source,[b.id]:target}});
  const edge=connectFlow(e,old.from,old.to)!;
  assert.equal(edge.routing,"curve");assert.equal(edge.portCurve,true);
  const verify=()=>{
    const {path,group}=painted(e.doc,edge.id),pts=path.points;
    const from=resolveEndpoint(e.doc,edge.from)!,to=resolveEndpoint(e.doc,edge.to)!;
    assert.deepEqual(pts[0],from);assert.deepEqual(pts.at(-1),to);assert.deepEqual(path.arrows?.heads[0][0],to);
    for(const [p,q,n] of [[from,pts[1],portNormal(source,"east")],[to,pts.at(-2)!,portNormal(target,"west")]]){
      const dx=q.x-p.x,dy=q.y-p.y;
      assert((dx*n.x+dy*n.y)/Math.hypot(dx,dy)>.98);
    }
    const sample=pts[Math.floor(pts.length/4)];
    assert.equal(hitTest([group],sample,.1),edge.id);
    const orthogonal=anchoredFlowPath(from,to,"orthogonal",[],edge.from,edge.to,id=>e.doc.objects[id]);
    assert(orthogonal.some(p=>!hitTest([group],p,2)),"the preexisting elbow cannot hit the curve");
  };
  verify();e.select(b.id);assert(e.moveSelection({x:27,y:-38}));verify();e.undo();verify();
});

test("switching a manually routed line keeps its pins, bindings, arrows and label through undo and reopening",()=>{
  const e=new EditorSession(demo),id="flow-arrow",before=e.doc,original=before.objects[id] as Connector;
  const originalPath=painted(before,id).path.points;
  assert(styleConnector(e,id,{...original,routing:"curve"}));
  const curved=e.doc,edge=curved.objects[id] as Connector,points=painted(curved,id).path.points;
  assert.deepEqual(edge,{...original,routing:"curve",portCurve:true});
  for(const pin of original.waypoints)assert(points.some(p=>p.x===pin.x&&p.y===pin.y));
  const vault=new AssetVault(),file=JSON.parse(encodeProject(curved,vault));
  assert.deepEqual(file.portCurves,[id]);assert(!("portCurve" in file.document.objects[id]));
  const reopened=new EditorSession(decodeProject(JSON.stringify(file)).document);
  assert.deepEqual(painted(reopened.doc,id).path.points,points);
  assert(styleConnector(reopened,id,{...edge,routing:"orthogonal"}));
  assert.deepEqual(reopened.doc.objects[id],original);assert.deepEqual(painted(reopened.doc,id).path.points,originalPath);
  assert.equal(reopened.history.past.length,1);reopened.undo();assert.deepEqual(reopened.doc.objects[id],edge);
  e.undo();assert.strictEqual(e.doc,before);e.redo();assert.strictEqual(e.doc,curved);
  for(const ids of [[id,id],["flow-source"],["absent"]])assert.throws(()=>decodeProject(JSON.stringify({...file,portCurves:ids})));
  file.document.objects[id].routing="orthogonal";assert.throws(()=>decodeProject(JSON.stringify(file)));
  assert.throws(()=>assertDocument({...before,objects:{...before.objects,[id]:{...original,portCurve:true}}}));
});

test("opening old automatic and pinned curves preserves their original spline and exported bytes",()=>{
  const old=demo.objects["flow-arrow"];assert(old.kind==="connector");
  const vault=new AssetVault();
  for(const waypoints of [old.waypoints,[]]){
    const edge={...old,routing:"curve" as const,waypoints};
    const doc={...demo,objects:{...demo.objects,[edge.id]:edge}},file=encodeProject(doc,vault);
    const reopened=decodeProject(file).document,path=painted(reopened,edge.id).path;
    assert.deepEqual(path.points,flowPath(resolveEndpoint(doc,edge.from)!,resolveEndpoint(doc,edge.to)!,"curve",waypoints));
    assert.deepEqual(reopened.objects[edge.id],edge);assert.equal(encodeProject(reopened,vault),file);
  }
});

test("a curved return link leaves its host and comes back onto the chosen side from outside",()=>{
  const shape=demo.objects["flow-source"];assert(shape.kind==="shape");
  const editor=new EditorSession(demo),anchor=(portId:PortId)=>({kind:"anchor",objectId:shape.id,portId} as const);
  for(const side of ["west","north","south"] as const){
    const line=connectFlow(editor,anchor("east"),anchor(side))!,{path}=painted(editor.doc,line.id);
    assert.deepEqual(path.points[0],resolveEndpoint(editor.doc,line.from));
    assert.deepEqual(path.arrows?.heads[0][0],resolveEndpoint(editor.doc,line.to));
    for(const p of path.points)assert(p.x<=shape.at.x||p.x>=shape.at.x+shape.width||p.y<=shape.at.y||p.y>=shape.at.y+shape.height);
  }
});
