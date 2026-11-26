import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { assertDocument, parseDocument, validateDocument } from "../core/document.ts";
import type { BoardDocument, BoardObject, Connector, ShapeObject, VectorPath } from "../core/document.ts";
import { worldToScreen } from "../core/geometry.ts";
import { createHistory, dispatch } from "../core/history.ts";
import { captureClipboard, decodeClipboard, encodeClipboard, pasteClipboard } from "../features/clipboard.ts";
import { FlowInput } from "../features/flow-input.ts";
import { AssetVault } from "../features/image-assets.ts";
import { decodeProject, encodeProject } from "../platform/project.ts";
import { EditorSession } from "../session/editor.ts";
import { cornerPoint } from "../session/resize.ts";
import { mixed } from "./fixtures/mixed.ts";

const files = new URL("../docs/fixtures/", import.meta.url);
const file = (name: string) => readFileSync(new URL(name, files), "utf8");
const p = (x: number, y: number) => ({x, y});
const board = (items: BoardObject[]): BoardDocument => ({...mixed, assets: {}, order: items.map(i => i.id),
  objects: Object.fromEntries(items.map(i => [i.id, i]))});

test("fractional zoom and pointer positions produce identical integer preview, history and saved geometry", () => {
  const camera = {zoom: 1.25, offset: p(83.16, -41.3)};
  const e = new EditorSession(board([]), camera), flow = new FlowInput(e, () => undefined);
  const screen = (x: number, y: number) => worldToScreen(p(x, y), camera);
  flow.setMode("process");
  flow.down(1, "mouse", screen(113.73, 98.33)); flow.up(1, screen(-3.41, -56.75));
  const node = e.doc.objects[e.selection!] as ShapeObject;
  assert.deepEqual([node.at, node.width, node.height], [p(-3, -57), 117, 155]);
  const original = e.doc;
  e.down(2, "mouse", screen(20, 20), node.id, false);
  e.move(2, screen(30.76, 7.39));
  const moved = e.preview!.objects.get(node.id) as ShapeObject;
  assert.deepEqual(moved.at, p(8, -70)); assert.equal(e.doc, original);
  e.up(2, screen(30.76, 7.39)); assert.deepEqual(e.doc.objects[node.id], moved);
  const corner = cornerPoint(moved, "se");
  const tip = screen(corner.x + 24.64, corner.y - 10.2);
  e.down(3, "mouse", worldToScreen(corner, camera), node.id, false, false, {id: node.id, corner: "se", lockRatio: false});
  e.move(3, tip);
  const resized = e.preview!.objects.get(node.id) as ShapeObject;
  assert.deepEqual([resized.at, resized.width, resized.height], [p(8, -70), 142, 145]);
  e.up(3, tip); assert.deepEqual(e.doc.objects[node.id], resized);
  const bytes = encodeProject(e.doc, new AssetVault());
  e.undo(); assert.deepEqual(e.doc.objects[node.id], moved); e.undo(); assert.equal(e.doc, original);
  e.redo(); e.redo(); assert.equal(encodeProject(e.doc, new AssetVault()), bytes);
  assert.deepEqual(decodeProject(bytes).document.objects[node.id], resized);
});

test("the document validator and atomic dispatch reject fractional rows on fast and full transaction paths", () => {
  const pkg = decodeProject(file("M5S-Cubic-Paths.mgcanvas")), h = createHistory(pkg.document);
  const objects = h.doc.objects, shape = objects["flow-submit"], text = objects["qa-label"], image = objects["qa-picture"];
  const map = objects["mind-booking"], path = objects["closed-path"], ink = objects["sample-ink"], link = objects["flow-first"];
  assert(shape.kind==="shape" && text.kind==="text" && image.kind==="image" && map.kind==="mindmap" &&
    path.kind==="path" && ink.kind==="ink" && link.kind==="connector");
  const root = map.topics[map.rootId];
  const invalid: BoardObject[] = [
    {...shape, at:p(391.37586, 54)}, {...shape, width:333.076}, {...image, height:209.23}, {...text, at:p(5, -3.4)},
    {...map, origin:p(.1, 0)}, {...map, topics:{...map.topics, [root.id]:{...root, appearance:{width:82.6}}}},
    {...link, to:{kind:"free", point:p(8.1, 9)}}, {...link, waypoints:[p(9, 5.7)]},
    {...ink, at:p(3, 2.5)}, {...ink, samples:[[0,0,.5],[2.5,3,.4]]},
    {...path, at:p(50.6, 10)}, {...path, vertices:path.vertices.map((v,i)=>i===1?p(v.x+.3,v.y):v)},
    {...path, curves:{0:{out:p(1.25,3), in:p(1,3)}}},
  ];
  for (const item of invalid) {
    const doc = {...h.doc, objects:{...objects, [item.id]:item}};
    assert(validateDocument(doc).length > 0);
    for (const prefix of [[], [{op:"setTheme",theme:"other"} as const]]) {
      assert.throws(() => dispatch(h,{label:"off-grid",patches:[...prefix,{op:"putObject",value:item}]}), {name:"DocumentValidationError"});
    }
  }
  assert.equal(h.revision, 0); assert.equal(h.past.length, 0);
});

test("legacy groups, pins, curves, pressure and image bytes survive migration through project and clipboard readers", () => {
  const raw = JSON.parse(file("M5S-Cubic-Paths.mgcanvas")), old = raw.document;
  const shape = old.objects["flow-submit"], map = old.objects["mind-booking"], ink = old.objects["sample-ink"];
  old.schemaVersion = 5; old.flowGroups = {baseVersion:4, members:{pair:[shape.id,"flow-review"]}};
  Object.assign(shape, {at:p(391.37586,53.66846), width:333.076, height:209.23, rotation:.37, strokeWidth:1.65});
  map.origin=p(-12.75,18.4); map.topics[map.rootId].appearance={width:82.75,strokeWidth:.5};
  const edge = old.objects["flow-first"]; edge.to={kind:"free",point:p(-3.8,5.25)}; edge.waypoints=[p(.6,-2.4)];
  ink.at=p(.4,-.3); ink.samples=[[0,0,.15],[.4,1.25,.78]];
  const path = old.objects["open-path"];
  path.at=p(.4,.4); path.vertices=[p(0,0),p(.4,2.4),p(5,3)]; path.curves={0:{out:p(.4,.4),in:p(.4,.4)}};
  const json=JSON.stringify(raw), pkg=decodeProject(json), doc=pkg.document;
  assert.deepEqual(parseDocument(JSON.stringify(old)),doc); assert.deepEqual(createHistory(old).doc,doc);
  assert.equal(JSON.stringify(raw),json); assertDocument(doc);
  assert.deepEqual(doc.flowGroups,old.flowGroups); assert.equal(doc.schemaVersion,5);
  assert.deepEqual(doc.objects[shape.id],{...shape,at:p(391,54),width:333,height:209});
  assert.deepEqual((doc.objects["flow-first"] as Connector),{...edge,to:{kind:"free",point:p(-4,5)},waypoints:[p(1,-2)]});
  assert.deepEqual(doc.objects[ink.id],{...ink,at:p(0,0),samples:[[0,0,.15],[1,1,.78]]});
  assert.deepEqual(doc.objects[path.id],{...path,at:p(0,0),vertices:[p(0,0),p(1,3),p(5,3)],curves:{0:{out:p(1,1),in:p(0,0)}}});
  const migratedMap=doc.objects[map.id]; assert(migratedMap.kind==="mindmap");
  assert.deepEqual(migratedMap.origin,p(-13,18)); assert.deepEqual(migratedMap.topics[map.rootId].appearance,{width:83,strokeWidth:.5});
  const bytes=encodeProject(doc,new AssetVault(pkg.assets)); assert.deepEqual(JSON.parse(bytes).assets,raw.assets);
  assert.deepEqual(decodeProject(bytes),pkg); assert.deepEqual(decodeClipboard("MG-CANVAS-CLIPBOARD/1\n"+json),pkg);
  shape.width=-.2; assert.throws(()=>decodeProject(JSON.stringify(raw)),{name:"DocumentValidationError"});
});

test("a sub-unit connector survives import and detachment at an odd-sized shape port", () => {
  const line: Connector={...mixed.objects["free-line"],from:{kind:"free",point:p(.1,0)},to:{kind:"free",point:p(.3,0)}};
  const loaded=parseDocument(JSON.stringify(board([line])));
  assert.deepEqual(loaded.objects[line.id],{...line,from:{kind:"free",point:p(0,0)},to:{kind:"free",point:p(1,0)}});
  const shape={...mixed.objects["shape-start"], at:p(0,0),width:3,height:1};
  const attached:Connector={...line,from:{kind:"anchor",objectId:shape.id,portId:"north"},to:{kind:"free",point:p(2,0)}};
  const e=new EditorSession(board([shape,attached]),{zoom:1,offset:p(0,0)}),vault=new AssetVault();
  const fragment=captureClipboard(e.doc,[attached.id],vault)!;
  assert.deepEqual(fragment.document.objects[attached.id],{...attached,from:{kind:"free",point:p(1,0)}});
  const copy=decodeClipboard(encodeClipboard(fragment))!;
  assert(pasteClipboard(e,vault,copy,{delta:p(3.75,-5.2)}));
  const pasted=e.doc.objects[e.selection!] as Connector;
  assert.deepEqual([pasted.from,pasted.to],[{kind:"free",point:p(5,-5)},{kind:"free",point:p(6,-5)}]);
});

test("all shipped sample projects reopen with stable integer geometry on the second save", () => {
  for (const name of readdirSync(files).filter(name=>name.endsWith(".mgcanvas"))) {
    const pkg=decodeProject(file(name)), bytes=encodeProject(pkg.document,new AssetVault(pkg.assets),pkg);
    const again=decodeProject(bytes);
    assert.deepEqual(again,pkg,name); assert.equal(encodeProject(again.document,new AssetVault(again.assets),again),bytes,name);
  }
});

test("sub-unit closed paths and both port bindings survive rounding onto the same grid point", () => {
  const shape = {...mixed.objects["shape-start"], at:p(.1,0), width:2, height:2, rotation:0};
  const other = {...shape, id:"second", at:p(.3,0)};
  const line: Connector = {...mixed.objects["free-line"], routing:"straight", waypoints:[],
    from:{kind:"anchor",objectId:shape.id,portId:"north"}, to:{kind:"anchor",objectId:other.id,portId:"north"}};
  const path: VectorPath = {id:"tiny-loop", kind:"path", at:p(1e18,.1), closed:true, stroke:"#123456", strokeWidth:1,
    vertices:[p(-1e18,0),p(-1e18,.01),p(-1e18,.02)]};
  const doc = parseDocument(JSON.stringify({...board([shape,other,line,path]),schemaVersion:3}));
  assert.deepEqual(doc.objects[line.id], {...line,routing:"orthogonal",waypoints:[p(2,0)]});
  const loop = doc.objects[path.id]; assert(loop.kind==="path");
  assert.deepEqual(loop.at,p(0,0));
  assert.deepEqual(loop.vertices,[p(0,0),p(0,1),p(1,0)]);
  assert.deepEqual(parseDocument(JSON.stringify(doc)),doc);
});
