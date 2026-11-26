import type { BoardDocument } from "../../core/document.ts";

export const mixed = {
  schemaVersion: 1,
  id: "fixture-mixed",
  theme: "paper",
  order: ["shape-start", "shape-choice", "link-main", "map-a", "map-b", "note", "picture", "free-line"],
  assets: { "asset-1": { id: "asset-1", mime: "image/png", pixelWidth: 4, pixelHeight: 3 } },
  objects: {
    "shape-start": { kind: "shape", id: "shape-start", shape: "rect", at: { x: -180, y: -40 }, width: 120, height: 56, rotation: 0, cornerRadius: 8, fill: "#EEF2FF", stroke: "#4F46E5", label: "提交预约" },
    "shape-choice": { kind: "shape", id: "shape-choice", shape: "diamond", at: { x: 100, y: 20 }, width: 90, height: 90, rotation: 0, cornerRadius: 0, fill: "#FFF7ED", stroke: "#F97316", label: "需要审批？" },
    "link-main": { kind: "connector", id: "link-main", from: { kind: "anchor", objectId: "shape-start", portId: "east" }, to: { kind: "anchor", objectId: "shape-choice", portId: "west" }, routing: "orthogonal", waypoints: [{ x: 0, y: -12 }, { x: 0, y: 65 }], label: "提交后", arrow: "end", stroke: "#334155" },
    "map-a": { kind: "mindmap", id: "map-a", origin: { x: 400, y: 0 }, rootId: "root-a", layout: "balanced", topics: {
      "root-a": { id: "root-a", text: "会议室系统", childIds: ["child-a", "child-b"], collapsed: false },
      "child-a": { id: "child-a", text: "预约", childIds: [], collapsed: false, side: "right" },
      "child-b": { id: "child-b", text: "门禁", childIds: [], collapsed: false, side: "left" },
    } },
    "map-b": { kind: "mindmap", id: "map-b", origin: { x: 400, y: 400 }, rootId: "root-b", layout: "right", topics: {
      "root-b": { id: "root-b", text: "另一个脑图", childIds: [], collapsed: false },
    } },
    note: { kind: "text", id: "note", at: { x: -180, y: 160 }, width: 200, height: 40, rotation: 0, text: "独立文字", fontSize: 16, color: "#334155", align: "left" },
    picture: { kind: "image", id: "picture", at: { x: -180, y: 220 }, width: 80, height: 60, rotation: 0, assetId: "asset-1" },
    "free-line": { kind: "connector", id: "free-line", from: { kind: "free", point: { x: 0, y: 300 } }, to: { kind: "free", point: { x: 50, y: 300 } }, routing: "straight", waypoints: [], label: "", arrow: "none", stroke: "#334155" },
  },
} as const satisfies BoardDocument;
