import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmdirSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AssetVault } from "../features/image-assets.ts";
import { commitBatch, executeBatch } from "../features/board-commands.ts";
import { arrangeCommands, arrangeSelection } from "../features/arrange.ts";
import { decodeProject, encodeProject } from "../platform/project.ts";
import { EditorSession } from "../session/editor.ts";
import { createLiveCommands } from "../platform/live-commands.ts";
import { layoutSelectedFlow } from "../features/flow-layout.ts";
import { getMap, moveTopic } from "../features/mindmap.ts";
import { SceneProjection } from "../scene/projector.ts";

const cli=fileURLToPath(new URL("../scripts/mgcanvas.mjs",import.meta.url));
const fixture=(name:string)=>readFileSync(new URL("../docs/fixtures/"+name+".mgcanvas",import.meta.url),"utf8");
const initial=fixture("Meeting-Room-Mobile-QA");
function run(args:string[],expected=0,input?:object) {
  const result=spawnSync(process.execPath,[cli,...args],{encoding:"utf8",input:input&&JSON.stringify(input),windowsHide:true});
  assert.equal(result.status,expected,result.stdout+result.stderr);
  assert.doesNotMatch(result.stdout,/[^\x00-\x7f]/,"JSON must survive native Windows pipeline decoding");
  return JSON.parse(result.stdout);
}
const update=(label:string)=>({op:"update",id:"flow-submit",fields:{label}});
const topic=(text:string)=>({op:"topic",id:"mind-booking",topicId:"topic-root",fields:{text}});
const batch=(revision:string,operations:unknown[],operationId="first")=>({baseRevision:revision,operationId,operations});
function temp(t:{after:(cb:()=>void)=>void}){
  const dir=mkdtempSync(join(tmpdir(),"mgcanvas-cli-test-"));
  t.after(()=>{for(const name of readdirSync(dir))unlinkSync(join(dir,name));rmdirSync(dir);});
  return dir;
}
test("disk CLI rejects partial, fractional and stale batches; saved edits retain image bytes and bindings",t=>{
  const dir=temp(t),file=join(dir,"board.mgcanvas");writeFileSync(file,initial);
  const inspect=["inspect","--file",file], apply=["apply","--file",file,"--batch","-"];
  const before=run(inspect);
  assert.equal(before.data.objects["flow-submit"].label,"提交预约");
  assert.equal(run([...inspect,"--map","mind-booking"]).data.topics[0].parent,null);
  for(const invalid of [{op:"update",id:"flow-submit",fields:{width:13.5}},{op:"remove",id:"flow-submit"},{op:"unrecognized"}]){
    run(apply,2,batch(before.revision,[topic("must roll back"),invalid]));
    assert.equal(readFileSync(file,"utf8"),initial);
  }
  const after=run(apply,0,batch(before.revision,[update("approved"),topic("edited tree")]));
  assert.notEqual(after.revision,before.revision);
  assert.equal(run([...inspect,"--id","flow-submit"]).data.label,"approved");
  assert.equal(run([...inspect,"--map","mind-booking"]).data.topics[0].text,"edited tree");
  assert.deepEqual(run([...inspect,"--kind","connector"]).data,before.data.order.map((id:string)=>before.data.objects[id]).filter((v:{kind:string})=>v.kind==="connector"));
  const changed=readFileSync(file,"utf8");
  assert.deepEqual(decodeProject(changed).assets,decodeProject(initial).assets);
  assert.equal(run(apply,3,batch(before.revision,[update("stale")],"late")).code,"STALE");
  assert.equal(readFileSync(file,"utf8"),changed);
  assert.equal(run(apply,0,batch(after.revision,[update("approved")],"noop")).revision,after.revision);
  assert.equal(run(["export","--file",file,"--out",file],3).code,"EXISTS");
});
test("legacy raw snapshots, path, cubic and group projects reopen through CLI export",t=>{
  const dir=temp(t),file=join(dir,"source.mgcanvas"),raw=JSON.parse(initial).document;
  delete raw.objects["qa-picture"];raw.order=raw.order.filter((id:string)=>id!=="qa-picture");raw.assets={};
  raw.objects["flow-submit"].at.x=-4.6;writeFileSync(file,JSON.stringify(raw));
  assert.equal(run(["inspect","--file",file,"--id","flow-submit"]).data.at.x,-5);
  for(const name of ["M5R-Vector-Paths","M5S-Cubic-Paths","M5X-Flow-Groups","MG-Canvas-Edit-Lifecycle"]){
    writeFileSync(file,fixture(name));const out=join(dir,name+".mgcanvas");
    run(["export","--file",file,"--out",out]);assert.deepEqual(decodeProject(readFileSync(out,"utf8")),decodeProject(fixture(name)));
  }
});
test("simultaneous conditional saves from independent CLI processes produce one winner",async t=>{
  const file=join(temp(t),"race.mgcanvas");writeFileSync(file,initial);
  const revision=run(["status","--file",file]).revision;
  function writer(label:string):Promise<{ok:boolean;code?:string;label:string}>{
    return new Promise((done,fail)=>{
      const child=spawn(process.execPath,[cli,"apply","--file",file,"--batch","-"],{windowsHide:true});
      let stdout="";child.stdout.on("data",chunk=>stdout+=chunk);child.on("error",fail);
      child.on("close",()=>{try{done({...JSON.parse(stdout),label});}catch(error){fail(error);}});
      child.stdin.end(JSON.stringify(batch(revision,[update(label)],label)));
    });
  }
  const replies=await Promise.all([writer("first"),writer("second")]);
  const winners=replies.filter(r=>r.ok);assert.equal(winners.length,1);
  assert.ok(["BUSY","STALE"].includes(replies.find(r=>!r.ok)!.code!));
  assert.equal(run(["inspect","--file",file,"--id","flow-submit"]).data.label,winners[0].label);
});
test("new image bytes and locked edits roll back, successful image survives undo and redo",()=>{
  const p=decodeProject(initial),editor=new EditorSession(p.document,{offset:{x:0,y:0},zoom:1}),vault=new AssetVault(p.assets);
  const picture=editor.doc.objects["qa-picture"],base64=JSON.parse(initial).assets["asset-1"];
  const image={op:"addImage",assetId:"second-asset",base64,value:{...picture,id:"second-picture",assetId:"second-asset"}};
  assert.throws(()=>commitBatch(editor,vault,[image,{...image,value:{...image.value,id:"third-picture"}}]));
  assert.deepEqual(vault.assetIds(),["asset-1"]);assert.equal(editor.history.revision,0);
  commitBatch(editor,vault,[image]);editor.undo();assert.ok(vault.get("second-asset"));editor.redo();
  const saved=decodeProject(encodeProject(editor.doc,vault));assert.deepEqual(saved.assets[0].bytes,saved.assets[1].bytes);
  editor.setLayerLocks(["flow-submit"],true);
  assert.throws(()=>commitBatch(editor,vault,[topic("rolled back"),update("locked")]),{code:"CONFLICT"});
  assert.deepEqual(editor.doc.objects["mind-booking"],p.document.objects["mind-booking"]);
  commitBatch(editor,vault,[{op:"remove",id:"second-picture"}]);
  assert.ok(!Object.hasOwn(editor.doc.assets,"second-asset"));assert.ok(vault.get("second-asset"));
  editor.undo();assert.ok(Object.hasOwn(editor.doc.assets,"second-asset"));
});

test("a restarted session has a new revision namespace and no receipt for a previous write",async()=>{
  const p=decodeProject(initial),editor=new EditorSession(p.document,{offset:{x:0,y:0},zoom:1}),vault=new AssetVault(p.assets);
  const connect=(epoch:string)=>createLiveCommands({editor,vault,epoch,busy:()=>false,save:async()=>({diskRevision:"saved"})});
  const live=connect("original"), command=batch(live.status().revision,[update("first page")]);
  const reply=await live.request("apply",command);
  editor.open(p.document,true);
  const next=connect("restarted");
  assert.equal((await next.request("receipt",{operationId:"first"})).known,false);
  await assert.rejects(next.request("apply",command),{code:"STALE"});
  assert.notEqual(next.status().revision,reply.appliedRevision);
  assert.equal(editor.history.revision,0);
});

test("object creation, styles, free connectors, ink, order and groups use the document version and history",()=>{
  const p=decodeProject(initial),editor=new EditorSession(p.document,{offset:{x:0,y:0},zoom:1}),vault=new AssetVault(p.assets);
  const a="flow-submit",b="flow-review";
  const ink={kind:"ink",id:"pen",brushVersion:1,at:{x:3,y:2},baseWidth:5,color:"#215b9d",samples:[[0,0,.13],[8,4,.82]]};
  const wire={kind:"connector",id:"wire",from:{kind:"free",point:{x:1,y:2}},to:{kind:"free",point:{x:19,y:20}},routing:"straight",waypoints:[],label:"free",arrow:"end",stroke:"#151515"};
  commitBatch(editor,vault,[{op:"create",value:ink},{op:"create",value:wire},{op:"order",ids:["wire",...p.document.order,"pen"]},
    {op:"update",id:"qa-label",fields:{fontSize:17}},{op:"groups",members:{review:[a,b]}},{op:"theme",theme:"paper"}]);
  assert.equal(editor.doc.schemaVersion,5);assert.equal(editor.doc.flowGroups?.baseVersion,2);
  assert.equal(editor.doc.order[0],"wire");assert.equal(editor.history.past.length,1);
  assert.throws(()=>commitBatch(editor,vault,[update("member")]),{code:"CONFLICT"});
  commitBatch(editor,vault,[{...update("member"),group:"review"}]);
  editor.undo();editor.undo();assert.deepEqual(editor.doc,p.document);
});

const layoutGroup = {op:"layoutFlow",ids:["a","b"]};
const moveBranch = {op:"moveTopic",id:"mind-booking",topicId:"topic-booking",targetId:"topic-display",place:"child"};
function treeFixture() {
  const wire=JSON.parse(fixture("M5AG-Layer-Locks"));
  const topics=wire.document.objects["mind-booking"].topics;
  topics["topic-booking"].childIds=["detail"];
  topics.detail={id:"detail",text:"保留这个后代",childIds:["leaf"],collapsed:false};
  topics.leaf={id:"leaf",text:"叶子",childIds:[],collapsed:false,appearance:{fill:"#aabbcc"}};
  topics["topic-display"].collapsed=true;
  return JSON.stringify(wire);
}

test("disk CLI runs the UI flow layout and subtree move, then reopens equal group, routing, tree and asset data",t=>{
  const details=run(["capabilities"]).operationDetails;
  assert.deepEqual(details.layoutFlow.required,["ids"]);assert.deepEqual(details.moveTopic.required,["id","topicId","targetId","place"]);
  const file=join(temp(t),"layout.mgcanvas"),source=treeFixture();writeFileSync(file,source);
  const sourceProject=decodeProject(source), expected=new EditorSession(sourceProject.document,{zoom:1,offset:{x:0,y:0}});
  expected.select("a");
  assert.equal(layoutSelectedFlow(expected,new SceneProjection(expected.doc)).state,"applied");
  assert.ok(moveTopic(expected,{mapId:"mind-booking",topicId:"topic-booking"},{target:"topic-display",place:"child"}));
  const apply=["apply","--file",file,"--batch","-"], before=run(["inspect","--file",file]);
  const invalid={...moveBranch,targetId:"leaf"};
  assert.equal(run(apply,2,batch(before.revision,[layoutGroup,invalid])).code,"INVALID");
  assert.equal(readFileSync(file,"utf8"),source);
  const after=run(apply,0,batch(before.revision,[layoutGroup,moveBranch]));
  const saved=readFileSync(file,"utf8"), actual=decodeProject(saved);
  assert.deepEqual(JSON.parse(saved),JSON.parse(encodeProject(expected.doc,new AssetVault(sourceProject.assets))));
  for(const id of ["internal","cross","review-link"])assert.deepEqual(actual.document.objects[id],sourceProject.document.objects[id]);
  assert.deepEqual(actual.document.flowGroups,sourceProject.document.flowGroups);
  assert.deepEqual(actual.assets,sourceProject.assets);
  const rows: {id:string;parent:string|null;depth:number;collapsed:boolean}[]=run(["inspect","--file",file,"--map","mind-booking"]).data.topics;
  assert.equal(rows.find(r=>r.id==="topic-booking")?.parent,"topic-display");
  assert.equal(rows.find(r=>r.id==="leaf")?.depth,4);
  assert.equal(rows.find(r=>r.id==="topic-display")?.collapsed,false);
  assert.equal(run(apply,0,batch(after.revision,[layoutGroup,moveBranch],"noop")).changed,false);
  assert.equal(readFileSync(file,"utf8"),saved);
  for(const bad of [{...moveBranch,topicId:"topic-root"},invalid,{...moveBranch,targetId:"topic-root",place:"before"},
    {...moveBranch,targetId:"other-map-only"},{...moveBranch,place:"next"},{...moveBranch,side:"top"},
    {...layoutGroup,ids:["a","a"]},{...layoutGroup,ids:["unknown"]}]){
    run(apply,2,batch(after.revision,[bad],"invalid"));assert.equal(readFileSync(file,"utf8"),saved);
  }
});

test("each native command is one undo step and uses page locks, group scope and sibling order",()=>{
  const p=decodeProject(treeFixture()),e=new EditorSession(p.document,{zoom:1,offset:{x:0,y:0}}),vault=new AssetVault(p.assets);
  const original=e.doc;e.select("qa-picture");const selection=e.selectedIds;
  e.setLayerLocks(["target"],true);
  assert.throws(()=>commitBatch(e,vault,[layoutGroup]),{code:"CONFLICT"});
  assert.equal(e.doc,original);
  const inside={...layoutGroup,group:"group-intake"};
  assert.ok(commitBatch(e,vault,[inside]));assert.equal(e.history.revision,1);
  assert.deepEqual(e.selectedIds,selection);assert.equal(e.doc.objects.target,original.objects.target);
  e.undo();assert.equal(e.doc,original);e.redo();const placed=e.doc;
  assert.ok(commitBatch(e,vault,[moveBranch]));e.undo();assert.equal(e.doc,placed);e.redo();
  assert.equal(getMap(e,"mind-booking")?.topics["topic-display"].childIds[0],"topic-booking");
  const next={...moveBranch,targetId:"topic-display",place:"before",side:"left"};
  assert.ok(commitBatch(e,vault,[next]));
  const map=getMap(e,"mind-booking");assert.ok(map);
  assert.deepEqual(map.topics[map.rootId].childIds,["topic-booking","topic-display"]);
  assert.equal(map.topics["topic-booking"].side,"left");assert.deepEqual(map.topics.detail.childIds,["leaf"]);
  assert.equal(commitBatch(e,vault,[next]),false);
  assert.ok(commitBatch(e,vault,[{...next,place:"after"}]));
  assert.deepEqual(getMap(e,"mind-booking")?.topics["topic-root"].childIds,["topic-display","topic-booking"]);
  e.setLayerVisibility(["mind-booking"],false);
  assert.throws(()=>commitBatch(e,vault,[moveBranch]),{code:"CONFLICT"});
});

test("derived operations use staged obstacles and preceding tree changes and publish only the completed batch",()=>{
  const p=decodeProject(initial),e=new EditorSession(p.document,{zoom:1,offset:{x:0,y:0}}),vault=new AssetVault(p.assets),original=e.doc;
  const flow={op:"layoutFlow",ids:["flow-submit","flow-review"]};
  assert.throws(()=>commitBatch(e,vault,[flow]),{code:"CONFLICT"});
  const clear={op:"update",id:"mind-booking",fields:{origin:{x:320,y:-80}}};
  const cycle={...moveBranch,topicId:"topic-display",targetId:"topic-booking"};
  assert.throws(()=>commitBatch(e,vault,[clear,flow,moveBranch,cycle]),{code:"INVALID"});
  assert.equal(e.doc,original);assert.equal(e.history.revision,0);
  assert.ok(commitBatch(e,vault,[clear,flow,moveBranch]));assert.equal(e.history.past.length,1);
  const moved=e.doc,node=moved.objects["flow-review"];assert.ok(node.kind==="shape");assert.deepEqual(node.at,{x:-35,y:-127});
  e.undo();assert.equal(e.doc,original);e.redo();assert.equal(e.doc,moved);
});

const arrange=(command:string,ids:string[],group?:string)=>({op:"arrange",command,ids,...(group?{group}:{})});
const camera={offset:{x:0,y:0},zoom:1};
test("all twelve native disk arrangements match the page command and retain image bytes on reopen",t=>{
  const caps=run(["capabilities"]),schema=caps.operationDetails.arrange.inputSchema;
  assert.deepEqual(caps.operations.arrange,["command","ids","group"]);
  assert.deepEqual(schema.required,["op","command","ids"]);assert.equal(schema.additionalProperties,false);
  assert.deepEqual(new Set(schema.properties.command.enum),new Set(["left","center","right","top","middle","bottom","distribute-x","distribute-y","front","back","forward","backward"]));
  const source=fixture("M5AG-Layer-Locks"),project=decodeProject(source),file=join(temp(t),"arrange.mgcanvas");
  const ids=["qa-picture","open-path","sample-ink","standalone"];
  for(const command of arrangeCommands){
    const ui=new EditorSession(project.document,camera);
    ids.forEach((id,i)=>ui.select(id,i>0));
    const changed=arrangeSelection(ui,command);
    writeFileSync(file,source);
    const captured=run(["status","--file",file]);
    const result=run(["apply","--file",file,"--batch","-"],0,batch(captured.revision,[arrange(command,ids)]));
    assert.equal(result.changed,changed,command);
    assert.equal(result.results[0].changed,changed);assert.deepEqual(result.results[0].selectedIds,[...ui.selectedIds]);
    const reopened=decodeProject(readFileSync(file,"utf8"));
    assert.deepEqual(JSON.parse(readFileSync(file,"utf8")),JSON.parse(encodeProject(ui.doc,new AssetVault(project.assets))),command);
    assert.deepEqual(reopened.assets,project.assets);
  }
  let current=run(["status","--file",file]).revision;
  const layerToFront=arrange("front",["qa-picture"]);
  current=run(["apply","--file",file,"--batch","-"],0,batch(current,[layerToFront])).revision;
  const atFront=readFileSync(file);
  const repeated=run(["apply","--file",file,"--batch","-"],0,batch(current,[layerToFront]));
  assert.equal(repeated.changed,false);assert.equal(repeated.revision,current);
  assert.deepEqual(repeated.results[0].changedIds,[]);assert.deepEqual(readFileSync(file),atFront);
  const saved=readFileSync(file),rev=run(["status","--file",file]).revision;
  for(const [bad,code,exit] of [
    [arrange("diagonal",ids),"INVALID",2],[arrange("top",[]),"INVALID",2],[arrange("left",["a","a"]),"INVALID",2],
    [arrange("left",["absent","a"]),"NOT_FOUND",2],[arrange("distribute-x",["a","b"]),"CONFLICT",3],
    [arrange("top",["a","outside"],"group-intake"),"CONFLICT",3],
    [{...arrange("front",ids),all:true},"INVALID",2],
  ] as const){
    const reply=run(["apply","--file",file,"--batch","-"],exit,batch(rev,[{op:"update",id:"standalone",fields:{label:"rollback"}},bad]));
    assert.equal(reply.code,code);assert.deepEqual(readFileSync(file),saved);
  }
});
test("arrange reads staged group membership, movement and order without taking over the page selection",()=>{
  const p=decodeProject(initial),vault=new AssetVault(p.assets),e=new EditorSession(p.document,camera);
  e.select("qa-picture");const before=e.doc,first=before.objects["flow-submit"];assert.ok(first.kind==="shape");
  const r=executeBatch(e,vault,[
    {op:"create",value:{...first,id:"new",at:{x:-410,y:-95}}},
    {op:"groups",members:{group:["flow-submit","flow-review"]}},
    arrange("left",["new","flow-review"]),arrange("bottom",["flow-review","flow-submit"],"group"),
    arrange("back",["new"]),arrange("forward",["new"]),
    {op:"update",id:"new",fields:{label:"retained"}},
  ]);
  assert.equal(e.history.past.length,1);assert.deepEqual(e.selectedIds,["qa-picture"]);
  assert.deepEqual(new Set(r.results[0].selectedIds as string[]),new Set(["new","flow-review","flow-submit","flow-first"]));
  assert.deepEqual(r.results.map(row=>row.index),[2,3,4,5]);assert.equal(e.doc.order[1],"new");
  for(const id of ["flow-submit","flow-review"]){const item=e.doc.objects[id];assert.ok(item.kind==="shape");assert.equal(item.at.x,-410);assert.equal(item.at.y,-37);}
  const applied=e.doc;e.undo();assert.equal(e.doc,before);e.redo();assert.equal(e.doc,applied);
  assert.equal(executeBatch(e,vault,[arrange("bottom",["flow-submit","flow-review"],"group")]).changed,false);
  assert.equal(e.history.past.length,1);
});
test("native arrange matches visible group selection and refuses protected stack barriers before publishing earlier edits",()=>{
  const p=decodeProject(fixture("M5AG-Layer-Locks")),e=new EditorSession(p.document,camera),ui=new EditorSession(p.document,camera),vault=new AssetVault(p.assets);
  for(const model of [e,ui])model.setLayerVisibility(["b"],false);
  ui.select("a");ui.select("standalone",true);
  const before=e.doc;
  assert.throws(()=>executeBatch(e,vault,[arrange("front",["b"])]),{code:"CONFLICT"});
  e.setLayerLocks(["qa-picture"],true);
  const prior={op:"update",id:"standalone",fields:{label:"do not publish"}};
  assert.throws(()=>executeBatch(e,vault,[prior,arrange("front",["standalone"])]),{code:"CONFLICT"});
  e.setLayerLocks(["qa-picture"],false);e.setLayerVisibility(["qa-label"],false);
  assert.throws(()=>executeBatch(e,vault,[prior,arrange("front",["standalone"])]),{code:"CONFLICT"});
  e.setLayerVisibility(["qa-label"],true);
  e.setLayerLocks(["target"],true);
  assert.throws(()=>executeBatch(e,vault,[prior,arrange("left",["a","standalone"])]),{code:"CONFLICT"});
  assert.equal(e.doc,before);assert.equal(e.history.revision,0);
  e.setLayerLocks(["target"],false);
  const r=executeBatch(e,vault,[arrange("left",["a","standalone"])]);
  assert.equal(r.changed,arrangeSelection(ui,"left"));
  assert.deepEqual(r.results[0].selectedIds,ui.selectedIds);
  assert.deepEqual(e.doc,ui.doc);assert.deepEqual(e.doc.objects.b,before.objects.b);
});
test("native align moves free wires and equal-delta bound bends; an unselected locked wire refuses the entire batch",()=>{
  const wire=JSON.parse(initial),items=wire.document.objects;
  items["flow-display"].at.x=-355;
  Object.assign(items["flow-first"],{routing:"orthogonal",waypoints:[{x:-126,y:-60}]});
  items.free={...items["flow-first"],id:"free",from:{kind:"free",point:{x:5,y:170}},to:{kind:"free",point:{x:65,y:170}},waypoints:[{x:45,y:186}]};
  wire.document.order.push("free");
  const p=decodeProject(JSON.stringify(wire)),e=new EditorSession(p.document,camera),vault=new AssetVault(p.assets),before=e.doc;
  const ids=["flow-submit","flow-review","flow-display","free"];
  e.setLayerLocks(["flow-first"],true);
  assert.throws(()=>executeBatch(e,vault,[update("must roll back"),arrange("left",ids)]),{code:"CONFLICT"});
  assert.equal(e.doc,before);e.setLayerLocks(["flow-first"],false);
  const r=executeBatch(e,vault,[arrange("left",ids)]);
  assert.ok((r.results[0].changedIds as string[]).includes("flow-first"));
  const line=e.doc.objects["flow-first"],free=e.doc.objects.free;assert.ok(line.kind==="connector"&&free.kind==="connector");
  assert.deepEqual(line.waypoints,[{x:-276,y:-60}]);assert.deepEqual(line.from,items["flow-first"].from);assert.deepEqual(line.to,items["flow-first"].to);
  assert.deepEqual(free.from,{kind:"free",point:{x:-355,y:170}});
  assert.deepEqual(free.to,{kind:"free",point:{x:-295,y:170}});
  assert.deepEqual(free.waypoints,[{x:-315,y:186}]);
  assert.equal(e.history.past.length,1);e.undo();assert.equal(e.doc,before);
});


