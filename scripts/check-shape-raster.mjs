// Optional pixel regression using the Linux workspace's existing native Skia module.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {CanvasView} from "../dist/renderers/canvas2d/canvas.js";
import {nodeFont} from "../dist/platform/text-metrics.js";
import {decodeProject,encodeProject} from "../dist/platform/project.js";
import {AssetVault} from "../dist/features/image-assets.js";
import {SceneProjection} from "../dist/scene/projector.js";
import {buildScene,fitScene} from "../dist/scene/board.js";
import {EditorSession} from "../dist/session/editor.js";
import {planShapeTransform} from "../dist/session/shape-properties.js";
import {resolveEndpoint} from "../dist/core/document.js";

const require=createRequire(import.meta.url),{createCanvas}=require("@napi-rs/canvas");
const version=require("@napi-rs/canvas/package.json").version,hash=b=>createHash("sha256").update(b).digest("hex");
const read=readFileSync(new URL("../docs/fixtures/M5Z-Shape-Properties.mgcanvas",import.meta.url),"utf8");
const base=decodeProject(read).document,vault=new AssetVault(),e=new EditorSession(base,{zoom:1,offset:{x:0,y:0}});
const w=540,h=332,dpr=1.5,idx=new SceneProjection(e.doc),camera=fitScene(idx.all(),w,h);
e.select("review");const s=e.doc.objects.review,original=encodeProject(e.doc,vault);
function draw(scene,selection){
  const surface=createCanvas(1,1),view=new CanvasView(surface);view.size(w,h,dpr);
  view.draw(scene,camera,[s.id],undefined,undefined,undefined,undefined,undefined,selection);
  const pixels=surface.getContext("2d").getImageData(0,0,surface.width,surface.height).data;
  return {surface,pixels,digest:hash(pixels)};
}
function count(frame,hex){
  const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));let n=0;
  for(let i=0;i<frame.pixels.length;i+=4)if(rgb.every((channel,j)=>frame.pixels[i+j]===channel))n++;
  return n;
}
const input={x:s.at.x,y:s.at.y,width:164,height:80,shapeStyle:{rotation:Math.PI/6,radius:8,fill:"#b4ddcf",stroke:"#146858",strokeWidth:5}};
const start=draw(idx.all(),s),changed=planShapeTransform(e.doc,s,input),override=idx.overlay({objects:changed});
const draft=draw(idx.all(override),changed.get(s.id));assert.notEqual(draft.digest,start.digest);
const fillPixels=count(draft,input.shapeStyle.fill),strokePixels=count(draft,input.shapeStyle.stroke);
assert(fillPixels>1000&&strokePixels>100&&count(start,input.shapeStyle.fill)===0);assert.equal(encodeProject(e.doc,vault),original);
e.listen(change=>idx.update(e.doc,change));assert(e.transformSelection(input));assert.equal(e.history.past.length,1);
const saved=encodeProject(e.doc,vault),live=e.doc.objects.review,applied=draw(idx.all(),live);assert.equal(draft.digest,applied.digest);
for(const id of ["route","arrival"]){
  const line=e.doc.objects[id],path=override.get(id).items.find(i=>i.kind==="path");
  assert.deepEqual(line,base.objects[id]);assert.deepEqual(path.points[0],resolveEndpoint(e.doc,line.from));assert.deepEqual(path.points.at(-1),resolveEndpoint(e.doc,line.to));
  for(const pin of line.waypoints)assert(path.points.some(p=>p.x===pin.x&&p.y===pin.y));
}
const zero=planShapeTransform(e.doc,live,{...input,shapeStyle:{...input.shapeStyle,strokeWidth:0}});
const zeroFrame=draw(idx.all(idx.overlay({objects:zero})),zero.get(s.id));assert.equal(count(zeroFrame,input.shapeStyle.stroke),0);
assert.equal(encodeProject(e.doc,vault),saved);e.undo();assert.equal(encodeProject(e.doc,vault),original);
assert.equal(draw(idx.all(),e.doc.objects.review).digest,start.digest);e.redo();assert.equal(draw(idx.all(),e.doc.objects.review).digest,applied.digest);
const reopened=decodeProject(saved);assert.equal(encodeProject(reopened.document,new AssetVault(reopened.assets)),saved);
assert.equal(draw(buildScene(reopened.document),reopened.document.objects.review).digest,applied.digest);

const pad=24,gap=18,top=104,width=w*2+2*pad+gap,height=top+h+pad;
const image=createCanvas(width*dpr,height*dpr),c=image.getContext("2d");c.scale(dpr,dpr);
c.fillStyle="#f5f6f6";c.fillRect(0,0,width,height);c.textBaseline="alphabetic";
function text(value,x,y,size,weight,color){c.fillStyle=color;c.font=nodeFont(size,weight);c.fillText(value,x,y);}
text("单选流程形状的属性预览",pad,38,22,700,"#18352e");
text("应用前",pad,75,15,700,"#1d302f");text("120 × 64   ·   0°",pad+72,75,13,500,"#47605a");
const right=pad+w+gap;text("输入预览与应用后",right,75,15,700,"#1d302f");text("164 × 80   ·   30°",right+145,75,13,500,"#47605a");
for(const [x,frame] of [[pad,start],[right,draft]]){
  c.drawImage(frame.surface,x,top,w,h);c.strokeStyle="#c4ceca";c.lineWidth=1;c.strokeRect(x,top,w,h);
}
const png=image.toBuffer("image/png"),[mode,file]=process.argv.slice(2);
if(mode==="--write"){assert(file);writeFileSync(file,png,{flag:"wx"});}
else if(mode==="--compare"){assert.deepEqual(readFileSync(file),png);}
else assert.equal(mode,undefined);
console.log(JSON.stringify({engine:"Skia Canvas 2D",version,frame:[w*dpr,h*dpr],image:[image.width,image.height],
  east:resolveEndpoint(e.doc,e.doc.objects.route.from),south:resolveEndpoint(e.doc,e.doc.objects.arrival.to),manualPins:7,
  fillPixels,strokePixels,zeroStrokePixels:count(zeroFrame,input.shapeStyle.stroke),baseRGBA:start.digest,finalRGBA:applied.digest,pngSHA256:hash(png)}));
