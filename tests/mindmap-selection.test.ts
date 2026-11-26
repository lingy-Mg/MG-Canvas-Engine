import {test} from "node:test";
import assert from "node:assert/strict";
import type {BoardDocument,MindMap,Topic} from "../core/document.ts";
import {boxBounds,screenToWorld,worldToScreen} from "../core/geometry.ts";
import type {Point,Rect} from "../core/geometry.ts";
import {EditorSession} from "../session/editor.ts";
import {MindMapInput} from "../features/mindmap-input.ts";
import {finishTopicDraft,getMap,topicDraft,setMindStyle,setTopicAppearance} from "../features/mindmap.ts";
import {topicBox} from "../features/mindmap-layout.ts";
import {deleteBoardSelection} from "../features/flow.ts";
import {captureClipboard,prepareClipboardCut} from "../features/clipboard.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {canvasThemes,contrastRatio,type WorkspaceTheme} from "../platform/theme.ts";
import {buildScene,hitTest,marqueeHit,topicPaint,mindPalette} from "../scene/board.ts";
import {mixed} from "./fixtures/mixed.ts";

const point=(x:number,y:number)=>({x,y});
function setup(){
  const map={...mixed.objects["map-a"],layout:"right",theme:"spectrum"} as const;
  const ids=["shape-start",map.id,"map-b"] as const;
  const doc:BoardDocument={...mixed,assets:{},order:ids,objects:Object.fromEntries(ids.map(id=>[id,id===map.id?map:mixed.objects[id]]))};
  const e=new EditorSession(doc,{offset:point(60,55),zoom:1.4}),vault=new AssetVault();
  const mind=new MindMapInput(e,p=>hitTest(buildScene(e.doc),screenToWorld(p,e.camera)),()=>{});
  e.listen(()=>mind.sync());
  const current=()=>getMap(e,map.id)!;
  const screen=(p:Point)=>worldToScreen(p,e.camera);
  function marquee(rect:Rect,shift=false){
    const a=screen(rect.min),b=screen(rect.max);
    e.down(1,"mouse",a,undefined,false,shift);e.move(1,b);
    e.up(1,b,(bounds,ranges)=>{mind.reset();return marqueeHit(buildScene(e.doc),bounds,ranges);});
  }
  return {e,mind,vault,current,screen,marquee};
}
function center(map:MindMap,id:string){
  const b=topicBox(map,id)!.box;return point(b.at.x+b.width/2,b.at.y+b.height/2);
}
function paint(map:MindMap,id:string,theme:WorkspaceTheme="light"){const row=topicBox(map,id)!;return topicPaint(map,row.topic,row,theme);}

test("marquee intersects node frames just like flow shapes and a drag from a selected branch never translates its map",()=>{
  const {e,mind,current,screen,marquee}=setup(),map=current();
  const a=topicBox(map,"child-a")!.box,b=topicBox(map,"child-b")!.box;
  marquee({min:point(a.at.x-8,a.at.y-8),max:point(a.at.x+2,a.at.y+2)});
  assert.deepEqual(e.selectedIds,[map.id]);assert.deepEqual([...e.selectedTopics.get(map.id)!],["child-a"]);
  assert.deepEqual(mind.decor().range,[a]);
  const source=center(map,"child-a"),dest=point(source.x+35,source.y+18);
  assert(mind.down(2,"mouse",screen(source)));mind.move(2,screen(dest));mind.up(2,screen(dest));
  assert.strictEqual(current(),map);assert.equal(e.history.past.length,0);assert.deepEqual(mind.decor().range,[a]);
  marquee({min:b.at,max:point(b.at.x+8,b.at.y+8)},true);
  assert.deepEqual(new Set(e.selectedTopics.get(map.id)),new Set(["child-a","child-b"]));
  assert.deepEqual(mind.decor().range,[a,b]);
  const bounds=buildScene(e.doc).find(g=>g.id===map.id)!.bounds;
  marquee(bounds);assert.equal(mind.decor().range?.length,3);
  const shape=mixed.objects["shape-start"];
  marquee({min:point(shape.at.x-5,shape.at.y-5),max:point(shape.at.x+1,shape.at.y+1)});
  assert.deepEqual(e.selectedIds,[shape.id]);assert.equal(e.selectedTopics.size,0);
});

test("selection count treats a whole map as one and partial maps as distinct selected topics",()=>{
  const {e,current,marquee,screen}=setup(),map=current();
  const a=boxBounds(topicBox(map,"child-a")!.box),b=boxBounds(topicBox(map,"child-b")!.box);
  marquee(a);assert.equal(e.selectedElementCount,1);
  e.select("shape-start",true);assert.equal(e.selectedElementCount,2);
  const hit=(box:Rect,ranges:Map<string,Set<string>>)=>marqueeHit(buildScene(e.doc),box,ranges);
  e.down(4,"mouse",screen(b.min),undefined,false,true);e.move(4,screen(b.max));
  assert.equal(e.marqueeElementCount(hit),3);assert.equal(e.selectedElementCount,2);
  e.up(4,screen(b.max),hit);assert.equal(e.selectedElementCount,3);
  marquee(a,true);assert.equal(e.selectedElementCount,3);
  e.select("shape-start",true);assert.equal(e.selectedElementCount,2);
  e.select(map.id);assert.equal(e.selectedElementCount,1);
  marquee(b,true);assert.equal(e.selectedElementCount,1);assert.equal(e.selectedTopics.size,0);
});

test("primary branch cross-root drops carry its descendants and color in both directions with one undo per drop",()=>{
  const {e,mind,current,screen,marquee}=setup();
  const draft=topicDraft(e,{mapId:current().id,topicId:"child-a"},"child")!;
  assert(finishTopicDraft(e,draft,"审核记录"));const original=current();
  const other=topicBox(original,"child-b")!.side,accent=paint(original,"child-a").branch;
  marquee(boxBounds(topicBox(original,"child-a")!.box));
  function drop(left:boolean){
    const before=current(),pos=center(before,"child-a"),root=before.origin,to=screen(point(root.x+(left?-100:100),root.y-55));
    const n=e.history.past.length;
    assert(mind.down(2,"mouse",screen(pos)));mind.move(2,to);assert(mind.decor().drop?.valid);
    assert.strictEqual(current(),before);mind.up(2,to);const map=current(),side=left?"left":"right";
    assert.equal(e.history.past.length,n+1);assert.deepEqual(map.origin,root);
    assert.equal(topicBox(map,"child-a")!.side,side);assert.equal(topicBox(map,draft.topicId)!.side,side);
    assert.equal(topicBox(map,"child-b")!.side,other);
    assert.deepEqual(map.topics[map.rootId].childIds,before.topics[map.rootId].childIds);
    assert.equal(paint(map,"child-a").branch,accent);assert.equal(paint(map,draft.topicId).branch,accent);
    const edge=buildScene(e.doc,undefined,[map.id])[0].items.filter(i=>i.kind==="path"&&i.color===accent);
    assert.equal(edge.length,2);assert(edge.every(i=>i.kind==="path"&&i.points.every(p=>left?p.x<root.x:p.x>root.x)));
  }
  drop(true);const left=current();drop(false);e.undo();assert.strictEqual(current(),left);e.undo();assert.strictEqual(current(),original);
});

test("primary insertion on either side retains palette slots; a marquee drag on a grandchild moves only its subtree",()=>{
  const {e,mind,current,screen,marquee,vault}=setup(),root=current().rootId;
  function add(parent:string,text:string){const d=topicDraft(e,{mapId:current().id,topicId:parent},"child")!;assert(finishTopicDraft(e,d,text));return d.topicId;}
  const c=add(root,"第三分支"),d=add(root,"第四分支"),k=add("child-a","孙一"),j=add("child-a","孙二"),leaf=add(k,"末级");
  const initial=current(),colors=Object.fromEntries(initial.topics[root].childIds.map(id=>[id,paint(initial,id).branch]));
  function drag(id:string,to:Point){
    const from=screen(center(current(),id)),at=screen(to),old=current();
    assert(mind.down(42,"mouse",from));assert(mind.move(42,at));assert.strictEqual(current(),old);
    mind.up(42,at);assert.deepEqual(current().origin,initial.origin);
  }
  const near=(id:string,fraction:number)=>{const b=topicBox(current(),id)!.box;return point(b.at.x+b.width/2,b.at.y+b.height*fraction);};
  const order=(side:string)=>current().topics[root].childIds.filter(id=>topicBox(current(),id)!.side===side);
  drag(c,near("child-a",.2));assert.deepEqual(order("right"),[c,"child-a","child-b",d]);
  drag("child-b",point(initial.origin.x-120,initial.origin.y));
  drag(d,near("child-b",.9));assert.deepEqual(order("left"),["child-b",d]);
  drag("child-a",near(d,.1));assert.deepEqual(order("left"),["child-b","child-a",d]);
  for(const id of initial.topics[root].childIds)assert.equal(paint(current(),id).branch,colors[id]);
  const saved=decodeProject(encodeProject(e.doc,vault)).document.objects[initial.id];assert.deepEqual(saved,current());
  marquee(boxBounds(topicBox(current(),j)!.box));drag(j,near(k,.04));assert.deepEqual(current().topics["child-a"].childIds,[j,k]);
  assert.deepEqual([...e.selectedTopics.get(initial.id)!],[j]);
  const reordered=current();drag(k,near(leaf,.5));assert.strictEqual(current(),reordered);
  drag(k,near(c,.5));assert.deepEqual(current().topics[c].childIds,[k]);assert.deepEqual(current().topics[k].childIds,[leaf]);
  assert.deepEqual(current().topics["child-a"].childIds,[j]);e.undo();assert.strictEqual(current(),reordered);
});

test("each map's five style settings reflow and paint, keep node overrides, undo and reopen",()=>{
  const {e,current,vault}=setup(),map=current(),other=e.doc.objects["map-b"];
  const first=topicDraft(e,{mapId:map.id,topicId:"child-a"},"child")!;assert(finishTopicDraft(e,first,"孙节点"));
  const deep=topicDraft(e,{mapId:map.id,topicId:first.topicId},"child")!;assert(finishTopicDraft(e,deep,"下一层"));
  assert(setTopicAppearance(e,{mapId:map.id,topicId:"child-b"},{fill:"#abcdab",textColor:"#102030"}));
  const before=current(),size=topicBox(before,before.rootId)!.box;
  assert(setMindStyle(e,map.id,"left","warm",{spacing:48,scale:1.3,skin:"capsule"}));
  const styled=current(),root=topicBox(styled,styled.rootId)!,a=topicBox(styled,"child-a")!,b=topicBox(styled,"child-b")!;
  assert.equal(root.box.width,size.width*1.3);assert.equal(a.side,"left");assert(a.box.at.x<root.box.at.x);
  assert(Math.abs(b.box.at.y-a.box.at.y-a.box.height-48*1.3)<.001);
  const boxes=buildScene(e.doc,undefined,[map.id])[0].items.filter(p=>p.kind==="box");
  assert(boxes.every(p=>p.kind==="box"&&p.radius===p.box.height/2));
  assert.equal(paint(styled,"child-a").fill,mindPalette("warm").branches[0]);
  assert.notEqual(paint(styled,"child-b").branch,paint(styled,"child-a").branch);
  assert.equal(paint(styled,"child-b").fill,"#abcdab");assert.equal(paint(styled,"child-b").textColor,"#102030");
  assert.notEqual(paint(styled,first.topicId).fill,paint(styled,deep.topicId).fill);
  for(const theme of ["spectrum","indigo","mint","warm"]){
    for(const color of mindPalette(theme).branches)for(const mode of ["light","dark"] as const)assert(contrastRatio(color,canvasThemes[mode].bg)!>=3);
    for(const mode of ["light","dark"] as const)for(const id of [map.rootId,"child-a",first.topicId,deep.topicId]){
      const p=paint({...styled,theme},id,mode),background=p.fill==="transparent"?canvasThemes[mode].bg:p.fill;
      assert(contrastRatio(p.textColor,background)!>=4.5);
      if(id===deep.topicId){assert(p.underline&&p.surfaceInk);assert.equal(p.fill,"transparent");assert.equal(p.textColor,mode==="dark"?"#fff":"#000");}
    }
  }
  assert.strictEqual(e.doc.objects["map-b"],other);e.undo();assert.strictEqual(current(),before);e.redo();
  const bytes=encodeProject(e.doc,vault),archive=JSON.parse(bytes).document.objects[map.id];
  assert(!Object.hasOwn(archive,"scale")&&!Object.hasOwn(archive,"spacing")&&!Object.hasOwn(archive,"skin"));
  const reopenedDoc=decodeProject(bytes).document,reopened=reopenedDoc.objects[map.id];
  assert.equal(encodeProject(reopenedDoc,vault),bytes);
  assert.deepEqual(reopened,styled);assert(reopened.kind==="mindmap");assert.deepEqual(paint(reopened,deep.topicId),paint(styled,deep.topicId));
});

test("partial selection copies and removes only the intersecting topics and invalidates a stale cut",()=>{
  const {e,current,vault,marquee}=setup(),map=current();
  const next=topicDraft(e,{mapId:map.id,topicId:"child-a"},"child")!;assert(finishTopicDraft(e,next,"保留"));
  marquee(boxBounds(topicBox(current(),"child-a")!.box));
  const copied=captureClipboard(e.doc,e.selectedIds,vault,undefined,e.selectedTopics)!.document.objects[map.id];
  assert(copied.kind==="mindmap");assert.deepEqual(Object.keys(copied.topics),["child-a"]);
  const stale=prepareClipboardCut(e,vault)!;marquee(boxBounds(topicBox(current(),"child-b")!.box));assert(!stale.remove());
  marquee(boxBounds(topicBox(current(),"child-a")!.box));const before=current();
  assert(deleteBoardSelection(e));assert(current().topics[next.topicId]);
  assert.deepEqual(current().topics[map.rootId].childIds,[next.topicId,"child-b"]);
  e.undo();assert.strictEqual(current(),before);
  marquee(boxBounds(topicBox(current(),"child-a")!.box));assert(prepareClipboardCut(e,vault)!.remove());
  assert(current().topics[next.topicId]);assert(!current().topics["child-a"]);
});

test("five underlined children stay close to their own parent with level tangents and matching widths on either side",()=>{
  const original=setup().current(),ids=["u","v","w","x","y"];
  const t=(id:string,childIds:string[]=[]):Topic=>({id,text:id,childIds,collapsed:false});
  const topics:Record<string,Topic>={r:t("r",["a"]),a:t("a",["b"]),b:t("b",ids),u:t("u",["g"]),g:t("g")};
  for(const id of ids.slice(1))topics[id]=t(id);
  topics.v={...topics.v,text:"宽节点预约管理123".repeat(7)};
  for(const side of ["left","right"] as const)for(const spacing of [4,17,80])for(const scale of [.5,1,2]){
    const map:MindMap={...original,rootId:"r",topics,layout:side,spacing,scale};
    const get=(id:string)=>topicBox(map,id)!.box,near=(n:number,m:number)=>assert(Math.abs(n-m)<1e-6);
    const inner=(id:string)=>get(id).at.x+(side==="right"?0:get(id).width);
    const outer=(id:string)=>get(id).at.x+(side==="left"?0:get(id).width);
    const gap=(30+spacing*.65)*scale,scene=buildScene({...mixed,order:[map.id],objects:{[map.id]:map}})[0];
    for(const id of [...ids,"g"]){
      const parent=id==="g"?"u":"b",b=get(id),p=get(parent);near(Math.abs(inner(id)-outer(parent)),gap);
      const edge=scene.items.find(i=>i.kind==="path"&&Math.abs(i.points[3].x-inner(id))<1e-7&&Math.abs(i.points[3].y-b.at.y-b.height)<1e-7);
      assert(edge?.kind==="path"&&edge.junction);near(edge.points[2].y,edge.points[3].y);near(edge.points[0].y,edge.points[1].y);
      near(edge.points[0].x,outer(parent));near(edge.points[0].y,p.at.y+p.height*(parent==="u"?1:.5));
      const rule=scene.items.find(i=>i.kind==="box"&&i.underline&&Math.abs(i.box.at.x-b.at.x)<1e-7&&i.box.at.y===b.at.y);
      assert(rule?.kind==="box");assert.equal(rule.underline,id==="u"?"joined":side);near(edge.junction.end,rule.strokeWidth!);
      near(edge.width,1.8*scale);if(parent==="u")near(edge.junction.start!,edge.width);
    }
    for(let i=1;i<ids.length;i++){const prev=get(ids[i-1]);near(get(ids[i]).at.y-prev.at.y-prev.height,spacing*.65*scale);}
    const center=(id:string)=>get(id).at.x+get(id).width/2;
    near(Math.abs(center("a")-center("r")),(199+spacing)*scale);near(Math.abs(center("b")-center("a")),(188+spacing*.8)*scale);
  }
});
