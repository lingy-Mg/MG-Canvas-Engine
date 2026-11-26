import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {assertDocument,resolveEndpoint} from "../core/document.ts";
import type {BoardDocument,Connector,ShapeObject} from "../core/document.ts";
import {flowGroupOf,groupUnit} from "../core/flow-groups.ts";
import {dispatch} from "../core/history.ts";
import {canArrange,arrangeSelection} from "../features/arrange.ts";
import {captureClipboard,encodeClipboard,decodeClipboard,pasteClipboard,duplicateClipboardSelection,cutClipboardSelection} from "../features/clipboard.ts";
import {connectToNewNode,deleteBoardSelection,setConnectorEnd} from "../features/flow.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {EditorSession} from "../session/editor.ts";

const fixture=(name:string)=>decodeProject(readFileSync(new URL("../docs/fixtures/"+name+".mgcanvas",import.meta.url),"utf8"));
const grouped=fixture("M5X-Flow-Groups").document,mixed=fixture("M5S-Cubic-Paths");
const A="group-intake",B="group-review",p=(x:number,y:number)=>({x,y}),camera={zoom:1,offset:p(0,0)};
const shape=(d:BoardDocument,id:string)=>d.objects[id] as ShapeObject;
const line=(d:BoardDocument,id:string)=>d.objects[id] as Connector;
const ordinary=(doc=grouped):BoardDocument=>{const {flowGroups,...rest}=doc;return {...rest,schemaVersion:flowGroups!.baseVersion};};
const editor=(doc=grouped)=>new EditorSession(doc,camera);
const bytes=(doc:BoardDocument)=>encodeProject(doc,new AssetVault(mixed.assets));
const groups=(e:EditorSession)=>Object.keys(e.doc.flowGroups?.members??{});
const select=(e:EditorSession,...ids:string[])=>ids.forEach((id,i)=>e.select(id,i>0));
const offset=(a:{x:number;y:number},delta:{x:number;y:number})=>p(a.x+delta.x,a.y+delta.y);
const native=(version:1|2|3|4):BoardDocument=>{
  const d=ordinary(),extra=["qa-picture","sample-ink","straight-path","closed-path"].slice(0,version);
  return {...d,schemaVersion:version,assets:mixed.document.assets,order:[...d.order,...extra],objects:{...d.objects,...Object.fromEntries(extra.map(id=>[id,mixed.document.objects[id]]))}};
};
test("forming and dissolving one explicit node group retain stacking, object identities and unrelated connected neighbors",()=>{
  const e=editor(ordinary()),start=bytes(e.doc),order=e.doc.order,before=e.doc.objects;
  select(e,"b","a","internal");assert(e.canGroup);assert(e.groupSelection());const g=e.selectedGroup!;
  assert.deepEqual(e.doc.flowGroups!.members[g],["b","a"]);assert.deepEqual(e.doc.order,order);
  assert.equal(e.doc.objects.a,before.a);assert(!flowGroupOf(e.doc,"outside"));assert(!flowGroupOf(e.doc,"cross"));
  assert.deepEqual(groupUnit(e.doc,g),["internal","a","b"]);assert.equal(e.history.past.length,1);
  assert(!e.groupSelection());assert(e.ungroupSelection());assert.equal(bytes(e.doc),start);assert.equal(e.history.past.length,2);
  e.undo();assert.equal(e.doc.flowGroups!.members[g].length,2);e.undo();assert.equal(bytes(e.doc),start);
  e.redo();e.redo();assert.equal(bytes(e.doc),start);
});
test("only shapes may be explicit members, including when nodes share a board with images, pressure, paths or a mind map",()=>{
  const e=editor(mixed.document);
  for(const id of ["qa-picture","sample-ink","mind-booking","qa-label","open-path","flow-first"]){
    select(e,"flow-display",id);assert(!e.canGroup);assert(!e.groupSelection());
  }
  select(e,"flow-submit","flow-review");assert(e.groupSelection());assert.equal(e.doc.flowGroups!.baseVersion,4);
  const before=e.doc;e.select("flow-submit");assert(e.moveSelection(p(18,5)));
  for(const id of ["sample-ink","mind-booking","qa-picture","closed-path","qa-label","flow-display"])assert.deepEqual(e.doc.objects[id],before.objects[id]);
  assert.deepEqual(decodeProject(bytes(e.doc)).assets,mixed.assets);
});
test("schema and group reference validation reject nesting, overlap, reserved IDs, missing/foreign kinds and counterfeit versions",()=>{
  const g=(members:unknown,baseVersion=1)=>({...grouped,flowGroups:{members,baseVersion}});
  const invalid=[{x:["a"]},{x:["a","a"]},{x:["a","none"]},{x:["a","internal"]},{x:["a","b"],y:["b","target"]},
    {a:["b","target"]},{x:["y","a"],y:["x","b"]},{x:["x","a"]},{},JSON.parse('{"__proto__":["a","b"]}')];
  for(const rows of invalid)assert.throws(()=>assertDocument(g(rows)));
  for(const schemaVersion of [1,2,3,4,6])assert.throws(()=>assertDocument({...grouped,schemaVersion}));
  assert.throws(()=>assertDocument({...ordinary(),schemaVersion:5}));assert.throws(()=>assertDocument(g({x:["a","b"]},4)));
  const d=native(1),asset=Object.keys(d.assets)[0];assert.throws(()=>assertDocument({...d,schemaVersion:5,flowGroups:{members:{[asset]:["a","b"]},baseVersion:1}}));
  const original=editor();
  assert.throws(()=>dispatch(original.history,{label:"invalid group",patches:[{op:"setFlowGroups",members:{x:["a","cross"]}}]}));
  for(const invalid of [null,[],0])assert.throws(()=>dispatch(original.history,{label:"malformed group patch",patches:[{op:"setFlowGroups",members:invalid as never}]}));
  assert.equal(original.history.past.length,0);assert.equal(bytes(original.doc),bytes(grouped));
});
test("ungrouped v1–v4 including legacy v2 without ink regain their original native bytes and object clipboard after ungrouping",()=>{
  for(const doc of [native(1),native(2),native(3),native(4),{...ordinary(),schemaVersion:2 as const}]){
    const e=editor(doc),initial=bytes(e.doc);select(e,"a","b");assert(e.groupSelection());const encoded=bytes(e.doc);
    assert.equal(e.doc.flowGroups!.baseVersion,doc.schemaVersion);assert.deepEqual(decodeProject(encoded).document,e.doc);
    assert(e.ungroupSelection());assert.equal(bytes(e.doc),initial);assert.deepEqual(e.doc.order,doc.order);
    assert(encodeClipboard(captureClipboard(e.doc,e.doc.order,new AssetVault(mixed.assets))!).startsWith("MG-CANVAS-CLIPBOARD/1\n"));
    e.undo();assert.equal(bytes(e.doc),encoded);e.undo();assert.equal(bytes(e.doc),initial);
  }
});
test("whole group, shift, marquee, group scope, internal links and outside selections resolve predictably",()=>{
  const e=editor();e.select("internal");assert.equal(e.selectedGroup,A);assert.deepEqual(e.selectedIds,groupUnit(e.doc,A));
  e.select("review",true);assert(!e.selectedGroup);assert.equal(e.selectedIds.length,7);e.select("a",true);assert.equal(e.selectedGroup,B);
  assert(e.enterGroup("review-link"));assert.deepEqual(e.selectedIds,["review-link"]);e.select("outside");assert.deepEqual(e.selectedIds,["outside"]);
  e.select("a");assert.equal(e.editingGroup,undefined);assert.equal(e.selectedGroup,A);
  assert.equal(e.selectedElementCount,groupUnit(e.doc,A).length);
  assert(e.enterGroup("b"));assert.equal(e.selectedElementCount,1);assert(e.leaveGroup());assert.equal(e.selectedGroup,A);
  const hit=()=>["a","outside","standalone"];
  e.down(3,"mouse",p(0,0),undefined,false);e.move(3,p(20,20));
  const count=groupUnit(e.doc,A).length+groupUnit(e.doc,B).length+1;
  assert.equal(e.marqueeElementCount(hit),count);
  e.up(3,p(20,20),hit);assert.equal(e.selectedElementCount,count);
  assert.deepEqual(new Set(e.selectedIds),new Set([...groupUnit(e.doc,A),...groupUnit(e.doc,B),"standalone"]));assert.equal(e.history.past.length,0);
});
test("drag previews and commit agree for interior bends and outer binding; board bytes, clipboard and undo see committed positions",()=>{
  const e=editor(),original=bytes(e.doc),delta=p(23,-13),start=p(63,67),end=offset(start,delta);
  const cross=line(e.doc,"cross"),from=resolveEndpoint(e.doc,cross.from)!,to=resolveEndpoint(e.doc,cross.to)!;
  e.select("a");e.down(1,"mouse",start,"a",false);e.move(1,end);assert(e.preview);
  const preview=e.preview.objects,initial=e.doc.objects;assert.deepEqual((preview.get("b") as ShapeObject).at,offset(shape(grouped,"b").at,delta));
  assert(!preview.has("outside")&&!preview.has("cross"));assert.equal(bytes(e.doc),original);
  const wire=encodeClipboard(captureClipboard(e.doc,e.selectedIds,new AssetVault())!);
  assert.deepEqual(decodeClipboard(wire)!.document.objects.a,initial.a);assert.equal(e.history.past.length,0);
  e.up(1,end);assert(!e.preview);assert.equal(e.history.past.length,1);
  for(const [id,obj] of preview)assert.deepEqual(e.doc.objects[id],obj);
  assert.deepEqual(line(e.doc,"internal").waypoints,line(grouped,"internal").waypoints.map(pt=>offset(pt,delta)));
  assert.deepEqual(line(e.doc,"cross"),cross);assert.deepEqual(resolveEndpoint(e.doc,cross.from),offset(from,delta));assert.deepEqual(resolveEndpoint(e.doc,cross.to),to);
  assert.equal(e.doc.objects.standalone,initial.standalone);
  const saved=bytes(e.doc);e.undo();assert.equal(bytes(e.doc),original);e.redo();assert.equal(bytes(e.doc),saved);assert.equal(bytes(decodeProject(saved).document),saved);
});
test("a crossing link translates its manual route once when both groups move and leaves other objects untouched",()=>{
  const e=editor();select(e,"a","review");const d=p(-9,4);assert(e.moveSelection(d));
  for(const id of ["internal","review-link","cross"])assert.deepEqual(line(e.doc,id).waypoints,line(grouped,id).waypoints.map(pt=>offset(pt,d)));
  for(const id of ["a","b","target","outside","review"])assert.deepEqual(shape(e.doc,id).at,offset(shape(grouped,id).at,d));
  assert.deepEqual(e.doc.objects.standalone,grouped.objects.standalone);assert.deepEqual(e.doc.flowGroups,grouped.flowGroups);assert.equal(e.history.past.length,1);
});
test("cancel, a second touch, switching boards and late releases drop the whole-group preview",()=>{
  for(const cause of ["escape","handoff","open"]){
    const e=editor();e.down(7,"mouse",p(55,60),"a",false);e.move(7,p(86,78));assert(e.preview);
    if(cause==="handoff")e.down(8,"touch",p(95,88),undefined,false);
    else if(cause==="open")e.open(grouped,true);else e.cancel();
    e.up(7,p(97,93));e.up(8,p(95,88));assert(!e.preview);assert.equal(e.history.past.length,0);assert.equal(bytes(e.doc),bytes(grouped));
  }
});
test("whole-group arrangement is rigid, layer order is stable and member-level alignment is explicitly scoped",()=>{
  const e=editor();e.select("a");assert(!canArrange(e,"left"));assert(!arrangeSelection(e,"left"));
  e.select("review",true);assert(canArrange(e,"left"));assert(arrangeSelection(e,"left"));
  for(const g of [A,B]){const ids=grouped.flowGroups!.members[g],first=ids[0];const dx=shape(e.doc,first).at.x-shape(grouped,first).at.x;
    for(const id of ids)assert.deepEqual(shape(e.doc,id).at,offset(shape(grouped,id).at,p(dx,0)));}
  assert.deepEqual(e.doc.order,grouped.order);e.undo();e.select("a");const previous=groupUnit(e.doc,A);
  assert(arrangeSelection(e,"front"));assert.deepEqual(e.doc.order.slice(-previous.length),previous);
  assert.deepEqual(e.doc.order.filter(id=>previous.includes(id)),previous);e.undo();
  e.select("a");assert(e.enterGroup("a"));e.select("b",true);assert(canArrange(e,"left"));assert(arrangeSelection(e,"left"));assert.equal(shape(e.doc,"a").at.x,shape(e.doc,"b").at.x);
});
test("whole delete removes internal connectors, preserves detached cross-route geometry and undo restores both groups",()=>{
  const e=editor(),original=bytes(e.doc),cross=line(grouped,"cross"),point=resolveEndpoint(grouped,cross.from);
  e.select("internal");assert(deleteBoardSelection(e));assert.deepEqual(groups(e),[B]);
  for(const id of ["a","b","target","internal"])assert(!Object.hasOwn(e.doc.objects,id));
  assert.deepEqual(line(e.doc,"cross").from,{kind:"free",point});assert.deepEqual(line(e.doc,"cross").to,cross.to);
  assert.deepEqual(line(e.doc,"cross").waypoints,cross.waypoints);assert.deepEqual(e.doc.objects["review-link"],grouped.objects["review-link"]);
  assert.equal(e.history.past.length,1);e.undo();assert.equal(bytes(e.doc),original);e.redo();assert(!e.doc.objects.a);
});
test("member delete prunes a larger group, dissolves its last pair, and both undo steps restore exact membership",()=>{
  const e=editor(),original=bytes(e.doc);e.select("target");assert(e.enterGroup("target"));assert(deleteBoardSelection(e));
  assert.deepEqual(e.doc.flowGroups!.members[A],["a","b"]);const first=bytes(e.doc);
  e.select("b");assert(e.enterGroup("b"));assert(deleteBoardSelection(e));assert.deepEqual(groups(e),[B]);assert(e.doc.objects.a&&e.doc.objects.internal);
  assert.equal(line(e.doc,"internal").to.kind,"free");assert.equal(line(e.doc,"cross").from.kind,"free");assert.equal(e.history.past.length,2);
  e.undo();assert.equal(bytes(e.doc),first);e.undo();assert.equal(bytes(e.doc),original);
});
test("clipboard, duplicate and cut remap both node and group IDs, retain z-order and detach a pasted outside endpoint",async()=>{
  const e=editor(),v=new AssetVault(),original=bytes(e.doc);select(e,"a","cross");
  const fragment=captureClipboard(e.doc,e.selectedIds,v)!,wire=encodeClipboard(fragment);assert.match(wire,/^MG-CANVAS-CLIPBOARD\/1\n/);assert.equal(decodeClipboard(wire)!.document.schemaVersion,5);
  assert.deepEqual(fragment.document.order,grouped.order.filter(id=>["a","b","target","internal","cross"].includes(id)));
  assert.equal(line(fragment.document,"cross").to.kind,"free");assert.deepEqual(decodeClipboard(wire)!.document,fragment.document);
  assert(pasteClipboard(e,v,decodeClipboard(wire)!,{delta:p(12,9)}));const pasted=groups(e).find(x=>x!==A&&x!==B)!;
  const ids=new Map(fragment.document.order.map((old,i)=>[old,e.doc.order[grouped.order.length+i]]));
  assert.deepEqual(e.doc.flowGroups!.members[pasted],["a","b","target"].map(id=>ids.get(id)));
  const link=line(e.doc,ids.get("internal")!);assert.deepEqual(link.from,{kind:"anchor",objectId:ids.get("a"),portId:"east"});
  assert.deepEqual(link.to,{kind:"anchor",objectId:ids.get("b"),portId:"west"});e.undo();assert.equal(bytes(e.doc),original);
  e.select("a");assert(duplicateClipboardSelection(e,v));assert.equal(groups(e).length,3);e.undo();
  e.select("a");await assert.rejects(()=>cutClipboardSelection(e,v,async()=>{throw Error("write rejected");}));assert.equal(bytes(e.doc),original);
  let output="";assert(await cutClipboardSelection(e,v,async w=>{output=w;}));assert.equal(decodeClipboard(output)!.document.schemaVersion,5);
  assert.deepEqual(groups(e),[B]);e.undo();assert.equal(bytes(e.doc),original);
});
test("an explicit downstream node remains independent; rebinding a line changes only its derived ownership",()=>{
  const e=editor(),base=bytes(e.doc);e.select("a");assert(e.enterGroup("a"));
  const link=connectToNewNode(e,{kind:"anchor",objectId:"a",portId:"north"},p(50,-150));
  assert(link&&link.to.kind==="anchor");assert(!flowGroupOf(e.doc,link.id));assert(!flowGroupOf(e.doc,link.to.objectId));
  assert.deepEqual(e.doc.flowGroups,grouped.flowGroups);e.undo();assert.equal(bytes(e.doc),base);
  assert(setConnectorEnd(e,"cross","to",{kind:"anchor",objectId:"target",portId:"north"}));
  assert.equal(flowGroupOf(e.doc,"cross"),A);e.select("cross");assert.equal(e.selectedGroup,A);
  assert.deepEqual(e.doc.flowGroups,grouped.flowGroups);assert.deepEqual(line(e.doc,"cross").waypoints,line(grouped,"cross").waypoints);
  e.undo();assert(!flowGroupOf(e.doc,"cross"));assert.equal(bytes(e.doc),base);
});
test("two-group copy includes a crossing link only on explicit selection and remaps both anchors across the copied groups",()=>{
  const e=editor(),vault=new AssetVault();select(e,"a","outside");assert(!e.canGroup);assert(!e.ungroupSelection());
  const missing=captureClipboard(e.doc,e.selectedIds,vault)!;assert(!missing.document.objects.cross);
  e.select("cross",true);const full=captureClipboard(e.doc,e.selectedIds,vault)!;assert.equal(Object.keys(full.document.flowGroups!.members).length,2);
  assert.deepEqual(line(full.document,"cross"),line(grouped,"cross"));const original=bytes(e.doc);
  assert(pasteClipboard(e,vault,full,{delta:p(30,-25)}));const fresh=e.doc.order.slice(grouped.order.length);
  const id=(old:string)=>fresh[full.document.order.indexOf(old)],cross=line(e.doc,id("cross"));assert.deepEqual(cross.from,{kind:"anchor",objectId:id("b"),portId:"east"});
  assert.deepEqual(cross.to,{kind:"anchor",objectId:id("outside"),portId:"west"});assert.deepEqual(cross.waypoints,line(grouped,"cross").waypoints.map(pt=>offset(pt,p(30,-25))));
  assert.notEqual(flowGroupOf(e.doc,id("b")),flowGroupOf(e.doc,id("outside")));assert(!flowGroupOf(e.doc,cross.id));assert.equal(groups(e).length,4);
  e.undo();assert.equal(bytes(e.doc),original);
});
test("partial member fragments stay native, mixed payloads retain pressure, tree, image bytes and curves; mismatched wire is refused",()=>{
  const doc=mixed.document,e=editor(doc),v=new AssetVault(mixed.assets);select(e,"flow-submit","flow-review");assert(e.groupSelection());
  const single=captureClipboard(e.doc,["flow-submit"],v)!;assert.equal(single.document.schemaVersion,1);
  const plain=encodeClipboard(single);assert.throws(()=>decodeClipboard(plain.replace("/1","/2")));
  e.selectAll();const mixedWire=encodeClipboard(captureClipboard(e.doc,e.selectedIds,v)!);
  assert.throws(()=>decodeClipboard(mixedWire.replace('"schemaVersion":5','"schemaVersion":1')));assert.throws(()=>decodeClipboard(mixedWire.replace("/1","/6")));
  const f=decodeClipboard(mixedWire)!;assert.deepEqual(f.assets,mixed.assets);assert.equal(f.document.schemaVersion,5);
  const dest=editor(ordinary());assert(pasteClipboard(dest,new AssetVault(),f,{delta:p(0,0)}));assert.equal(dest.history.past.length,1);
  const fresh=dest.doc.order.slice(grouped.order.length).map(id=>dest.doc.objects[id]);
  for(const id of ["sample-ink","mind-booking","qa-picture","closed-path"]){
    const obj=f.document.objects[id],copy=fresh[f.document.order.indexOf(id)];assert.equal(copy.kind,obj.kind);
    if(obj.kind==="ink"&&copy.kind==="ink")assert.deepEqual(copy.samples,obj.samples);
    if(obj.kind==="path"&&copy.kind==="path")assert.deepEqual(copy.curves,obj.curves);
    if(obj.kind==="mindmap"&&copy.kind==="mindmap")assert.equal(Object.keys(copy.topics).length,Object.keys(obj.topics).length);
  }
  dest.undo();assert.equal(bytes(dest.doc),bytes(ordinary()));
});
