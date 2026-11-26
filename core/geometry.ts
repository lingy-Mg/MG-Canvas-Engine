/** World units are CSS pixels at zoom 1. Bitmap pixels are never document units. */
export type Point = Readonly<{ x: number; y: number }>;
export type Camera = Readonly<{ offset: Point; zoom: number }>;
export type Box = Readonly<{ at: Point; width: number; height: number; rotation: number }>;
export type PortId = "north" | "east" | "south" | "west";
export type ShapeKind = "rect" | "triangle" | "diamond";
export const PORT_IDS: readonly PortId[] = ["north", "east", "south", "west"];
export const ZOOM = Object.freeze({ min: 0.05, max: 16 });

/** One document unit is one world pixel. Camera, projection and device math stay continuous. */
export function roundWorld(value: number): number {
  if (!Number.isFinite(value)) return NaN;
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}
export function gridPoint(point: Point): Point {
  return { x: roundWorld(point.x), y: roundWorld(point.y) };
}
export function onGrid(point: Point): boolean {
  return Number.isInteger(point.x) && Number.isInteger(point.y);
}
export function gridSize(value: number): number {
  return value > 0 ? Math.max(1, roundWorld(value)) : value;
}
export function gridBox<T extends Box>(box: T): T {
  return { ...box, at: gridPoint(box.at), width: gridSize(box.width), height: gridSize(box.height) };
}

export function worldToScreen(world: Point, camera: Camera): Point {
  return { x: world.x * camera.zoom + camera.offset.x, y: world.y * camera.zoom + camera.offset.y };
}
export function screenToWorld(screen: Point, camera: Camera): Point {
  return { x: (screen.x - camera.offset.x) / camera.zoom, y: (screen.y - camera.offset.y) / camera.zoom };
}
export function screenToDevice(screen: Point, pixelRatio: number): Point {
  requirePositive(pixelRatio, "pixel ratio");
  return { x: screen.x * pixelRatio, y: screen.y * pixelRatio };
}
export function deviceToScreen(device: Point, pixelRatio: number): Point {
  requirePositive(pixelRatio, "pixel ratio");
  return { x: device.x / pixelRatio, y: device.y / pixelRatio };
}
export function clientToScreen(client: Point, viewportOrigin: Point): Point {
  return { x: client.x - viewportOrigin.x, y: client.y - viewportOrigin.y };
}
export function panBy(camera: Camera, deltaCss: Point): Camera {
  return { offset: { x: camera.offset.x + deltaCss.x, y: camera.offset.y + deltaCss.y }, zoom: camera.zoom };
}
export function zoomAt(camera: Camera, screen: Point, requestedZoom: number): Camera {
  requirePositive(requestedZoom, "zoom");
  // A whole-board overview can be below the manual floor. Zoom back in from its current scale.
  const zoom = Math.max(Math.min(ZOOM.min,camera.zoom), Math.min(ZOOM.max, requestedZoom));
  const world = screenToWorld(screen, camera);
  return { offset: { x: screen.x - world.x * zoom, y: screen.y - world.y * zoom }, zoom };
}
/** Both anchors are viewport-local CSS positions. Allows pan + pinch in one operation. */
export function moveZoomAnchor(camera: Camera, previous: Point, next: Point, scale: number): Camera {
  return panBy(zoomAt(camera, previous, camera.zoom * scale), { x: next.x - previous.x, y: next.y - previous.y });
}
/** Wheel values from the capture adapter. Provide measured/configured line height, not DPR. */
export function normalizeWheel(delta: Point, mode: 0 | 1 | 2, lineHeight: number, page: Point): Point {
  if (mode === 0) return { ...delta };
  if (mode === 1) {
    requirePositive(lineHeight, "line height");
    return { x: delta.x * lineHeight, y: delta.y * lineHeight };
  }
  if (mode !== 2) throw new RangeError("unknown wheel delta unit");
  requirePositive(page.x, "page width");
  requirePositive(page.y, "page height");
  return { x: delta.x * page.x, y: delta.y * page.y };
}
export function localToWorld(local: Point, box: Box): Point {
  const x = local.x - box.width / 2;
  const y = local.y - box.height / 2;
  const c = Math.cos(box.rotation);
  const s = Math.sin(box.rotation);
  return { x: box.at.x + box.width / 2 + x * c - y * s, y: box.at.y + box.height / 2 + x * s + y * c };
}
export function worldToLocal(world: Point, box: Box): Point {
  const x = world.x - box.at.x - box.width / 2;
  const y = world.y - box.at.y - box.height / 2;
  const c = Math.cos(box.rotation);
  const s = Math.sin(box.rotation);
  return { x: box.width / 2 + x * c + y * s, y: box.height / 2 - x * s + y * c };
}
export function boxBounds(box: Box): Readonly<{ min: Point; max: Point }> {
  const corners = [
    localToWorld({ x: 0, y: 0 }, box),
    localToWorld({ x: box.width, y: 0 }, box),
    localToWorld({ x: box.width, y: box.height }, box),
    localToWorld({ x: 0, y: box.height }, box),
  ];
  return {
    min: { x: Math.min(...corners.map(p => p.x)), y: Math.min(...corners.map(p => p.y)) },
    max: { x: Math.max(...corners.map(p => p.x)), y: Math.max(...corners.map(p => p.y)) },
  };
}

export function shapeOutlinePoints(box:Box,shape:ShapeKind):Point[]{
  const w=box.width,h=box.height;
  const corners=shape==="diamond"?[{x:w/2,y:0},{x:w,y:h/2},{x:w/2,y:h},{x:0,y:h/2}]:
    shape==="triangle"?[{x:w/2,y:0},{x:w,y:h},{x:0,y:h}]:
    [{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}];
  return corners.map(p=>localToWorld(p,box));
}
export function portNormal(box:Pick<Box,"rotation">,port:PortId):Point{
  const c=Math.cos(box.rotation),s=Math.sin(box.rotation);
  switch(port){
    case "east":return {x:c,y:s};
    case "south":return {x:-s,y:c};
    case "west":return {x:-c,y:-s};
    case "north":return {x:s,y:-c};
  }
}
/** Ports are geometrically derived in world coordinates. The triangle points upward. */
export function portWorld(box: Box, shape: ShapeKind, port: PortId): Point {
  const { width: w, height: h } = box;
  switch (port) {
    case "north": return localToWorld({ x: w / 2, y: 0 }, box);
    case "south": return localToWorld({ x: w / 2, y: h }, box);
    case "east": return localToWorld({ x: shape === "triangle" ? 3 * w / 4 : w, y: h / 2 }, box);
    case "west": return localToWorld({ x: shape === "triangle" ? w / 4 : 0, y: h / 2 }, box);
  }
}
function requirePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(label + " must be positive and finite");
}

export type Rect = Readonly<{ min: Point; max: Point }>;
export function rectBetween(a:Point,b:Point):Rect {
  return { min:{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y)},max:{x:Math.max(a.x,b.x),y:Math.max(a.y,b.y)} };
}
