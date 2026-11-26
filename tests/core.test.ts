import { test } from "node:test";
import assert from "node:assert/strict";
import { DocumentValidationError, parseDocument, resolveEndpoint, validateDocument } from "../core/document.ts";
import { createHistory, dispatch, redo, undo } from "../core/history.ts";
import { boxBounds, clientToScreen, deviceToScreen, localToWorld, moveZoomAnchor, normalizeWheel, portWorld, screenToDevice, screenToWorld, worldToLocal, worldToScreen, ZOOM, zoomAt } from "../core/geometry.ts";
import { mixed } from "./fixtures/mixed.ts";

test("versioned mixed document round-trips ids, order, text, assets, routes and topics", () => {
  assert.deepEqual(validateDocument(mixed), []);
  const imported = parseDocument(JSON.stringify(mixed));
  assert.deepEqual(imported, mixed);
  assert(Object.isFrozen(imported.objects["map-a"]));
  assert(Object.isFrozen(mixed) === false);
  assert.throws(() => parseDocument(JSON.stringify({ ...mixed, schemaVersion: 3 })), DocumentValidationError);
});

test("malformed asset, dangling endpoint and duplicate z-order are rejected", () => {
  const order = [...mixed.order, "note"];
  const bad = { ...mixed, order, assets: {}, objects: {
    ...mixed.objects, "link-main": { ...mixed.objects["link-main"], from: { kind: "anchor", objectId: "map-a", portId: "west" } },
  } };
  const paths = validateDocument(bad).map(i => i.path);
  assert(paths.includes("order"));
  assert(paths.includes("objects.picture"));
  assert(paths.includes("objects.link-main.from"));
});
test("negative size, non-finite coordinates and zero-length free segments are rejected", () => {
  const bad = { ...mixed, objects: {
    ...mixed.objects,
    "shape-start": { ...mixed.objects["shape-start"], width: -1 },
    note: { ...mixed.objects.note, at: { x: Infinity, y: 0 } },
    "free-line": { ...mixed.objects["free-line"], to: mixed.objects["free-line"].from },
  } };
  const paths = validateDocument(bad).map(i => i.path);
  for (const path of ["objects.shape-start", "objects.note", "objects.free-line"]) assert(paths.includes(path));
});
test("cycle, repeated ownership, missing children and disconnected topics are rejected", () => {
  const map = mixed.objects["map-a"];
  const topics = {
    ...map.topics,
    "child-a": { ...map.topics["child-a"], childIds: ["root-a", "child-b", "missing"] },
    detached: { id: "detached", text: "", childIds: [], collapsed: false },
  };
  const bad = { ...mixed, objects: { ...mixed.objects, "map-a": { ...map, topics } } };
  const issues = validateDocument(bad).map(i => i.message).join("; ");
  assert.match(issues, /tree cycle/);
  assert.match(issues, /more than once/);
  assert.match(issues, /unknown child/);
  assert.match(issues, /unreachable/);
});
test("a disconnected cycle is found without recursive traversal", () => {
  const map = mixed.objects["map-a"];
  const issues = validateDocument({ ...mixed, objects: { ...mixed.objects, "map-a": { ...map, topics: {
    ...map.topics,
    orphan1: { id: "orphan1", text: "", childIds: ["orphan2"], collapsed: false },
    orphan2: { id: "orphan2", text: "", childIds: ["orphan1"], collapsed: false },
  } } } }).map(i => i.message);
  assert(issues.includes("tree cycle"));
});

test("a drag commits one frame, changes only attached connector geometry, and preserves the rest", () => {
  const initial = createHistory(mixed);
  const link = mixed.objects["link-main"];
  const drag = dispatch(initial, { label: "move shape", patches: [
    { op: "putObject", value: { ...mixed.objects["shape-start"], at: { x: -190, y: -90 } } },
  ] });
  assert.equal(drag.state.past.length, 1);
  assert.deepEqual(drag.changeSet.updated, ["shape-start"]);
  assert.deepEqual(drag.changeSet.invalidatedConnectors, ["link-main"]);
  assert.deepEqual(drag.changeSet.invalidatedMaps, []);
  assert.deepEqual(resolveEndpoint(drag.state.doc, link.from), { x: -70, y: -62 });
  assert.deepEqual(resolveEndpoint(initial.doc, link.from), { x: -60, y: -12 });
  assert.strictEqual(drag.state.doc.objects["link-main"], initial.doc.objects["link-main"]);
  assert.strictEqual(drag.state.doc.objects["map-a"], initial.doc.objects["map-a"]);
  const undone = undo(drag.state);
  assert.equal(undone.state.revision, 2);
  assert.strictEqual(undone.state.doc, initial.doc);
  assert.deepEqual(undone.changeSet.invalidatedConnectors, ["link-main"]);
  assert.strictEqual(redo(undone.state).state.doc, drag.state.doc);
});
test("a dangling deletion is rejected and legal multi-patch detach/delete undo restores the binding", () => {
  const initial = createHistory(mixed);
  const remove = { op: "removeObject", id: "shape-start" } as const;
  const link = mixed.objects["link-main"];
  assert.throws(() => dispatch(initial, { label: "illegal remove", patches: [remove] }), DocumentValidationError);
  assert.equal(initial.past.length, 0);
  assert(initial.doc.objects["shape-start"]);
  const anchor = resolveEndpoint(initial.doc, link.from);
  assert(anchor);
  const detached = dispatch(initial, { label: "delete and detach", patches: [remove, {
    op: "putObject", value: { ...link, from: { kind: "free", point: anchor } },
  }] });
  assert.equal(detached.state.past.length, 1);
  assert.deepEqual(detached.changeSet.removed, ["shape-start"]);
  assert.equal(detached.state.doc.objects["shape-start"], undefined);
  assert.deepEqual(undo(detached.state).state.doc.objects["link-main"], link);
});

test("fold invalidates only its map; moving the whole map only changes transform", () => {
  const initial = createHistory(mixed);
  const map = mixed.objects["map-a"];
  const fold = dispatch(initial, { label: "fold", patches: [{ op: "putObject", value: {
    ...map, topics: { ...map.topics, "root-a": { ...map.topics["root-a"], collapsed: true } },
  } }] });
  assert.deepEqual(fold.changeSet.invalidatedMaps, ["map-a"]);
  assert.deepEqual(fold.changeSet.invalidatedConnectors, []);
  assert.strictEqual(fold.state.doc.objects["map-b"], initial.doc.objects["map-b"]);
  const move = dispatch(initial, { label: "move", patches: [{ op: "putObject", value: { ...map, origin: { x: 31, y: 22 } } }] });
  assert.deepEqual(move.changeSet.updated, ["map-a"]);
  assert.deepEqual(move.changeSet.invalidatedMaps, []);
});

test("image + asset transaction stays atomic, immutable and redoable; new edit clears redo", () => {
  const initial = createHistory(mixed);
  const input = { ...mixed.objects.picture, id: "extra-image", assetId: "extra-asset", at: { x: 2, y: 3 } };
  const inserted = dispatch(initial, { label: "import image", patches: [
    { op: "putObject", value: input },
    { op: "putAsset", value: { ...mixed.assets["asset-1"], id: "extra-asset" } },
  ] });
  input.at.x = 900;
  const picture = inserted.state.doc.objects["extra-image"];
  assert(picture?.kind === "image");
  assert.deepEqual(picture.at, { x: 2, y: 3 });
  assert.deepEqual(inserted.changeSet.assetsChanged, ["extra-asset"]);
  assert.equal(inserted.state.past.length, 1);
  assert.throws(() => dispatch(inserted.state, { label: "remove live asset", patches: [{ op: "removeAsset", id: "extra-asset" }] }), DocumentValidationError);
  const undone = undo(inserted.state);
  assert.strictEqual(undone.state.doc, initial.doc);
  assert.deepEqual(undone.changeSet.assetsChanged, ["extra-asset"]);
  assert.strictEqual(redo(undone.state).state.doc, inserted.state.doc);
  assert.strictEqual(dispatch(undone.state, { label: "same theme", patches: [{ op: "setTheme", theme: mixed.theme }] }).state, undone.state);
  assert.equal(dispatch(undone.state, { label: "new edit", patches: [{ op: "setTheme", theme: "night" }] }).state.future.length, 0);
});

function approx(a: Readonly<{ x: number; y: number }>, b: Readonly<{ x: number; y: number }>) {
  assert(Math.abs(a.x - b.x) < 1e-9, "x differs");
  assert(Math.abs(a.y - b.y) < 1e-9, "y differs");
}

test("camera CSS/device/world round trips at fractional DPI and negative world positions", () => {
  const camera = { offset: { x: 67.3, y: -45.7 }, zoom: 2.15 };
  const point = { x: -133.1, y: -406.7 };
  const worldToLocalScreen = worldToScreen(point, camera);
  for (const dpr of [1, 1.25, 1.5, 2]) {
    approx(worldToLocalScreen, deviceToScreen(screenToDevice(worldToLocalScreen, dpr), dpr));
    approx(point, screenToWorld(deviceToScreen(screenToDevice(worldToLocalScreen, dpr), dpr), camera));
  }
  assert.deepEqual(clientToScreen({ x: 330, y: 90 }, { x: 100, y: 40 }), { x: 230, y: 50 });
  assert.throws(() => deviceToScreen(point, 0), RangeError);
});
test("anchored zoom and two-finger midpoint pan stay fixed under clamping", () => {
  const camera = { offset: { x: 25, y: -10 }, zoom: 1.4 };
  const anchor = { x: 40, y: 85 };
  const next = { x: 53, y: 100 };
  const under = screenToWorld(anchor, camera);
  const clamped = zoomAt(camera, anchor, 1000);
  assert.equal(clamped.zoom, ZOOM.max);
  approx(worldToScreen(under, clamped), anchor);
  approx(worldToScreen(under, moveZoomAnchor(camera, anchor, next, 0.0001)), next);
});
test("wheel units normalize without treating CSS pixels as device pixels", () => {
  const delta = { x: -1, y: 2 };
  const page = { x: 800, y: 600 };
  assert.deepEqual(normalizeWheel(delta, 0, 16, page), delta);
  assert.deepEqual(normalizeWheel(delta, 1, 16, page), { x: -16, y: 32 });
  assert.deepEqual(normalizeWheel(delta, 2, 16, page), { x: -800, y: 1200 });
});
test("rotated shape transforms are inverse and anchors follow shape-specific geometry", () => {
  const box = { at: { x: -10, y: 20 }, width: 80, height: 40, rotation: Math.PI / 2 };
  const from = { x: 10, y: 15 };
  approx(worldToLocal(localToWorld(from, box), box), from);
  approx(portWorld(box, "rect", "east"), { x: 30, y: 80 });
  approx(portWorld(box, "triangle", "east"), { x: 30, y: 60 });
  const bounds = boxBounds(box);
  approx(bounds.min, { x: 10, y: 0 });
  approx(bounds.max, { x: 50, y: 80 });
});

test("camera and derived topic coordinates are rejected as persistent fields", () => {
  const map = mixed.objects["map-a"];
  const bad = {
    ...mixed,
    camera: { offset: { x: 0, y: 0 }, zoom: 1 },
    objects: {
      ...mixed.objects,
      "map-a": {
        ...map,
        topics: { ...map.topics, "root-a": { ...map.topics["root-a"], at: { x: 0, y: 0 } } },
      },
    },
  };
  const paths = validateDocument(bad).map(i => i.path);
  assert(paths.includes("$"));
  assert(paths.includes("objects.map-a.topics.root-a"));
});
