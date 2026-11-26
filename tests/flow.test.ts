import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSession } from "../session/editor.ts";
import { FlowInput } from "../features/flow-input.ts";
import { addWaypoint,connectFlow,createFlowNode,deleteFlowSelection,detachConnectorEnd,flowHandles,flowPath,free,pickPort,removeWaypoint,setConnectorEnd,setFlowNodeLabel,setWaypoint,styleConnector } from "../features/flow.ts";
import { buildScene,hitTest } from "../scene/board.ts";
import {placementBox} from "../features/placement.ts";
import { worldToScreen,screenToWorld } from "../core/geometry.ts";
import { resolveEndpoint } from "../core/document.ts";
import { decodeProject,encodeProject } from "../platform/project.ts";
import { AssetVault } from "../features/image-assets.ts";
import { demo } from "../app/demo.ts";
import type { Connector, Endpoint } from "../core/document.ts";
const p=(x:number,y:number)=>({x,y});
const anchor=(objectId:string,portId:"north"|"east"|"south"|"west"):Endpoint=>({kind:"anchor",objectId,portId});
function fixture(){
  const editor=new EditorSession(demo,{offset:p(145,184),zoom:1.3});
  const q=(screen:ReturnType<typeof p>)=>hitTest(buildScene(editor.doc),screenToWorld(screen,editor.camera),5/editor.camera.zoom);
  const flow=new FlowInput(editor,q);
  const screen=(world:ReturnType<typeof p>)=>worldToScreen(world,editor.camera);
  const from=anchor("flow-source","east"),to=anchor("flow-decision","west");
  const fromScreen=screen(resolveEndpoint(editor.doc,from)!);
  const toScreen=screen(resolveEndpoint(editor.doc,to)!);
  return {editor,flow,screen,from,to,fromScreen,toScreen};
}
function lineAt(editor:EditorSession,id:string):Connector{
  const item=editor.doc.objects[id];assert(item?.kind==="connector");return item;
}

test("flow node presets place process, diamond and triangle and can change label",()=>{
  const {editor,flow,screen}=fixture();
  flow.setMode("decision");
  const at=screen(p(480,-240));assert(flow.down(1,"mouse",at));flow.up(1,at);
  const id=editor.selection!,diamond=editor.doc.objects[id];
  assert(diamond.kind==="shape");assert.equal(diamond.shape,"diamond");
  assert.deepEqual(diamond.at,p(424,-285));
  assert(!flow.mode);assert(setFlowNodeLabel(editor,id,"次序\n正确？"));
  assert.equal((editor.doc.objects[id] as typeof diamond).label,"次序 正确？");
  assert.equal(createFlowNode(editor,"process",p(580,-240))?.shape,"rect");
  assert.equal(createFlowNode(editor,"triangle",p(720,-240))?.shape,"triangle");
  assert.equal(editor.history.past.length,4);editor.undo();assert.equal(editor.history.past.length,3);
});

test("armed presets draft and commit the dragged mouse or touch bounds, including reverse drag",()=>{
  const {editor,flow,screen}=fixture();
  for(const [i,preset,type] of [[1,"process","mouse"],[2,"decision","mouse"],[3,"triangle","touch"]] as const){
    flow.setMode(preset);
    const before=editor.doc,start=screen(p(510,480)),end=screen(p(390,410));
    assert(flow.down(i,type,start));flow.move(i,end,type==="touch");
    const outline=flow.decor().draft;assert(outline);
    assert.deepEqual(outline[0],outline.at(-1));
    assert.equal(outline.length,preset==="triangle"?4:5);
    assert.strictEqual(editor.doc,before,"draft shape modified the live document");
    assert(flow.up(i,end));
    const item=editor.doc.objects[editor.selection!];assert(item.kind==="shape");
    assert.equal(item.shape,preset==="process"?"rect":preset==="decision"?"diamond":"triangle");
    assert(Math.abs(item.width-120)<1e-8&&Math.abs(item.height-70)<1e-8);
    assert(Math.abs(item.at.x-390)<1e-8&&Math.abs(item.at.y-410)<1e-8);
    assert(!flow.mode);editor.undo();assert.strictEqual(editor.doc,before);
  }
  const before=editor.doc,start=screen(p(510,480)),end=screen(p(390,410));
  flow.setMode("process");flow.down(4,"touch",start);flow.move(4,end,true);
  assert(flow.decor().draft);flow.cancel();
  assert(!flow.decor().draft&&!flow.up(4,end));assert.strictEqual(editor.doc,before);
});

test("flow placement uses the displayed box through jitter, pointerup-only drags and a drag returning to its origin",()=>{
  const {editor,flow}=fixture();
  const start=p(220,161),near=p(227,165),far=p(177,136);
  for(const [preset,moves,end,dragged] of [
    ["decision",[near],near,false],["process",[],far,true],["triangle",[far,near],near,true]
  ] as const){
    const before=editor.history;flow.setMode(preset);flow.move(1,start);assert.equal(editor.history,before);
    assert(flow.down(1,"mouse",start));for(const next of moves)flow.move(1,next);
    assert.equal(editor.history,before);assert(flow.up(1,end));
    const item=editor.doc.objects[editor.selection!];assert(item.kind==="shape");
    const {at,width,height}=item;assert.deepEqual({at,width,height},placementBox(preset,end,editor.camera,dragged?start:undefined));
    assert.equal(editor.history.past.length,before.past.length+1);editor.undo();assert.equal(editor.doc,before.doc);
  }
});

test("drag-to-port is visual until drop, supports multiple output routes and undo",()=>{
  const {editor,flow,from,to,fromScreen,toScreen,screen}=fixture();
  const baseline=editor.doc;
  flow.setMode("connect");
  assert(flow.down(1,"mouse",fromScreen));flow.move(1,toScreen);
  assert(flow.decor().draft);assert(flow.decor().markers.some(mark=>mark.kind==="origin"));
  assert(flow.decor().markers.some(mark=>mark.kind==="input"&&mark.active));
  assert.strictEqual(editor.doc,baseline);
  assert(flow.up(1,toScreen));const first=editor.selection!;
  assert.deepEqual(lineAt(editor,first).from,from);
  assert.deepEqual(lineAt(editor,first).to,to);
  const alt=anchor("flow-decision","north"),altScreen=screen(resolveEndpoint(editor.doc,alt)!);
  // Even with the last line selected, the explicit connect tool starts a new edge at the same port.
  assert(flow.down(2,"mouse",fromScreen));flow.move(2,altScreen);assert(flow.up(2,altScreen));
  assert.deepEqual(lineAt(editor,editor.selection!).to,alt);
  assert.equal(editor.history.past.length,2);
  editor.undo();editor.undo();assert.strictEqual(editor.doc,baseline);
});

test("touch two-tap Connect on blank previews the new port and creates the node and link in one undo step",()=>{
  const {editor,flow,screen,from,fromScreen}=fixture();
  const start=editor.doc;
  flow.setMode("connect");
  assert(flow.down(1,"touch",fromScreen));assert(flow.up(1,fromScreen));
  assert(flow.pending);assert.equal(editor.history.past.length,0);
  const blank=screen(p(-70,220));
  assert(flow.down(2,"touch",blank));
  const preview=flow.decor();assert(preview.markers.some(mark=>mark.kind==="input"&&mark.active));
  assert(flow.up(2,blank));
  const created=editor.selection!,node=editor.doc.objects[created];
  assert(node.kind==="shape");assert.equal(node.shape,"rect");
  const connector=editor.doc.objects[editor.doc.order.at(-1)!];assert(connector.kind==="connector");
  assert.deepEqual(connector.from,from);
  assert(connector.to.kind==="anchor");assert.equal(connector.to.objectId,created);
  assert.deepEqual(preview.draft?.at(-1),resolveEndpoint(editor.doc,connector.to));
  assert.equal(editor.history.past.length,1);assert.equal(editor.doc.order.length,start.order.length+2);
  editor.undo();assert.strictEqual(editor.doc,start);
  editor.redo();assert.equal(editor.doc.objects[created].kind,"shape");
});

test("a continuous drag to blank holds its draft until the user keeps the free endpoint",()=>{
  const {editor,flow,from,fromScreen,screen}=fixture();
  const inside=screen(p(-280,-20)),blank=screen(p(-180,220)),before=editor.doc;
  flow.move(1,inside);
  assert(flow.decor().markers.some(mark=>mark.kind==="output"));
  assert(flow.down(1,"mouse",fromScreen));flow.move(1,blank);
  assert(flow.decor().draft);assert.strictEqual(editor.doc,before);
  flow.up(1,blank);const drop=flow.drop;assert(drop);
  assert.strictEqual(editor.doc,before);assert.equal(editor.history.past.length,0);
  assert(flow.finishDrop(drop));assert(!flow.finishDrop(drop,"process"));
  assert.equal(editor.history.past.length,1);assert.equal(editor.doc.order.length,before.order.length+1);
  const line=lineAt(editor,editor.selection!);
  assert.deepEqual(line.from,from);assert.deepEqual(line.to,free(p(-180,220)));
  editor.undo();assert.strictEqual(editor.doc,before);
});

test("cancel, stale generation, same port and mindmap interior do not write a connection",()=>{
  const {editor,flow,screen,from,fromScreen}=fixture();
  const map=editor.doc.objects["mind-room"];assert(map.kind==="mindmap");
  flow.setMode("connect");
  flow.down(1,"mouse",fromScreen);flow.move(1,screen(p(540,260)));flow.cancel();
  assert.equal(flow.up(1,screen(p(540,260))),false);
  assert.equal(editor.history.past.length,0);
  flow.down(2,"touch",fromScreen);flow.up(2,fromScreen);
  flow.down(3,"touch",screen(map.origin));flow.up(3,screen(map.origin));
  assert.equal(editor.history.past.length,0);
  assert.equal(pickPort(editor.doc,map.origin,4),undefined);
  assert.equal(connectFlow(editor,from,from),undefined);
  assert.equal(connectFlow(editor,from,{kind:"anchor",objectId:"root-a",portId:"west"}),undefined);
  flow.down(4,"mouse",fromScreen);editor.open(demo,true);
  flow.up(4,screen(p(540,260)));
  assert.equal(editor.history.past.length,0);
});

test("free straight line is not bound even when sketched over a shape port",()=>{
  const {editor,flow,screen,from,fromScreen}=fixture();
  flow.setMode("line");
  const end=p(-130,220);
  assert(flow.down(1,"mouse",fromScreen));flow.move(1,screen(end));assert(flow.up(1,screen(end)));
  const line=lineAt(editor,editor.selection!);
  assert.equal(line.routing,"straight");assert(line.from.kind==="free");
  const start=resolveEndpoint(editor.doc,from)!;
  assert(Math.abs(line.from.point.x-start.x)<1e-9&&Math.abs(line.from.point.y-start.y)<1e-9);
  assert.equal(line.to.kind,"free");
  if(line.to.kind==="free"){assert(Math.abs(line.to.point.x-end.x)<1e-9);assert(Math.abs(line.to.point.y-end.y)<1e-9);}
});
test("rebind to a port, detach at exact point, and undo restore the original endpoints",()=>{
  const {editor,flow,screen}=fixture();
  const id="flow-arrow",original=lineAt(editor,id);
  editor.select(id);
  const item=flowHandles(editor.doc,id).find(h=>h.kind==="endpoint"&&h.field==="to")!;
  const startScreen=screen(item.point), bound=anchor("flow-decision","south"),end=resolveEndpoint(editor.doc,bound)!;
  flow.down(1,"mouse",startScreen);flow.move(1,screen(end));flow.up(1,screen(end));
  assert.deepEqual(lineAt(editor,id).to,bound);
  assert(detachConnectorEnd(editor,id,"to"));assert.deepEqual(lineAt(editor,id).to,free(end));
  editor.undo();assert.deepEqual(lineAt(editor,id).to,bound);
  editor.undo();assert.deepEqual(lineAt(editor,id).to,original.to);
  assert(flow.beginRebind(id,"from"));
  const blank=p(-340,210);assert(flow.down(2,"touch",screen(blank)));flow.up(2,screen(blank));
  const detached=lineAt(editor,id).from;assert(detached.kind==="free");
  assert(Math.abs(detached.point.x-blank.x)<1e-9);
  assert.equal(setConnectorEnd(editor,id,"from",anchor("mind-room","west")),false);
});
test("manual waypoints edit independently and survive shape motion and portable reopen",()=>{
  const {editor,flow,screen}=fixture(),id="flow-arrow";
  editor.select(id);
  assert(addWaypoint(editor,id));
  assert(setWaypoint(editor,id,0,p(-177,-36)));
  const control=flowHandles(editor.doc,id).find(h=>h.kind==="waypoint"&&h.index===0)!;
  const a=screen(control.point),b=screen(p(-204,-68));
  flow.down(1,"mouse",a);flow.move(1,b);
  const old=lineAt(editor,id);
  assert.deepEqual(old.waypoints[0],p(-177,-36));
  assert(flow.up(1,b));
  const movedPin=lineAt(editor,id).waypoints[0];
  assert(Math.abs(movedPin.x+204)<1e-9&&Math.abs(movedPin.y+68)<1e-9);
  assert(styleConnector(editor,id,{label:"同意 → 下一步",arrow:"both",routing:"curve"}));
  const curved=lineAt(editor,id),from=resolveEndpoint(editor.doc,curved.from)!,to=resolveEndpoint(editor.doc,curved.to)!;
  const path=flowPath(from,to,curved.routing,curved.waypoints);
  assert(path.length>4);assert(path.some(q=>Math.abs(q.x-curved.waypoints[0].x)<1e-9&&Math.abs(q.y-curved.waypoints[0].y)<1e-9));
  editor.select("flow-source");editor.moveSelection(p(10,20));
  assert.strictEqual(lineAt(editor,id),curved);
  const portable=decodeProject(encodeProject(editor.doc,new AssetVault()));
  assert.deepEqual(portable.document.objects[id],curved);
  assert(removeWaypoint(editor,id,0));assert.equal(lineAt(editor,id).waypoints.length,old.waypoints.length-1);
});

test("deleting connected shape leaves other line end and pins stable; undo rebinds",()=>{
  const {editor}=fixture(),id="flow-arrow",before=editor.doc,line=lineAt(editor,id);
  const oldPoint=resolveEndpoint(editor.doc,line.from)!;
  editor.select("flow-source");assert(deleteFlowSelection(editor));
  const changed=lineAt(editor,id);
  assert.deepEqual(changed.from,free(oldPoint));assert.deepEqual(changed.to,line.to);assert.deepEqual(changed.waypoints,line.waypoints);
  assert(!editor.doc.objects["flow-source"]);
  assert.strictEqual(editor.doc.objects["mind-room"],before.objects["mind-room"]);
  editor.undo();assert.strictEqual(editor.doc,before);
});

test("selected manual pins on 进入审批 delete one at a time, while cancelled drags and automatic bends keep their route",()=>{
  const {editor,flow,screen}=fixture(),id="flow-arrow";
  editor.select(id);
  const original=lineAt(editor,id),[first,second]=original.waypoints;
  assert.equal(original.label,"进入审批");
  const press=(point:typeof first)=>assert(flow.down(21,"mouse",screen(point)));
  press(second);flow.move(21,screen(p(-205,236)));
  assert(flow.decor().draft);flow.cancel();assert(!flow.up(21,screen(p(-205,236))));
  assert(!flow.decor().draft);assert.strictEqual(lineAt(editor,id),original);assert.equal(editor.history.past.length,0);
  press(second);flow.up(21,screen(second));flow.move(21,screen(p(33,180)));
  assert.deepEqual(flow.decor().markers.filter(m=>m.selected).map(m=>m.point),[second]);
  assert(flow.removeSelectedWaypoint());
  assert.deepEqual(lineAt(editor,id),{...original,waypoints:[first]});
  assert(!flow.removeSelectedWaypoint());assert.equal(editor.history.past.length,1);
  press(first);flow.up(21,screen(first));assert(flow.removeSelectedWaypoint());
  assert.deepEqual(lineAt(editor,id),{...original,waypoints:[]});
  const route=buildScene(editor.doc,undefined,[id])[0].items[0];assert(route.kind==="path"&&route.points.length>2);
  assert(!flow.decor().markers.some(m=>m.kind==="waypoint"));
  for(const point of route.points)assert.equal(flow.waypointAt(screen(point),false),undefined);
  editor.undo();assert.deepEqual(lineAt(editor,id),{...original,waypoints:[first]});
  editor.undo();assert.strictEqual(lineAt(editor,id),original);
  editor.redo();editor.redo();assert.deepEqual(lineAt(editor,id),{...original,waypoints:[]});
});
