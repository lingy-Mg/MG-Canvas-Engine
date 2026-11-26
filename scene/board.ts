import {localPoint,localRect,placeTopics,topicPlacement} from "./topic-placement.ts";
import {SceneGrid} from "./spatial-grid.ts";
import {connectorArrows} from "./connector-arrows.ts";
import {layoutSceneLabels,registerConnectorLabel} from "./connector-labels.ts";
import {isCard} from "../core/document.ts";
import type {CardObject} from "../core/document.ts";
import {cardLayout} from "../features/card-content.ts";
import type {CardLayout} from "../features/card-content.ts";
import {tablePrimitives} from "./table-layout.ts";
import type {CellAddress} from "../features/table.ts";
import type {ConnectorArrows} from "./connector-arrows.ts";
import { autoLabelInk,canvasThemes,contrastInk } from "../platform/theme.ts";
import type {WorkspaceTheme} from "../platform/theme.ts";
import { DEFAULT_CONNECTOR_STROKE,DEFAULT_SHAPE_STROKE } from "../core/document.ts";
import {closestSegment,insideVector,pathSegments,segmentDistance,vectorBounds} from "../core/path-geometry.ts";
import type {PathSegment} from "../core/path-geometry.ts";
import { boxBounds, localToWorld, portWorld, shapeOutlinePoints, worldToLocal } from "../core/geometry.ts";
import { HIGHLIGHTER_BRUSH_VERSION,hitInk,inkBounds,inkPoints,inkSegmentHull } from "../features/ink.ts";
import type { InkPoint } from "../features/ink.ts";
import type {TextFace,TextPaint} from "../core/text-style.ts";
import {automaticTextColor} from "../core/text-style.ts";
import { plainTextWidth,textBoxWithSize,textFrame,wrapPlainText } from "../features/plain-text.ts";
import { anchoredFlowPath,flowLabelAnchor } from "../features/flow.ts";
import { layoutIndex,layoutMap,topicTier } from "../features/mindmap-layout.ts";
import type {LocalTopic} from "../features/mindmap-layout.ts";
import type {PaintedTopic} from "./mindmap-motion.ts";
export { layoutMap } from "../features/mindmap-layout.ts";
import type { Box, Camera, Point, Rect, ShapeKind } from "../core/geometry.ts";
import type { BoardDocument, BoardObject, Endpoint, Id, MindMap, ShapeObject, Topic } from "../core/document.ts";

export type Bounds = Rect;
type Underline="joined"|"left"|"right";
type UnderlineJunction=Readonly<{start?:number;end:number}>;
export type Primitive = Readonly<{topicAlpha?:number}>&(
  | Readonly<{kind:"cardText";box:CardObject;layout:CardLayout}>
  | Readonly<{kind:"tableGrid";box:Box;rowEdges:readonly number[];columnEdges:readonly number[];backgrounds:readonly {box:Box;color:string}[]}>
  | Readonly<{ kind:"box"; box:Box; shape:ShapeKind; radius:number; fill:string; stroke:string; strokeWidth?:number; underline?:Underline }>
  | Readonly<{ kind:"text"; at:Point; text:string; color:string; size:number; align:"left"|"center"|"right"; weight:number; maxWidth?:number; canvasInk?:true; surfaceInk?:true }>
  | Readonly<{ kind:"path"; points:readonly Point[]; color:string; width:number; segments?:readonly PathSegment[]; curved?:boolean; closed?:boolean; fill?:string; arrow?:"none"|"start"|"end"|"both"; arrows?:ConnectorArrows; junction?:UnderlineJunction }>
  | Readonly<{ kind:"image"; box:Box; assetId:Id;shadow?:false }>
  | Readonly<{ kind:"ink"; points:readonly InkPoint[]; color:string; highlighter?:true; subpixel?:true }>
  | Readonly<{ kind:"nodeLabel"; box:Box; topicId?:Id; text:string; rows?:readonly string[]; fontSize:number; color:string; weight:number; maxLines:number; surfaceInk?:true; labelFill?:string }>
  | Readonly<TextFace & TextPaint & { kind:"textBlock"; box:Box; lines:readonly string[]; textAlign:"left"|"center"|"right"; fontSize:number;clip?:true;cell?:CellAddress;strike?:boolean;underline?:boolean }>);
export type ScenePick = Readonly<{ shape:ShapeKind; box:Box; radius?:number } | { points:readonly Point[]; hitPad?:number } | {segments:readonly PathSegment[];hitPad:number;filled:boolean} | { ink:readonly InkPoint[] }>;
type Pick=ScenePick;
const outlineRadii=new WeakMap<Box,number>();
export function outlineRadius(box:Box){return outlineRadii.get(box)??0;}
export type DrawGroup = Readonly<{ id:Id; items:readonly Primitive[]; picks:readonly Pick[]; bounds:Bounds; topicCount?:number; topicIds?:readonly Id[] }>;
export type Scene = readonly DrawGroup[];
const dark = "#212735";
const grey = "#64748b";
const point = (x:number,y:number):Point => ({ x,y });
const topicGeometry=new WeakMap<ReturnType<typeof layoutMap>,{id:Id;theme:MindMap["theme"];skin:MindMap["skin"];colors:MindMap["branchColors"];group:DrawGroup}>();
const makeBox = (at:Point,width:number,height:number):Box => ({ at,width,height,rotation:0 });

export function flowLabelBox(shape:ShapeObject):Box{
  const triangle=shape.shape==="triangle",diamond=shape.shape==="diamond";
  const center=localToWorld(point(shape.width/2,shape.height*(triangle?.66:.5)),shape);
  const width=Math.max(0,shape.width*(triangle?.56:diamond?.82:1)-(diamond?10:16));
  const height=Math.max(0,shape.height*(triangle?.48:diamond?.34:1)-(diamond?8:10));
  return {at:point(center.x-width/2,center.y-height/2),width,height,rotation:shape.rotation};
}
export function topicLabelBox(box:Box,scale=1,depth=1):Box{
  const tier=topicTier(depth),x=tier.padX*scale,y=tier.padY*scale;
  return makeBox(point(box.at.x+x,box.at.y+y),box.width-2*x,box.height-2*y);
}
function topicPort(row:LocalTopic,left:boolean):Point{
  const b=row.box;
  return point(b.at.x+(left?0:b.width),b.at.y+(row.depth>=3?b.height:b.height/2));
}
const branchWidth=(map:MindMap)=>1.8*(map.scale??1);

const mindColors={
  spectrum:{root:"#24223f",branches:["#c74450","#bd782e","#9e8531","#24846d","#3e71bd","#7759ae"]},
  indigo:{root:"#282b50",branches:["#527bba","#8264ae","#328984","#b3667b","#a4773b","#627b9b"]},
  mint:{root:"#13564d",branches:["#319078","#5087ae","#a28b3f","#6c86b1","#9771a4","#58936b"]},
  warm:{root:"#70452b",branches:["#b76c44","#b08632","#af637a","#7b7561","#8b69a1","#4b887d"]},
};
export function mindPalette(theme?:string){
  return theme&&Object.hasOwn(mindColors,theme)?mindColors[theme as keyof typeof mindColors]:mindColors.indigo;
}
function tint(hex:string,white:number){
  const rgb=[1,3,5].map(offset=>Math.round(parseInt(hex.slice(offset,offset+2),16)*(1-white)+255*white));
  return "#"+rgb.map(c=>c.toString(16).padStart(2,"0")).join("");
}
export function topicPaint(map:MindMap,topic:Topic,placement:LocalTopic|"left"|"right",workspace:WorkspaceTheme="light"){
  const palette=mindPalette(map.theme);
  const row=typeof placement==="string"?layoutIndex(layoutMap(map)).get(topic.id):placement;
  const root=topic.id===map.rootId,style=topic.appearance;
  const depth=row?.depth??1;
  const index=Math.max(0,row?.branch??0),branch=palette.branches[(map.branchColors?.[index]??index)%palette.branches.length];
  const underline=depth>=3;
  const fill=underline?"transparent":style?.fill??(root?palette.root:depth===1?branch:tint(branch,.79));
  const stroke=style?.stroke??(underline?branch:root?tint(palette.root,.32):depth===1?branch:tint(branch,.36));
  const background=fill==="transparent"?canvasThemes[workspace].bg:fill;
  return {fill,stroke,textColor:style?.textColor??contrastInk(background),strokeWidth:style?.strokeWidth??(underline?branchWidth(map):undefined),branch,
    underline,surfaceInk:fill==="transparent"&&style?.textColor===undefined};
}
export function mergeBounds(a:Bounds|undefined,b:Bounds):Bounds {
  if (!a) return b;
  return { min:point(Math.min(a.min.x,b.min.x),Math.min(a.min.y,b.min.y)), max:point(Math.max(a.max.x,b.max.x),Math.max(a.max.y,b.max.y)) };
}
function pathBounds(points:readonly Point[]):Bounds {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const p of points) { minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); }
  return { min:point(minX,minY), max:point(maxX,maxY) };
}
/** World edges shared by drag guides and explicit alignment commands. */
export function alignmentBounds(item:BoardObject,projected:Rect):Rect{
  if(item.kind!=="shape"||item.shape==="rect")return projected;
  return pathBounds(shapeOutlinePoints(item,item.shape));
}
type Preview=Readonly<{objects:ReadonlyMap<Id,BoardObject>;extra?:readonly Id[];topicLayouts?:ReadonlyMap<Id,readonly PaintedTopic[]>}>;
export function buildScene(doc:BoardDocument,preview?:Preview,ids?:readonly Id[]):Scene{
  if(ids?.some(id=>{const item=preview?.objects.get(id)??doc.objects[id];return item?.kind==="connector"&&item.label;})){
    // An individual PNG uses the same label position as the full board.
    const all=[...new Set([...doc.order,...(preview?.extra??[]),...ids])];
    const groups=new Map(layoutSceneLabels(projectGeometry(doc,preview,all)).map(g=>[g.id,g]));
    return ids.flatMap(id=>groups.get(id)??[]);
  }
  return layoutSceneLabels(projectGeometry(doc,preview,ids));
}
export function projectGeometry(doc:BoardDocument,preview?:Preview,ids?:readonly Id[]):Scene {
  const lookup = (id:Id) => preview?.objects.get(id) ?? doc.objects[id];
  const endpoint = (e:Endpoint):Point|undefined => {
    if (e.kind === "free") return e.point;
    const shape = lookup(e.objectId);
    if (shape?.kind !== "shape") return;
    return portWorld(shape,shape.shape,e.portId);
  };
  const groups: DrawGroup[] = [];
  const ordered=ids ?? (preview?.extra?.length ? [...doc.order,...preview.extra] : doc.order);
  for (const id of ordered) {
    const object = preview?.objects.get(id) ?? doc.objects[id];
    if(!object)continue;
    const items: Primitive[] = [], picks: Pick[] = [];
    let bounds: Bounds|undefined;
    const box = (range:Box, shape:ShapeKind, radius:number, fill:string, stroke:string, strokeWidth?:number,underline?:Underline) => {
      items.push({ kind:"box",box:range,shape,radius,fill,stroke,...(strokeWidth===undefined?{}:{strokeWidth}),...(underline?{underline}:{}) });
      picks.push({ box:range,shape });outlineRadii.set(range,radius);
      const b=boxBounds(range), pad=strokeWidth!==undefined&&strokeWidth>DEFAULT_SHAPE_STROKE?strokeWidth/2:0;
      bounds = mergeBounds(bounds,pad?{min:point(b.min.x-pad,b.min.y-pad),max:point(b.max.x+pad,b.max.y+pad)}:b);
    };
    const label = (at:Point,text:string,size:number,color = dark,align:"left"|"center"|"right"="center",weight = 600,maxWidth?:number,canvasInk?:true) => {
      if (text) items.push({ kind:"text",at,text,size,color,align,weight,maxWidth,...(canvasInk?{canvasInk}:{}) });
    };
    const line = (points:readonly Point[], color:string, width:number, arrow?:"none"|"start"|"end"|"both", curved=false, pick=true, pad=0,junction?:UnderlineJunction) => {
      const arrows=arrow&&connectorArrows(points,width,arrow);
      items.push({ kind:"path",points,color,width,arrow,curved,...(arrows?{arrows}:{}),...(junction?{junction}:{}) });
      if (pick) picks.push({ points:arrows?.shaft??points,...(pad?{hitPad:pad}:{}) });
      const b=pathBounds(points);
      bounds = mergeBounds(bounds,pad?{min:point(b.min.x-pad,b.min.y-pad),max:point(b.max.x+pad,b.max.y+pad)}:b);
      if(arrows)for(const head of arrows.heads){
        bounds=mergeBounds(bounds,pathBounds(head));
        picks.push({segments:head.map((from,i)=>({from,to:head[(i+1)%3]})),hitPad:0,filled:true});
      }
    };
    if (object.kind === "shape") {
      const range = object;
      box(range,object.shape,object.cornerRadius,object.fill,object.stroke,object.strokeWidth);
      if(isCard(object)){
        items.push({kind:"cardText",box:object,layout:cardLayout(object)});
      }else if(object.label){
        items.push({kind:"nodeLabel",box:flowLabelBox(object),text:object.label,
          fontSize:object.labelFontSize??13,weight:700,color:autoLabelInk(dark,object.fill),labelFill:object.fill,maxLines:object.shape==="diamond"?1:3});
      }
    } else if (object.kind === "connector") {
      const from = endpoint(object.from),to = endpoint(object.to);
      if (!from || !to) continue;
      const path=anchoredFlowPath(from,to,object.routing,object.waypoints,object.from,object.to,lookup,object);
      const width=object.strokeWidth??DEFAULT_CONNECTOR_STROKE;
      line(path,object.stroke,width,object.arrow,false,true,width>DEFAULT_CONNECTOR_STROKE?width/2:0);
      const size=object.labelFontSize??10,anchor=object.label&&flowLabelAnchor(path,object.portCurve,size);
      if(anchor)label(anchor.point,object.label,size,grey,anchor.align,560,undefined,true);
    } else if (object.kind === "mindmap") {
      const local:readonly PaintedTopic[]=preview?.topicLayouts?.get(id)??layoutMap(object),cached=topicGeometry.get(local);
      if(cached?.id===id&&cached.theme===object.theme&&cached.skin===object.skin&&cached.colors===object.branchColors){groups.push(placeTopics(cached.group,object.origin));continue;}
      const index = layoutIndex(local),branches=mindPalette(object.theme).branches,baseWidth=branchWidth(object);
      for (const node of local) {
        const inside = node.parent ? index.get(node.parent) : undefined;
        if (!inside) continue;
        const left = node.side === "left";
        const a=topicPort(inside,left),b=topicPort(node,!left);
        const center = (a.x+b.x)/2;
        const junction=node.depth<3?undefined:{start:inside.depth>=3?inside.topic.appearance?.strokeWidth??baseWidth:undefined,
          end:node.topic.appearance?.strokeWidth??baseWidth};
        const width=(junction?.start??baseWidth)||junction?.end||baseWidth;
        const colors=node.retiring?mindPalette(node.retiring.theme).branches:branches;
        const slot=(node.retiring??object).branchColors?.[node.branch]??node.branch;
        line([a,point(center,a.y),point(center,b.y),b],colors[slot%colors.length],width,undefined,true,false,
          junction?Math.max(width,junction.end)/2:0,junction);
        if(node.alpha!==undefined&&node.alpha<1)items[items.length-1]={...items[items.length-1],topicAlpha:node.alpha};
      }
      for (const node of local) {
        const at=node.box.at;
        const isRoot=node.depth===0;
        const left=node.side==="left";
        const first=items.length,paint=topicPaint(node.retiring??object,node.topic,node);
        const radius=object.skin==="square"?2:object.skin==="capsule"?node.box.height/2:(isRoot?12:8)*(object.scale??1);
        const underline=paint.underline?(node.topic.collapsed||!node.topic.childIds.length?node.side:"joined"):undefined;
        box(node.box,"rect",radius,paint.fill,paint.stroke,paint.strokeWidth,underline);
        if(node.retiring)picks.pop();
        const textBox=topicLabelBox(node.box,object.scale,node.depth);
        items.push({kind:"nodeLabel",box:textBox,topicId:node.topic.id,text:node.topic.text||"未命名",rows:node.lines,fontSize:node.fontSize,
          weight:topicTier(node.depth).weight,color:paint.textColor,maxLines:node.lines.length,...(paint.surfaceInk?{surfaceInk:true}:{})});
        if(node.topic.collapsed&&node.topic.childIds.length){
          const x=at.x+(left?5:node.box.width-5),y=at.y+7;
          items.push({kind:"text",at:point(x,y),text:"+",size:10,color:paint.textColor,align:"center",weight:700,...(paint.surfaceInk?{surfaceInk:true}:{})});
        }
        if(node.alpha!==undefined&&node.alpha<1)for(let i=first;i<items.length;i++)items[i]={...items[i],topicAlpha:node.alpha};
      }
      if(bounds){
        const group={id,items,picks,bounds,topicCount:picks.length,topicIds:local.filter(row=>!row.retiring).map(row=>row.topic.id)};
        topicGeometry.set(local,{id,theme:object.theme,skin:object.skin,colors:object.branchColors,group});groups.push(placeTopics(group,object.origin));
      }
      continue;
    } else if (object.kind === "table") {
      items.push(...tablePrimitives(object));
      picks.push({box:object,shape:"rect"});bounds=boxBounds(object);
    } else if (object.kind === "text") {
      const fixed=object.heightMode==="fixed";
      const lines=wrapPlainText(object.text,object.width,object.fontSize,object);
      const range=textFrame(object,lines);
      let width=object.width;
      if(!fixed&&width<object.fontSize)for(const row of lines)width=Math.max(width,plainTextWidth(row,object.fontSize,object));
      const offset=object.align==="left"?0:object.align==="right"?object.width-width:(object.width-width)/2;
      const visible=textBoxWithSize(range,width,range.height,offset);
      picks.push({box:visible,shape:"rect"});bounds=mergeBounds(bounds,boxBounds(visible));
      const {align:textAlign,fontSize,color,background,fontFamily,fontWeight,italic}=object;
      const colorMode=automaticTextColor(object)?"auto":object.colorMode;
      items.push({kind:"textBlock",box:range,lines,textAlign,fontSize,color,colorMode,background,fontFamily,fontWeight,italic,...(fixed?{clip:true}:{})});
    } else if(object.kind==="path"){
      const segments=pathSegments(object),pad=object.strokeWidth/2;
      const points=[segments[0].from,...segments.slice(0,object.vertices.length-1).map(s=>s.to)];
      items.push({kind:"path",points,segments,closed:object.closed,fill:object.fill,color:object.stroke,width:object.strokeWidth});
      picks.push({segments,hitPad:pad,filled:Boolean(object.closed&&object.fill)});
      const b=vectorBounds(segments);bounds={min:point(b.min.x-pad,b.min.y-pad),max:point(b.max.x+pad,b.max.y+pad)};
    } else if(object.kind==="ink"){
      const points=inkPoints(object);
      items.push({kind:"ink",points,color:object.color,...(object.brushVersion===HIGHLIGHTER_BRUSH_VERSION?{highlighter:true as const}:{}),
        ...(object.subpixel?{subpixel:true as const}:{})});
      picks.push({ink:points});bounds=inkBounds(points);
    } else {
      const range = object;
      items.push({kind:"image",box:range,assetId:object.assetId,...(object.shadow===false?{shadow:false as const}:{})});
      picks.push({box:range,shape:"rect"});
      bounds=mergeBounds(bounds,boxBounds(range));
    }
    if(bounds){
      const group={id,items,picks,bounds};
      if(object.kind==="connector"&&items[0]?.kind==="path"&&items[1]?.kind==="text")
        registerConnectorLabel(group,items[0],items[1]);
      groups.push(group);
    }
  }
  return groups;
}
function nearSegment(p:Point,a:Point,b:Point):number {
  const x=b.x-a.x,y=b.y-a.y;
  const denom=x*x+y*y;
  const q=denom?Math.max(0,Math.min(1,((p.x-a.x)*x+(p.y-a.y)*y)/denom)):0;
  return Math.hypot(p.x-a.x-q*x,p.y-a.y-q*y);
}
function hitShape(p:Point,range:Box,shape:ShapeKind):boolean {
  const q=worldToLocal(p,range), x=q.x/range.width,y=q.y/range.height;
  if (shape === "diamond") return Math.abs(x-.5)+Math.abs(y-.5)<=.5;
  if (shape === "triangle") return y>=0 && y<=1 && Math.abs(x-.5)<=y*.5;
  return x>=0 && x<=1 && y>=0 && y<=1;
}
export type SceneHit=Readonly<{group:DrawGroup;target:ScenePick;topicId?:Id;origin?:Point}>;
const topicPickGrids=new WeakMap<DrawGroup,SceneGrid>();
function nearbyTopics(source:DrawGroup,region:Rect){
  if(!source.topicIds||source.topicIds.length<128)return;
  let grid=topicPickGrids.get(source);
  if(!grid){
    grid=new SceneGrid();
    source.picks.forEach((pick,i)=>{if("box" in pick)grid!.add(String(i),boxBounds(pick.box));});
    topicPickGrids.set(source,grid);
  }
  const nearby=new Set<Id>();
  if(grid.collect(region,source.picks.length,nearby))return Array.from(nearby,Number).sort((a,b)=>a-b);
}
export function hitDetail(scene:Scene, world:Point,tolerance:number):SceneHit|undefined {
  for (let i=scene.length-1;i>=0;i--) {
    const group=scene[i],pose=topicPlacement(group),point=pose?localPoint(world,pose.origin):world;
    const source=pose?.local??group,near=nearbyTopics(source,{min:point,max:point});
    for(let j=0,n=near?.length??source.picks.length;j<n;j++){
      const index=near?near[n-1-j]:source.picks.length-1-j,target=source.picks[index];
      if ("box" in target ? hitShape(point,target.box,target.shape) : "ink" in target ? hitInk(target.ink,point,tolerance) :
        "segments" in target ? closestSegment(target.segments,point,tolerance+target.hitPad)!==undefined||target.filled&&insideVector(target.segments,point) : target.points.some((b,index) => index > 0 && nearSegment(point,target.points[index-1],b)<=tolerance+(target.hitPad??0)))
        return {group,target,topicId:source.topicIds?.[index],origin:pose?.origin};
    }
  }
}
export function hitTest(scene:Scene,world:Point,tolerance:number):Id|undefined{return hitDetail(scene,world,tolerance)?.group.id;}
export function groupBounds(scene:Scene, ids?:ReadonlySet<Id>):Bounds|undefined {
  return scene.reduce<Bounds|undefined>((bounds,group)=>!ids||ids.has(group.id)?mergeBounds(bounds,group.bounds):bounds,undefined);
}
const contains=(r:Bounds,p:Point):boolean=>p.x>=r.min.x&&p.x<=r.max.x&&p.y>=r.min.y&&p.y<=r.max.y;
const overlaps=(a:Bounds,b:Bounds):boolean=>a.min.x<=b.max.x&&b.min.x<=a.max.x&&a.min.y<=b.max.y&&b.min.y<=a.max.y;
function segmentIntersectsRect(a:Point,b:Point,r:Bounds):boolean {
  // Intersect two axis slabs, clipping the segment's parametric interval.
  let start=0,end=1;
  for (const axis of ["x","y"] as const) {
    const delta=b[axis]-a[axis];
    if(delta===0){if(a[axis]<r.min[axis]||a[axis]>r.max[axis])return false;continue;}
    const one=(r.min[axis]-a[axis])/delta,two=(r.max[axis]-a[axis])/delta;
    start=Math.max(start,Math.min(one,two));end=Math.min(end,Math.max(one,two));
    if(start>end)return false;
  }
  return true;
}
function corners(r:Bounds):Point[]{return [r.min,point(r.max.x,r.min.y),r.max,point(r.min.x,r.max.y)];}
export function marqueeHit(scene:Scene, world:Bounds,topics?:Map<Id,Set<Id>>):Id[]{
  return scene.filter(group=>{
    if(!overlaps(group.bounds,world))return false;
    const pose=topicPlacement(group),rectangle=pose?localRect(world,pose.origin):world;
    const source=pose?.local??group;
    if(topics&&source.topicIds){
      const ids=new Set<Id>();
      const near=nearbyTopics(source,rectangle);
      for(let j=0,n=near?.length??source.picks.length;j<n;j++){
        const i=near?near[j]:j,target=source.picks[i];
        if("box" in target&&overlaps(boxBounds(target.box),rectangle))ids.add(source.topicIds![i]);
      }
      if(ids.size)topics.set(group.id,ids);
      return ids.size>0;
    }
    return source.picks.some(target=>{
      if("ink" in target){
        if(corners(rectangle).some(corner=>hitInk(target.ink,corner)))return true;
        return target.ink.some((p,i)=>{
          const x=Math.max(rectangle.min.x,Math.min(rectangle.max.x,p.x));
          const y=Math.max(rectangle.min.y,Math.min(rectangle.max.y,p.y));
          if(Math.hypot(x-p.x,y-p.y)<=p.radius)return true;
          const next=target.ink[i+1],quad=next&&inkSegmentHull(p,next);
          return quad&&quad.some((a,j)=>segmentIntersectsRect(a,quad[(j+1)%4],rectangle));
        });
      }
      if("segments" in target){
        return target.segments.some(s=>segmentDistance(s,rectangle,target.hitPad)<=target.hitPad)||
          target.filled&&corners(rectangle).some(p=>insideVector(target.segments,p));
      }
      if("points" in target)return target.points.some((p,i)=>i>0&&segmentIntersectsRect(target.points[i-1],p,rectangle));
      const {box,shape}=target,world=shapeOutlinePoints(box,shape);
      return world.some(p=>contains(rectangle,p))||corners(rectangle).some(p=>hitShape(p,box,shape))||
        world.some((a,i)=>segmentIntersectsRect(a,world[(i+1)%world.length],rectangle));
    });
  }).map(group=>group.id);
}
export function fitScene(scene:Scene, width:number,height:number):Camera {
  return fitBounds(groupBounds(scene),width,height);
}
export function fitBounds(box:Bounds|undefined,width:number,height:number):Camera{
  if (!box) return { offset:point(width/2,height/2),zoom:1 };
  const padding=Math.min(74,Math.max(18,Math.min(width,height)*.12));
  const sceneW=Math.max(1,box.max.x-box.min.x), sceneH=Math.max(1,box.max.y-box.min.y);
  // An overview must include widely separated objects even when manual zoom stops at 5%.
  const zoom=Math.min(1.3,Math.max(1,width-padding*2)/sceneW,Math.max(1,height-padding*2)/sceneH);
  return { offset:point(width/2-(box.min.x+sceneW/2)*zoom,height/2-(box.min.y+sceneH/2)*zoom),zoom };
}
