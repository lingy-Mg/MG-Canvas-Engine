import { validInkGeometry } from "../features/ink.ts";
import type { InkGeometry } from "../features/ink.ts";
import { PORT_IDS, gridPoint, portWorld } from "./geometry.ts";
import type { Box, Point, PortId, ShapeKind } from "./geometry.ts";
import { hasIntegerGeometry, migrateObjectGeometry, restoreConnectorSpan } from "./document-grid.ts";
import {textFamilies} from "./text-style.ts";
import {MAX_CARD_TEXT,validCardStyle} from "./card.ts";
import type {CardStyle} from "./card.ts";
import {validCellStyle,validTableCells,validTableWeights} from "./table.ts";
import type {TableObject} from "./table.ts";
import type {TextFace,TextPaint} from "./text-style.ts";

export type Id = string;
export type Endpoint = Readonly<{ kind: "anchor"; objectId: Id; portId: PortId } | { kind: "free"; point: Point }>;
export type ShapeObject = Box & Readonly<{ kind: "shape"; id: Id; shape: ShapeKind; cornerRadius: number; fill: string; stroke: string; strokeWidth?: number; label: string; labelFontSize?:number; content?:CardStyle }>;
export const validFlowLabelSize=(v:unknown):v is number=>typeof v==="number"&&Number.isInteger(v)&&v>=8&&v<=72;
export type CardObject=ShapeObject & Readonly<{content:CardStyle}>;
export function isCard(item:BoardObject|undefined):item is CardObject{return item?.kind==="shape"&&item.content!==undefined;}
export const DEFAULT_SHAPE_STROKE = 1.3;
export const MAX_SHAPE_STROKE = 256;
export type TextObject = Box & TextFace & TextPaint & Readonly<{ kind: "text"; id: Id; text: string; fontSize: number; align: "left" | "center" | "right"; heightMode?: "fixed" }>;
export type ImageObject = Box & Readonly<{ kind: "image"; id: Id; assetId: Id; lockAspect?: false; shadow?: false }>;
export type ImageAsset = Readonly<{ id: Id; mime: "image/png" | "image/jpeg" | "image/webp"; pixelWidth: number; pixelHeight: number }>;
export type Connector = Readonly<{
  kind: "connector"; id: Id; from: Endpoint; to: Endpoint;
  routing: "straight" | "orthogonal" | "curve";
  /** Curves authored with port tangents. Earlier curves use their original spline. */
  portCurve?: true;
  /** Ports chosen by expansion or proximity. A user can fix either end by rebinding it. */
  autoPorts?:"from"|"to"|"both";
  waypoints: readonly Point[]; label: string; labelFontSize?:number; arrow: "none" | "start" | "end" | "both"; stroke: string; strokeWidth?: number;
  /** Set at creation. Absent on edited connectors and in projects with unknown edit history. */
  unedited?: true;
}>;
export const DEFAULT_CONNECTOR_STROKE=1.65;
export const MAX_CONNECTOR_STROKE=64;
export const MIN_TOPIC_WIDTH=52, MAX_TOPIC_WIDTH=196, MAX_TOPIC_STROKE=8;
export type TopicAppearance = Readonly<{fill?:string;textColor?:string;stroke?:string;strokeWidth?:number;width?:number}>;
export type Topic = Readonly<{ id: Id; text: string; childIds: readonly Id[]; collapsed: boolean; side?: "left" | "right"; appearance?:TopicAppearance }>; 
export type MindSkin="rounded"|"square"|"capsule";
export type MindMap = Readonly<{
  kind: "mindmap"; id: Id; origin: Point; rootId: Id; layout: "left" | "right" | "balanced";
  topics: Readonly<Record<Id, Topic>>; theme?: string; spacing?:number; scale?:number; skin?:MindSkin;branchColors?:readonly number[];
}>;
export type InkObject = InkGeometry & Readonly<{ kind:"ink"; id:Id }>;
export type CubicHandles=Readonly<{out:Point;in:Point}>;
export type VectorPath = Readonly<{kind:"path";id:Id;at:Point;vertices:readonly Point[];closed:boolean;stroke:string;strokeWidth:number;fill?:string;curves?:Readonly<Record<string,CubicHandles>>}>;
export const MAX_PATH_VERTICES=4096, MAX_BOARD_PATH_VERTICES=200_000, MAX_PATH_STROKE=64;
export const MAX_BOARD_INK_SAMPLES = 200_000;
export type BoardObject = ShapeObject | TextObject | ImageObject | Connector | MindMap | InkObject | VectorPath | TableObject;
export type ObjectVersion=1|2|3|4|6;
export type GroupMembers=Readonly<Record<Id,readonly Id[]>>;
export type FlowGroups=Readonly<{baseVersion:ObjectVersion;members:GroupMembers}>;
export type BoardDocument = Readonly<{
  schemaVersion:ObjectVersion|5; flowGroups?:FlowGroups; id: Id; theme: string; objects: Readonly<Record<Id, BoardObject>>;
  assets: Readonly<Record<Id, ImageAsset>>; order: readonly Id[];
}>;

/** Minimum schema for this set of objects, including isolated clipboard selections. */
export function contentVersion(objects:Iterable<BoardObject>):ObjectVersion{
  let version:ObjectVersion=1;
  for(const item of objects){
    if(item.kind==="table")return 6;
    if(item.kind==="path"){if(item.curves)version=4;else if(version<3)version=3;}
    else if(item.kind==="ink"&&version===1)version=2;
  }
  return version;
}
type RecordValue = Record<string, unknown>;
export type ValidationIssue = Readonly<{ path: string; message: string }>;
export class DocumentValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map(i => i.path + ": " + i.message).join("; "));
    this.name = "DocumentValidationError";
    this.issues = issues;
  }
}
export function has(obj: object, key: PropertyKey): boolean {
  return Object.hasOwn(obj, key);
}
function lookup<T>(obj: Readonly<Record<Id, T>>, key: Id): T | undefined {
  return has(obj, key) ? obj[key] : undefined;
}
export function objectById(document: BoardDocument, id: Id): BoardObject | undefined { return lookup(document.objects, id); }
export function resolveEndpoint(document: BoardDocument, endpoint: Endpoint): Point | undefined {
  if (endpoint.kind === "free") return endpoint.point;
  const shape = objectById(document, endpoint.objectId);
  return shape?.kind === "shape" ? portWorld(shape, shape.shape, endpoint.portId) : undefined;
}
export function isRecord(x: unknown): x is RecordValue {
  return x !== null && typeof x === "object" && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
}
export function isId(x: unknown): x is Id {
  return typeof x === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(x) && !has(Object.prototype, x);
}
export const isHexPaint=(value:unknown):value is string=>typeof value==="string"&&/^#[0-9a-f]{6}$/i.test(value);
function inRange(value:unknown,min:number,max:number):value is number{
  return typeof value==="number"&&Number.isFinite(value)&&value>=min&&value<=max;
}
export function isTopicAppearance(value:unknown):value is TopicAppearance{
  return isRecord(value)&&allowedKeys(value,["fill","textColor","stroke","strokeWidth","width"])&&
    ["fill","textColor","stroke"].every(k=>!(k in value)||isHexPaint(value[k]))&&
    (!("width" in value)||inRange(value.width,MIN_TOPIC_WIDTH,MAX_TOPIC_WIDTH))&&
    (!("strokeWidth" in value)||inRange(value.strokeWidth,0,MAX_TOPIC_STROKE));
}
function allowedKeys(x: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(x).every(key => keys.includes(key));
}
export function isPoint(x: unknown): x is Point {
  return isRecord(x) && allowedKeys(x, ["x", "y"]) && Number.isFinite(x.x) && Number.isFinite(x.y);
}
function validVertices(value:unknown,closed:boolean,at:Point):value is readonly Point[]{
  if(!Array.isArray(value)||value.length<(closed?3:2)||value.length>MAX_PATH_VERTICES)return false;
  const distinct=new Set<string>();
  for(let i=0;i<value.length;i++){
    const p=value[i];
    if(!isPoint(p)||![at.x+p.x,at.y+p.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=1e9))return false;
    const previous=i?value[i-1]:closed?value.at(-1):undefined;
    if(previous&&p.x===previous.x&&p.y===previous.y)return false;
    if(distinct.size<3)distinct.add(p.x+","+p.y);
  }
  return distinct.size>=(closed?3:2);
}
function validCurveMap(value:unknown,vertices:readonly Point[],closed:boolean,at:Point):boolean{
  if(!isRecord(value))return false;
  const count=vertices.length-(closed?0:1),rows=Object.entries(value);
  if(!rows.length||rows.length>count)return false;
  const validHandle=(anchor:Point,delta:unknown)=>isPoint(delta)&&
    [at.x+anchor.x+delta.x,at.y+anchor.y+delta.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=1e9);
  return rows.every(([key,pair])=>{
    const index=Number(key);
    return Number.isInteger(index)&&index>=0&&index<count&&String(index)===key&&isRecord(pair)&&
      allowedKeys(pair,["out","in"])&&validHandle(vertices[index],pair.out)&&validHandle(vertices[(index+1)%vertices.length],pair.in);
  });
}
export function validPathGeometry(path:VectorPath):boolean{
  return isPoint(path.at)&&validVertices(path.vertices,path.closed,path.at)&&
    (!path.curves||validCurveMap(path.curves,path.vertices,path.closed,path.at));
}
function isPositive(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}
function inList<T>(x: unknown, values: readonly T[]): x is T {
  return values.some(value => value === x);
}
export function isBox(x: unknown): x is Box {
  return isRecord(x) && isPoint(x.at) && isPositive(x.width) && isPositive(x.height) && Number.isFinite(x.rotation);
}

function validateStructure(input: unknown): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (path: string, message: string) => { errors.push({ path, message }); };
  if (!isRecord(input)) return [{ path: "$", message: "expected document object" }];
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2 && input.schemaVersion !== 3 && input.schemaVersion !== 4 && input.schemaVersion !== 5 && input.schemaVersion !== 6) return [{ path: "schemaVersion", message: "unsupported format version" }];
  if (!isId(input.id)) add("id", "invalid id");
  if (!allowedKeys(input, ["schemaVersion", "id", "theme", "objects", "assets", "order",...(input.schemaVersion>=5?["flowGroups"]:[])])) add("$", "unexpected document fields");
  if (typeof input.theme !== "string") add("theme", "expected theme token");
  if (!isRecord(input.objects) || !isRecord(input.assets) || !Array.isArray(input.order)) {
    add("$", "expected objects, assets and order collections");
    return errors;
  }
  const { objects, assets, order } = input;
  const ordered = new Set<Id>();
  for (const id of order) {
    if (!isId(id) || !has(objects, id)) { add("order", "unknown object id"); continue; }
    if (ordered.has(id)) add("order", "duplicate object " + id);
    ordered.add(id);
  }
  const validShapes = new Map<Id, ShapeObject>();
  const connectors: Array<readonly [Id, RecordValue]> = [];
  for (const [key, asset] of Object.entries(assets)) {
    if (!isId(key) || !isRecord(asset) || asset.id !== key || !allowedKeys(asset, ["id", "mime", "pixelWidth", "pixelHeight"]) || !inList(asset.mime, ["image/png", "image/jpeg", "image/webp"])
        || !isPositive(asset.pixelWidth) || !Number.isSafeInteger(asset.pixelWidth) || !isPositive(asset.pixelHeight) || !Number.isSafeInteger(asset.pixelHeight)) {
      add("assets." + key, "invalid asset metadata");
    }
  }
  let inkSamples=0,pathVertices=0,hasCurves=false,hasTable=false;
  for (const [id, obj] of Object.entries(objects)) {
    const path = "objects." + id;
    if (!ordered.has(id)) add(path, "object absent from order");
    if (!isId(id) || !isRecord(obj) || obj.id !== id) { add(path, "invalid or mismatched object id"); continue; }
    if (obj.kind === "shape") {
      if (!isBox(obj) || !allowedKeys(obj, ["id", "kind", "at", "width", "height", "rotation", "shape", "cornerRadius", "fill", "stroke", "strokeWidth", "label","labelFontSize","content"]) || !inList(obj.shape, ["rect", "triangle", "diamond"]) || typeof obj.cornerRadius !== "number" || !Number.isFinite(obj.cornerRadius) || obj.cornerRadius < 0 || typeof obj.fill !== "string" || typeof obj.stroke !== "string" || ("strokeWidth" in obj && (typeof obj.strokeWidth !== "number" || !Number.isFinite(obj.strokeWidth) || obj.strokeWidth < 0 || obj.strokeWidth > MAX_SHAPE_STROKE)) || typeof obj.label !== "string" ||
        ("labelFontSize" in obj&&(!validFlowLabelSize(obj.labelFontSize)||"content" in obj)) ||
        ("content" in obj && (obj.shape!=="rect"||!validCardStyle(obj.content)||obj.label.length>MAX_CARD_TEXT))) {
        add(path, "invalid shape geometry or style");
      } else {
        validShapes.set(id, obj as unknown as ShapeObject);
      }
    } else if (obj.kind === "text") {
      if (!isBox(obj) || !allowedKeys(obj, ["id","kind","at","width","height","rotation","text","fontSize","color","align","heightMode","background","colorMode","fontFamily","fontWeight","italic"]) ||
          typeof obj.text!=="string" || !isPositive(obj.fontSize) || typeof obj.color!=="string" || !inList(obj.align,["left","center","right"]) ||
          ("heightMode" in obj && obj.heightMode!=="fixed") || ("background" in obj && !isHexPaint(obj.background)) ||
          ("colorMode" in obj && !inList(obj.colorMode,["auto","custom"])) || ("fontFamily" in obj && !inList(obj.fontFamily,textFamilies)) ||
          ("fontWeight" in obj && ![400,500,600,700].includes(obj.fontWeight as number)) || ("italic" in obj && typeof obj.italic!=="boolean")) add(path,"invalid text object");
    } else if (obj.kind === "table") {
      hasTable=true;
      if(input.schemaVersion!==6||!isBox(obj)||obj.rotation!==0||
        !allowedKeys(obj,["kind","id","at","width","height","rotation","cells","style","rowWeights","columnWeights"])||
        !validTableCells(obj.cells)||("rowWeights" in obj&&!validTableWeights(obj.rowWeights,obj.cells.length))||
        ("columnWeights" in obj&&!validTableWeights(obj.columnWeights,obj.cells[0].length))||
        ("style" in obj&&!validCellStyle(obj.style)))add(path,"表格尺寸、单元格、样式或工程版本无效");
    } else if (obj.kind === "image") {
      if (!isBox(obj) || !allowedKeys(obj, ["id", "kind", "at", "width", "height", "rotation", "assetId", "lockAspect", "shadow"]) || ("lockAspect" in obj && obj.lockAspect!==false) || ("shadow" in obj && obj.shadow!==false) || !isId(obj.assetId) || !has(assets, obj.assetId)) add(path, "invalid image geometry or missing asset");
    } else if(obj.kind==="path"){
      if(input.schemaVersion<3||!allowedKeys(obj,["id","kind","at","vertices","closed","stroke","strokeWidth","fill","curves"])||
        !isPoint(obj.at)||typeof obj.closed!=="boolean"||!isHexPaint(obj.stroke)||!inRange(obj.strokeWidth,.25,MAX_PATH_STROKE)||
        ("fill" in obj&&(!obj.closed||!isHexPaint(obj.fill)))||!validVertices(obj.vertices,obj.closed,obj.at)||
        ("curves" in obj&&(input.schemaVersion<4||!validCurveMap(obj.curves,obj.vertices,obj.closed,obj.at))))add(path,"路径顶点、曲线控制柄或文档版本无效");
      else {pathVertices+=obj.vertices.length;if("curves" in obj)hasCurves=true;}
    } else if(obj.kind === "ink") {
      if(input.schemaVersion===1||!allowedKeys(obj,["id","kind","at","color","baseWidth","brushVersion","samples","subpixel"])||
        !isPoint(obj.at)||!validInkGeometry(obj))add(path,"invalid ink stroke or unsupported document version");
      else inkSamples+=obj.samples.length;
    } else if (obj.kind === "connector") {
      connectors.push([id, obj]);
    } else if (obj.kind === "mindmap") {
      if (!isPoint(obj.origin) || !allowedKeys(obj, ["id", "kind", "origin", "rootId", "layout", "topics", "theme","spacing","scale","skin","branchColors"]) || !inList(obj.layout, ["left", "right", "balanced"]) || (obj.theme !== undefined && typeof obj.theme !== "string") ||
        obj.spacing!==undefined&&!inRange(obj.spacing,4,80)||obj.scale!==undefined&&!inRange(obj.scale,.5,2)||
        obj.skin!==undefined&&!inList(obj.skin,["rounded","square","capsule"])) add(path, "invalid mind map origin, layout or style");
      validateTree(obj, path, add);
    } else {
      add(path, "unknown object kind");
    }
  }
  if(input.schemaVersion===6&&!hasTable)add("schemaVersion","版本 6 需要包含表格");
  if(input.schemaVersion===5||input.schemaVersion===6&&"flowGroups" in input){
    const groups=input.flowGroups;
    if(!isRecord(groups)||!allowedKeys(groups,["baseVersion","members"])||!isRecord(groups.members)||!Object.keys(groups.members).length){
      add("flowGroups","分组工程需要有效的成员表");
    }else{
      const base=hasTable?6:hasCurves?4:pathVertices?3:inkSamples?2:1;
      if(groups.baseVersion!==base&&!(base===1&&groups.baseVersion===2))add("flowGroups.baseVersion","原工程版本与内容不一致");
      const claimed=new Set<Id>();
      for(const [gid,members] of Object.entries(groups.members)){
        const field="flowGroups.members."+gid;
        if(!isId(gid)||has(objects,gid)||has(assets,gid)||!Array.isArray(members)||members.length<2){add(field,"流程组至少需要两个独立节点");continue;}
        for(const id of members){
          if(!isId(id)||!validShapes.has(id)||claimed.has(id))add(field,"分组成员必须是唯一且存在的流程节点");
          else claimed.add(id);
        }
      }
    }
  }
  if(input.schemaVersion===4&&!hasCurves)add("schemaVersion","版本 4 必须含有三次贝塞尔段");
  if(input.schemaVersion===3&&pathVertices===0)add("schemaVersion","version 3 requires a vector path");
  if(pathVertices>MAX_BOARD_PATH_VERTICES)add("objects","path vertex budget exceeded");
  if(inkSamples>MAX_BOARD_INK_SAMPLES)add("objects","ink sample budget exceeded");
  for (const [id, link] of connectors) {
    const path = "objects." + id;
    const endpoint = (value: unknown, field: string): Point | undefined => {
      if (isRecord(value)) {
        if (value.kind === "free" && allowedKeys(value, ["kind", "point"]) && isPoint(value.point)) return value.point;
        if (value.kind === "anchor" && allowedKeys(value, ["kind", "objectId", "portId"]) && isId(value.objectId) && inList(value.portId, PORT_IDS)) {
          const shape = validShapes.get(value.objectId);
          if (shape) return portWorld(shape, shape.shape, value.portId);
        }
      }
      add(path + "." + field, "endpoint must be finite or bound to a shape port");
      return undefined;
    };
    const from = endpoint(link.from, "from");
    const to = endpoint(link.to, "to");
    if (!allowedKeys(link, ["id", "kind", "from", "to", "routing", "waypoints", "label","labelFontSize", "arrow", "stroke", "strokeWidth", "unedited","portCurve","autoPorts"]) ||
        ("labelFontSize" in link&&!validFlowLabelSize(link.labelFontSize)) ||
        ("autoPorts" in link&&!inList(link.autoPorts,["from","to","both"])) ||
        ("portCurve" in link && (link.portCurve !== true || link.routing !== "curve")) ||
        ("unedited" in link && link.unedited !== true) || !inList(link.routing, ["straight", "orthogonal", "curve"]) || !inList(link.arrow, ["none", "start", "end", "both"]) || typeof link.label !== "string" || typeof link.stroke !== "string" || ("strokeWidth" in link && !inRange(link.strokeWidth,.25,MAX_CONNECTOR_STROKE)) || !Array.isArray(link.waypoints) || !Array.from(link.waypoints).every(isPoint)) {
      add(path, "invalid connector route or style");
    } else if (from && to && zeroLengthConnector(from,to,link.routing,link.waypoints)) {
      add(path, "zero-length connector");
    }
  }
  return errors;
}

export function zeroLengthConnector(from:Point,to:Point,route:Connector["routing"],waypoints:readonly Point[]):boolean{
  return from.x===to.x&&from.y===to.y&&(route==="straight"||waypoints.every(p=>p.x===from.x&&p.y===from.y));
}

/** Detaching a derived port turns it into a stored grid point. Keep the surviving end fixed. */
export function detachEndpoints(doc: BoardDocument, line: Connector, detach: (objectId: Id, field: "from" | "to") => boolean): Connector {
  const freeFrom = line.from.kind === "anchor" && detach(line.from.objectId, "from");
  const freeTo = line.to.kind === "anchor" && detach(line.to.objectId, "to");
  if (!freeFrom && !freeTo) return line;
  const originalFrom = resolveEndpoint(doc, line.from)!, originalTo = resolveEndpoint(doc, line.to)!;
  const from = freeFrom ? gridPoint(originalFrom) : originalFrom, to = freeTo ? gridPoint(originalTo) : originalTo;
  const next: Connector = { ...line, from: freeFrom ? { kind: "free", point: from } : line.from,
    to: freeTo ? { kind: "free", point: to } : line.to };
  return zeroLengthConnector(from, to, next.routing, next.waypoints)
    ? restoreConnectorSpan(next, from, originalFrom, originalTo, freeTo ? "to" : "from") : next;
}

export function isBranchColors(value:unknown,count:number):value is readonly number[]{
  return Array.isArray(value)&&value.length===count&&value.every(n=>Number.isSafeInteger(n)&&n>=0)&&new Set(value).size===count;
}
function validateTree(map: RecordValue, path: string, add: (path: string, msg: string) => void): void {
  const { topics, rootId } = map;
  if (!isRecord(topics) || !isId(rootId) || !has(topics, rootId)) {
    add(path, "missing tree root");
    return;
  }
  const root=topics[rootId];
  if(map.branchColors!==undefined&&(!isRecord(root)||!Array.isArray(root.childIds)||!isBranchColors(map.branchColors,root.childIds.length)))
    add(path+".branchColors","invalid branch palette assignments");
  const children = new Map<Id, readonly Id[]>();
  const parent = new Map<Id, Id>();
  for (const [id, info] of Object.entries(topics)) {
    const topicPath = path + ".topics." + id;
    if (!isId(id) || !isRecord(info) || info.id !== id || !allowedKeys(info, ["id", "text", "childIds", "collapsed", "side", "appearance"]) || typeof info.text !== "string" || !Array.isArray(info.childIds) || typeof info.collapsed !== "boolean") {
      add(topicPath, "invalid topic");
      continue;
    }
    if ("appearance" in info && !isTopicAppearance(info.appearance)) add(topicPath+".appearance", "invalid topic appearance");
    if (info.side !== undefined && !inList(info.side, ["left", "right"])) add(topicPath, "invalid branch side");
    const validKids: Id[] = [];
    for (const child of info.childIds) {
      if (!isId(child) || !has(topics, child)) { add(topicPath, "unknown child id"); continue; }
      if (child === rootId) add(topicPath, "root cannot have a parent");
      if (parent.has(child)) add(topicPath, "child appears more than once: " + child);
      parent.set(child, id);
      validKids.push(child);
    }
    children.set(id, validKids);
  }
  // Iterative DFS detects cycles even in malformed disconnected components.
  const visited = new Set<Id>();
  const active = new Set<Id>();
  const reachable = new Set<Id>();
  for (const start of [rootId, ...children.keys()]) {
    if (visited.has(start)) continue;
    const stack: Array<{ id: Id; exit: boolean }> = [{ id: start, exit: false }];
    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) break;
      const { id, exit } = item;
      if (exit) { active.delete(id); visited.add(id); continue; }
      if (active.has(id)) { add(path + ".topics." + id, "tree cycle"); continue; }
      if (visited.has(id)) continue;
      if (start === rootId) reachable.add(id);
      active.add(id);
      stack.push({ id, exit: true });
      for (const child of children.get(id) ?? []) stack.push({ id: child, exit: false });
    }
  }
  for (const [id, info] of Object.entries(topics)) {
    if (!reachable.has(id)) add(path + ".topics." + id, "topic unreachable from root");
    if (isRecord(info) && info.side !== undefined && parent.get(id) !== rootId) add(path + ".topics." + id, "side applies only to first-level branches");
  }
}

export function validateDocument(input: unknown): readonly ValidationIssue[] {
  const issues = validateStructure(input);
  if (issues.length) return issues;
  const doc = input as BoardDocument;
  const errors: ValidationIssue[] = [];
  for (const item of Object.values(doc.objects)) {
    if (!hasIntegerGeometry(item)) errors.push({ path: "objects." + item.id, message: "坐标和宽高必须为整数" });
  }
  return errors;
}
export function assertDocument(input: unknown): asserts input is BoardDocument {
  const errors = validateDocument(input);
  if (errors.length) throw new DocumentValidationError(errors);
}
/** Load an owned snapshot (freshly parsed or cloned). Validate old data before converting it. */
export function readDocument(input: unknown): BoardDocument {
  const errors = validateStructure(input);
  if (errors.length) throw new DocumentValidationError(errors);
  const doc = input as BoardDocument;
  let objects: Record<Id, BoardObject> | undefined;
  for (const item of Object.values(doc.objects)) {
    if (hasIntegerGeometry(item)) continue;
    objects ??= { ...doc.objects };
    objects[item.id] = migrateObjectGeometry(item);
  }
  if (!objects) return freezeData(doc);
  const next = { ...doc, objects };
  for (const item of Object.values(objects)) {
    if (item.kind !== "connector") continue;
    const from = resolveEndpoint(next, item.from)!, to = resolveEndpoint(next, item.to)!;
    if (zeroLengthConnector(from, to, item.routing, item.waypoints)) {
      const old = doc.objects[item.id] as Connector;
      objects[item.id] = restoreConnectorSpan(item, from, resolveEndpoint(doc, old.from)!, resolveEndpoint(doc, old.to)!);
    }
  }
  assertDocument(next);
  return freezeData(next);
}
export function parseDocument(json: string): BoardDocument {
  return readDocument(JSON.parse(json));
}
/** For this JSON-only document schema; snapshots can be safely shared by readers. */
export function freezeData<T>(value: T): T {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const obj = pending.pop();
    if (typeof obj !== "object" || obj === null || seen.has(obj)) continue;
    seen.add(obj);
    for (const entry of Object.values(obj)) pending.push(entry);
    Object.freeze(obj);
  }
  return value;
}
