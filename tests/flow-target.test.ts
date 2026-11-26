import {test} from "node:test";
import assert from "node:assert/strict";
import {resolveEndpoint} from "../core/document.ts";
import type {BoardDocument,BoardObject,Endpoint,ShapeObject} from "../core/document.ts";
import {gridPoint,localToWorld,screenToWorld,worldToScreen} from "../core/geometry.ts";
import type {Point,PortId} from "../core/geometry.ts";
import {newCard} from "../features/card-content.ts";
import {FlowInput} from "../features/flow-input.ts";
import {directionalTarget,endpointTarget} from "../features/flow-target.ts";
import {connectFlow,free,shapePorts,shapePreset} from "../features/flow.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {buildScene,hitTest} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";
import {EditorSession} from "../session/editor.ts";

const p=(x:number,y:number)=>({x,y});
const anchor=(objectId:string,portId:PortId)=>({kind:"anchor",objectId,portId} as const);
function box(id:string,x:number,y:number,width=100,height=64):ShapeObject{
  return {...shapePreset("process",p(0,0),id),at:p(x,y),width,height,cornerRadius:0};
}
function setup(items:readonly BoardObject[],zoom=1){
  const doc:BoardDocument={schemaVersion:1,id:"nearby",theme:"paper",order:items.map(n=>n.id),
    objects:Object.fromEntries(items.map(n=>[n.id,n])),assets:{}};
  const editor=new EditorSession(doc,{offset:p(11,27),zoom}),scene=new SceneProjection(editor.doc);
  const flow=new FlowInput(editor,screen=>hitTest(buildScene(editor.doc),screenToWorld(screen,editor.camera),3/zoom),
    rect=>{scene.update(editor.doc);return scene.query(rect).map(g=>g.id);});
  const pos=(point:Point)=>worldToScreen(point,editor.camera);
  const point=(end:Endpoint)=>resolveEndpoint(editor.doc,end)!;
  const line=(id=editor.selection!)=>{const obj=editor.doc.objects[id];assert(obj?.kind==="connector");return obj;};
  return {editor,flow,pos,point,line};
}
function active(flow:FlowInput){return flow.decor().markers.filter(mark=>mark.kind==="input"&&mark.active).map(mark=>mark.point);}
function checkShallowCurve(path:readonly Point[]|undefined,from:Point,to:Point){
  assert(path);assert.deepEqual(path[0],from);assert.deepEqual(path.at(-1),to);
  for(let i=1;i<path.length;i++)assert(path[i].x>path[i-1].x&&Math.abs(path[i].y-path[i-1].y)<(path[i].x-path[i-1].x)/12);
}

test("the south handle previews the nearby sticky, skips the left sibling, and commits the exact rendered route",()=>{
  const source=box("a",459,68,266,168),left=box("left",82,68,268,168);
  const sticky={...newCard("sticky",p(349,431),"待确认"),width:180,height:180};
  const farther=box("farther",526,506,132,90);
  const {editor,flow,pos,point,line}=setup([left,source,sticky,farther]);
  const origin=anchor(source.id,"south"),end=anchor(sticky.id,"north"),start=pos(point(origin)),baseline=editor.doc;
  editor.select(source.id);flow.move(1,start);
  const preview=flow.decor();assert.deepEqual(active(flow),[point(end)]);
  assert.equal(preview.arrow,"end");assert.deepEqual(preview.draft?.[0],point(origin));
  assert.deepEqual(preview.draft?.at(-1),point(end));assert.equal(editor.history.past.length,0);
  assert(flow.down(1,"mouse",start));assert.deepEqual(flow.decor().draft,preview.draft);
  assert(flow.up(1,start));const edge=line();assert.deepEqual(edge.from,origin);assert.deepEqual(edge.to,end);
  const painted=buildScene(editor.doc).find(g=>g.id===edge.id)!.items.find(item=>item.kind==="path");
  assert.deepEqual(painted?.points,preview.draft);
  assert.equal(editor.history.past.length,1);editor.undo();assert.strictEqual(editor.doc,baseline);editor.redo();
  editor.select(sticky.id);assert(editor.moveSelection(p(34,-18)));assert.deepEqual(point(edge.to),p(473,413));
  assert.equal(line(edge.id),edge);
  const saved=decodeProject(encodeProject(editor.doc,new AssetVault())).document;
  assert.equal((saved.objects[sticky.id] as ShapeObject).content?.kind,"sticky");
  assert.deepEqual(resolveEndpoint(saved,edge.to),p(473,413));
  flow.move(1,pos(point(end)));assert(flow.down(1,"mouse",pos(point(end))),"the sticky is also a source");
  flow.cancel();assert.equal(editor.history.past.length,2);
});

test("dragging between two close outlines changes the receiving side, and release uses the final sample",()=>{
  const {editor,flow,pos,point,line}=setup([box("source",0,200),box("first",188,50,100,84),box("second",312,50,100,84)]);
  const start=pos(point(anchor("source","east"))),a=anchor("first","east"),b=anchor("second","west");
  editor.select("source");assert(flow.down(1,"mouse",start));
  flow.move(1,pos(p(298,68)));assert.deepEqual(active(flow),[point(a)]);
  flow.move(1,pos(p(303,68)));assert.deepEqual(active(flow),[point(b)]);
  flow.move(1,pos(p(298,68)));assert(flow.up(1,pos(p(303,68))));assert.deepEqual(line().to,b);
  const id=line().id;assert.equal(line().autoPorts,"to");
  assert(flow.down(2,"mouse",pos(point(b))));flow.move(2,pos(p(298,68)));
  assert.deepEqual(flow.decor().draft?.at(-1),point(a));assert(flow.up(2,pos(p(298,68))));
  assert.deepEqual(line(id).to,a);assert.equal(line(id).autoPorts,undefined);
  assert(flow.down(3,"mouse",pos(point(a))));const outside=p(480,39);
  flow.move(3,pos(outside));assert.deepEqual(active(flow),[]);assert.deepEqual(flow.decor().draft?.at(-1),outside);
  assert(flow.up(3,pos(outside)));assert.deepEqual(line(id).to,free(outside));
  editor.undo();assert.deepEqual(line(id).to,a);editor.undo();assert.deepEqual(line(id).to,b);
});

test("a tiny port offset has the same route during creation, node drag, undo and reopen at every zoom",()=>{
  for(const zoom of [.05,1,4.3,16]){
    const source=box("source",-330,-34,132,56);
    const decision={...box("decision",-84,-65,136,122),shape:"diamond" as const};
    const {editor,flow,pos,point,line}=setup([source,decision],zoom);
    const from=anchor(source.id,"east"),to=anchor(decision.id,"west"),ends=[point(from),point(to)];
    const original=editor.doc;
    editor.select(source.id);assert(flow.down(1,"mouse",pos(ends[0])));flow.move(1,pos(ends[1]));
    const wirePreview=flow.decor().draft;checkShallowCurve(wirePreview,ends[0],ends[1]);assert(flow.up(1,pos(ends[1])));
    const edge=line(),connected=editor.doc;
    const path=(doc:BoardDocument)=>buildScene(doc,undefined,[edge.id])[0].items.find(q=>q.kind==="path")?.points;
    assert.deepEqual(edge.from,from);assert.deepEqual(edge.to,to);assert.deepEqual(path(connected),wirePreview);
    const projection=new SceneProjection(connected),grab=p(-16,-4),release=p(64,-8);
    editor.down(2,"mouse",pos(grab),decision.id,false);editor.move(2,pos(release));
    const draft=projection.overlay(editor.preview).get(edge.id)?.items.find(q=>q.kind==="path");
    assert(draft);checkShallowCurve(draft.points,ends[0],p(-4,-8));assert.strictEqual(editor.doc,connected);
    editor.up(2,pos(release));const moved=editor.doc;
    assert.deepEqual(path(moved),draft.points);assert.strictEqual(moved.objects[edge.id],edge);
    assert.equal(editor.history.past.length,2);editor.undo();assert.strictEqual(editor.doc,connected);
    editor.undo();assert.strictEqual(editor.doc,original);editor.redo();editor.redo();assert.strictEqual(editor.doc,moved);
    const reopened=decodeProject(encodeProject(moved,new AssetVault())).document;
    assert.deepEqual(reopened.objects[edge.id],edge);assert.deepEqual(path(reopened),draft.points);
  }
});

test("a two-tap new node uses the same nearly horizontal port segment in the ghost and the saved connection",()=>{
  const {editor,flow,pos,point,line}=setup([box("a",0,0)],2.7),before=editor.doc;
  const from=anchor("a","east"),start=pos(point(from)),center=pos(p(312,34));
  flow.setMode("connect");assert(flow.down(1,"mouse",start));assert(flow.up(1,start));
  flow.move(1,center);const draft=flow.decor().draft;
  checkShallowCurve(draft,point(from),p(244,34));
  assert(flow.down(2,"mouse",center));assert(flow.up(2,center));
  const edge=line(editor.doc.order.at(-1));assert.deepEqual(point(edge.to),p(244,34));
  assert.deepEqual(buildScene(editor.doc,undefined,[edge.id])[0].items.find(q=>q.kind==="path")?.points,draft);
  assert.equal(editor.history.past.length,1);editor.undo();assert.equal(editor.doc,before);
});

test("the snap radius is measured in screen pixels for mouse and touch throughout the zoom range",()=>{
  for(const zoom of [.05,1,16])for(const type of ["mouse","touch"] as const){
    const {editor,flow,pos,point,line}=setup([box("a",0,0,64/zoom,64/zoom),box("b",192/zoom,0,96/zoom,96/zoom)],zoom);
    editor.select("a");const start=pos(point(anchor("a","east"))),end=anchor("b","west");
    const edge=pos(p(192/zoom,24/zoom)),radius=type==="touch"?30:20;
    const near=p(edge.x-radius+.25,edge.y),outside=p(edge.x-radius-.25,edge.y);
    flow.move(1,start);assert.deepEqual(flow.decor().draft?.at(-1),point(end));
    assert(flow.down(1,type,start));flow.move(1,outside,type==="touch");assert.deepEqual(active(flow),[]);
    assert.deepEqual(flow.decor().draft?.at(-1),gridPoint(screenToWorld(outside,editor.camera)));
    flow.move(1,near,type==="touch");assert.deepEqual(active(flow),[point(end)]);
    assert(flow.up(1,near));assert.deepEqual(line().to,end);
  }
});

test("direction, visibility and rotated outlines govern target rank; overlap ties follow drawing order",()=>{
  const source={...box("origin",0,0,64,64),rotation:Math.PI/2},north=box("up",12,-55,40,30);
  const near=box("near",98,96,60,70),upper={...near,id:"upper"},far=box("far",7,164,50,40);
  const {editor,flow,pos,point}=setup([source,north,near,upper,far]);
  const out=shapePorts(source).find(q=>q.end.portId==="east")!;
  assert.deepEqual(directionalTarget(editor.doc,editor.doc.order,out,280)?.end,anchor(upper.id,"west"));
  editor.select(source.id);editor.setLayerVisibility([upper.id],false);
  flow.move(1,pos(out.point));assert.deepEqual(active(flow),[point(anchor(near.id,"west"))]);
  const triangle={...box("tri",300,80,140,120),shape:"triangle" as const,rotation:Math.PI/4};
  const square={...box("round",500,100,100,100),cornerRadius:50};
  const board=setup([source,triangle,square]).editor.doc;
  const target=(cursor:Point,r:number)=>endpointTarget(board,board.order,cursor,r,5,out.end,out.point);
  assert.equal(target(localToWorld(p(0,0),triangle),10),undefined);
  assert.equal(target(p(500,100),15),undefined);
  const west=shapePorts(triangle).find(q=>q.end.portId==="west")!;
  assert.deepEqual(target(west.point,10)?.end,west.end);
});

test("manual pins determine the facing side of an interior drop on either endpoint and survive undo",()=>{
  const card=newCard("markdown",p(320,120),"# 设计"),start=box("a",0,0);
  const {editor,flow,pos,point,line}=setup([start,card]);
  const a=anchor(start.id,"south"),b=free(p(190,30)),edge=connectFlow(editor,a,b,"curve")!;
  const pins=[p(90,80),p(530,490)];
  assert(editor.commitEdit({label:"手动拐点",patches:[{op:"putObject",value:{...edge,waypoints:pins}}]},editor.generation));
  const center=p(card.at.x+card.width/2,card.at.y+card.height/2);
  for(const [field,side] of [["to","south"],["from","west"]] as const){
    const before=line(edge.id),end=anchor(card.id,side);
    assert(flow.beginRebind(edge.id,field));assert(flow.down(1,"mouse",pos(center)));
    const draft=flow.decor().draft!;
    assert.deepEqual(active(flow),[point(end)]);assert.deepEqual(field==="to"?draft.at(-1):draft[0],point(end));
    assert(flow.up(1,pos(center)));assert.deepEqual(line(edge.id)[field],end);assert.deepEqual(line(edge.id).waypoints,pins);
    editor.undo();assert.deepEqual(line(edge.id),before);
  }
});

test("a returned drag, cancellation, and an ordinary press near the edge never trigger a suggested link",()=>{
  const {editor,flow,pos,point}=setup([box("a",0,0),box("b",141,-4)]);
  editor.select("a");const start=pos(point(anchor("a","east")));
  flow.move(1,start);assert(flow.decor().draft);assert(flow.down(1,"mouse",start));
  flow.move(1,pos(p(130,65)));flow.move(1,start);assert.deepEqual(active(flow),[]);assert(flow.up(1,start));
  assert(!flow.pending);assert.equal(editor.history.past.length,0);
  flow.move(2,start);assert(flow.down(2,"mouse",start));flow.move(2,pos(p(136,12)));flow.cancel();
  assert(!flow.up(2,pos(p(136,12))));assert.equal(editor.history.past.length,0);
  const grab=pos(p(90,32));flow.move(3,grab);assert(!flow.down(3,"mouse",grab));
});

test("all four source ports can create either node at the release point with a facing anchor and a single undo",()=>{
  const landings=[["north","south",p(50,-150)],["east","west",p(290,32)],
    ["south","north",p(50,224)],["west","east",p(-160,32)]] as const;
  for(const [side,incoming,at] of landings)for(const preset of ["process","decision"] as const){
    const {editor,flow,pos,point,line}=setup([box("a",0,0)],1.7);
    const before=editor.doc,from=anchor("a",side),start=pos(point(from)),end=pos(at);
    editor.select("a");const type=preset==="process"?"mouse":"touch";
    if(type==="touch")flow.setMode("connect");
    assert(flow.down(1,type,start));flow.move(1,end,type==="touch");
    const preview=flow.decor().draft;assert(flow.up(1,end));const drop=flow.drop;assert(drop);
    assert(flow.working);flow.clearHover();flow.move(1,p(0,0));editor.pan(p(-35,72));
    assert.deepEqual(flow.decor().draft,preview);assert.strictEqual(editor.doc,before);
    assert(flow.finishDrop(drop,preset));assert(!flow.finishDrop(drop));assert(!flow.working);
    const created=editor.doc.objects[editor.selection!];assert(created.kind==="shape");
    assert.equal(created.shape,preset==="process"?"rect":"diamond");
    assert.deepEqual(p(created.at.x+created.width/2,created.at.y+created.height/2),at);
    const edge=line(editor.doc.order.at(-1));assert.deepEqual(edge.from,from);
    assert.deepEqual(edge.to,anchor(created.id,incoming));assert.equal(edge.arrow,"end");assert.equal(edge.routing,"curve");assert.equal(edge.portCurve,true);
    assert.equal(editor.history.past.length,1);const after=editor.doc;editor.undo();assert.strictEqual(editor.doc,before);
    editor.redo();assert.strictEqual(editor.doc,after);
    const reopened=decodeProject(encodeProject(after,new AssetVault())).document;
    assert.deepEqual(resolveEndpoint(reopened,edge.to),point(edge.to));
  }
});

test("short high-zoom drops keep the connected side at the drop instead of covering the starting port",()=>{
  for(const [preset,dx] of [["decision",6],["process",68]] as const){
    const {editor,flow,pos,point,line}=setup([box("a",0,0)],16);
    const from=anchor("a","east"),at=p(100+dx,32);editor.select("a");
    assert(flow.down(1,"pen",pos(point(from))));assert(flow.up(1,pos(at)));
    const drop=flow.drop;assert(drop);assert(flow.finishDrop(drop,preset));
    const edge=line(editor.doc.order.at(-1));assert.deepEqual(edge.from,from);
    assert.deepEqual(edge.to,anchor(editor.selection!,"west"));assert.deepEqual(point(edge.to),at);
  }
});

test("occupied or snapped drops bypass the menu and stale menu choices cannot edit a new board or gesture",()=>{
  const a=box("a",0,0),b=box("b",240,0);
  const text={id:"text",kind:"text",at:p(210,150),width:120,height:40,rotation:0,fontSize:16,
    heightMode:"fixed",align:"left",text:"说明",color:"#112233"} as const;
  const {editor,flow,pos,point,line}=setup([a,b,text]);
  const original=editor.doc,from=anchor("a","east"),start=pos(point(from)),blank=p(520,190);
  const drag=(at:Point)=>{editor.select("a");assert(flow.down(1,"mouse",start));assert(flow.up(1,pos(at)));};
  drag(p(230,18));assert(!flow.drop);assert.deepEqual(line().to,anchor("b","west"));editor.undo();
  drag(p(217,161));assert(!flow.drop);assert.deepEqual(line().to,free(p(217,161)));editor.undo();
  drag(blank);const previous=flow.drop;assert(previous);flow.cancel();
  drag(blank);const next=flow.drop;assert(next);assert(!flow.finishDrop(previous,"decision"));assert.strictEqual(flow.drop,next);
  editor.open(original,true);assert(!flow.finishDrop(next,"process"));assert(!flow.working);assert.equal(editor.history.past.length,0);
  drag(blank);const hidden=flow.drop;assert(hidden);editor.setLayerVisibility(["a"],false);
  assert(!flow.finishDrop(hidden));assert.equal(editor.history.past.length,0);
});
