import assert from "node:assert/strict";
import {test} from "node:test";
import type {BoardDocument, Connector, Endpoint} from "../core/document.ts";
import {assertDocument, resolveEndpoint} from "../core/document.ts";
import {captureClipboard, decodeClipboard, encodeClipboard, pasteClipboard} from "../features/clipboard.ts";
import {FlowInput} from "../features/flow-input.ts";
import {addDownstream} from "../features/flow-keyboard.ts";
import {addWaypoint, connectFlow, deleteBoardSelection, deleteFlowSelection, detachConnectorEnd, free,
  removeWaypoint, setConnectorEnd, shapePreset, styleConnector} from "../features/flow.ts";
import {AssetVault} from "../features/image-assets.ts";
import {SelectionProperties} from "../features/selection-appearance.ts";
import {decodeProject, encodeProject} from "../platform/project.ts";
import {EditorSession} from "../session/editor.ts";

const camera={zoom:1,offset:{x:0,y:0}},vault=new AssetVault();
const anchor=(objectId:string,portId:"east"|"west"):Endpoint=>({kind:"anchor",objectId,portId});
const from=anchor("a","east"),to=anchor("b","west");
function fixture(decision=false){
  const a=shapePreset(decision?"decision":"process",{x:0,y:0},"a");
  const b=shapePreset("process",{x:400,y:0},"b"),c=shapePreset("process",{x:400,y:220},"c");
  const d=shapePreset("process",{x:-280,y:220},"d");
  return new EditorSession({id:"flow-delete",schemaVersion:1,theme:"paper",assets:{},order:["a","b","c","d"],objects:{a,b,c,d}},camera);
}
function lineAt(doc:BoardDocument,id:string):Connector{
  const line=doc.objects[id];assert(line?.kind==="connector",id);return line;
}

test("deleting either bound node removes its untouched unbent route in one undoable edit",()=>{
  for(const routing of ["orthogonal","straight","curve"] as const)for(const field of ["from","to"] as const){
    const e=fixture(),endId=routing==="straight"?"c":"b";
    const line=connectFlow(e,from,anchor(endId,"west"),routing)!;
    const before=e.doc,count=e.history.past.length,id=field==="from"?"a":endId,other=field==="from"?endId:"a";
    e.select(id);assert(deleteFlowSelection(e));const after=e.doc;
    assert(!after.objects[id]&&!after.objects[line.id]);assert.strictEqual(after.objects[other],before.objects[other]);
    assert.equal(e.history.past.length,count+1);
    e.undo();assert.strictEqual(e.doc,before);assert.deepEqual(lineAt(e.doc,line.id),line);
    e.redo();assert.strictEqual(e.doc,after);
  }
});

test("mixed deletion classifies each incident edge using its full current path, including automated bends",()=>{
  const e=fixture(),straight=connectFlow(e,from,to,"orthogonal")!,loose=connectFlow(e,from,free({x:280,y:0}))!;
  const bent=connectFlow(e,from,anchor("c","west"))!,wrongSide=connectFlow(e,from,anchor("b","east"))!;
  const legacyCurve=(id:string,to:Endpoint):Connector=>{
    const line={...straight,id,to,routing:"curve" as const};
    assert(e.commitEdit({label:"旧工程曲线",patches:[{op:"putObject",value:line}]},e.generation));
    return line;
  };
  const curve=legacyCurve("old-curve",to),pinned=connectFlow(e,from,to)!;
  const start=resolveEndpoint(e.doc,from)!;
  const vertical=(dy:number)=>free({x:start.x,y:start.y+dy});
  const collinear=legacyCurve("old-collinear",vertical(400)),doublesBack=legacyCurve("old-doubles-back",vertical(12));
  assert(addWaypoint(e,pinned.id,{x:185,y:95}));
  const unrelated=connectFlow(e,anchor("b","east"),anchor("c","west"))!,before=e.doc;
  const point=resolveEndpoint(before,from)!;
  e.select("a");e.select("d",true);e.select(straight.id,true);assert(deleteBoardSelection(e));
  for(const id of ["a","d",straight.id,loose.id,collinear.id])assert(!e.doc.objects[id]);
  for(const {id} of [bent,wrongSide,curve,pinned,doublesBack]){
    assert.deepEqual(lineAt(e.doc,id),{...lineAt(before,id),from:free(point)});
  }
  assert.strictEqual(e.doc.objects[unrelated.id],before.objects[unrelated.id]);
  const after=e.doc;e.undo();assert.strictEqual(e.doc,before);e.redo();assert.strictEqual(e.doc,after);
  e.undo();e.select("a");e.select("b",true);assert(deleteBoardSelection(e));
  assert(!e.doc.objects[straight.id]);
  assert.equal(lineAt(e.doc,pinned.id).from.kind,"free");assert.equal(lineAt(e.doc,pinned.id).to.kind,"free");
});

test("displaying a small automatic jog as one segment never changes which saved links are deleted",()=>{
  const e=fixture();e.select("b");assert(e.moveSelection({x:0,y:2}));
  const edge=connectFlow(e,from,to,"orthogonal")!,before=e.doc,p=resolveEndpoint(before,from)!;
  e.select("a");assert(deleteBoardSelection(e));
  assert.deepEqual(lineAt(e.doc,edge.id),{...edge,from:free(p)});
  e.undo();assert.strictEqual(e.doc,before);
});

test("restoring a pin, endpoint, route, label or paint to its initial value still protects the line after reopening",()=>{
  const e=fixture(),make=()=>connectFlow(e,from,to,"orthogonal")!;
  const pin=make(),end=make(),route=make(),label=make(),paint=make(),otherPaint=make();
  assert(addWaypoint(e,pin.id,{x:185,y:95}));assert(removeWaypoint(e,pin.id,0));
  assert(detachConnectorEnd(e,end.id,"to"));assert(setConnectorEnd(e,end.id,"to",to));
  assert(styleConnector(e,route.id,{...route,routing:"curve"}));assert(styleConnector(e,route.id,route));
  assert(styleConnector(e,label.id,{...label,label:"Yes"}));assert(styleConnector(e,label.id,label));
  e.select(paint.id);e.select(otherPaint.id,true);
  assert(new SelectionProperties(e).apply(new Map([["lineColor","#cc3344"]])));
  assert(new SelectionProperties(e).apply(new Map([["lineColor",paint.stroke]])));
  const fresh=make(),json=encodeProject(e.doc,vault),reopened=new EditorSession(decodeProject(json).document,camera);
  for(const line of [pin,end,route,label,paint,otherPaint]){
    assert.deepEqual({...lineAt(reopened.doc,line.id),unedited:true},line);
    assert.equal(lineAt(reopened.doc,line.id).unedited,undefined);
  }
  reopened.select("b");assert(deleteBoardSelection(reopened));assert(!reopened.doc.objects[fresh.id]);
  for(const line of [pin,end,route,label,paint,otherPaint]){
    const kept=lineAt(reopened.doc,line.id);assert.deepEqual(kept.from,from);assert.equal(kept.to.kind,"free");
  }
});

test("automatic Yes and No labels stay eligible while a manually restored Yes stays bound at its surviving end",()=>{
  const e=fixture(true),source=e.doc.objects.a;assert(source.kind==="shape");
  const yes=addDownstream(e,source,()=>false)!,no=addDownstream(e,source,()=>false)!;
  assert.equal(yes.label,"Yes");assert.equal(no.label,"No");
  const both=e.doc;e.select("a");assert(deleteBoardSelection(e));
  assert(!e.doc.objects[yes.id]&&!e.doc.objects[no.id]);e.undo();assert.strictEqual(e.doc,both);
  assert(styleConnector(e,yes.id,{...yes,label:"是"}));assert(styleConnector(e,yes.id,yes));
  const before=e.doc;e.select("a");assert(deleteBoardSelection(e));
  assert(!e.doc.objects[no.id]);const kept=lineAt(e.doc,yes.id);
  assert.equal(kept.label,"Yes");assert.equal(kept.from.kind,"free");assert.deepEqual(kept.to,yes.to);
  const after=e.doc;e.undo();assert.strictEqual(e.doc,before);e.redo();assert.strictEqual(e.doc,after);
});

test("moving nodes, cancelling an endpoint drag and applying no change leave creation history intact",()=>{
  const e=fixture(),line=connectFlow(e,from,to)!,original=e.doc;
  const flow=new FlowInput(e,()=>undefined),end=resolveEndpoint(e.doc,to)!;
  assert(flow.down(1,"mouse",end));flow.move(1,{x:end.x+50,y:end.y+30});assert(flow.decor().draft);
  flow.cancel();assert(!flow.up(1,end));assert(!styleConnector(e,line.id,line));
  const {unedited,...fields}=line;
  assert(!e.commitEdit({label:"原样应用",patches:[{op:"putObject",value:fields}]},e.generation));
  assert(!setConnectorEnd(e,line.id,"to",to));assert(!removeWaypoint(e,line.id,0));assert.strictEqual(e.doc,original);
  e.select("b");assert(e.moveSelection({x:0,y:100}));const bent=e.doc;
  e.select("a");assert(deleteBoardSelection(e));assert.equal(lineAt(e.doc,line.id).from.kind,"free");
  e.undo();assert.strictEqual(e.doc,bent);
  e.select("b");assert(e.moveSelection({x:0,y:-100}));
  e.select("a");assert(deleteBoardSelection(e));assert(!e.doc.objects[line.id]);
});

test("v1 and grouped v5 files with no edit history keep even identical old straight connectors",()=>{
  const e=fixture(),line=connectFlow(e,from,to)!;
  const file=JSON.parse(encodeProject(e.doc,vault));
  assert.deepEqual(file.uneditedConnectors,[line.id]);assert(!("unedited" in file.document.objects[line.id]));
  delete file.uneditedConnectors;
  for(const schemaVersion of [1,5]){
    const document={...file.document,schemaVersion,...(schemaVersion===5?{flowGroups:{baseVersion:1,members:{group:["b","c"]}}}:{})};
    const old=decodeProject(JSON.stringify({...file,document})).document;
    const opened=new EditorSession(decodeProject(encodeProject(old,vault)).document,camera);
    opened.select("a");assert(deleteBoardSelection(opened));assert.equal(lineAt(opened.doc,line.id).from.kind,"free");
    opened.undo();assert.deepEqual(opened.doc,old);
  }
  assert.throws(()=>decodeProject(JSON.stringify({...file,uneditedConnectors:["missing"]})));
  assert.throws(()=>decodeProject(JSON.stringify({...file,uneditedConnectors:[line.id,line.id]})));
  assert.throws(()=>assertDocument({...e.doc,objects:{...e.doc.objects,[line.id]:{...line,unedited:"yes"}}}));
});

test("clipboard remapping preserves an untouched line and protected edges prevent a partial deletion",()=>{
  const e=fixture(),line=connectFlow(e,from,to)!,before=e.doc;
  e.setLayerLocks([line.id],true);e.select("a");assert(!deleteBoardSelection(e));assert.strictEqual(e.doc,before);
  e.setLayerLocks([line.id],false);
  const fragment=decodeClipboard(encodeClipboard(captureClipboard(e.doc,["a","b",line.id],vault)!))!;
  assert(pasteClipboard(e,vault,fragment));
  const copy=lineAt(e.doc,e.doc.order.at(-1)!);assert(copy.from.kind==="anchor"&&copy.to.kind==="anchor");
  e.select(copy.to.objectId);assert(deleteBoardSelection(e));assert(!e.doc.objects[copy.id]);
  assert.deepEqual(lineAt(e.doc,line.id),line);
});
