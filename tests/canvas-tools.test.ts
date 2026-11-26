import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {fitCanvas} from "../app/canvas-fit.ts";
import type {CanvasControl} from "../app/canvas-fit.ts";
import {createCanvasTools} from "../app/canvas-tool-host.ts";
import {exposeCanvasTools} from "../app/canvas-webmcp.ts";
import type {BoardDocument} from "../core/document.ts";
import {zoomAt} from "../core/geometry.ts";
import {AssetVault} from "../features/image-assets.ts";
import {canvasToolDefinitions} from "../platform/canvas-tools.ts";
import {createLiveCommands} from "../platform/live-commands.ts";
import type {BlockReason} from "../platform/live-commands.ts";
import {decodeProject} from "../platform/project.ts";
import {SceneProjection} from "../scene/projector.ts";
import {EditorSession} from "../session/editor.ts";

const blank:BoardDocument={schemaVersion:1,id:"qa",theme:"paper",order:[],objects:{},assets:{}};
const fixture=(name:string)=>decodeProject(readFileSync(new URL("../docs/fixtures/"+name+".mgcanvas",import.meta.url),"utf8"));
function board(project={document:blank,assets:[] as ReturnType<typeof decodeProject>["assets"]}){
  const editor=new EditorSession(project.document,{offset:{x:0,y:0},zoom:1}),vault=new AssetVault(project.assets);
  const scene=new SceneProjection(editor.doc),reasons:BlockReason[]=[];
  editor.listen(change=>{scene.update(editor.doc,change);scene.setHidden(editor.hiddenIds);});
  const live=createLiveCommands({editor,vault,epoch:"qa",busy:()=>reasons});
  const tools=createCanvasTools({editor,vault:()=>vault,live:()=>live,scene,
    size:()=>({width:650,height:872,usableWidth:650,windowWidth:650,windowHeight:950})});
  async function call(name:string,args:Record<string,unknown>={},error?:string){
    const reply=await tools.callTool(name,args),data=reply.structuredContent;
    assert.deepEqual(JSON.parse(reply.content[0].text),data);
    assert.equal(data.ok,!error,JSON.stringify(data));
    if(error){assert.equal(reply.isError,true);assert.equal(data.code,error,JSON.stringify(data));}
    return data;
  }
  return {editor,vault,scene,reasons,tools,call,revision:()=>live.status().revision};
}
const node=(id:string,x=0,y=0)=>({op:"node",id,x,y,label:id});
const edge=(id:string,from:string,to:string)=>({op:"edge",id,from,to});
const update=(id:string,fields:Record<string,unknown>)=>({op:"update",id,fields});
const batch=(baseRevision:string,operationId:string,operations:unknown[])=>({baseRevision,operationId,operations});

test("camera fit translates clear of the dock at the original zoom and shrinks only between overlapping controls",()=>{
  const groups=[{id:"column",items:[],picks:[],bounds:{min:{x:0,y:0},max:{x:100,y:480}}}];
  const canvas={width:650,height:640},original=fitCanvas(groups,canvas);
  const dock:CanvasControl={id:"dock",edge:"bottom",left:10,right:640,top:549,bottom:630};
  const top:CanvasControl={id:"zoom",edge:"top",left:0,right:80,top:10,bottom:140};
  const fit=(occlusions:CanvasControl[])=>fitCanvas(groups,{...canvas,occlusions});
  const shifted=fit([top,dock]);
  assert.equal(shifted.zoom,original.zoom);
  assert.equal(shifted.offset.y+480*shifted.zoom,dock.top-8);
  assert.deepEqual(fit([top,{...dock,right:80}]),original);
  const beside=fit([{...top,left:330,right:640},dock]);
  assert.equal(beside.zoom,original.zoom);
  assert.ok(beside.offset.x+100*beside.zoom<=330-8);
  assert.ok(beside.offset.x+100*beside.zoom>330-9);
  const constrained=fit([{...top,right:650},dock]);
  assert.ok(constrained.offset.y>=top.bottom+8);
  assert.ok(constrained.offset.y+480*constrained.zoom<=dock.top-8);
  assert.ok(Math.abs(constrained.zoom-(dock.top-top.bottom-16)/480)<.001);
});

test("return to content frames a lone draft, an empty board and objects beyond the manual zoom floor",()=>{
  const view={width:650,height:641};
  assert.deepEqual(fitCanvas([],view),{offset:{x:325,y:320.5},zoom:1});
  const draft={min:{x:44000,y:-48000},max:{x:44100,y:-47940}};
  const draftFit=fitCanvas([],view,draft);
  assert.equal(draftFit.offset.x+44050*draftFit.zoom,325);
  assert.equal(draftFit.offset.y-47970*draftFit.zoom,320.5);
  const far=[0,30000].map(x=>({id:String(x),items:[],picks:[],bounds:{min:{x,y:0},max:{x:x+100,y:60}}}));
  const wide=fitCanvas(far,view);
  assert.ok(wide.zoom>0&&wide.zoom<.05);
  assert.ok(wide.offset.x>0&&wide.offset.x+30100*wide.zoom<650);
  assert.equal(zoomAt(wide,{x:325,y:320},wide.zoom*1.25).zoom,wide.zoom*1.25);
  assert.equal(zoomAt(wide,{x:325,y:320},wide.zoom/2).zoom,wide.zoom);
  assert.equal(zoomAt(draftFit,{x:325,y:320},.01).zoom,.05);
});

test("session snapshots and disk saves carry the open project's name after an edit",async()=>{
  const p=fixture("MG-Canvas-Edit-Lifecycle"),b=board(p),names={title:p.title,fileName:"Lifecycle.mgcanvas"};
  const saved:string[]=[];
  const live=createLiveCommands({editor:b.editor,vault:b.vault,epoch:"named",busy:()=>false,names,
    save:async bytes=>{saved.push(bytes);return {diskRevision:"saved"};}});
  await b.call("canvas_edit",batch(b.revision(),"annotate",[update("change-note",{text:"测试副本"})]));
  const snapshot=await live.request("snapshot");
  await live.request("save",{baseRevision:snapshot.revision});
  assert.equal(saved[0],snapshot.project);
  const project=decodeProject(saved[0]);assert.equal(project.title,"MG Canvas 编辑流程");assert.equal(project.fileName,names.fileName);
});

test("page catalog, bounded read, visible scope and query text measurements share the native projection",async()=>{
  const b=board(),catalog=b.tools.listTools();
  assert.equal(catalog.length,5);catalog[0].description="changed";assert.notEqual(b.tools.listTools()[0].description,"changed");
  const ops=Array.from({length:110},(_,i)=>({...node("item"+i,i*180),label:i<12?"撤销 "+i:"别的对象"}));
  await b.call("canvas_edit",batch(b.revision(),"setup",ops));
  const first=await b.call("canvas_read",{limit:2});
  assert.equal(first.total,110);assert.equal(first.nextOffset,2);assert.equal(first.screenText,undefined);
  const full=await b.call("canvas_read",{detail:"full",limit:100});assert.equal(full.nextOffset,10);
  const search=await b.call("canvas_read",{query:"撤销",limit:8});
  assert.equal(search.total,12);assert.equal(search.nextOffset,8);
  assert.deepEqual(search.screenText,(search.objects as {id:string}[]).map(({id})=>({id,minFontPx:13,maxFontPx:13})));
  const next=await b.call("canvas_read",{query:"撤销",offset:8});
  assert.equal((next.screenText as unknown[]).length,4);
  b.editor.select("item0");b.editor.setLayerVisibility(["item1"],false);
  assert.deepEqual((await b.call("canvas_read",{scope:"selection"})).screenText,[{id:"item0",minFontPx:13,maxFontPx:13}]);
  const visible=(await b.call("canvas_read",{scope:"viewport"})).objects as {id:string}[];
  assert.ok(visible.length>0&&visible.length<6);assert.ok(!visible.some(o=>o.id==="item1"));
  const camera=b.editor.camera;
  await b.call("canvas_view",{action:"fit",ids:["item0"],measureIds:["missing"]},"NOT_FOUND");
  assert.equal(b.editor.camera,camera);
  await b.call("canvas_edit",batch(b.revision(),"size-labels",[
    {...node("large",120,350),labelFontSize:22},{...edge("caption","item0","large"),label:"说明",labelFontSize:18}]));
  assert.deepEqual((await b.call("canvas_read",{ids:["large","caption"]})).screenText,
    [{id:"large",minFontPx:22,maxFontPx:22},{id:"caption",minFontPx:18,maxFontPx:18}]);
});

test("one batch creates native bindings and one history step, guarded retries cannot repeat a later undo",async()=>{
  const b=board(),start=b.editor.doc;
  const args=batch(b.revision(),"three",[edge("line","A","B"),node("A",10,-40),node("B",260,30)]);
  const [one,two]=await Promise.all([b.call("canvas_edit",args),b.call("canvas_edit",args)]);
  assert.notEqual(one.replayed,two.replayed);assert.equal(one.appliedRevision,two.appliedRevision);
  await b.call("canvas_edit",{...args,operations:[node("different")]},"ID_CONFLICT");
  assert.equal(b.editor.history.past.length,1);assert.ok(!b.editor.doc.objects.different);
  assert.equal(b.editor.history.past.length,1);
  const line=b.editor.doc.objects.line;assert.ok(line.kind==="connector");
  assert.deepEqual(line.from,{kind:"anchor",objectId:"A",portId:"east"});assert.deepEqual(line.to,{kind:"anchor",objectId:"B",portId:"west"});
  await b.call("canvas_edit",{...args,operations:[node("C")]},"ID_CONFLICT");
  await b.call("canvas_edit",batch(args.baseRevision,"stale",[node("late")]),"STALE");
  const undo={baseRevision:b.revision(),operationId:"undo",action:"undo"};
  await b.call("canvas_history",undo);assert.equal(b.editor.doc,start);
  await b.call("canvas_history",{baseRevision:b.revision(),operationId:"redo",action:"redo"});
  assert.equal((await b.call("canvas_history",undo)).replayed,true);assert.equal(b.editor.doc.objects.line,line);
  const move=batch(b.revision(),"move",[update("A",{at:{x:99,y:101},label:"moved"})]);
  await b.call("canvas_edit",move);assert.deepEqual(b.editor.doc.objects.line.to,line.to);
  const removed=await b.call("canvas_edit",batch(b.revision(),"remove",[{op:"remove",id:"A"}]));
  assert.ok((removed.removedIds as string[]).includes("A"));
  const remaining=b.editor.doc.objects.line;
  if(remaining){assert.ok(remaining.kind==="connector");assert.equal(remaining.from.kind,"free");assert.deepEqual(remaining.to,line.to);}
  assert.equal(b.editor.doc.objects.B.id,"B");
  await b.call("canvas_history",{baseRevision:b.revision(),operationId:"restore",action:"undo"});
  assert.deepEqual(b.editor.doc.objects.line.from,line.from);
});

test("bad operations, locked and busy editors, aborted and stale in-flight work preserve prior state",async()=>{
  const b=board(fixture("Meeting-Room-Mobile-QA")),doc=b.editor.doc,start=b.revision();
  const first=update("flow-submit",{label:"must not appear"});
  for(const [bad,code] of [[node("fraction",1.2),"INVALID"],[edge("line","unknown","flow-review"),"NOT_FOUND"],
    [update("flow-review",{nonsense:true}),"INVALID"],[update("flow-review",{width:2.5}),"INVALID"],
    [update("flow-review",{at:{x:2.3,y:0}}),"INVALID"]] as const){
    const out=await b.call("canvas_edit",batch(start,"retry",[first,bad]),code);
    assert.equal(out.operationIndex,1);assert.equal(b.editor.doc,doc);assert.equal(b.revision(),start);
  }
  b.editor.setLayerLocks(["flow-review"],true);
  const locked=await b.call("canvas_edit",batch(start,"retry",[first,update("flow-review",{label:"protected"})]),"CONFLICT");
  assert.equal(locked.operationIndex,1);assert.equal(b.editor.doc,doc);
  b.editor.setLayerLocks(["flow-review"],false);b.reasons.push("TEXT_EDITOR");
  await b.call("canvas_edit",batch(start,"retry",[first]),"BUSY");
  assert.deepEqual((await b.call("canvas_read")).blockingReasons,["TEXT_EDITOR"]);
  b.reasons.length=0;
  const controller=new AbortController();
  const cancelled=b.tools.callTool("canvas_edit",batch(start,"retry",[first]),controller.signal);controller.abort();
  assert.equal((await cancelled).structuredContent.code,"CANCELLED");assert.equal(b.editor.doc,doc);
  const accepted=await b.call("canvas_edit",batch(start,"retry",[first]));assert.equal(accepted.changed,true);
  const current=b.revision(),race=b.tools.callTool("canvas_edit",batch(current,"race",[node("new")]));
  b.editor.undo();
  assert.equal((await race).structuredContent.code,"STALE");assert.equal(b.editor.doc,doc);
  const reopened=b.tools.callTool("canvas_edit",batch(b.revision(),"swap",[node("lost")]));
  b.editor.open(blank,true);assert.equal((await reopened).structuredContent.code,"STALE");assert.deepEqual(b.editor.doc.order,[]);
});

test("local Mermaid IDs are unique per drawing and stable on retry, with actual editable nodes and anchored edges",async()=>{
  const b=board(fixture("Meeting-Room-Mobile-QA")),original=b.editor.doc;
  const mermaid="flowchart LR\n  A[提交] -->|审核| B{批准}";
  const a={baseRevision:b.revision(),operationId:"flow1",mermaid},first=await b.call("canvas_draw_flow",a);
  const second=await b.call("canvas_draw_flow",{...a,baseRevision:b.revision(),operationId:"flow2"});
  const replay=await b.call("canvas_draw_flow",a);
  assert.deepEqual(replay.nodeIdMap,first.nodeIdMap);assert.deepEqual(replay.edgeIds,first.edgeIds);
  assert.equal(replay.appliedRevision,first.revision);assert.equal(replay.replayed,true);assert.equal(b.editor.history.past.length,2);
  const ids1=first.nodeIdMap as Record<string,string>,ids2=second.nodeIdMap as Record<string,string>;
  assert.notEqual(ids1.A,ids2.A);assert.notEqual(ids1.B,ids2.B);
  for(const id of original.order)assert.equal(b.editor.doc.objects[id],original.objects[id]);
  for(const [plan,ids] of [[first,ids1],[second,ids2]] as const){
    const line=b.editor.doc.objects[(plan.edgeIds as string[])[0]];
    assert.ok(line.kind==="connector"&&line.from.kind==="anchor"&&line.to.kind==="anchor");
    assert.equal(line.from.objectId,ids.A);assert.equal(line.to.objectId,ids.B);
  }
  const box1=b.scene.selectedBounds(first.addedIds as string[])!,box2=b.scene.selectedBounds(second.addedIds as string[])!;
  assert.ok(box1.max.x<box2.min.x||box2.max.x<box1.min.x||box1.max.y<box2.min.y||box2.max.y<box1.min.y);
  await b.call("canvas_edit",batch(b.revision(),"rename",[update(ids2.A,{label:"改名"})]));
  const labels=(await b.call("canvas_read",{ids:[ids1.A,ids2.A]})).objects as {label:string}[];
  assert.deepEqual(labels.map(o=>o.label),["提交","改名"]);
  const graph={nodes:[{id:"graph1",shape:"stadium"}],edges:[]};
  const graphPlan=await b.call("canvas_draw_flow",{baseRevision:b.revision(),operationId:"fromgraph",graph});
  assert.deepEqual(graphPlan.nodeIds,["graph1"]);
  const before=b.editor.doc;
  const collision=await b.call("canvas_draw_flow",{baseRevision:b.revision(),operationId:"collision",graph},"CONFLICT");
  assert.equal(collision.path,"graph.nodes[0].id");
  await b.call("canvas_draw_flow",{baseRevision:b.revision(),operationId:"ambiguous",graph,mermaid},"INVALID");
  const syntax=await b.call("canvas_draw_flow",{baseRevision:b.revision(),operationId:"syntax",mermaid:"flowchart TB\nA ~~> B"},"INVALID");
  assert.equal(syntax.line,2);assert.ok(typeof syntax.column==="number");assert.equal(syntax.path,"mermaid");
  assert.equal(b.editor.doc,before);
});

test("document validation attributes dotted IDs and errors in staged edits to their originating operation",async()=>{
  const b=board();
  await b.call("canvas_edit",batch(b.revision(),"create",[node("step",0),node("step.verify",250),node("other",540)]));
  const original=b.editor.doc;
  const invalid=update("step.verify",{unexpected:true}),valid=update("step",{label:"should roll back"});
  for(const tail of [[valid],[valid,{op:"remove",id:"other"}]]){
    const data=await b.call("canvas_edit",batch(b.revision(),"failed",[invalid,...tail]),"INVALID");
    assert.equal(data.operationIndex,0);assert.equal(data.path,"objects.step.verify");assert.equal(b.editor.doc,original);
  }
});

test("native partitions retain existing groups, editable titles, bound crossing edges and one-step history",async()=>{
  const b=board(fixture("M5X-Flow-Groups")),original=b.editor.doc,oldGroups=original.flowGroups!.members;
  const mermaid=["flowchart TD","subgraph ui[交互层]","A[输入] --> B[提交]","end",
    "subgraph db[存储层]","C[保存] --> D[恢复]","end","B -->|写入| C"].join("\n");
  const args={baseRevision:b.revision(),operationId:"grouped",mermaid};
  const out=await b.call("canvas_draw_flow",args);
  type MappedGroup={localId:string;id:string;titleId:string;nodeIds:string[]};
  const [ui,db]=out.groups as MappedGroup[],ids=out.nodeIdMap as Record<string,string>;
  assert.deepEqual(out.groupIdMap,{ui:ui.id,db:db.id});assert.deepEqual(ui.nodeIds,[ids.A,ids.B]);
  assert.deepEqual(db.nodeIds,[ids.C,ids.D]);assert.deepEqual(out.nodeIds,[ids.A,ids.B,ids.C,ids.D]);
  assert.deepEqual(b.editor.doc.flowGroups?.members,{...oldGroups,[ui.id]:[ui.titleId,ids.A,ids.B],[db.id]:[db.titleId,ids.C,ids.D]});
  const part=await b.call("canvas_read",{ids:[ui.titleId,db.titleId,ids.A,ids.C]});
  assert.deepEqual((part.objects as {label:string;group:string}[]).map(o=>[o.label,o.group]),
    [["交互层",ui.id],["存储层",db.id],["输入",ui.id],["保存",db.id]]);
  const lines=(await b.call("canvas_read",{ids:out.edgeIds})).objects as {label:string;group:string|null;from:{objectId:string};to:{objectId:string}}[];
  const cross=lines.find(o=>o.label==="写入")!;
  assert.deepEqual([cross.group,cross.from.objectId,cross.to.objectId],[null,ids.B,ids.C]);
  assert.deepEqual((await b.call("canvas_draw_flow",args)).groups,out.groups);
  assert.equal(b.editor.history.past.length,1);
  await b.call("canvas_history",{baseRevision:b.revision(),operationId:"undo-group",action:"undo"});
  assert.equal(b.editor.doc,original);
  await b.call("canvas_history",{baseRevision:b.revision(),operationId:"redo-group",action:"redo"});
  await b.call("canvas_edit",batch(b.revision(),"rename-title",[{...update(ui.titleId,{label:"客户端"}),group:ui.id}]));
  assert.equal(b.editor.doc.objects[ui.titleId].label,"客户端");
  const graph={nodes:[{id:"new-a"}],edges:[],groups:[{id:"fresh-group",label:"附注",nodeIds:["new-a"]}]};
  const other=await b.call("canvas_draw_flow",{baseRevision:b.revision(),operationId:"grouped-json",graph});
  const [g]=other.groups as MappedGroup[];
  assert.equal(g.id,"fresh-group");assert.deepEqual(b.editor.doc.flowGroups?.members[g.id],[g.titleId,"new-a"]);
  assert.deepEqual(b.editor.doc.flowGroups?.members[ui.id],[ui.titleId,ids.A,ids.B]);
  const reject=await b.call("canvas_draw_flow",{baseRevision:b.revision(),operationId:"bad-group",graph:{
    nodes:[{id:"n"}],edges:[],groups:[{id:"group-intake",nodeIds:["n"]}]}},"CONFLICT");
  assert.equal(reject.path,"graph.groups[0].id");assert.ok(!b.editor.doc.objects.n);
  const unchanged=b.editor.doc;b.editor.setLayerLocks([ui.titleId],true);
  const locked=await b.call("canvas_edit",batch(b.revision(),"protected-group",[
    update("standalone",{label:"roll back"}),{op:"remove",id:ids.A,group:ui.id}]),"CONFLICT");
  assert.equal(locked.operationIndex,1);assert.equal(b.editor.doc,unchanged);
});

test("automatic placement uses an interior gap, respects explicit world coordinates and keeps flow direction",async()=>{
  const b=board();
  await b.call("canvas_edit",batch(b.revision(),"far-apart",[node("left",-900,0),node("right",900,0)]));
  const original=b.scene.selectedBounds(["left","right"])!;
  const graph={direction:"LR",nodes:[{id:"one"},{id:"two"}],edges:[{from:"one",to:"two"}]};
  const placed=await b.call("canvas_draw_flow",{baseRevision:b.revision(),operationId:"fill",graph});
  const box=b.scene.selectedBounds(placed.addedIds as string[])!;
  assert.ok(box.min.x>b.scene.group("left")!.bounds.max.x&&box.max.x<b.scene.group("right")!.bounds.min.x);
  assert.equal(b.scene.selectedBounds(b.editor.doc.order)!.min.x,original.min.x);
  assert.ok(b.scene.group("two")!.bounds.min.x>b.scene.group("one")!.bounds.max.x);
  const origin={x:-900,y:0},drawn=await b.call("canvas_draw_flow",{baseRevision:b.revision(),operationId:"manual",
    graph:{nodes:[{id:"specific"}],edges:[]},origin});
  assert.deepEqual(drawn.origin,origin);assert.deepEqual(b.editor.doc.objects.specific.at,origin);
});

test("document WebMCP discovery and the local fallback execute the shared tools; disposal respects bfcache",async()=>{
  const b=board(),host=new EventTarget() as Window,definitions=new Map<string,{execute:Function;signal:AbortSignal}>();
  const doc={modelContext:{registerTool(tool:{name:string;execute:Function},options:{signal:AbortSignal}){
    definitions.set(tool.name,{execute:tool.execute,signal:options.signal});
  }}} as unknown as Document;
  await exposeCanvasTools(host,doc,b.tools);
  assert.deepEqual([...definitions.keys()],canvasToolDefinitions.map(d=>d.name));
  const read=definitions.get("canvas_read")!;
  assert.deepEqual(await read.execute({}), (await b.tools.callTool("canvas_read")).structuredContent);
  assert.equal((await read.execute({unknown:true})).code,"INVALID");
  host.dispatchEvent(Object.assign(new Event("pagehide"),{persisted:true}));assert.equal(read.signal.aborted,false);
  host.dispatchEvent(new Event("pagehide"));assert.equal(read.signal.aborted,true);
  const fallback=new EventTarget() as Window;
  await exposeCanvasTools(fallback,{} as Document,b.tools);
  assert.equal((fallback as unknown as {mgCanvasTools:unknown}).mgCanvasTools,b.tools);
});

test("a replaced viewport cancels old page calls and in-flight edits and releases its WebMCP registrations",async()=>{
  const first=board(),second=board(),host=new EventTarget() as Window&{mgCanvasTools?:typeof first.tools};
  let finishRegistration!:()=>void;
  const registered:{name:string;signal:AbortSignal}[]=[];
  const delayed={modelContext:{registerTool(tool:{name:string},{signal}:{signal:AbortSignal}){
    registered.push({name:tool.name,signal});
    return new Promise<void>(done=>{finishRegistration=done;});
  }}} as unknown as Document;
  const oldLife=new AbortController(),newLife=new AbortController();
  const exposing=exposeCanvasTools(host,delayed,first.tools,oldLife.signal);
  const old=host.mgCanvasTools!;
  const args=batch(first.revision(),"stale-edit",[node("stale")]);
  const edit=old.callTool("canvas_edit",args);
  await exposeCanvasTools(host,{} as Document,second.tools,newLife.signal);
  const replacement=host.mgCanvasTools!;
  // Clean up out of order as well as during registration.
  oldLife.abort();finishRegistration();await exposing;
  assert.equal((await edit).structuredContent.code,"CANCELLED");
  assert.equal((await old.callTool("canvas_edit",args)).structuredContent.code,"CANCELLED");
  assert.deepEqual(first.editor.doc.order,[]);assert.deepEqual(second.editor.doc.order,[]);
  assert.equal(registered.length,1);assert.ok(registered[0].signal.aborted);
  assert.equal(host.mgCanvasTools,replacement);assert.ok((await replacement.callTool("canvas_read")).structuredContent.ok);
  const caller=new AbortController();caller.abort();
  assert.equal((await replacement.callTool("canvas_read",{},caller.signal)).structuredContent.code,"CANCELLED");
  newLife.abort();assert.equal(host.mgCanvasTools,undefined);
});
