import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEndpoint } from "../core/document.ts";
import type { BoardDocument, BoardObject, Connector, ShapeObject } from "../core/document.ts";
import { localToWorld } from "../core/geometry.ts";
import type { Point } from "../core/geometry.ts";
import { arrangeLayerOrder, arrangeSelection, canArrange } from "../features/arrange.ts";
import type { ArrangeCommand } from "../features/arrange.ts";
import { buildScene } from "../scene/board.ts";
import { EditorSession } from "../session/editor.ts";
import { mixed } from "./fixtures/mixed.ts";

const p=(x:number,y:number)=>({x,y});
const approx=(a:number,b:number)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const e=(doc:BoardDocument=mixed)=>new EditorSession(doc,{offset:p(0,0),zoom:1});
const select=(editor:EditorSession,ids:readonly string[])=>ids.forEach((id,i)=>editor.select(id,i>0));
const shape=(id:string,x:number,y:number,w:number,h:number):ShapeObject=>({...mixed.objects["shape-start"],id,at:p(x,y),width:w,height:h});
const doc=(items:readonly BoardObject[]):BoardDocument=>({
  ...mixed,assets:{},order:items.map(item=>item.id),objects:Object.fromEntries(items.map(item=>[item.id,item])),
});
function bounds(editor:EditorSession,id:string){
  const group=buildScene(editor.doc,undefined,[id])[0];assert(group);return group.bounds;
}
function checkInside(doc:BoardDocument,line:Connector,expected:Point,field:"from"|"to"="from"){
  const position=resolveEndpoint(doc,line[field]);assert(position);approx(position.x,expected.x);approx(position.y,expected.y);
}

test("layer commands preserve selected internal order and step each run over one neighbor",()=>{
  const order=["a","b","c","d","e","f","g"], chosen=["f","b","c"];
  assert.deepEqual(arrangeLayerOrder(order,chosen,"front"),["a","d","e","g","b","c","f"]);
  assert.deepEqual(arrangeLayerOrder(order,chosen,"back"),["b","c","f","a","d","e","g"]);
  assert.deepEqual(arrangeLayerOrder(order,chosen,"forward"),["a","d","b","c","e","g","f"]);
  assert.deepEqual(arrangeLayerOrder(order,chosen,"backward"),["b","c","a","d","f","e","g"]);
  const editor=e(),before=editor.doc;
  select(editor,["shape-start","link-main","map-a"]);
  assert(arrangeSelection(editor,"front"));assert.deepEqual(editor.doc.order.slice(-3),["shape-start","link-main","map-a"]);
  assert(!canArrange(editor,"forward"));assert.equal(editor.history.past.length,1);
  assert.deepEqual(editor.selectedIds,["shape-start","link-main","map-a"]);
  editor.undo();assert.strictEqual(editor.doc,before);
});

test("six alignments use shared axes, preserve the perpendicular coordinates, and undo once",()=>{
  const cases:readonly [ArrangeCommand,"x"|"y","min"|"max"|"middle"][]=[
    ["left","x","min"],["center","x","middle"],["right","x","max"],
    ["top","y","min"],["middle","y","middle"],["bottom","y","max"],
  ];
  for(const [command,axis,edge] of cases){
    const editor=e();
    const selected=["shape-start","picture","map-b"];
    select(editor,selected);
    const before=editor.doc, originals=selected.map(id=>bounds(editor,id));
    const min=Math.min(...originals.map(box=>box.min[axis])),max=Math.max(...originals.map(box=>box.max[axis]));
    const target=edge==="min"?min:edge==="max"?max:(min+max)/2, other=axis==="x"?"y":"x";
    assert(arrangeSelection(editor,command));
    for(const [i,id] of selected.entries()){
      const b=bounds(editor,id);
      const initial=edge==="middle"?(originals[i].min[axis]+originals[i].max[axis])/2:originals[i][edge][axis];
      approx(edge==="middle"?(b.min[axis]+b.max[axis])/2:b[edge][axis],initial+Math.round(target-initial));
      approx(b.min[other],originals[i].min[other]);approx(b.max[other],originals[i].max[other]);
    }
    assert.strictEqual(editor.doc.objects["link-main"],before.objects["link-main"]);
    assert.equal(editor.history.past.length,1);
    assert(!arrangeSelection(editor,command));
    editor.undo();assert.strictEqual(editor.doc,before);
  }
});

test("alignment uses the vertices of a rotated triangle rather than invisible bounding box corners",()=>{
  const triangle:ShapeObject={...shape("triangle",80,40,90,40),shape:"triangle",rotation:Math.PI/5};
  const editor=e(doc([shape("reference",0,-100,30,30),triangle]));
  select(editor,["reference","triangle"]);
  assert(arrangeSelection(editor,"left"));
  const result=editor.doc.objects.triangle as ShapeObject;
  const visible=[p(45,0),p(90,40),p(0,40)].map(point=>localToWorld(point,result));
  const oldLeft=Math.min(...[p(45,0),p(90,40),p(0,40)].map(point=>localToWorld(point,triangle).x));
  approx(Math.min(...visible.map(point=>point.x)),oldLeft+Math.round(-oldLeft));
  assert.equal(result.rotation,triangle.rotation);
});

test("equal edge gaps anchor endpoints with mixed sizes on both axes",()=>{
  for(const axis of ["x","y"] as const){
    const editor=e(doc([shape("a",0,0,10,15),shape("b",37,22,25,10),shape("c",83,103,15,30),shape("d",110,130,25,10)]));
    select(editor,["d","b","a","c"]);
    const start=editor.doc;
    const cmd=axis==="x"?"distribute-x":"distribute-y";
    assert(arrangeSelection(editor,cmd));
    const b=["a","b","c","d"].map(id=>bounds(editor,id));
    const gaps=b.slice(1).map((next,k)=>next.min[axis]-b[k].max[axis]);
    for(const g of gaps)approx(g,gaps[0]);
    assert.strictEqual(editor.doc.objects.a,start.objects.a);assert.strictEqual(editor.doc.objects.d,start.objects.d);
    assert(!arrangeSelection(editor,cmd));
    editor.undo();assert.strictEqual(editor.doc,start);
  }
});

test("only an unbound line counts as movable; bound bends follow matching translations once",()=>{
  const a=shape("a",100,0,30,20),b=shape("b",100,70,30,20),c=shape("c",0,140,30,20);
  const bound:Connector={...mixed.objects["link-main"],id:"anchor",from:{kind:"anchor",objectId:"a",portId:"east"},
    to:{kind:"anchor",objectId:"b",portId:"east"},waypoints:[p(150,10),p(150,80)]};
  const free:Connector={...mixed.objects["free-line"],id:"free",from:{kind:"free",point:p(70,190)},to:{kind:"free",point:p(100,200)},waypoints:[p(80,194)]};
  const linear=e(doc([a,b,c,bound,free]));
  select(linear,["a","anchor"]);
  assert(!canArrange(linear,"left")&&!canArrange(linear,"distribute-x"));
  const before=linear.doc;
  select(linear,["a","b","c","anchor","free"]);
  assert(arrangeSelection(linear,"left"));
  const first=linear.doc.objects.anchor as Connector, second=linear.doc.objects.free as Connector;
  assert.deepEqual(first.from,bound.from);assert.deepEqual(first.to,bound.to);
  assert.deepEqual(first.waypoints,[p(50,10),p(50,80)]);
  checkInside(linear.doc,first,p(30,10));
  assert.deepEqual(second.from,{kind:"free",point:p(0,190)});
  assert.deepEqual(second.to,{kind:"free",point:p(30,200)});
  assert.deepEqual(second.waypoints,[p(10,194)]);
  linear.undo();assert.strictEqual(linear.doc,before);
  select(linear,["a","c"]);
  assert(arrangeSelection(linear,"left"));
  assert.strictEqual(linear.doc.objects.anchor,bound===before.objects.anchor?bound:before.objects.anchor);
  checkInside(linear.doc,linear.doc.objects.anchor as Connector,p(30,10));
  checkInside(linear.doc,linear.doc.objects.anchor as Connector,p(130,80),"to");
});

test("spacing no-op does not invent a transaction when overlap would reverse order",()=>{
  const editor=e(doc([shape("a",0,0,100,10),shape("b",2,0,5,10),shape("c",3,0,100,10)]));
  const before=editor.doc;
  select(editor,["a","b","c"]);
  assert(!arrangeSelection(editor,"distribute-x"));
  assert.strictEqual(editor.doc,before);assert.equal(editor.history.past.length,0);
});
