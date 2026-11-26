import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {BoardDocument} from "../core/document.ts";
import {diffDocuments} from "../core/history.ts";
import {portWorld} from "../core/geometry.ts";
import {newCard} from "../features/card-content.ts";
import {createTable} from "../features/table.ts";
import {SceneMotion} from "../scene/motion.ts";
import {SceneProjection} from "../scene/projector.ts";
import {hitTest} from "../scene/board.ts";
import {revealPrimitive} from "../renderers/canvas2d/reveal.ts";
import {decodeProject} from "../platform/project.ts";

const data=decodeProject(readFileSync(new URL("../docs/fixtures/M5S-Cubic-Paths.mgcanvas",import.meta.url),"utf8")).document;
const extra=[newCard("sticky",{x:80,y:200},"便签"),newCard("markdown",{x:260,y:160},"# 标题"),createTable({x:470,y:0})];
const doc:BoardDocument={...data,schemaVersion:6,objects:{...data.objects,...Object.fromEntries(extra.map(x=>[x.id,x]))},
  order:[...data.order,...extra.map(x=>x.id)]};
const empty:BoardDocument={...doc,objects:{},order:[]};
const region={min:{x:-10000,y:-10000},max:{x:10000,y:10000}};
function harness(initial:BoardDocument){
  const motion=new SceneMotion(),scene=new SceneProjection(initial);
  let before=initial;
  function commit(after:BoardDocument,now:number,direct=false,writingInk=false){
    const delta=diffDocuments(before,after),shown=scene.overlay({objects:motion.objects});
    const old=motion.capture(delta,id=>scene.group(id,shown),id=>scene.paintOrder(id));
    scene.update(after,delta);
    motion.transition(before,after,delta,old,id=>scene.group(id),region,now,direct,writingInk);before=after;
  }
  return {motion,scene,commit};
}
test("every visible object enters and exits together; ghost groups keep paint order and leave hit testing immediately",()=>{
  const {motion,scene,commit}=harness(empty),initial=JSON.stringify(doc);
  commit(doc,100);assert.equal(motion.paint.size,doc.order.length);
  motion.tick(164);const ink=[...motion.paint.values()][0].alpha;assert(ink>0&&ink<1);
  commit(empty,165);assert.equal(hitTest(scene.all(),{x:-180,y:-110},5),undefined);
  assert.deepEqual(motion.drawList([],id=>scene.paintOrder(id)).map(g=>g.id),doc.order);
  assert.equal([...motion.paint.values()][0].alpha,ink);
  motion.tick(225);const departing=[...motion.paint.values()][0].alpha;assert(departing>0&&departing<ink);
  commit(doc,225);assert.equal([...motion.paint.values()][0].alpha,departing);
  motion.tick(500);assert(!motion.active);assert.equal(motion.paint.size,0);
  assert.equal(motion.drawList(scene.all(),id=>scene.paintOrder(id)),scene.all());
  assert.equal(JSON.stringify(doc),initial);
});
test("retargeted layout and drag handoff start at the visible pose while bound connector geometry follows the node",()=>{
  const source=doc.objects["flow-submit"];assert.equal(source.kind,"shape");if(source.kind!=="shape")return;
  const shifted=(dx:number):BoardDocument=>({...doc,objects:{...doc.objects,[source.id]:{...source,at:{x:source.at.x+dx,y:source.at.y}}}});
  const {motion,scene,commit}=harness(doc);
  commit(shifted(300),100);motion.tick(150);
  const seen=motion.objects.get(source.id);assert(seen?.kind==="shape");assert(seen.at.x>source.at.x&&seen.at.x<source.at.x+300);
  const patch=scene.overlay({objects:motion.objects});
  const connector=Object.values(doc.objects).find(o=>o.kind==="connector"&&o.from.kind==="anchor"&&o.from.objectId===source.id);
  assert(connector?.kind==="connector"&&connector.from.kind==="anchor");
  const route=patch.get(connector.id)?.items.find(x=>x.kind==="path");
  assert(route?.kind==="path");assert.deepEqual(route.points[0],portWorld(seen,seen.shape,connector.from.portId));
  const setup=scene.prepareDrag([source.id],region,1,undefined,motion.objects,patch);
  const held=setup.plan.movers[0];assert(held.kind==="shape");assert.equal(held.at.x,Math.round(seen.at.x));
  commit(shifted(-100),151);assert.deepEqual((motion.objects.get(source.id) as typeof seen).at,seen.at);
  commit(shifted(35),165,true);assert(!motion.objects.has(source.id));assert(!motion.active);
});
test("newly drawn ink bypasses entrance and a partial line keeps its arrowhead at the advancing tip",()=>{
  const ink=Object.values(doc.objects).find(o=>o.kind==="ink")!;
  const {motion,commit}=harness(empty);
  commit({...empty,objects:{[ink.id]:ink},order:[ink.id]},0,false,true);assert(!motion.active);
  commit(empty,30,false,true);assert(!motion.active);
  commit(doc,60,true);assert(!motion.active); // Drag copies have already been painted at full opacity.
  const path=revealPrimitive({kind:"path",points:[{x:0,y:0},{x:40,y:0},{x:40,y:60}],width:2,color:"#123456",arrow:"end"},.5);
  assert(path.kind==="path");assert.deepEqual(path.points.at(-1),{x:40,y:10});assert.deepEqual(path.arrows?.heads[0][0],{x:40,y:10});
});
