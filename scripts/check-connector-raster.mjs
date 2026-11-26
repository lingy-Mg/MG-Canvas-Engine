// Optional pixel regression using the Linux workspace's installed Skia Canvas 2D.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {opaquePickerColor} from "../dist/app/property-color.js";
import {resolveEndpoint} from "../dist/core/document.js";
import {worldToScreen} from "../dist/core/geometry.js";
import {AssetVault} from "../dist/features/image-assets.js";
import {FlowInput} from "../dist/features/flow-input.js";
import {planConnectorStyle,styleConnector} from "../dist/features/flow.js";
import {decodeProject,encodeProject} from "../dist/platform/project.js";
import {nodeFont} from "../dist/platform/text-metrics.js";
import {CanvasView} from "../dist/renderers/canvas2d/canvas.js";
import {buildScene,fitScene} from "../dist/scene/board.js";
import {SceneProjection} from "../dist/scene/projector.js";
import {EditorSession} from "../dist/session/editor.js";

const require=createRequire(import.meta.url),{createCanvas}=require("@napi-rs/canvas");
const hash=b=>createHash("sha256").update(b).digest("hex"),version=require("@napi-rs/canvas/package.json").version;
let surfaces=0;const doc={createElement(name){assert.equal(name,"canvas");surfaces++;return createCanvas(1,1);}};
for(const [token,expected] of [["rebeccapurple","#663399"],["navy","#000080"],["black","#000000"],["#AbC","#aabbcc"],
  ["transparent",undefined],["rgba(40,60,80,0.5)",undefined],["invalid-paint",undefined],["rgb(1,2,3)","#010203"],["rgb(4,5,6)","#040506"]]){
  assert.equal(opaquePickerColor(token,doc),expected,token);
}
assert.equal(surfaces,1);
const text=readFileSync(new URL("../docs/fixtures/M5AA-Connector-Colors.mgcanvas",import.meta.url),"utf8");
const base=decodeProject(text).document,w=540,h=300,dpr=1.5,camera=fitScene(buildScene(base),w,h);
const vault=new AssetVault(),editor=new EditorSession(base,camera),line=editor.doc.objects.route;
const projector=new SceneProjection(editor.doc),flow=new FlowInput(editor,()=>undefined),source=encodeProject(editor.doc,vault);editor.select(line.id);
editor.listen(change=>projector.update(editor.doc,change));
const style={label:line.label,stroke:"#000000",strokeWidth:7,routing:"curve",arrow:"both"};
function draw(scene,marked){
  const surface=createCanvas(1,1),view=new CanvasView(surface);view.size(w,h,dpr);
  view.draw(scene,camera,marked?[line.id]:[],undefined,undefined,undefined,marked);
  const pixels=surface.getContext("2d").getImageData(0,0,surface.width,surface.height).data;
  return {surface,pixels,digest:hash(pixels)};
}
const region=p=>{const at=worldToScreen(p,camera);return {x:at.x*dpr,y:at.y*dpr};};
const ends=[resolveEndpoint(base,line.from),resolveEndpoint(base,line.to)].map(region);
function rgbaAt(frame,p){
  const q=region(p),i=4*(Math.floor(q.y)*frame.surface.width+Math.floor(q.x));return [...frame.pixels.slice(i,i+4)];
}
function colorCount(frame,r,g,b){
  const a=frame.pixels;let n=0;for(let i=0;i<a.length;i+=4)if(a[i]===r&&a[i+1]===g&&a[i+2]===b&&a[i+3]===255)n++;return n;
}
function diffNear(first,second){
  const counts=[0,0,0],a=first.pixels,b=second.pixels,w=first.surface.width,rad=25*dpr*camera.zoom;
  for(let i=0;i<a.length;i+=4){
    if(a[i]===b[i]&&a[i+1]===b[i+1]&&a[i+2]===b[i+2]&&a[i+3]===b[i+3])continue;
    const n=i/4,x=n%w,y=Math.floor(n/w),end=ends.findIndex(p=>Math.hypot(x-p.x,y-p.y)<rad);counts[end<0?2:end]++;
  }
  return counts;
}
const planned=planConnectorStyle(editor.doc,line,style);assert(planned);
const projected=projector.overlay({objects:new Map([[line.id,planned]])});
const before=draw(projector.all()),draft=draw(projector.all(projected)),marked=draw(projector.all(projected),flow.decor({width:w,height:h},planned));
const isolate=(obj)=>{
  const overlay=projector.overlay({objects:new Map([[line.id,obj]])});return draw([overlay.get(line.id)]);
};
const raw=draw([projector.all().find(g=>g.id===line.id)]),afterRaw=isolate(planned);
const purplePixels=colorCount(raw,102,51,153),blackPixels=colorCount(afterRaw,0,0,0);
assert(purplePixels>100&&blackPixels>500);assert.equal(colorCount(raw,0,0,0),0);assert.equal(colorCount(afterRaw,102,51,153),0);
const shape=base.objects.review,empty=draw([]),inspection={x:shape.at.x+19,y:shape.at.y+17};
const originalNode=draw([projector.all().find(g=>g.id===shape.id)]);assert.deepEqual(rgbaAt(originalNode,inspection),rgbaAt(empty,inspection));
const fill=projector.overlay({objects:new Map([[shape.id,{...shape,fill:"#000000"}]])});
assert.deepEqual(rgbaAt(draw([fill.get(shape.id)]),inspection),[0,0,0,255]);
const variants={};
for(const arrow of ["none","start","end","both"])variants[arrow]=isolate(planConnectorStyle(editor.doc,line,{...style,arrow}));
const arrowPixels=Object.fromEntries(["start","end","both"].map(k=>[k,diffNear(variants.none,variants[k])]));
assert(arrowPixels.start[0]>0&&arrowPixels.end[1]>0);
assert.deepEqual(arrowPixels.start.slice(1),[0,0]);assert.equal(arrowPixels.end[0],0);assert.equal(arrowPixels.end[2],0);
assert.deepEqual(arrowPixels.both,[arrowPixels.start[0],arrowPixels.end[1],0]);
const straight=planConnectorStyle(editor.doc,line,{...style,routing:"straight"}),straightDecor=flow.decor({width:w,height:h},straight);
assert.equal(straightDecor.markers.filter(m=>m.kind==="waypoint").length,0);assert.deepEqual(straight.waypoints,line.waypoints);
assert.equal(flow.decor(undefined,planned).markers.filter(m=>m.kind==="waypoint").length,4);
assert.equal(encodeProject(editor.doc,vault),source);assert.equal(editor.history.past.length,0);
assert(styleConnector(editor,line.id,style));assert.equal(editor.history.past.length,1);
const bytes=encodeProject(editor.doc,vault),committed=draw(projector.all());assert.equal(draft.digest,committed.digest);
assert.equal(marked.digest,draw(projector.all(),flow.decor({width:w,height:h})).digest);assert.notEqual(before.digest,draft.digest);
assert.deepEqual(editor.doc.objects.route,{...line,...style});editor.undo();
assert.equal(encodeProject(editor.doc,vault),source);assert.equal(before.digest,draw(projector.all()).digest);
editor.redo();assert.equal(draw(projector.all()).digest,draft.digest);const reopened=decodeProject(bytes);
assert.equal(encodeProject(reopened.document,new AssetVault(reopened.assets)),bytes);assert.equal(draw(buildScene(reopened.document)).digest,draft.digest);

const pad=24,gap=18,top=101,width=2*w+2*pad+gap,height=top+h+pad,right=pad+w+gap;
const image=createCanvas(width*dpr,height*dpr),ctx=image.getContext("2d");ctx.scale(dpr,dpr);ctx.fillStyle="#f6f7f7";ctx.fillRect(0,0,width,height);
function caption(value,x,y,size,weight,ink){ctx.font=nodeFont(size,weight);ctx.fillStyle=ink;ctx.fillText(value,x,y);}
caption("连线路由与外观",pad,39,23,700,"#263541");
caption("原连线",pad,77,16,700,"#25333f");caption("rebeccapurple   ·   3   ·   折线   ·   终点箭头",pad+72,77,13,500,"#4a5360");
caption("输入预览与应用后",right,77,16,700,"#25333f");caption("#000000   ·   7   ·   曲线   ·   两端箭头",right+144,77,13,500,"#4a5360");
for(const [x,frame] of [[pad,before],[right,draft]]){ctx.drawImage(frame.surface,x,top,w,h);ctx.strokeStyle="#c4cbcf";ctx.lineWidth=1;ctx.strokeRect(x,top,w,h);}
const png=image.toBuffer("image/png"),[mode,file]=process.argv.slice(2);
if(mode==="--write"){assert(file);writeFileSync(file,png,{flag:"wx"});}
else if(mode==="--compare"){assert.deepEqual(png,readFileSync(file));}else assert.equal(mode,undefined);
console.log(JSON.stringify({engine:"Skia Canvas 2D",version,pickerSurfaceCount:surfaces,purplePixels,blackPixels,arrowPixels,
  endpointPixels:ends,manualPins:4,frame:[w*dpr,h*dpr],baseRGBA:before.digest,finalRGBA:committed.digest,markedRGBA:marked.digest,pngSHA256:hash(png)}));
