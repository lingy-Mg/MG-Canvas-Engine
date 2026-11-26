import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {MindMap,Topic} from "../core/document.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {withTopicAppearance,parentIndex,revealTopicPath,setTopicAppearance} from "../features/mindmap.ts";
import {layoutMap,topicAt,topicBox,topicTier} from "../features/mindmap-layout.ts";
import {MindMapInput} from "../features/mindmap-input.ts";
import {EditorSession} from "../session/editor.ts";

const raw=readFileSync(new URL("../docs/fixtures/M5AI-Topic-Tree.mgcanvas",import.meta.url),"utf8");
const doc=decodeProject(raw).document,map=doc.objects["booking-map"] as MindMap,ref={mapId:map.id,topicId:"dup-a"};
test("topic style planning validates nullable overrides, changes only the stable target and shares the immutable parent index",()=>{
  const parents=parentIndex(map),topic=map.topics[ref.topicId],style={...topic.appearance,width:52,strokeWidth:0,textColor:"#000000"};
  assert.equal(withTopicAppearance(map,"missing",style),undefined);assert.equal(withTopicAppearance(map,"toString",style),undefined);
  for(const invalid of [{width:NaN},{width:51.99},{width:196.01},{strokeWidth:-1},{strokeWidth:8.01},{stroke:"black"}])assert.equal(withTopicAppearance(map,ref.topicId,invalid),undefined);
  assert.equal(withTopicAppearance(map,ref.topicId,topic.appearance),map);
  assert.equal(withTopicAppearance(map,"root",{}),map);
  const next=withTopicAppearance(map,ref.topicId,style)!;assert.equal(parentIndex(next),parents);
  assert.deepEqual(next.topics[topic.id],{...topic,appearance:style});
  for(const id of Object.keys(map.topics))if(id!==topic.id)assert.equal(next.topics[id],map.topics[id]);
  assert.equal(next.topics[topic.id].childIds,topic.childIds);
  const e=new EditorSession(doc);assert(setTopicAppearance(e,ref,style));assert(!setTopicAppearance(e,ref,style));
  assert.equal(e.history.past.length,1);assert.equal((e.doc.objects[map.id] as MindMap).topics.desk.collapsed,true);
  e.undo();assert.equal(encodeProject(e.doc,new AssetVault()),raw);
});
test("revealed topic preview supplies the exact picked and selected box while pointer movement keeps the committed map",()=>{
  const e=new EditorSession(doc,{zoom:1,offset:{x:0,y:0}}),committed=e.doc,source=committed.objects[map.id] as MindMap;let shown:MindMap|undefined;
  const mind=new MindMapInput(e,()=>map.id,()=>{},()=>shown);assert(mind.focus(map.id,ref.topicId,true));
  const canonical=mind.displayMap(source),next=withTopicAppearance(source,ref.topicId,{width:196})!;
  shown=mind.displayMap(next);const row=topicBox(shown,ref.topicId)!,b=row.box,p={x:b.at.x+(row.side==="right"?b.width-7:7),y:b.at.y+b.height/2};
  assert.equal(topicAt(canonical,p),undefined);assert.deepEqual(mind.decor().selected,b);
  assert.deepEqual(mind.at(p),ref);assert(mind.down(9,"pen",p));assert.equal(mind.pointer?.map,source);
  shown=undefined;mind.cancelPointer();assert.equal(mind.at(p),undefined);assert.deepEqual(mind.decor().selected,topicBox(canonical,ref.topicId)!.box);
  assert.equal(next.topics.desk.collapsed,true);assert.equal(revealTopicPath(next,ref.topicId).topics.desk.collapsed,false);
  assert.equal(e.doc,committed);assert.equal(e.history.past.length,0);
});
test("cached topic measurements follow root type, metric surface, text and width without remeasuring unchanged branches",()=>{
  const saved=Object.getOwnPropertyDescriptor(globalThis,"document");
  const surface=(width:number)=>{
    let count=0;
    const ctx={font:"",measureText(t:string){count++;return {width:[...t].length*width};}};
    Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>({getContext:()=>ctx})}});
    return ()=>count;
  };
  try{
    const measure=surface(12);const topics:Record<string,Topic>={root:{id:"root",text:"Root",childIds:[],collapsed:false}};
    const kids=Array.from({length:500},(_,i)=>"t"+i);topics.root={...topics.root,childIds:kids};
    for(const id of kids)topics[id]={id,text:"会议 "+id,childIds:[],collapsed:false};
    const wide={...map,topics,rootId:"root"};assert.equal(layoutMap(wide).length,501);
    assert(measure()>500);const original=measure(),changed=withTopicAppearance(wide,"t0",{width:52})!;
    const row=topicBox(changed,"t0")!;assert.equal(row.box.width,52);assert(row.lines.length>1);assert(measure()-original<24);
    const warm=measure();assert.equal(layoutMap(changed),layoutMap(changed));assert.equal(measure(),warm);
    const promoted=topicBox({...wide,topics:{t0:topics.t0},rootId:"t0"},"t0")!;
    assert.equal(promoted.fontSize,topicTier(0).fontSize);assert(promoted.fontSize>row.fontSize);
    assert(measure()>warm);const other=surface(27),remeasured=topicBox(wide,"t1")!;
    assert(other()>500);assert(remeasured.box.width>84);const before=other();
    const rename={...wide,topics:{...topics,t1:{...topics.t1,text:"新"}}};assert.equal(topicBox(rename,"t1")!.box.width,84);assert(other()-before<10);
  }finally{if(saved)Object.defineProperty(globalThis,"document",saved);else Reflect.deleteProperty(globalThis,"document");}
});
