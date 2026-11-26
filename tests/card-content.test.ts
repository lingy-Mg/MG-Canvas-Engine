import {test} from "node:test";
import assert from "node:assert/strict";
import {assertDocument,isCard,resolveEndpoint} from "../core/document.ts";
import {formatMarkdown,markdownState} from "../features/markdown-format.ts";
import {validCardStyle} from "../core/card.ts";
import {cardBlocks,cardInk,cardLayout,cardOffsetAt,hasMarkdown,newCard} from "../features/card-content.ts";
import {captureClipboard,decodeClipboard,encodeClipboard,pasteClipboard} from "../features/clipboard.ts";
import {shapePorts} from "../features/flow.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {buildScene} from "../scene/board.ts";
import {EditorSession} from "../session/editor.ts";
import {demo} from "../app/demo.ts";

const source=["# 会议简报","","中文与 **粗体**、[链接](https://example.com)","- 项目一","2. 第二项","> 引用","```js","const n = 123;","```"].join("\n");
test("Markdown offsets, rich runs, visible blocks and measured wraps preserve authored source",()=>{
  const item=newCard("markdown",{x:4,y:7},"\uFEFF"+source.replaceAll("\n","\r\n"));
  assert.equal(item.label,source);
  const blocks=cardBlocks(item.label);assert.deepEqual(blocks.map(b=>b.kind),["heading","space","paragraph","list","list","quote","code"]);
  assert.equal(blocks.map(b=>source.slice(b.start,b.end)).join("\n"),source);
  assert(blocks[2].runs.some(r=>r.bold&&r.text==="粗体"));assert(blocks[2].runs.some(r=>r.link==="https://example.com"));
  const rich=cardLayout(item);assert(rich.glyphs.some(r=>r.link));assert.equal(rich.bands.length,2);assert(item.height>=rich.height);
  const long={...item,label:"## 跟进\n"+"数据 1234567890 会议 ".repeat(35)};
  assert(cardLayout({...long,width:180}).height>cardLayout(long).height);
  assert(!validCardStyle({...item.content,fontSize:-1}));assert(!validCardStyle({...item.content,color:"red"}));
});

test("both card types round-trip, structurally copy, move and undo with live rectangle ports",()=>{
  const editor=new EditorSession(demo),vault=new AssetVault();
  const doc=newCard("markdown",{x:10,y:15},source),note=newCard("sticky",{x:90,y:130},"便签第一行\n明天继续");
  assert(editor.commitEdit({label:"放置",patches:[{op:"putObject",value:doc},{op:"putObject",value:note}]},editor.generation,[doc.id,note.id]));
  const before=editor.doc,wire=encodeProject(before,vault);assertDocument(JSON.parse(wire).document);
  assert.deepEqual(decodeProject(wire).document,JSON.parse(JSON.stringify(before)));assert.deepEqual(decodeProject(encodeProject(demo,vault)).document,demo);
  for(const item of [doc,note]){
    assert.equal(shapePorts(item).length,4);
    for(const p of shapePorts(item))assert.deepEqual(resolveEndpoint(before,p.end),p.point);
    const group=buildScene(before,undefined,[item.id])[0];assert(group.items.some(p=>p.kind==="cardText"));assert(!group.items.some(p=>p.kind==="nodeLabel"));
  }
  const fragment=captureClipboard(before,[doc.id,note.id],vault)!;
  assert(pasteClipboard(editor,vault,decodeClipboard(encodeClipboard(fragment)),{anchor:{x:700,y:100}}));
  for(const id of editor.selectedIds){const item=editor.doc.objects[id];assert(isCard(item));assert([source,note.label].includes(item.label));assert(![doc.id,note.id].includes(id));}
  const pasted=editor.doc;editor.undo();assert.strictEqual(editor.doc,before);editor.redo();assert.strictEqual(editor.doc,pasted);
});

test("sticky text preserves literal Markdown and empty rows, with ink chosen from the painted background",()=>{
  const label="# 标题\n\n**数字123**\n- 中文",note=newCard("sticky",{x:0,y:0},label);
  const layout=cardLayout(note);
  assert.equal(layout.blocks.length,4);
  assert.equal(layout.glyphs.map(g=>g.text).join(""),label.replaceAll("\n",""));
  assert(layout.glyphs.every(g=>!g.marker&&!g.link&&g.size===note.content.fontSize));
  const legacy={...note,content:{...note.content,color:"#141414"}};
  assert.notEqual(cardInk({...legacy,fill:"#242424"},"light"),cardInk({...legacy,fill:"#fafafa"},"dark"));
  assert.equal(hasMarkdown("普通文字\n123\nroom_booking_id"),false);assert(hasMarkdown(label));
});

test("painted graphemes map back into original nested Markdown and list syntax",()=>{
  const doc=newCard("markdown",{x:0,y:0},"## 标题\n1) __粗体 [入口](https://example.org)__\n\n`行内`");
  const layout=cardLayout(doc),g=layout.glyphs.find(g=>g.text==="入口")!;
  assert.equal(cardOffsetAt(doc,{x:g.x+.1,y:g.baseline-g.size*.3},true),doc.label.indexOf("入口"));
  assert.equal(cardOffsetAt(doc,{x:g.x+g.width-.1,y:g.baseline-g.size*.3},true),doc.label.indexOf("入口")+2);
  assert.equal(cardOffsetAt(doc,{x:doc.width-2,y:g.baseline},true),undefined);
  for(const glyph of layout.glyphs.filter(g=>!g.marker))assert.equal(doc.label.slice(glyph.at,glyph.at+glyph.text.length),glyph.text);
});

test("Markdown paragraph actions preserve the source selection, indentation and fenced code",()=>{
  const source="## 会议\n  - 任务\n保留正文\n\x60\x60\x60js\n原文\n\x60\x60\x60";
  const r={start:source.indexOf("会议"),end:source.indexOf("任务")+2};
  const edit=formatMarkdown(source,r,{block:"number"})!;
  assert.equal(edit.source,"1. 会议\n  2. 任务\n保留正文\n\x60\x60\x60js\n原文\n\x60\x60\x60");
  assert.equal(edit.source.slice(edit.start,edit.end),"会议\n  2. 任务");
  assert.equal(markdownState(edit.source,{start:edit.start,end:edit.start}).block,"number");
  const code=source.indexOf("原文");assert.equal(formatMarkdown(source,{start:code,end:code+2},{mark:"bold"}),undefined);
});
test("inline toggles preserve surrounding glyphs and combine emphasis on the selected substring only",()=>{
  const source="混排 Ab中文与 \x60code\x60 及 [参考](https://example.org)";
  const at=source.indexOf("Ab"),bold=formatMarkdown(source,{start:at,end:at+4},{mark:"bold"})!;
  const italic=formatMarkdown(bold.source,{start:bold.start+1,end:bold.end},{mark:"italic"})!;
  const flags=(s:string)=>cardBlocks(s).flatMap(b=>b.runs).flatMap(r=>[...r.text].map(c=>[c,!!r.bold,!!r.italic]));
  const chars=flags(italic.source);
  assert.equal(chars.map(v=>v[0]).join(""),"混排 Ab中文与 code 及 参考");
  assert.deepEqual(chars.slice(3,7),[["A",true,false],["b",true,true],["中",true,true],["文",true,true]]);
  assert.equal(markdownState(italic.source,italic).italic,true);
  const withoutBold=formatMarkdown(italic.source,italic,{mark:"bold"})!;
  assert.deepEqual(flags(withoutBold.source).slice(3,7),[["A",true,false],["b",false,true],["中",false,true],["文",false,true]]);
  const reverse=formatMarkdown(source,{start:at,end:at+4},{mark:"italic"})!;
  const inWord=formatMarkdown(reverse.source,{start:reverse.start+1,end:reverse.end-1},{mark:"bold"})!;
  assert.deepEqual(flags(inWord.source).slice(3,7),[["A",false,true],["b",true,true],["中",true,true],["文",false,true]]);
});
test("links use the selected text or caret, keep existing markup and expose the resulting range",()=>{
  const spaced=formatMarkdown("甲 ab 乙",{start:1,end:5},{mark:"bold"})!;
  assert.equal(spaced.source,"甲 **ab** 乙");assert.equal(markdownState("plain",{start:2,end:2}).canMark,false);
  const mixed="[A **B** C](https://old.test)";
  assert.equal(formatMarkdown(mixed,{start:1,end:mixed.indexOf("C")+1},{link:"https://new.test"})?.source,mixed.replace("old.test","new.test"));
  const source="一 [**说明**](https://old.test) 二";
  const at=source.indexOf("说明");
  const edit=formatMarkdown(source,{start:at,end:at+2},{link:"https://new.test"})!;
  assert.equal(edit.source,source.replace("old.test","new.test"));assert.equal(edit.source.slice(edit.start,edit.end),"说明");
  const linked=formatMarkdown("版本甲",{start:2,end:3},{link:"https://m.test"})!;
  assert.equal(linked.source,"版本[甲](https://m.test)");assert.equal(linked.source.slice(linked.start,linked.end),"甲");
  const caret=formatMarkdown("",{start:0,end:0},{link:"https://m.test"})!;
  assert.equal(caret.source,"[https://m.test](https://m.test)");assert.equal(markdownState(caret.source,caret).link,"https://m.test");
});
