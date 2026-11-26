import type { BoardDocument, TextObject } from "../core/document.ts";

export const demoTitle = "会议室系统";

function heading(id: string, x: number, text: string): TextObject {
  return {
    kind: "text", id, at: { x, y: -139 }, width: 200, height: 22, rotation: 0,
    text, fontSize: 14, color: "#52647e", align: "left", colorMode: "auto",
  };
}

export const demo: BoardDocument = {
  schemaVersion: 1, id: "meeting-room-demo", theme: "paper", assets: {},
  order: ["flow-heading", "mind-heading", "flow-source", "flow-decision", "flow-arrow", "mind-room"],
  objects: {
    "flow-heading": heading("flow-heading", -332, "01  /  预约流程"),
    "mind-heading": heading("mind-heading", 131, "02  /  功能脑图"),
    "flow-source": {
      kind: "shape", id: "flow-source", shape: "rect", at: { x: -330, y: -34 },
      width: 132, height: 56, rotation: 0, cornerRadius: 8, fill: "#edf4ff", stroke: "#5d8fed", label: "提交预约",
    },
    "flow-decision": {
      kind: "shape", id: "flow-decision", shape: "diamond", at: { x: -96, y: -7 },
      width: 90, height: 90, rotation: 0, cornerRadius: 0, fill: "#fff5e6", stroke: "#ebad54", label: "需要审批？",
    },
    "flow-arrow": {
      kind: "connector", id: "flow-arrow",
      from: { kind: "anchor", objectId: "flow-source", portId: "east" },
      to: { kind: "anchor", objectId: "flow-decision", portId: "west" },
      routing: "orthogonal", waypoints: [{ x: -152, y: -6 }, { x: -152, y: 38 }],
      label: "进入审批", arrow: "end", stroke: "#334155",
    },
    "mind-room": {
      kind: "mindmap", id: "mind-room", origin: { x: 194, y: 34 }, rootId: "root-a", layout: "right",
      topics: {
        "root-a": { id: "root-a", text: demoTitle, childIds: ["child-a", "child-b"], collapsed: false },
        "child-a": { id: "child-a", text: "预约管理", childIds: [], collapsed: false, side: "right" },
        "child-b": { id: "child-b", text: "门禁控制", childIds: [], collapsed: false, side: "left" },
      },
      theme: "spectrum",
    },
  },
};
