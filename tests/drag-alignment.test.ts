import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DragAlignment} from "../session/drag-alignment.ts";
import {SceneProjection} from "../scene/projector.ts";
import {alignmentBounds,buildScene} from "../scene/board.ts";
import {EditorSession} from "../session/editor.ts";
import {planMove,moveObjects} from "../session/transform.ts";
import {localToWorld} from "../core/geometry.ts";
import type {Camera,Point,Rect} from "../core/geometry.ts";
import type {BoardDocument,BoardObject,Connector,MindMap,ShapeObject} from "../core/document.ts";
import {resolveEndpoint} from "../core/document.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {largeBoard} from "./fixtures/large-board.ts";
import {verifyLowZoomAccess} from "./fixtures/drag-alignment-access.ts";

const p=(x:number,y:number):Point=>({x,y}),rect=(x:number,y:number,w:number,h:number):Rect=>({min:p(x,y),max:p(x+w,y+h)});
const src=rect(0,0,20,10),view=rect(-1000,-1000,2000,2000),cam={zoom:1,offset:p(0,0)};
const target=(id:string,x:number,y:number,w=20,h=10)=>({id,bounds:rect(x,y,w,h)});
type Reference=ReturnType<typeof target>;
const helper=(items:Reference[],zoom=1,viewport=view)=>new DragAlignment(src,viewport,zoom,()=>items);
const one=decodeProject(readFileSync(new URL("../docs/fixtures/M5V-Drag-Alignment.mgcanvas",import.meta.url),"utf8")).document;
const shape=(id:string,x:number,y:number,w=20,h=10):ShapeObject=>({...one.objects.a as ShapeObject,id,at:p(x,y),width:w,height:h});
const board=(rows:BoardObject[]):BoardDocument=>({...one,objects:Object.fromEntries(rows.map(n=>[n.id,n])),order:rows.map(n=>n.id)});
const encode=(d:BoardDocument)=>encodeProject(d,new AssetVault());
const near=(a:number,b:number)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function setup(doc=one,camera:Camera=cam){
  const index=new SceneProjection(doc),e=new EditorSession(doc,camera,(ids,c)=>index.prepareDrag(ids,view,c.zoom));
  e.listen(change=>{if(change)index.update(e.doc,change);});return e;
}
test("CSS acquisition/release bands are inclusive, keep the old line through jitter and rearm only inside the entry band",()=>{
  for(const z of [.05,1,16]){
    const t=1024/z,a=helper([target("near",t,32/z)],z,rect(-100/z,-100/z,2000/z,2000/z)),ideal=t-src.max.x;
    const sample=(css:number,locked:boolean)=>{
      const raw=ideal-css/z,d=a.resolve(p(raw,0));near(d.x,locked?ideal:raw);
      assert.equal(a.guides.some(g=>g.axis==="x"),locked);
      if(locked)assert.equal(a.guides.find(g=>g.axis==="x")!.at,t);
    };
    sample(4.1,false);sample(4,true);sample(7.9,true);sample(8,true);sample(8.1,false);sample(4.1,false);sample(3.9,true);
  }
});
test("anchor ties are deterministic and the two axes choose independently",()=>{
  const first=target("z",100,45),second=target("a",108,45),raw=p(84,31);
  for(const list of [[first,second],[second,first]]){
    const a=helper(list);assert.deepEqual(a.resolve(raw),p(88,35));
    assert.deepEqual(a.guides.map(g=>[g.axis,g.at,g.targetId]),[["x",108,"a"],["y",45,"z"]]);
    // z is now closer; the previous x latch is still within its release band.
    assert.equal(a.resolve(p(81,31)).x,88);
  }
  const center=helper([target("wide",100,30,60,60)]);
  assert.deepEqual(center.resolve(p(117,54)),p(120,55));assert.deepEqual(center.guides.map(g=>g.at),[130,60]);
  const side=helper([target("wide",100,34,60,60)]);assert.equal(side.resolve(p(97,0)).x,100);
  const stationary=helper([target("other",70,3)]);assert.equal(stationary.resolve(p(48,0)).y,0);
});
test("either edge and the center of a dragged box can meet every anchor of a neighbor on both axes",()=>{
  const fixed=target("fixed",100,100,60,60);
  for(const x of [0,10,20])for(const y of [0,5,10]){
    for(const targetX of [100,130,160])for(const targetY of [100,130,160]){
      const a=helper([fixed]),ideal=p(targetX-x,targetY-y);
      assert.deepEqual(a.resolve(p(ideal.x-1,ideal.y+1)),ideal);
      assert.deepEqual(a.guides.map(g=>[g.kind,g.axis,g.at]),[["alignment","x",targetX],["alignment","y",targetY]]);
    }
  }
});

const oriented=(axis:"x"|"y",along:number,across:number):Point=>axis==="x"?p(along,across):p(across,along);
test("unequal-size objects snap before, between and after adjacent neighbors on either axis, with two equal edge gaps",()=>{
  for(const axis of ["x","y"] as const){
    const box=(start:number,length:number):Rect=>({min:oriented(axis,start,0),max:oriented(axis,start+length,24)});
    const first={id:"a",bounds:box(180,40)},second={id:"b",bounds:box(300,60)};
    for(const targets of [[first,second],[second,first]]){
      for(const [ideal,spans] of [[80,[[100,180],[220,300]]],[250,[[220,250],[270,300]]],[440,[[220,300],[360,440]]]] as const){
        const drag=new DragAlignment(box(0,20),view,1,()=>targets);
        assert.deepEqual(drag.resolve(oriented(axis,ideal-3,0)),oriented(axis,ideal,0));
        assert.deepEqual(drag.guides.filter(g=>g.kind==="spacing").map(g=>[g.axis,g.from,g.to,g.at]),
          spans.map(([from,to])=>[axis,from,to,16]));
      }
    }
  }
});
test("spacing uses screen acquisition and release distances, including reversal and a stationary Alt bypass",()=>{
  for(const z of [.05,1,16]){
    const box=(x:number,w:number)=>rect(x/z,0,w/z,40/z);
    const drag=new DragAlignment(box(0,48),rect(-200/z,-100/z,1000/z,400/z),z,
      ()=>[{id:"a",bounds:box(48,64)},{id:"b",bounds:box(160,80)}]);
    const ideal=288/z;
    for(const [css,locked] of [[4.1,false],[4,true],[-8,true],[-8.1,false],[-5,false],[-3,true]] as const){
      const raw=ideal+css/z;near(drag.resolve(p(raw,0)).x,locked?ideal:raw);
      assert.equal(drag.guides.filter(g=>g.kind==="spacing").length,locked?2:0);
    }
    const raw=p(ideal+3/z,0);assert.deepEqual(drag.resolve(raw,true),raw);assert.deepEqual(drag.guides,[]);
    near(drag.resolve(raw).x,ideal);assert.deepEqual(drag.resolve(p(0,0)),p(0,0));assert.deepEqual(drag.guides,[]);
  }
});
test("a fourth element continues the existing edge gap at either end of a run",()=>{
  const row=[target("a",100,0,40,10),target("b",160,0,100,10),target("c",280,0,80,10)];
  for(const [pointer,left,gaps] of [[57,60,[[80,100],[140,160]]],[378,380,[[260,280],[360,380]]]] as const){
    const drag=helper(row);assert.equal(drag.resolve(p(pointer,0)).x,left);
    assert.deepEqual(drag.guides.filter(g=>g.kind==="spacing").map(g=>[g.from,g.to]),gaps);
  }
});
test("spacing requires adjacent neighbors with a shared visible row, and keeps hidden layers and the moving selection out",()=>{
  const rows=[shape("a",180,0,40,30),shape("b",300,0,60,30),shape("obstacle",380,0),shape("s",0,0)];
  const index=new SceneProjection(board(rows));
  const solve=()=>index.prepareDrag(["s"],view,1).alignment!;
  let a=solve();assert.equal(a.resolve(p(438,0)).x,438);assert(!a.guides.some(g=>g.kind==="spacing"));
  index.setHidden(new Set(["obstacle"]));a=solve();assert.equal(a.resolve(p(438,0)).x,440);
  index.setHidden(new Set(["b","obstacle"]));a=solve();assert.equal(a.resolve(p(438,0)).x,438);
  const disjoint=helper([target("left",180,-8,40,10),target("right",300,8,60,10)]);
  assert.equal(disjoint.resolve(p(438,0)).x,438);assert(!disjoint.guides.some(g=>g.kind==="spacing"));
  const selected=new SceneProjection(board(rows.slice(0,2).concat(rows[3]))).prepareDrag(["a","s"],view,1).alignment!;
  selected.resolve(p(438,0));assert(!selected.guides.some(g=>g.kind==="spacing"));
});
test("the actual multi-selection preview, release and undo use the same measured gutters",()=>{
  const rows=[shape("a",0,0,20,20),shape("b",30,0,10,20),shape("left",100,0,140,30),shape("right",390,0,90,30)];
  const e=setup(board(rows)),initial=encode(e.doc);
  e.select("a");e.select("b",true);e.down(1,"mouse",p(10,10),"a",false);
  const end=p(302,10);e.move(1,end);
  const rulers=()=>e.alignmentGuides?.filter(g=>g.kind==="spacing").map(g=>[g.from,g.to]);
  assert.deepEqual(rulers(),[[240,295],[335,390]]);
  assert.deepEqual((e.preview!.objects.get("a") as ShapeObject).at,p(295,0));
  assert.deepEqual((e.preview!.objects.get("b") as ShapeObject).at,p(325,0));
  assert.equal(encode(e.doc),initial);assert.equal(e.history.past.length,0);
  e.setMoveBypass(true);assert.deepEqual(rulers(),[]);assert.deepEqual((e.preview!.objects.get("a") as ShapeObject).at,p(292,0));
  e.setMoveBypass(false);assert.deepEqual(rulers(),[[240,295],[335,390]]);
  e.up(1,end);assert(!e.alignmentGuides?.length);assert.equal(e.history.past.length,1);
  assert.deepEqual((e.doc.objects.a as ShapeObject).at,p(295,0));assert.deepEqual((e.doc.objects.b as ShapeObject).at,p(325,0));
  assert.deepEqual(e.doc.objects.left,rows[2]);assert.deepEqual(e.doc.objects.right,rows[3]);
  const moved=encode(e.doc);e.undo();assert.equal(encode(e.doc),initial);e.redo();assert.equal(encode(e.doc),moved);
});
test("spacing rulers stay in the clear part of a row and cannot cross a covering element",()=>{
  const pair=[target("a",180,0,40,10),target("b",300,0,60,10)];
  const partial=target("block",380,0,20,6),drag=helper([...pair,partial]);
  assert.equal(drag.resolve(p(438,0)).x,440);
  assert.deepEqual(drag.guides.filter(g=>g.kind==="spacing").map(g=>g.at),[8,8]);
  const covered=helper([...pair,target("cover",130,-5,260,25)]);
  assert.equal(covered.resolve(p(438,0)).x,438);assert(!covered.guides.some(g=>g.kind==="spacing"));
});

test("center alignment leaves node interiors clear and both equal gaps readable, in rows and columns",()=>{
  for(const axis of ["x","y"] as const){
    const box=(along:number,across:number,length:number,height:number):Rect=>({
      min:oriented(axis,along,across),max:oriented(axis,along+length,across+height)});
    const neighbors=[{id:"first",bounds:box(70,67,158,150)},{id:"second",bounds:box(298,67,158,150)}];
    const drag=new DragAlignment(box(0,0,144,90),view,1,()=>neighbors);
    assert.deepEqual(drag.resolve(oriented(axis,524,96)),oriented(axis,526,97));
    const alignment=drag.guides.find(g=>g.kind==="alignment")!;
    assert.equal(alignment.at,142);assert.equal(alignment.source,1);assert.equal(alignment.edge,1);
    assert.deepEqual(alignment.runs,[{min:294,max:296},{min:458,max:524},{min:672,max:674}]);
    const rulers=drag.guides.filter(g=>g.kind==="spacing");
    assert.deepEqual(rulers.map(g=>[g.from,g.to,g.at,g.label]),[[228,298,179,"70"],[456,526,179,"70"]]);
    drag.resolve(oriented(axis,527,99));
    assert.deepEqual(drag.guides.filter(g=>g.kind==="spacing").map(g=>g.at),[179,179]);
  }
});

test("parallel guides yield the measured gaps to the rulers when a row is too thin to separate them",()=>{
  const row=[target("a",100,0,40,10),target("b",160,0,100,10)];
  const drag=helper(row);
  assert.deepEqual(drag.resolve(p(278,0)),p(280,0));
  const align=drag.guides.find(g=>g.kind==="alignment")!,gaps=drag.guides.filter(g=>g.kind==="spacing");
  assert.equal(gaps.length,2);assert.equal(align.at,gaps[0].at);
  for(const ruler of gaps)assert(align.runs.every(run=>run.max<=ruler.from||run.min>=ruler.to));
});
test("one drag can match distinct horizontal and vertical gaps at once",()=>{
  const drag=helper([target("left",40,210,50,20),target("right",170,210,30,20),
    target("above",115,110,35,30),target("below",115,290,35,20)]);
  assert.deepEqual(drag.resolve(p(118,208)),p(120,210));
  assert.deepEqual(drag.guides.map(g=>[g.kind,g.axis,g.to-g.from]),
    [["spacing","x",30],["spacing","x",30],["spacing","y",70],["spacing","y",70]]);
});
test("a gap that cannot be bisected with an integer translation does not advertise equal spacing",()=>{
  const e=setup(board([shape("a",0,0),shape("left",100,0,50,20),shape("right",211,0,50,20)]));
  e.select("a");e.down(1,"mouse",p(10,5),"a",false);e.move(1,p(179,5));
  assert.deepEqual((e.preview!.objects.get("a") as ShapeObject).at,p(169,0));
  assert(!e.alignmentGuides?.some(g=>g.kind==="spacing"));
});
test("nearby-only matching, per-axis visibility, clipped guides and bypass all release stale targets",()=>{
  const t=target("fixed",100,100),a=helper([t],1,rect(0,0,160,112));
  assert.equal(a.resolve(p(77,17)).x,77); // 73 CSS px across the other axis.
  assert.equal(a.resolve(p(77,18)).x,80);
  assert.equal(a.guides[0].from,14);assert.equal(a.guides[0].to,112);
  assert.equal(a.resolve(p(75,7)).x,80);assert.equal(a.resolve(p(75,5)).x,75);
  a.resolve(p(77,18));assert.deepEqual(a.resolve(p(77,18),true),p(77,18));assert.deepEqual(a.guides,[]);
  assert.equal(a.resolve(p(75,18)).x,75);assert.equal(a.resolve(p(78,18)).x,80);
  assert.deepEqual(a.resolve(p(0,0)),p(0,0));assert.deepEqual(a.guides,[]);
  a.resolve(p(400,400));assert.deepEqual(a.guides,[]);
  const clipped=helper([target("partial",150,44,80,20)],1,rect(0,0,160,160));
  clipped.resolve(p(178,42));assert(!clipped.guides.some(g=>g.at===190),"offscreen target center is not a guide");
});
test("ordinary snapped group move uses one preview and one history frame for nodes, internal manual bends and crossing bound endpoints",()=>{
  const e=setup(),old=encode(e.doc),beforeCross=e.doc.objects.cross,from=p(60,85),end=p(107,107);
  e.select("a");e.select("b",true);e.down(9,"mouse",from,"a",false);e.move(9,end);
  assert.equal(e.history.past.length,0);assert.equal(encode(e.doc),old);assert.equal(e.alignmentGuides!.length,2);
  const expect=moveObjects(planMove(e.doc,["a","b"]),p(50,24));assert.deepEqual(e.preview!.objects,expect);
  const projected=buildScene(e.doc,e.preview),cross=projected.find(g=>g.id==="cross")!;
  assert.deepEqual((cross.items[0] as {points:Point[]}).points[0],p(220,109));
  e.up(9,end);assert.equal(e.history.past.length,1);assert(!e.alignmentGuides?.length);
  const after=e.doc;assert.deepEqual((after.objects.a as ShapeObject).at,p(90,94));assert.deepEqual((after.objects.b as ShapeObject).at,p(180,94));
  const internal=after.objects.internal as Connector,external=after.objects.cross as Connector;
  assert.deepEqual(internal.waypoints,[p(146,79),p(164,79)]);assert.equal(external,beforeCross);
  assert.deepEqual(resolveEndpoint(after,external.from),p(220,109));assert.deepEqual(resolveEndpoint(after,external.to),p(400,243));
  const saved=encode(after);assert.equal(encode(decodeProject(saved).document),saved);e.undo();assert.equal(encode(e.doc),old);e.redo();assert.equal(encode(e.doc),saved);
});
test("a snapped mixed selection translates every origin together while preserving curve handles, pressure, image assets and topic structure",()=>{
  const sample=decodeProject(readFileSync(new URL("../docs/fixtures/M5S-Cubic-Paths.mgcanvas",import.meta.url),"utf8"));
  const base=sample.document,ids=base.order.filter(id=>base.objects[id].kind!=="connector");
  const bounds=buildScene(base,undefined,ids).map(group=>alignmentBounds(base.objects[group.id],group.bounds));
  const right=Math.max(...bounds.map(b=>b.max.x)),wall=shape("alignment-target",right+45,0,60,60);
  const doc={...base,order:[...base.order,wall.id],objects:{...base.objects,[wall.id]:wall}};
  const e=setup(doc),vault=new AssetVault(sample.assets),original=encodeProject(e.doc,vault);
  ids.forEach((id,i)=>e.select(id,i>0));
  const grab=p(-175,-100),end=p(-132,-100),expected=moveObjects(planMove(e.doc,ids),p(45,0));
  e.down(3,"mouse",grab,"flow-submit",false);e.move(3,end);
  assert.deepEqual(e.preview!.objects,expected);assert.equal(e.alignmentGuides?.find(g=>g.axis==="x")?.targetId,wall.id);
  assert.equal(encodeProject(e.doc,vault),original);assert.equal(e.history.past.length,0);e.up(3,end);
  for(const id of ids){assert(expected.has(id),id);assert.deepEqual(e.doc.objects[id],expected.get(id),id);}
  assert.deepEqual(e.doc.objects[wall.id],wall);assert.equal(e.history.past.length,1);
  const encoded=encodeProject(e.doc,vault),reopened=decodeProject(encoded);
  assert.equal(encodeProject(reopened.document,new AssetVault(reopened.assets)),encoded);
  e.undo();assert.equal(encodeProject(e.doc,vault),original);
});
test("pointer-up samples, stationary Alt toggles, zero-net moves and programmatic exact moves use the requested delta",()=>{
  const e=setup();e.select("a");const start=p(60,85),end=p(107,85);
  e.down(1,"mouse",start,"a",false);e.move(1,end);assert.equal((e.preview!.objects.get("a") as ShapeObject).at.x,90);
  e.setMoveBypass(true);assert.equal((e.preview!.objects.get("a") as ShapeObject).at.x,87);assert.deepEqual(e.alignmentGuides,[]);
  e.setMoveBypass(false);assert.equal((e.preview!.objects.get("a") as ShapeObject).at.x,90);e.up(1,end,undefined,false,true);
  assert.deepEqual((e.doc.objects.a as ShapeObject).at,p(87,70));e.undo();
  e.down(1,"mouse",start,"a",false);e.up(1,end);assert.deepEqual((e.doc.objects.a as ShapeObject).at,p(90,70));e.undo();
  e.down(1,"mouse",start,"a",false);e.move(1,end);e.up(1,start);assert.equal(e.history.past.length,0);
  assert(e.moveSelection(p(47,0)));assert.deepEqual((e.doc.objects.a as ShapeObject).at,p(87,70));
  e.undo();assert(e.transformSelection({x:87,y:70}));assert.deepEqual((e.doc.objects.a as ShapeObject).at,p(87,70));
});
test("cancel, capture loss, second contact, tool/camera/selection and board changes discard guides and late releases",()=>{
  for(const reason of ["cancel","capture","pinch","tool","camera","selection","open"]){
    const e=setup(),old=encode(e.doc);e.select("a");
    e.down(1,"touch",p(60,85),"a",false);e.move(1,p(107,85));assert(e.alignmentGuides!.length);
    if(reason==="cancel")e.cancel();if(reason==="capture")e.pointerCancelled(1);
    if(reason==="pinch"){e.down(2,"touch",p(205,180),undefined,false);e.move(2,p(225,213));assert(e.camera.zoom>1);e.up(2,p(225,213));}
    if(reason==="tool")e.setTool("hand");if(reason==="camera")e.setCamera({...cam,zoom:2});
    if(reason==="selection")e.select("target");if(reason==="open")e.open(one,true);
    assert(!e.alignmentGuides?.length);assert.equal(e.preview,undefined);e.up(1,p(110,85));
    assert.equal(encode(e.doc),old);assert.equal(e.history.past.length,0);
  }
});
test("targets are visible committed objects, excluding the drag set, connectors, preview-only IDs and collapsed topics",()=>{
  const a=shape("a",0,0),off=shape("off",100,106),edge:Connector={...one.objects.internal as Connector,id:"line",
    from:{kind:"free",point:p(100,40)},to:{kind:"free",point:p(160,80)},waypoints:[]};
  const doc=board([a,off,edge]),index=new SceneProjection(doc),viewport=rect(-10,-10,200,110);
  const phantom=shape("draft",100,45);
  assert(index.overlay({objects:new Map([[phantom.id,phantom]])}).has("draft"));
  const search=index.prepareDrag(["a","line"],viewport,1).alignment!;
  assert.deepEqual(search.resolve(p(78,48)),p(78,48));assert.deepEqual(search.guides,[]);
  assert.equal(index.prepareDrag(["line"],viewport,1).alignment,undefined);
  const selected=index.prepareDrag(["a","off"],view,1).alignment!;
  selected.resolve(p(1,1));assert.deepEqual(selected.guides,[]);
  const map=largeBoard(10).document.objects["m-9"] as MindMap;
  const collapsed={...map,topics:{...map.topics,[map.rootId]:{...map.topics[map.rootId],collapsed:true}}};
  const visible=buildScene(board([map]))[0].bounds,hidden=buildScene(board([collapsed]))[0].bounds;
  assert(visible.max.x-hidden.max.x>10);const offset=p(visible.max.x-20-2,(hidden.max.y+hidden.min.y)/2);
  const expanded=new SceneProjection(board([a,map])).prepareDrag(["a"],view,1).alignment!;
  assert.equal(expanded.resolve(offset).x,visible.max.x-20);assert.equal(expanded.guides.find(g=>g.axis==="x")!.targetId,map.id);
  const folded=new SceneProjection(board([a,collapsed])).prepareDrag(["a"],view,1).alignment!;
  assert.equal(folded.resolve(offset).x,offset.x);assert(!folded.guides.some(g=>g.axis==="x"));
});
test("rotated outline edges match explicit alignment geometry and the indexed motion plan matches the original scan",()=>{
  const tri:ShapeObject={...shape("tri",60,60,100,50),shape:"triangle",rotation:-Math.PI/4};
  const doc=board([tri,shape("a",-80,60)]),group=buildScene(doc)[0],bounds=alignmentBounds(tri,group.bounds);
  const xs=[p(50,0),p(100,50),p(0,50)].map(pt=>localToWorld(pt,tri).x);
  near(bounds.min.x,Math.min(...xs));assert(bounds.min.x>group.bounds.min.x+.1);
  const aligned=new SceneProjection(doc).prepareDrag(["a"],view,1).alignment!;
  near(aligned.resolve(p(bounds.min.x+60-2,0)).x,bounds.min.x+60);
  const extra:Connector={...one.objects.internal as Connector,id:"free",from:{kind:"free",point:p(3,4)},to:{kind:"free",point:p(100,75)}};
  const many=board([...Object.values(one.objects),extra]),idx=new SceneProjection(many);
  for(const selected of [["a"],["a","b"],["a","b","cross","free"],["internal","free"],many.order]){
    const indexed=moveObjects(idx.prepareDrag(selected,view,1).plan,p(7,-13)),baseline=moveObjects(planMove(many,selected),p(7,-13));
    assert.deepEqual(indexed,baseline);
  }
});
test("1920 × 1080 at 5%: 20,000 distant ordinary shapes change neither per-sample visits nor snapped positions and guides",()=>{
  const result=verifyLowZoomAccess();
  assert.equal(result.extended.objects-result.baseline.objects,20000);assert.equal(result.extended.farLookups,0);
});
test("dense or overwide regions fall back to raw movement and regular local samples never enumerate a large document",()=>{
  const dense=board(Array.from({length:600},(_,i)=>shape("n"+i,50+i%10,50)));
  const busy=new SceneProjection(dense).prepareDrag(["n0"],view,1).alignment!;
  assert.deepEqual(busy.resolve(p(3,5)),p(3,5));assert.deepEqual(busy.guides,[]);
  const broad=new SceneProjection(board([shape("wide",0,0,80000,5000),shape("n",80024,60)]));
  const full=broad.prepareDrag(["wide"],rect(-100,-100,81000,6000),1).alignment!;
  assert.deepEqual(full.resolve(p(22,10)),p(22,10));assert.deepEqual(full.guides,[]);
  const source=largeBoard(6000).document;let reads=0,watch=false;
  const guarded={...source,objects:new Proxy(source.objects,{
    get(target,key){if(watch)reads++;return Reflect.get(target,key);},
    ownKeys(target){assert(!watch,"enumerated the full board during drag");return Reflect.ownKeys(target);}
  })};
  const idx=new SceneProjection(guarded);watch=true;
  const drag=idx.prepareDrag(["s-0","s-1"],rect(0,0,800,550),1);
  for(let i=0;i<50;i++)drag.alignment!.resolve(p(36+i%6,12+i%8));
  assert(reads>0&&reads<50*100);assert.equal(drag.plan.movers.length,2);
});
