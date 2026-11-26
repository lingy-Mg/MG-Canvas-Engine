import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {TextObject} from "../core/document.ts";
import {localToWorld,worldToScreen} from "../core/geometry.ts";
import type {Camera,Point} from "../core/geometry.ts";
import {AssetVault} from "../features/image-assets.ts";
import {textHeight,wrapPlainText} from "../features/plain-text.ts";
import {setTextStyle} from "../features/standalone.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {buildScene} from "../scene/board.ts";
import {EditorSession} from "../session/editor.ts";
import {hitTextWidthGrip,resizeTextWidth,TEXT_EDGES,textWidthCursor,textWidthGrip,textWidthTravel} from "../session/text-width.ts";
import type {TextEdge} from "../session/text-width.ts";

const project=decodeProject(readFileSync(new URL("../docs/fixtures/M5W-Text-Width.mgcanvas",import.meta.url),"utf8"));
const board=project.document,auto=board.objects.auto as TextObject,fixed=board.objects.fixed as TextObject;
const p=(x:number,y:number):Point=>({x,y});
const camera=(zoom=1):Camera=>({zoom,offset:p(-35,83)});
const near=(a:number,b:number)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const bytes=(doc=board)=>encodeProject(doc,new AssetVault(project.assets));
const opposite=(item:TextObject,edge:TextEdge,y:number)=>localToWorld(p(edge==="right"?0:item.width,y),item);
const style=(item:TextObject)=>[item.text,item.rotation,item.fontSize,item.color,item.align,item.heightMode];
const get=(e:EditorSession,id:string)=>e.doc.objects[id] as TextObject;
const moved=(start:Point,angle:number,along:number,across=0)=>p(start.x+along*Math.cos(angle)-across*Math.sin(angle),start.y+along*Math.sin(angle)+across*Math.cos(angle));
function textBlock(item:TextObject){
  const scene=buildScene({...board,objects:{...board.objects,[item.id]:item}},undefined,[item.id]);
  const block=scene[0].items.find(a=>a.kind==="textBlock");assert(block);return block;
}
test("fitted text reflows CJK paragraphs and a long Latin word with one shared line height and intact style",()=>{
  const resized=resizeTextWidth(auto,"right",-80);
  assert.equal(resized.width,80);assert.equal(resized.height,308);assert.deepEqual(resized.at,auto.at);
  const block=textBlock(resized);
  assert.deepEqual(block.lines,["中文排版","換行測試","日本語テ","スト","한국어문","장","ABCDEF","GHIJKL","MNOPQR","STUVWX","YZ"]);
  assert.deepEqual(style(resized),style(auto));assert.equal(block.textAlign,"center");assert(!block.clip);
  assert.equal(textHeight(auto.text,auto.width,auto.fontSize),168);
  const e=new EditorSession(board,camera());e.select("auto");const original=get(e,"auto");
  assert(setTextStyle(e,original,{fontSize:auto.fontSize,color:auto.color,align:auto.align,width:80}));
  assert.deepEqual(get(e,"auto"),resized);
});
test("each grip fixes the opposite top and first writing baseline through rotation, fitting, and fixed-height clipping",()=>{
  for(const model of [auto,fixed])for(const rotation of [0,Math.PI/2,-Math.PI/3,Math.PI])for(const edge of TEXT_EDGES){
    const item={...model,rotation},next=resizeTextWidth(item,edge,edge==="right"?-50:50);
    assert.equal(next.width,item.width-50);assert.deepEqual(style(next),style(item));
    for(const y of [0,item.fontSize*.8]){
      const a=opposite(item,edge,y),b=opposite(next,edge,y);
      assert(Number.isInteger(next.at.x)&&Number.isInteger(next.at.y));
      assert(Math.abs(a.x-b.x)<=.5+1e-10&&Math.abs(a.y-b.y)<=.5+1e-10);
    }
    assert.equal(next.height,item.heightMode==="fixed"?item.height:textHeight(item.text,next.width,item.fontSize));
    const block=textBlock(next);assert.equal(Boolean(block.clip),item.heightMode==="fixed");
    assert.deepEqual(block.lines,wrapPlainText(item.text,next.width,item.fontSize));assert.equal(block.textAlign,item.align);
  }
});
test("limits preserve old out-of-range widths and legacy noncanonical heights until a real width edit",()=>{
  assert.equal(resizeTextWidth(auto,"right",-10000).width,24);assert.equal(resizeTextWidth(auto,"left",-10000).width,5000);
  const tiny={...auto,width:10,height:77},huge={...auto,width:6300,height:2};
  assert.equal(resizeTextWidth(tiny,"right",-2),tiny);assert.equal(resizeTextWidth(tiny,"left",-3).width,13);
  assert.equal(resizeTextWidth(huge,"left",-1),huge);assert.equal(resizeTextWidth(huge,"right",-10).width,6290);
  for(const travel of [0,NaN,Infinity,-Infinity])assert.equal(resizeTextWidth(tiny,"right",travel),tiny);
  assert.equal(resizeTextWidth(auto,"left",Number.EPSILON),auto);
});
test("CSS grips remain distinct at the zoom limits and leave the body free at the narrowest width",()=>{
  for(const zoom of [.05,.42,2.4,16])for(const rotation of [0,Math.PI*.25,Math.PI*.5,Math.PI]){
    const item={...fixed,width:24,rotation},view=camera(zoom),mid=worldToScreen(localToWorld(p(12,item.height/2),item),view);
    const left=textWidthGrip(item,view,"left"),right=textWidthGrip(item,view,"right");
    assert(Math.hypot(right.center.x-left.center.x,right.center.y-left.center.y)>51.99999);
    assert.equal(hitTextWidthGrip(item,view,mid,true),undefined);
    for(const edge of TEXT_EDGES){
      const grip=textWidthGrip(item,view,edge),axis=moved(grip.center,rotation,5,3);
      assert.equal(hitTextWidthGrip(item,view,axis),edge);assert.equal(hitTextWidthGrip(item,view,moved(grip.center,rotation,12),true),edge);
      assert.equal(hitTextWidthGrip(item,view,moved(grip.center,rotation,0,24),true),undefined);
      near(textWidthTravel(item,axis,moved(axis,rotation,27,-58)),27);
    }
  }
  assert.deepEqual([0,Math.PI/4,Math.PI/2,-Math.PI/4].map(textWidthCursor),["ew-resize","nwse-resize","ns-resize","nesw-resize"]);
});
test("a tall or rotated text edge crossing the viewport keeps a hittable grip on its visible portion",()=>{
  const view={width:800,height:550},cam={zoom:1,offset:p(0,0)};
  const lines=Array(130).fill("一行短句").join("\n");
  const tall={...auto,at:p(120,40),width:140,height:textHeight(lines,140,18),fontSize:18,text:lines};
  assert.equal(tall.height,3276);
  for(const rotation of [0,Math.PI/18]){
    // Place the upper left at the same world point for both orientations.
    const rotated={...tall,rotation},top=localToWorld(p(0,0),rotated);
    const item={...rotated,at:p(rotated.at.x+120-top.x,rotated.at.y+40-top.y)};
    for(const edge of TEXT_EDGES){
      assert(textWidthGrip(item,cam,edge).center.y>view.height);
      const visible=textWidthGrip(item,cam,edge,view),x=edge==="left"?0:item.width;
      assert(visible.center.y>40&&visible.center.y<540);
      assert.equal(hitTextWidthGrip(item,cam,visible.center,true,view),edge);
      const start=localToWorld(p(x,0),item),offset=p(visible.base.x-start.x,visible.base.y-start.y);
      near(offset.x*Math.cos(rotation)+offset.y*Math.sin(rotation),0);
    }
  }
  for(const height of [999.8,1000,1000.2]){
    const edge=textWidthGrip({...tall,height},cam,"left",view);
    near(edge.center.y,(40+550)/2);
  }
  const outside={...tall,at:p(1500,40)};
  assert.deepEqual(textWidthGrip(outside,cam,"left",view),textWidthGrip(outside,cam,"left"));
});
test("preview, final release without a move, project reopen, undo and redo share identical text geometry",()=>{
  for(const zoom of [.05,1.25,16])for(const id of ["auto","fixed"])for(const edge of TEXT_EDGES){
    const view=camera(zoom),e=new EditorSession(board,view);e.select(id);
    const item=get(e,id),start=moved(textWidthGrip(item,view,edge).center,item.rotation,2,3);
    const delta=zoom===.05?100:50,end=moved(start,item.rotation,delta*zoom,29);
    e.down(7,"mouse",start,id,false,false,{id,textEdge:edge});e.move(7,end);
    const next=e.preview?.objects.get(id);assert(next?.kind==="text");near(next.width,item.width+(edge==="right"?delta:-delta));
    const expected=bytes({...e.doc,objects:{...e.doc.objects,[id]:next}});assert.equal(bytes(e.doc),bytes());assert.equal(e.history.past.length,0);
    e.up(7,end);e.up(7,end);assert.equal(bytes(e.doc),expected);assert.equal(e.history.past.length,1);
    assert.equal(bytes(decodeProject(expected).document),expected);e.undo();assert.equal(bytes(e.doc),bytes());e.redo();assert.equal(bytes(e.doc),expected);
    e.undo();e.down(8,"mouse",start,id,false,false,{id,textEdge:edge});e.up(8,end);assert.equal(bytes(e.doc),expected);
  }
});
test("perpendicular motion and a round trip to the grab retain legacy height and create zero history",()=>{
  const text={...auto,rotation:Math.PI*.37,height:19.75},doc={...board,objects:{...board.objects,auto:text}};
  const e=new EditorSession(doc,camera()),edge="right";e.select("auto");
  const initial=bytes(e.doc);assert.equal(get(e,"auto").height,20);
  const start=textWidthGrip(text,e.camera,edge).center,across=moved(start,text.rotation,0,180);
  e.down(1,"mouse",start,"auto",false,false,{id:"auto",textEdge:edge});e.move(1,across);assert(!e.preview);
  e.move(1,moved(start,text.rotation,-55,50));assert(e.preview);e.move(1,across);assert(!e.preview);e.up(1,start);
  assert.equal(bytes(e.doc),initial);assert.equal(e.history.past.length,0);
});
test("cancel, capture loss, pointer handoff, selection and board changes discard stale text-width releases",()=>{
  for(const reason of ["esc","capture","pinch","mixed contacts","selection","board","tool","camera"]){
    const e=new EditorSession(board,camera());e.select("auto");const start=textWidthGrip(auto,e.camera,"right").center,end=moved(start,0,-70);
    e.down(1,"touch",start,"auto",false,false,{id:"auto",textEdge:"right"});e.move(1,end);assert(e.preview);
    if(reason==="esc")e.cancel();
    if(reason==="capture")e.pointerCancelled(1);
    if(reason==="pinch"||reason==="mixed contacts")e.down(2,reason==="pinch"?"touch":"pen",p(600,240),undefined,true);
    if(reason==="selection")e.select("fixed");
    if(reason==="board")e.open(board,true);
    if(reason==="tool")e.setTool("hand");
    if(reason==="camera")e.setCamera(camera(2));
    assert(!e.preview);e.up(1,end);e.up(2,p(620,240));assert.equal(bytes(e.doc),bytes());assert.equal(e.history.past.length,0);
  }
});
test("ordinary text moves and mixed selections translate objects, retaining their line widths and native formats",()=>{
  const e=new EditorSession(board,camera());e.select("auto");e.select("fixed",true);
  const start=p(60,100),end=p(70,118);e.down(1,"mouse",start,"auto",false);e.up(1,end);
  assert.equal(e.history.past.length,1);for(const old of [auto,fixed]){
    const now=get(e,old.id);assert.deepEqual(now,{...old,at:p(old.at.x+10,old.at.y+18)});
  }
  e.undo();assert.equal(bytes(e.doc),bytes());e.select("fixed");assert(e.moveSelection(p(-1,0)));
  assert.equal(get(e,"fixed").width,fixed.width);assert.equal(e.doc.schemaVersion,1);
});
