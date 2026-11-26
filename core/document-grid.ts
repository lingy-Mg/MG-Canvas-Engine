import type { BoardObject, Connector, CubicHandles, Endpoint, Topic, VectorPath } from "./document.ts";
import { gridBox, gridPoint, onGrid, roundWorld } from "./geometry.ts";
import type { Point } from "./geometry.ts";
import { gridInk } from "../features/ink.ts";

/** Called after the ordinary schema checks, or for geometry on a validated object. */
export function hasIntegerGeometry(item: BoardObject): boolean {
  switch (item.kind) {
    case "shape": case "text": case "image": case "table":
      return onGrid(item.at) && Number.isInteger(item.width) && Number.isInteger(item.height);
    case "mindmap":
      return onGrid(item.origin) && Object.values(item.topics).every(topic =>
        topic.appearance?.width === undefined || Number.isInteger(topic.appearance.width));
    case "connector":
      return (item.from.kind === "anchor" || onGrid(item.from.point)) &&
        (item.to.kind === "anchor" || onGrid(item.to.point)) && item.waypoints.every(onGrid);
    case "ink":
      return onGrid(item.at) && (item.subpixel===true || item.samples.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y)));
    case "path":
      return onGrid(item.at) && item.vertices.every(onGrid) &&
        Object.values(item.curves ?? {}).every(pair => onGrid(pair.out) && onGrid(pair.in));
  }
}

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

/** Legacy paths can be shorter than one unit. Keep every vertex and its segment indices. */
function nearestDistinct(raw: Point, avoid: readonly Point[]): Point {
  const p = gridPoint(raw);
  if (!avoid.some(other => same(other, p))) return p;
  let best: Point | undefined;
  let distance = Infinity;
  for (const dx of [0, 1, -1]) for (const dy of [0, 1, -1]) {
    const next = { x: p.x + dx, y: p.y + dy };
    if (Math.abs(next.x) > 1e9 || Math.abs(next.y) > 1e9 || avoid.some(other => same(other, next))) continue;
    const d = Math.hypot(next.x - raw.x, next.y - raw.y);
    if (d < distance) { best = next; distance = d; }
  }
  return best!;
}

/** Round absolute anchors and controls together, then express them relative to their new owners. */
export function gridPath(path: VectorPath, preserveLegacyVertices = false): VectorPath {
  let at = gridPoint(path.at);
  const raw = path.vertices.map(vertex => add(path.at, vertex));
  const points: Point[] = [];
  const distinct: Point[] = [];
  for (const p of raw) {
    let next = gridPoint(p);
    if (preserveLegacyVertices) {
      const previous = points.at(-1);
      const avoid = previous ? [previous] : [];
      if (path.closed && points.length === raw.length - 1) {
        avoid.push(points[0]);
        if (distinct.length < 3) avoid.push(...distinct);
      }
      next = nearestDistinct(p, avoid);
      if (distinct.length < 3 && !distinct.some(other => same(other, next))) distinct.push(next);
    }
    points.push(next);
  }
  // Old files allow a remote local origin. Keep it unless subtracting it would lose a snapped vertex.
  if (preserveLegacyVertices && points.some(p => !same(add(at, subtract(p, at)), p))) at = points[0];
  const vertices = points.map(p => subtract(p, at));
  if (!path.curves) return { ...path, at, vertices };
  const curves: Record<string, CubicHandles> = {};
  for (const [key, pair] of Object.entries(path.curves)) {
    const i = Number(key), j = (i + 1) % vertices.length;
    curves[key] = {
      out: subtract(gridPoint(add(raw[i], pair.out)), points[i]),
      in: subtract(gridPoint(add(raw[j], pair.in)), points[j]),
    };
  }
  return { ...path, at, vertices, curves };
}

export function gridEndpoint(end: Endpoint): Endpoint {
  return end.kind === "free" ? { ...end, point: gridPoint(end.point) } : end;
}

export function migrateObjectGeometry(item: BoardObject): BoardObject {
  switch (item.kind) {
    case "shape": case "text": case "image": case "table": return gridBox(item);
    case "path": return gridPath(item, true);
    case "ink": return gridInk(item);
    case "connector":
      return { ...item, from: gridEndpoint(item.from), to: gridEndpoint(item.to), waypoints: item.waypoints.map(gridPoint) };
    case "mindmap": {
      const topics: Record<string, Topic> = { ...item.topics };
      for (const topic of Object.values(topics)) {
        const width = topic.appearance?.width;
        if (width !== undefined && !Number.isInteger(width))
          topics[topic.id] = { ...topic, appearance: { ...topic.appearance, width: roundWorld(width) } };
      }
      return { ...item, origin: gridPoint(item.origin), topics };
    }
  }
}

/** A formerly nonzero span can fall on one grid point. Retain bindings and direction on import. */
export function restoreConnectorSpan(line: Connector, at: Point, originalFrom: Point, originalTo: Point,
  end: "from" | "to" | undefined = line.to.kind === "free" ? "to" : line.from.kind === "free" ? "from" : undefined): Connector {
  const delta = end === "from" ? subtract(originalFrom, originalTo) : subtract(originalTo, originalFrom);
  const axis = Math.abs(delta.y) > Math.abs(delta.x) ? "y" : "x";
  const point = gridPoint(at);
  const step = Math.max(1, Math.ceil(Math.abs(point[axis]) * Number.EPSILON));
  const shift = (Math.sign(delta[axis]) || 1) * step;
  const coordinate = point[axis] + shift;
  const neighbor = { ...point, [axis]: Number.isFinite(coordinate) ? coordinate : point[axis] - shift };
  if (end) return { ...line, [end]: { kind: "free", point: neighbor } };
  return { ...line, routing: line.routing === "straight" ? "orthogonal" : line.routing, waypoints: [...line.waypoints, neighbor] };
}
