import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { executeBatch } from "../features/board-commands.ts";
import { addDownstream } from "../features/flow-keyboard.ts";
import { AssetVault } from "../features/image-assets.ts";
import { getMap, topSide } from "../features/mindmap.ts";
import { createLiveCommands } from "../platform/live-commands.ts";
import { decodeProject } from "../platform/project.ts";
import { SceneProjection } from "../scene/projector.ts";
import { EditorSession } from "../session/editor.ts";

const initial=readFileSync(new URL("../docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas",import.meta.url),"utf8");
const update=(label:string)=>({op:"update",id:"flow-submit",fields:{label}});
const batch=(baseRevision:string,operations:unknown[])=>({operationId:"first",baseRevision,operations});
const mapId="mind-booking", rootId="topic-root";
const add=(topicId:string,relation:string,newId?:string,text?:string)=>({op:"addTopic",id:mapId,topicId,relation,newId,text});
const drop=(topicId:string)=>({op:"deleteTopic",id:mapId,topicId});
const layout=(layout:string)=>({op:"setMapLayout",id:mapId,layout});
const side=(topicId:string,side:string)=>({op:"setBranchSide",id:mapId,topicId,side});
const downstream=(nodeId?:string,connectorId?:string)=>({op:"addDownstream",id:"flow-submit",nodeId,connectorId});
function fresh(){
  const p=decodeProject(initial);
  return {e:new EditorSession(p.document,{zoom:1,offset:{x:0,y:0}}),vault:new AssetVault(p.assets)};
}
test("branch creation, direction, side and deletion follow the UI tree, editor text and one-step history",()=>{
  const {e,vault}=fresh(),original=e.doc;
  const first=executeBatch(e,vault,[layout("left"),add(rootId,"child","beta","Beta\r\n二"),
    add("beta","sibling","gamma",""),add("beta","child","discard"),add("discard","child","detail"),
    drop("discard"),side("gamma","right"),add("beta","child",undefined,"a".repeat(799)+"😀")]);
  const map=getMap(e,mapId)!;
  assert.ok(first.changed);assert.equal(e.history.past.length,1);
  assert.equal(map.layout,"balanced");assert.ok(map.topics[rootId].childIds.every(id=>topSide(map,id)===(id==="gamma"?"right":"left")));
  assert.deepEqual(first.results[5],{op:"deleteTopic",index:5,id:mapId,topicId:"discard",parentId:"beta",removedIds:["discard","detail"]});
  assert.equal(map.topics.beta.text,"Beta\n二");assert.equal(map.topics.gamma.text,"新主题");
  assert.equal(first.results[2].position,map.topics[rootId].childIds.indexOf("gamma"));
  const generated=first.results[7].topicId as string;
  assert.equal(map.topics.beta.childIds[0],generated);assert.equal(map.topics[generated].text,"a".repeat(799));
  assert.ok(!map.topics.discard&&!map.topics.detail);
  assert.deepEqual(executeBatch(e,vault,[side("gamma","right"),layout("balanced")]).results.map(x=>x.changed),[false,false]);
  const applied=e.doc;e.undo();assert.equal(e.doc,original);e.redo();assert.equal(e.doc,applied);
  const folded={op:"topic",id:mapId,topicId:"beta",fields:{collapsed:true}};
  executeBatch(e,vault,[folded,add("beta","child","expanded","x")]);assert.equal(getMap(e,mapId)!.topics.beta.collapsed,false);
});
test("downstream matches the page Tab command, stages occupied slots and keeps one transaction",()=>{
  const {e,vault}=fresh(),ui=fresh().e,source=ui.doc.objects["flow-submit"];assert.ok(source.kind==="shape");
  const projection=new SceneProjection(ui.doc);
  const uiLine=addDownstream(ui,source,area=>projection.query(area).some(hit=>ui.doc.objects[hit.id].kind!=="connector"))!;
  assert.ok(uiLine.to.kind==="anchor");
  const uiNode=ui.doc.objects[uiLine.to.objectId],original=e.doc;
  const applied=executeBatch(e,vault,[downstream("next","edge"),downstream()]);
  const [first,second]=applied.results;
  assert.equal(first.nodeId,"next");assert.equal(first.connectorId,"edge");
  assert.deepEqual(e.doc.objects.next,{...uiNode,id:"next"});
  assert.deepEqual(e.doc.objects.edge,{...uiLine,id:"edge",to:{...uiLine.to,objectId:"next"}});
  assert.notDeepEqual(first.at,second.at);assert.equal(e.doc.objects[second.nodeId as string].kind,"shape");
  assert.ok(e.doc.objects[second.connectorId as string]);assert.equal(e.history.past.length,1);
  e.undo();assert.equal(e.doc,original);e.redo();
  const grouped=executeBatch(e,vault,[{op:"groups",members:{pair:["next","flow-submit"]}},
    {...downstream("third","third-line"),group:"pair"}]);assert.equal(grouped.results[0].index,1);
  assert.deepEqual(e.doc.flowGroups?.members.pair,["next","flow-submit"]);
  assert.throws(()=>executeBatch(e,vault,[downstream()]),{code:"CONFLICT"});
});
test("invalid or protected structural targets roll back all earlier operations and retain original assets",()=>{
  const {e,vault}=fresh(),original=e.doc;
  for(const [bad,code] of [
    [add(rootId,"sibling","x"),"INVALID"],[add(rootId,"child","topic-booking"),"CONFLICT"],
    [add(rootId,"child","constructor"),"INVALID"],[drop(rootId),"INVALID"],[drop("missing"),"NOT_FOUND"],
    [layout("up"),"INVALID"],[side(rootId,"left"),"INVALID"],[side("topic-booking","up"),"INVALID"],
    [downstream("same","same"),"CONFLICT"],[downstream("asset-1"),"CONFLICT"],[downstream("x","flow-review"),"CONFLICT"],
    [{...downstream(),id:"qa-picture"},"INVALID"]] as const){
    assert.throws(()=>executeBatch(e,vault,[update("should roll back"),bad]),{code});
    assert.equal(e.doc,original);assert.equal(e.history.revision,0);
  }
  for(const protect of ["lock","hide"]){
    if(protect==="lock")e.setLayerLocks([mapId,"flow-submit"],true);else e.setLayerVisibility([mapId,"flow-submit"],false);
    for(const op of [drop("topic-booking"),add(rootId,"child"),layout("right"),downstream()]){
      assert.throws(()=>executeBatch(e,vault,[op]),{code:"CONFLICT"});
      assert.equal(e.doc,original);assert.equal(e.history.revision,0);
    }
    e.setLayerLocks([mapId,"flow-submit"],false);
  }
  assert.deepEqual(vault.assetIds(),["asset-1"]);
});
test("a fully occupied downstream search rejects earlier staged objects without changing history",()=>{
  const {e,vault}=fresh(),original=e.doc,source=original.objects["flow-submit"];
  assert.ok(source.kind==="shape");
  const blocker={...source,id:"block-all",at:{x:-20000,y:-20000},width:40000,height:40000,rotation:0};
  assert.throws(()=>executeBatch(e,vault,[{op:"create",value:blocker},downstream("node","wire")]),{code:"CONFLICT"});
  assert.equal(e.doc,original);assert.equal(e.history.past.length,0);
});
test("live receipts return original generated IDs and deletion results even after a later page edit",async()=>{
  const {e,vault}=fresh();
  const live=createLiveCommands({editor:e,vault,epoch:"proof",busy:()=>false,save:async()=>({diskRevision:"saved"})});
  const command=batch(live.status().revision,[add(rootId,"child"),drop("topic-booking"),downstream()]);
  const applied=await live.request("apply",command);
  executeBatch(e,vault,[update("page changed")]);
  const replay=await live.request("apply",command),receipt=await live.request("receipt",{operationId:"first"});
  assert.ok(replay.replayed);assert.notEqual(replay.revision,applied.appliedRevision);
  for(const r of [replay,receipt]){assert.equal(r.appliedRevision,applied.appliedRevision);assert.deepEqual(r.results,applied.results);}
  await assert.rejects(live.request("apply",{...command,operationId:"new-id"}),{code:"STALE"});
  await assert.rejects(live.request("apply",{...command,operations:[downstream()]}),{code:"ID_CONFLICT"});
  assert.equal(e.history.revision,2);
});
