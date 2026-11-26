import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AssetVault } from "../features/image-assets.ts";
import { createLiveCommands } from "../platform/live-commands.ts";
import type { BlockReason } from "../platform/live-commands.ts";
import { decodeProject } from "../platform/project.ts";
import { EditorSession } from "../session/editor.ts";

const source=readFileSync(new URL("../docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas",import.meta.url),"utf8");
function live(){
  const board=decodeProject(source),editor=new EditorSession(board.document,{zoom:1,offset:{x:0,y:0}});
  let reasons:BlockReason[]=[];
  const api=createLiveCommands({editor,vault:new AssetVault(board.assets),epoch:"a",busy:()=>reasons,
    focusedTopic:()=>({mapId:"mind-booking",topicId:"topic-root"}),save:async()=>({diskRevision:"disk"})});
  return {editor,request:api.request,block:(value:BlockReason[])=>{reasons=value;}};
}
test("edit-state reports IDs, explicit and inherited visibility, locks and no document fields",async()=>{
  const {editor,request}=live();editor.select("flow-submit");editor.setLayerLocks(["flow-submit"],true);
  const now=await request("edit-state");
  assert.deepEqual(now.selectedIds,["flow-submit"]);assert.deepEqual(now.focusedTopic,{mapId:"mind-booking",topicId:"topic-root"});
  assert.doesNotMatch(JSON.stringify(now),/提交预约|"label"|"text"|"document"/);
  const hidden=await request("set-layer",{id:"flow-submit",visible:false,stateRevision:now.stateRevision});
  assert.equal(hidden.revision,now.revision);assert.notEqual(hidden.stateRevision,now.stateRevision);
  assert.deepEqual(hidden.selectedIds,[]);assert.deepEqual(new Set(hidden.affectedIds as string[]),new Set(["flow-first","flow-submit"]));
  const line=await request("edit-state",{id:"flow-first"});
  assert.deepEqual(line.layers,[{id:"flow-first",locked:false,directlyHidden:false,hidden:true,hiddenBy:["flow-submit"],reasons:["HIDDEN_ENDPOINT"]}]);
  const shown=await request("set-layer",{id:"flow-first",visible:true,stateRevision:line.stateRevision});
  assert.equal(shown.changed,true);assert.ok(editor.isLocked("flow-submit"));assert.ok(!editor.isHidden("flow-submit"));
  assert.equal(editor.history.revision,0);assert.equal(editor.canUndo,false);assert.equal(editor.dirty,now.dirty);
});
test("explicit layer writes reject stale state, drafts and malformed fields before changing anything",async()=>{
  const {editor,request,block}=live();
  const state=await request("edit-state",{id:"flow-submit"});
  const args={stateRevision:state.stateRevision,id:"flow-submit",locked:true};
  for(const invalid of [{...args,id:""},{...args,visible:false},{...args,locked:"false"},{...args,other:true}]){
    await assert.rejects(request("set-layer",invalid),{code:"INVALID"});
  }
  await assert.rejects(request("edit-state",{id:"unknown"}),{code:"NOT_FOUND"});
  block(["INSPECTOR_DRAFT"]);const busy=await request("edit-state");
  assert.equal(busy.activeDraft,true);assert.deepEqual(busy.blockingReasons,["INSPECTOR_DRAFT"]);
  await assert.rejects(request("set-layer",args),{code:"BUSY"});assert.equal(editor.isLocked("flow-submit"),false);
  block(["INSPECTOR_FOCUS"]);assert.equal((await request("edit-state")).activeDraft,false);
  block([]);editor.setLayerVisibility(["qa-picture"],false);
  await assert.rejects(request("set-layer",args),{code:"STALE"});
  const next=await request("edit-state");const good=await request("set-layer",{...args,stateRevision:next.stateRevision});
  const noop=await request("set-layer",{...args,stateRevision:good.stateRevision});
  assert.equal(noop.changed,false);assert.equal(noop.stateRevision,good.stateRevision);
  await assert.rejects(request("set-layer",{...args,locked:false}),{code:"STALE"});assert.ok(editor.isLocked("flow-submit"));
  await assert.rejects(request("apply",{operationId:"implicit",baseRevision:state.revision,
    operations:[{op:"update",id:"flow-submit",fields:{label:"blocked"}}]}),{code:"CONFLICT"});
  assert.equal(editor.history.revision,0);
});
