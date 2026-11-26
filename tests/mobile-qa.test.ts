import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveEndpoint } from "../core/document.ts";
import type { Endpoint } from "../core/document.ts";
import { screenToWorld,worldToScreen } from "../core/geometry.ts";
import { FlowInput } from "../features/flow-input.ts";
import { AssetVault } from "../features/image-assets.ts";
import { finishTopicDraft,getMap,topicDraft } from "../features/mindmap.ts";
import { topicEditKey } from "../features/plain-text.ts";
import { decodeProject,encodeProject } from "../platform/project.ts";
import { buildScene,hitTest } from "../scene/board.ts";
import { EditorSession } from "../session/editor.ts";

test("portable meeting-room QA board supports touch connection, topic edit, undo and image round trip",()=>{
  const fixture=decodeProject(readFileSync(new URL("../docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas",import.meta.url),"utf8"));
  const editor=new EditorSession(fixture.document,{offset:{x:180,y:190},zoom:.72});
  const uneditedMap=editor.doc.objects["mind-booking"];
  const flow=new FlowInput(editor,screen=>hitTest(buildScene(editor.doc),screenToWorld(screen,editor.camera),10/editor.camera.zoom));
  const from:Endpoint={kind:"anchor",objectId:"flow-review",portId:"south"};
  const to:Endpoint={kind:"anchor",objectId:"flow-display",portId:"north"};
  const screen=(tip:Endpoint)=>worldToScreen(resolveEndpoint(editor.doc,tip)!,editor.camera);
  flow.setMode("connect");
  for(const [id,endpoint] of [[1,from],[2,to]] as const){
    const point=screen(endpoint);
    assert(flow.down(id,"touch",point));assert(flow.up(id,point));
  }
  const line=editor.doc.objects[editor.selection!];
  assert(line.kind==="connector");assert.deepEqual([line.from,line.to],[from,to]);
  assert.strictEqual(editor.doc.objects["mind-booking"],uneditedMap);
  const draft=topicDraft(editor,{mapId:"mind-booking",topicId:"topic-root"},"child");
  assert(draft);
  const enter={key:"Enter",ctrlKey:false,metaKey:false,shiftKey:false,isComposing:false};
  assert.equal(topicEditKey(enter,true,false),undefined);
  assert.equal(topicEditKey(enter,false,true),undefined);
  assert(finishTopicDraft(editor,draft,"预约提醒"));
  assert.equal(getMap(editor,"mind-booking")?.topics[draft.topicId].text,"预约提醒");
  editor.undo();assert.equal(getMap(editor,"mind-booking")?.topics[draft.topicId],undefined);
  assert.strictEqual(editor.doc.objects[line.id],line);
  editor.redo();
  const reopened=decodeProject(encodeProject(editor.doc,new AssetVault(fixture.assets)));
  assert.deepEqual(reopened.document,{...editor.doc,objects:{...editor.doc.objects}});
  assert.equal(reopened.assets.length,1);
  assert.deepEqual(reopened.assets[0].bytes,fixture.assets[0].bytes);
});
