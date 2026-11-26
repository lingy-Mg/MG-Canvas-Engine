// Optional native QA. Uses an already available Skia Canvas 2D, without changing the app's dependencies.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {CanvasView} from "../dist/renderers/canvas2d/canvas.js";
import {nodeTextRows} from "../dist/renderers/canvas2d/node-text.js";
import {nodeFont,standaloneFont,topicMeasureContext} from "../dist/platform/text-metrics.js";
import {buildScene,fitScene} from "../dist/scene/board.js";
import {decodeProject,encodeProject} from "../dist/platform/project.js";
import {AssetVault} from "../dist/features/image-assets.js";
import {layoutMap} from "../dist/features/mindmap-layout.js";
import {textWidthGrip} from "../dist/session/text-width.js";
import {EditorSession} from "../dist/session/editor.js";

const require=createRequire(import.meta.url);
const {createCanvas}=require("@napi-rs/canvas"),version=require("@napi-rs/canvas/package.json").version;
globalThis.document={createElement(tag){assert.equal(tag,"canvas");return createCanvas(1,1);}};
const ctx=topicMeasureContext();assert(ctx,"native measurement canvas was not used");
ctx.font=standaloneFont(16);
const bound=ctx.measureText("👩‍💻").width,separate=ctx.measureText("👩").width+ctx.measureText("💻").width;
assert(bound>0&&bound<separate,"the native font must support the joined emoji used in the fixture");
assert(Math.abs(ctx.measureText("审批").width-32)<1,"CJK fixture font unavailable");
const source=readFileSync(new URL("../docs/fixtures/M5Y-Text-Layout.mgcanvas",import.meta.url),"utf8");
const pkg=decodeProject(source),e=new EditorSession(pkg.document,{offset:{x:0,y:0},zoom:1});
const vault=new AssetVault(pkg.assets),bytes=()=>encodeProject(e.doc,vault),original=bytes();
const size={width:660,height:510,dpr:2},camera=fitScene(buildScene(e.doc),size.width,size.height);
const sha=b=>createHash("sha256").update(b).digest("hex");
function render(scene,theme="light",editing){
  const surface=createCanvas(1,1),c=surface.getContext("2d"),calls=[],strokes=[];
  for(const [method,list] of [["fillText",calls],["strokeText",strokes]]){
    const draw=c[method].bind(c);
    c[method]=function(...args){
      list.push({text:args[0],x:args[1],y:args[2],width:args[3],color:c.fillStyle.toLowerCase(),font:c.font});
      return draw(...args);
    };
  }
  const view=new CanvasView(surface);view.size(size.width,size.height,size.dpr);view.setTheme(theme);view.draw(scene,camera,[],undefined,undefined,editing);
  const pixels=c.getImageData(0,0,surface.width,surface.height);
  return {calls,strokes,pixels,png:surface.toBuffer("image/png"),digest:sha(pixels.data)};
}
const texts=(callList,color)=>callList.filter(r=>r.color===color.toLowerCase()).map(r=>r.text);
const baseline=render(buildScene(e.doc));const item=e.doc.objects.approval;e.select(item.id);
const grab=textWidthGrip(item,e.camera,"right").center,end={x:grab.x-48,y:grab.y};
e.down(1,"mouse",grab,item.id,false,false,{id:item.id,textEdge:"right"});e.move(1,end);assert(e.preview);
const planned=render(buildScene(e.doc,e.preview));assert.equal(bytes(),original);assert.notEqual(planned.digest,baseline.digest);
e.up(1,end);const committed=bytes(),scene=buildScene(e.doc),frame=render(scene);assert.equal(e.history.past.length,1);
assert.equal(planned.digest,frame.digest);assert.deepEqual(planned.calls,frame.calls);
assert.deepEqual(texts(frame.calls,item.color),["审批","（复","核）"]);
assert.deepEqual(texts(frame.calls,e.doc.objects.fixed.color),["审批通","过，归档"]);
assert.deepEqual(texts(frame.calls,e.doc.objects.family.color),["👩‍💻 ","ok"]);
assert.deepEqual(texts(frame.calls,e.doc.objects.accent.color),["Cafe\u0301","","末行"]);
const mind=layoutMap(e.doc.objects.map);
for(const {topic,lines} of mind)assert.deepEqual(texts(frame.calls,topic.appearance.textColor),lines.filter(s=>s.length));
assert.deepEqual(mind[1].lines,["甲","","乙","丙","丁","👩‍💻…"]);assert.equal(mind[0].lines.join(""),"审批通过，归档");
assert(mind[0].lines.every(s=>!s.startsWith("，")));
const flow=scene.find(o=>o.id==="flow").items.find(i=>i.kind==="nodeLabel");
ctx.font=nodeFont(flow.fontSize,flow.weight);
const flowRows=nodeTextRows(flow.text,flow.box.width,flow.maxLines,s=>ctx.measureText(s));
assert.deepEqual(texts(frame.calls,flow.color),flowRows);assert(flowRows.every(s=>!s.startsWith("，")));assert(flowRows.length>1);
for(const row of flowRows)assert(ctx.measureText(row).width<=flow.box.width+.001);

const fixed=e.doc.objects.fixed;
function clippedInk(pixels,height){
  const {data,width}=pixels,red=[0x8e,0x28,0x4c];let count=0,bottom=-1;
  for(let j=0;j<data.length;j+=4)if(red.every((v,i)=>Math.abs(data[j+i]-v)<=2)){
    count++;bottom=Math.max(bottom,Math.floor((j/4)/width));
  }
  const clipBottom=(camera.offset.y+(fixed.at.y+height)*camera.zoom)*size.dpr;
  assert(count>30&&bottom<Math.ceil(clipBottom),"fixed-height colored glyph pixels escaped the clip");
  return {count,bottom,clipBottom};
}
const full=clippedInk(frame.pixels,fixed.height),short=render(buildScene({...e.doc,objects:{...e.doc.objects,fixed:{...fixed,height:28}}}));
const partial=clippedInk(short.pixels,28);assert(partial.count<full.count&&partial.bottom<full.bottom);
const dark=render(scene,"dark");assert.deepEqual(texts(dark.strokes,item.color),texts(frame.calls,item.color));
const hidden=render(scene,"light",{objectId:"map",topicId:"details"});assert.deepEqual(texts(hidden.calls,mind[1].topic.appearance.textColor),[]);
assert.deepEqual(texts(hidden.calls,mind[0].topic.appearance.textColor),mind[0].lines);
e.undo();assert.equal(bytes(),original);assert.equal(render(buildScene(e.doc)).digest,baseline.digest);
e.redo();assert.equal(bytes(),committed);assert.equal(render(buildScene(e.doc)).digest,frame.digest);
const reopened=decodeProject(committed);assert.equal(encodeProject(reopened.document,new AssetVault(reopened.assets)),committed);
assert.equal(render(buildScene(reopened.document)).digest,frame.digest);
const [mode,path]=process.argv.slice(2);
if(mode==="--write"){assert(path);writeFileSync(path,frame.png,{flag:"wx"});}
else if(mode==="--compare"){assert.deepEqual(readFileSync(path),frame.png);}
else assert.equal(mode,undefined);
console.log(JSON.stringify({engine:"@napi-rs/canvas",version,width:frame.pixels.width,height:frame.pixels.height,
  flowRows,topicRows:mind.map(t=>t.lines),joinedEmojiAdvance:bound,separateEmojiAdvance:separate,
  fixedInk:full,partialClipInk:partial,basePixelSHA256:baseline.digest,finalPixelSHA256:frame.digest,pngSHA256:sha(frame.png)}));
