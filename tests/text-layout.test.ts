import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {BoardDocument,MindMap,TextObject} from "../core/document.ts";
import {localToWorld} from "../core/geometry.ts";
import {captureClipboard,decodeClipboard,encodeClipboard} from "../features/clipboard.ts";
import {AssetVault} from "../features/image-assets.ts";
import {finishTopicDraft,topicDraft,withTopicInput} from "../features/mindmap.ts";
import {layoutMap,topicAt,topicBox} from "../features/mindmap-layout.ts";
import {plainText,textHeight,wrapPlainText} from "../features/plain-text.ts";
import {saveText} from "../features/standalone.ts";
import {boundedTextEdit,estimatedTextWidth,graphemePrefix,textRows} from "../features/text-layout.ts";
import {limitTextInput} from "../app/text-editor.ts";
import {encodeProject,decodeProject} from "../platform/project.ts";
import {centeredNodeRuns,nodeTextRows} from "../renderers/canvas2d/node-text.ts";
import {buildScene,hitTest} from "../scene/board.ts";
import {SceneProjection} from "../scene/projector.ts";
import {EditorSession} from "../session/editor.ts";
import {textWidthGrip} from "../session/text-width.ts";

const raw=readFileSync(new URL("../docs/fixtures/M5Y-Text-Layout.mgcanvas",import.meta.url),"utf8");
const board=decodeProject(raw).document,vault=new AssetVault(),bytes=(d:BoardDocument)=>encodeProject(d,vault);
const seg=new Intl.Segmenter("zh",{granularity:"grapheme"});
const split=(s:string)=>Array.from(seg.segment(s),part=>part.segment);
const camera={offset:{x:0,y:0},zoom:1},editor=(d=board)=>new EditorSession(d,camera);
const text=(d:BoardDocument,id:string)=>d.objects[id] as TextObject;
const map=board.objects.map as MindMap;
function withTopic(id:string,value:string,width=78):MindMap{
  const original=map.topics[id];
  return {...map,topics:{...map.topics,[id]:{...original,text:value,appearance:{...original.appearance,width}}}};
}
const metrics=(width:number)=>({width,actualBoundingBoxLeft:width/2,actualBoundingBoxRight:width/2,actualBoundingBoxAscent:11,actualBoundingBoxDescent:3});
const metric=(s:string)=>metrics(split(s).length*16);
const cases:[string,number,string[]][]=[
  ["审批（复核）",48,["审批","（复","核）"]],["审批通过，归档",64,["审批通","过，归档"]],
  ["👩‍💻 ok",32,["👩‍💻 ","ok"]],["Cafe\u0301",40,["Cafe\u0301"]],
];

test("four frozen regressions retain source UTF-16 and have concrete new display rows at font size 16",()=>{
  for(const [value,width,expected] of cases){
    const rows=wrapPlainText(value,width,16);assert.deepEqual(rows,expected);assert.equal(rows.join(""),value);
    assert.equal(textHeight(value,width,16),Math.ceil(expected.length*16*1.4));
  }
  assert.equal(estimatedTextWidth("e\u0301",16),estimatedTextWidth("e",16));
  assert.equal(estimatedTextWidth("👩🏽‍💻",16),16);assert.equal(estimatedTextWidth("1️⃣",16),16);
});
test("grapheme boundaries and UTF-16 cuts agree for ZWJ, emoji modifier, flag, keycap, Indic, Hangul and variation selectors",()=>{
  const glyphs=["👩🏽‍💻","🇨🇳","1️⃣","e\u0301","葛\u{E0100}","क्‍ष","한"];
  for(const glyph of glyphs){
    const original="甲"+glyph+"乙";assert.deepEqual(wrapPlainText(original,1,16),["甲",glyph,"乙"]);
    const allowed=["","甲","甲"+glyph,original];
    for(let budget=0;budget<=original.length+1;budget++)assert.equal(graphemePrefix(original,budget),allowed.filter(s=>s.length<=budget).at(-1));
  }
  assert.equal(plainText("x".repeat(11999)+"e\u0301"),"x".repeat(11999));
});
test("Chinese open and close punctuation obey feasible margins, with bounded emergency progress and explicit empty lines",()=>{
  for(const opener of "（《〈【「『〔［｛“‘"){
    const s="甲乙"+opener+"丙丁",rows=wrapPlainText(s,48,16);assert.equal(rows[0],"甲乙");assert.equal(rows.join(""),s);
  }
  for(const closer of "），。、！？；：》〉】」』〕］｝”’…"){
    const s="甲乙丙丁"+closer+"戊",rows=wrapPlainText(s,64,16);assert.equal(rows[0],"甲乙丙");assert.equal(rows.join(""),s);
  }
  assert.deepEqual(wrapPlainText("甲，",1,16),["甲","，"]);assert.deepEqual(wrapPlainText("👩‍💻",2,20),["👩‍💻"]);
  assert.deepEqual(wrapPlainText("\r\n A\r\rB \n",200,16),[""," A","","B ",""]);
  const repeated="（".repeat(140)+"，".repeat(160);const rows=wrapPlainText(repeated,160,16);
  assert.equal(rows.join(""),repeated);assert(rows.every(s=>s.length>0&&s.length<=10));
});
test("standalone text takes the last available CJK boundary and keeps whole Latin words and trailing spaces",()=>{
  const opts={measure:(s:string)=>split(s).length,wordWrap:true};
  assert.deepEqual(textRows("A9 测试中文换行",6,1,opts),["A9 测试中","文换行"]);
  assert.deepEqual(textRows("甲乙 Canvas 2026",7,1,opts),["甲乙 ","Canvas ","2026"]);
  assert.deepEqual(textRows("画布ABCD（版本）",5,1,opts),["画布","ABCD","（版本）"]);
  assert.deepEqual(textRows("Canvas 2026",6,1,opts),["Canvas ","2026"]);
  assert.deepEqual(textRows("A     中",1,1,opts),["A     ","中"]);
});
test("flow wrapping preserves real shaped-run advance and ink overhang, optical centering, strict cap and blank rows",()=>{
  assert.deepEqual(nodeTextRows(cases[0][0],48,8,metric),cases[0][2]);
  assert.deepEqual(nodeTextRows(cases[1][0],64,8,metric),cases[1][2]);
  const kerning=(s:string)=>metrics(s==="AV"?15:split(s).length*12);
  assert.deepEqual(nodeTextRows("AVA",16,4,kerning),["AV","A"]);
  const overhang=(s:string)=>({...metrics(s.length*5),actualBoundingBoxLeft:s.length*7,actualBoundingBoxRight:s.length*7});
  assert.deepEqual(nodeTextRows("abc",24,4,overhang),["a","b","c"]);
  const large=(s:string)=>metrics(s.includes("👩")?60:split(s).length*8);
  assert.deepEqual(nodeTextRows("👩‍💻",16,2,large),["…"]);assert.deepEqual(nodeTextRows("👩‍💻",2,2,large),[]);
  assert.deepEqual(nodeTextRows("\n甲\n\n乙\n",42,10,metric),["","甲","","乙",""]);
  const one=centeredNodeRuns(["甲"],16,20,metric)[0],before=centeredNodeRuns(["","甲"],16,20,metric)[0];
  assert.equal(before.baseline-one.baseline,10);
});
test("long measured paragraphs use row-local probes and preserve the entire grapheme stream",()=>{
  const value="审批（复核），👩‍💻Cafe\u0301 ".repeat(600);let calls=0,total=0,largest=0;
  const measured=(s:string)=>{calls++;total+=s.length;largest=Math.max(largest,s.length);return split(s).length*16;};
  const rows=textRows(value,48,16,{measure:measured});assert.equal(rows.join(""),value);
  assert(rows.length>2000);assert(calls<value.length*3);assert(total<value.length*16);assert(largest<=24);
  assert.deepEqual(rows.flatMap(split),split(value));
  const stable=wrapPlainText("甲".repeat(12000),16,16);assert.equal(stable.length,12000);assert(stable.every(s=>s==="甲"));
});
test("fixed topic widths keep all explicit and wrapped rows, and oversized imported text elides only whole clusters",()=>{
  const lines=(s:string,width=78)=>layoutMap(withTopic("root",s,width))[0].lines;
  assert.deepEqual(lines("甲\n\n乙\n丙\n丁\n👩‍💻\n完整"),["甲","","乙","丙","丁","👩‍💻","完整"]);
  assert.deepEqual(lines("甲\n乙\n丙\n丁\n戊\n👩‍💻🇨🇳中\n末",52),["甲","乙","丙","丁","戊","👩‍💻","🇨🇳","中","末"]);
  assert.deepEqual(lines("A"+"\u0301".repeat(800)),["…"]);
  assert.deepEqual(lines("x"+"\u0301".repeat(798)+"e\u0301"),["x"+"\u0301".repeat(798)+"…"]);
  const value="行\n".repeat(5)+"Cafe\u0301\n其余";const edited=withTopic("root",value);assert.deepEqual(layoutMap(edited)[0].lines,value.split("\n"));
  assert.equal(edited.topics.root.text,value);
});
test("scene projection and topic hit layout share the same row plan and keep the complete stored label",()=>{
  const scene=buildScene(board).find(s=>s.id==="map")!,layout=layoutMap(map);
  for(const record of layout){
    const primitive=scene.items.find(i=>i.kind==="nodeLabel"&&i.topicId===record.topic.id);assert(primitive?.kind==="nodeLabel");
    assert.strictEqual(primitive.rows,record.lines);assert.equal(primitive.text,record.topic.text);
    const pt={x:map.origin.x+record.box.at.x+record.box.width/2,y:map.origin.y+record.box.at.y+record.box.height/2};
    assert.equal(topicAt(map,pt)?.topicId,record.topic.id);assert.equal(hitTest([scene],pt,0),map.id);
  }
  assert.strictEqual(layoutMap(map),layout);
});
test("automatic topic widths grow through draft, commit and reopen with clearance for adjacent columns on either side",()=>{
  const number="123123123123123123123123",chinese="预约审核部门".repeat(9),mixed="预约A1234567890复核".repeat(5);
  for(const layout of ["left","right"] as const)for(const scale of [.5,1,2]){
    const topics={root:{id:"root",text:"根",childIds:["a"],collapsed:false},
      a:{id:"a",text:"数字",childIds:["b"],collapsed:false},b:{id:"b",text:mixed,childIds:[],collapsed:false}};
    const initial={...map,rootId:"root",layout,scale,topics},doc={...board,objects:{...board.objects,map:initial}};
    const e=editor(doc),committed=e.doc,draft=topicDraft(e,{mapId:initial.id,topicId:"a"})!,old=topicBox(initial,"a")!;
    const value=number+"\n\n"+chinese+"\n",preview=withTopicInput(draft.map,"a",value,false);
    const a=topicBox(preview,"a")!,b=topicBox(preview,"b")!,root=topicBox(preview,"root")!;
    assert.deepEqual(a.lines,[number,"",chinese,""]);assert.deepEqual(b.lines,[mixed]);
    assert(a.box.width>old.box.width&&a.box.height>old.box.height);
    const ordered=layout==="left"?[b,a,root]:[root,a,b];
    for(let i=1;i<ordered.length;i++)assert(ordered[i].box.at.x>ordered[i-1].box.at.x+ordered[i-1].box.width);
    assert.strictEqual(e.doc,committed);assert.equal(e.history.past.length,0);
    assert(finishTopicDraft(e,draft,value));assert.equal(e.history.past.length,1);
    const reopened=decodeProject(bytes(e.doc)).document.objects.map as MindMap;
    assert.deepEqual(topicBox(reopened,"a"),a);assert.deepEqual(topicBox(reopened,"b"),b);
    assert.equal(reopened.topics.a.appearance?.width,undefined);e.undo();assert.deepEqual(topicBox(e.doc.objects.map as MindMap,"a"),old);
  }
});
test("theme title edits preserve edge spaces, hard breaks and blank lines; returning to an oversized imported value writes no history",()=>{
  const value=" 甲\n\n👩‍💻\n ",e=editor(),draft=topicDraft(e,{mapId:"map",topicId:"root"});assert(draft);
  assert(finishTopicDraft(e,draft,value));const changed=bytes(e.doc);
  assert.equal((e.doc.objects.map as MindMap).topics.root.text,value);assert.equal((decodeProject(changed).document.objects.map as MindMap).topics.root.text,value);
  e.undo();assert.equal(bytes(e.doc),bytes(board));e.redo();assert.equal(bytes(e.doc),changed);
  const over="甲".repeat(799)+"👩‍💻",long=withTopic("root",over);
  const file={...board,objects:{...board.objects,map:long}},legacy=editor(file),again=topicDraft(legacy,{mapId:"map",topicId:"root"});assert(again);
  assert(!finishTopicDraft(legacy,again,over));assert.equal(bytes(legacy.doc),bytes(file));assert.equal(legacy.history.past.length,0);
  const capped=topicDraft(e,{mapId:"map",topicId:"root"});assert(capped&&finishTopicDraft(e,capped,over));
  assert.equal((e.doc.objects.map as MindMap).topics.root.text,"甲".repeat(799));
});
test("pointer reflow preview, committed scene, history, clipboard and project reopen use the same intact text",()=>{
  const e=editor(),a=text(e.doc,"approval"),origin=bytes(e.doc);e.select(a.id);
  const start=textWidthGrip(a,camera,"right").center,end={x:start.x-48,y:start.y};
  e.down(1,"mouse",start,a.id,false,false,{id:a.id,textEdge:"right"});e.move(1,end);
  const label=(s:ReturnType<typeof buildScene>)=>{const block=s.find(g=>g.id===a.id)!.items[0];assert(block.kind==="textBlock");return block;};
  assert(e.preview);const before=label(buildScene(e.doc,e.preview));
  assert.deepEqual(before.lines,cases[0][2]);assert.equal(bytes(e.doc),origin);
  const clip=decodeClipboard(encodeClipboard(captureClipboard(e.doc,[a.id],vault)!))!;assert.equal(text(clip.document,a.id).width,96);
  e.up(1,end);assert.deepEqual(label(buildScene(e.doc)),before);assert.equal(e.history.past.length,1);const after=bytes(e.doc);
  assert.equal(text(e.doc,a.id).text,a.text);assert.deepEqual(label(buildScene(decodeProject(after).document)),before);
  e.undo();assert.equal(bytes(e.doc),origin);e.redo();assert.equal(bytes(e.doc),after);
});
test("visible reflow below an old fitted frame is indexed and hittable including rotation; fixed frames clip it",()=>{
  for(const rotation of [0,.6])for(const fixed of [true,false]){
    const item={...text(board,"approval"),at:{x:16,y:460},width:48,height:45,rotation,...(fixed?{heightMode:"fixed" as const}:{})};
    const doc={...board,objects:{[item.id]:item},order:[item.id]},projector=new SceneProjection(doc);
    const at=localToWorld({x:24,y:60},item),window={min:{x:at.x-1,y:at.y-1},max:{x:at.x+1,y:at.y+1}};
    assert.equal(hitTest(projector.query(window),at,0),fixed?undefined:item.id);
    const block=buildScene(doc)[0].items[0];assert(block.kind==="textBlock");assert.equal(Boolean(block.clip),fixed);
    assert.equal(block.box.height,fixed?45:68);
    assert.equal(text(decodeProject(bytes(doc)).document,item.id).height,45);
  }
});
test("a full input keeps the previous suffix and selected text when an inserted grapheme cannot fit",()=>{
  assert.equal(boundedTextEdit("abcXYZ","abc👩‍💻XYZ",8),"abcXYZ");
  assert.equal(boundedTextEdit("abQ尾","ab👩‍💻尾",4),"abQ尾");
  assert.equal(boundedTextEdit("abQ尾","abA👩‍💻尾",5),"abA尾");
  assert.equal(boundedTextEdit("👩尾","👩‍💻尾",3),"👩尾");
  assert.equal(boundedTextEdit("e尾","e\u0301尾",2),"e尾");
  const orig="a".repeat(798)+"终点",m=withTopic("root",orig),e=editor({...board,objects:{...board.objects,map:m}});
  const draft=topicDraft(e,{mapId:"map",topicId:"root"});assert(draft);
  assert(!finishTopicDraft(e,draft,"a".repeat(798)+"👩‍💻终点"));assert.equal((e.doc.objects.map as MindMap).topics.root.text,orig);
  assert.equal(e.history.past.length,0);
});
test("native text limit defers during composition and removes only a full overflowing paste or composition cluster",()=>{
  const handlers=new Map<string,(evt:object)=>void>();let cut=0;
  const input={value:"",addEventListener:(name:string,fn:(evt:object)=>void)=>handlers.set(name,fn),
    setRangeText(replacement:string,start:number,end:number){cut++;this.value=this.value.slice(0,start)+replacement+this.value.slice(end);}};
  limitTextInput(input as unknown as HTMLTextAreaElement,4);
  input.value="abc👩‍💻";handlers.get("compositionstart")!({});handlers.get("input")!({isComposing:true});assert.equal(cut,0);
  handlers.get("compositionend")!({});assert.equal(input.value,"abc");assert.equal(cut,1);
  input.value="ab e\u0301";handlers.get("input")!({});assert.equal(input.value,"ab ");assert.equal(cut,2);
  input.value="e\u0301";handlers.get("input")!({});assert.equal(cut,2);
  const over={...text(board,"accent"),text:"x".repeat(11999)+"👩‍💻"},d={...board,objects:{...board.objects,accent:over}};
  const e=editor(d);assert(!saveText(e,e.generation,text(e.doc,"accent"),over.text));assert.equal(bytes(e.doc),bytes(d));
});
