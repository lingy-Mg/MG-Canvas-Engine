import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {contrastRatio} from "../platform/theme.ts";
import type {ShapeObject,TextObject,Connector,MindMap,BoardObject} from "../core/document.ts";
import {createHistory,dispatch,undo,redo} from "../core/history.ts";
import {layerTitle,layerName,layerPageIds,layerQuery,LayerSearch,pageOfLayer} from "../app/layer-search.ts";
import {layerSearchBoard,numberedLayers} from "./fixtures/layer-search.ts";

test("search starts with all 241 layers, then paginates the matches in original stacking order",()=>{
  const doc=layerSearchBoard(),search=new LayerSearch();
  assert.equal(search.list(doc,""),doc.order);
  assert.equal(layerPageIds(doc.order,0).length,180);
  assert.equal(pageOfLayer(doc.order,"s-0"),1);
  assert.equal(layerPageIds(doc.order,1).at(-1),"s-0");
  assert.deepEqual(search.list(doc,layerQuery("  会议步骤 0 ")),["s-0"]);
  const matches=search.list(doc,layerQuery(" reVIEW 东"));
  assert.deepEqual(layerPageIds(matches,0),["s-240","s-10"]);
  assert.equal(pageOfLayer(matches,"s-0"),-1);
  assert.deepEqual(search.list(doc,"absent"),[]);
  assert.equal(search.list(doc,layerQuery("  ")),doc.order);
});
test("names use the root, first text line and typed defaults, never internal IDs or hidden subtopics",()=>{
  const doc=layerSearchBoard(),shape=doc.objects["s-0"] as ShapeObject,link=doc.objects["l-6"] as Connector;
  const map=doc.objects["m-9"] as MindMap,line=doc.objects["t-8"] as TextObject;
  assert.equal(layerName({...shape,label:""}),"流程节点");assert.equal(layerName({...link,label:""}),"连接线");
  assert.equal(layerName(map),"会议管理");assert.equal(layerName({...line,text:"\n注释"}),"空文字");
  assert.equal(layerTitle({...line,text:"e"+"\u0301".repeat(110)}),"空文字");
  const first="文".repeat(99)+"👩‍💻"+"Cafe\u0301";
  const full={...line,text:first+"\n仅正文"};
  assert.equal(layerTitle(full),"文".repeat(99));assert.equal(layerName(full),first);
  for(const [kind,expected] of [["image","独立图片"],["path","矢量路径"],["ink","手写笔迹"]]){
    assert.equal(layerName({kind} as BoardObject),expected);
  }
  const withText={...doc,objects:{...doc.objects,[line.id]:full}},s=new LayerSearch();
  assert.deepEqual(s.list(withText,layerQuery("CAFÉ")),[line.id]);
  for(const missing of ["仅正文","预约设置","s-240"])assert.deepEqual(s.list(withText,missing),[]);
});
test("a name change, ordering, deletion, undo and replacement board update the same active query",()=>{
  const doc=layerSearchBoard(),s=new LayerSearch(),history=createHistory(doc),key="review";
  assert.deepEqual(s.list(history.doc,key),["s-10","s-240"]);
  const shape=history.doc.objects["s-0"] as ShapeObject;
  const rename=dispatch(history,{label:"rename",patches:[{op:"putObject",value:{...shape,label:"Review"}}]});
  assert.deepEqual(s.list(rename.state.doc,key,rename.changeSet),["s-0","s-10","s-240"]);
  const order=[...doc.order.slice(1),"s-0"];
  const sorted=dispatch(rename.state,{label:"reorder",patches:[{op:"setOrder",ids:order}]});
  assert.deepEqual(layerPageIds(s.list(sorted.state.doc,key,sorted.changeSet),0),["s-0","s-240","s-10"]);
  const removed=dispatch(sorted.state,{label:"remove",patches:[{op:"removeObject",id:"s-240"}]});
  assert.deepEqual(s.list(removed.state.doc,key,removed.changeSet),["s-10","s-0"]);
  const back=undo(removed.state),forward=redo(back.state);
  assert.deepEqual(s.list(back.state.doc,key,back.changeSet),["s-10","s-240","s-0"]);
  assert.deepEqual(s.list(forward.state.doc,key,forward.changeSet),["s-10","s-0"]);
  assert.deepEqual(s.list(numberedLayers(241),key),[]);
});
test("unchanged membership reuses the projection through movement and matching-label edits",()=>{
  const h=createHistory(layerSearchBoard()),s=new LayerSearch(),key="review",first=s.list(h.doc,key);
  const shape=h.doc.objects["s-10"] as ShapeObject;
  const moved=dispatch(h,{label:"move",patches:[{op:"putObject",value:{...shape,at:{x:-18,y:200}}}]});
  assert.equal(s.list(moved.state.doc,key,moved.changeSet),first);
  const renamed=dispatch(moved.state,{label:"rename",patches:[{op:"putObject",value:{...shape,label:"new review"}}]});
  assert.equal(s.list(renamed.state.doc,key,renamed.changeSet),first);
  assert.equal(s.list(renamed.state.doc,key),first);
});
test("20000 cached names are read once across queries and result pages stay bounded",()=>{
  const base=numberedLayers(20000);let reads=0;
  const objects=Object.fromEntries(base.order.map(id=>{
    const item=base.objects[id] as ShapeObject;return [id,{...item,get label(){reads++;return item.label;}}];
  }));
  const doc={...base,objects},s=new LayerSearch();
  assert.equal(s.list(doc,"").length,20000);assert.equal(reads,0);
  assert.equal(s.list(doc,"batch").length,20000);assert.equal(reads,20000);
  const ids=s.list(doc,"batch 00");assert.equal(ids.length,1000);
  assert.equal(layerPageIds(ids,0)[0],"s-999");assert.equal(layerPageIds(ids,1)[0],"s-819");
  assert.equal(layerPageIds(ids,5).length,100);assert.equal(layerPageIds(ids,6).length,0);
  assert.equal(s.list(doc,"batch 0000").length,10);assert.equal(reads,20000);
});
test("search is in the layers drawer, with responsive controls and legible light/dark theme tokens",()=>{
  const drawer=readFileSync(new URL("../app/react/LayersPanel.tsx",import.meta.url),"utf8");
  const css=readFileSync(new URL("../app/style.css",import.meta.url),"utf8");
  assert.match(drawer,/<Control as="aside" id="layers-panel"/);
  assert.match(drawer,/role="search"[\s\S]*id="layer-search-field"[\s\S]*id="layer-search-clear"[^>]*hidden/);
  assert.match(drawer,/id="layer-results"[^>]*role="status"/);
  assert.match(css,/\.layer-search-field\{[^}]*min-width:0/);
  assert.match(css,/\.layer-search input\{[^}]*height:32px[^}]*var\(--text\)[^}]*var\(--well\)/);
  assert.match(css,/@media\(max-width:760px\)\{\s*\.layer-search input\{[^}]*height:44px[^}]*font-size:16px\}\s*\.layer-search-clear\{width:44px;height:44px\}/);
  const palettes=[...css.matchAll(/:root(?:\[data-workspace-theme=dark\])?\{([^}]*)\}/g)];
  assert.equal(palettes.length,2);
  for(const [,block] of palettes){
    const token=Object.fromEntries([...block.matchAll(/--([\w-]+):(#[\da-f]+)/g)].map(([,name,color])=>[name,color]));
    for(const [fg,bg,min] of [["text","well",4.5],["muted","well",4.5],["secondary","surface",4.5],["focus","well",3]] as const){
      assert.ok((contrastRatio(token[fg],token[bg])??0)>=min,fg+" / "+bg);
    }
  }
});
