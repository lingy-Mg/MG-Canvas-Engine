import {transformCompletedInk} from "../features/ink.ts";
import {LayerVisibility} from "./layer-visibility.ts";
import {preservesLayerLocks,preservesLockedOrder} from "./layer-locks.ts";
import {allocateId} from "../core/id.ts";
import {expandGroupSelection,flowGroupOf,groupUnit,groupableNodes} from "../core/flow-groups.ts";
import {planShapeTransform} from "./shape-properties.ts";
import {planImageTransform} from "./image-properties.ts";
import type {ImageTransform} from "./image-properties.ts";
import type {ShapeTransform} from "./shape-properties.ts";
import { objectById } from "../core/document.ts";
import {isCard} from "../core/document.ts";
import {cardLayout,minimumCardWidth} from "../features/card-content.ts";
import { completeInsertion,createHistory, dispatch, groupEdits, redo, undo } from "../core/history.ts";
import { localToWorld, moveZoomAnchor, panBy, rectBetween, screenToWorld, worldToScreen, zoomAt } from "../core/geometry.ts";
import {pathFrame,pathHandleBox,transformPath} from "../core/path-transform.ts";
import type {PathFrame} from "../core/path-transform.ts";
import { constrainRotation,cornerPoint,dragRotation,resizable,resizeAroundOpposite } from "./resize.ts";
import type { BoxHandle,Resizable,ResizeOptions } from "./resize.ts";
import {resizeTextWidth,textWidthTravel} from "./text-width.ts";
import type {TextEdge} from "./text-width.ts";
import {resizeTableBand} from "../features/table-geometry.ts";
import type {TableDivider} from "../features/table-geometry.ts";
import type {TableObject} from "../core/table.ts";
import { moveObjects, movePatches, objectOrigin, planMapOrigin, planMove } from "./transform.ts";
import type {DragAlignment} from "./drag-alignment.ts";
import type { MovePlan, MovePreview, ObjectCopies } from "./transform.ts";
import type { BoardDocument,Id,TextObject,VectorPath } from "../core/document.ts";
import type { Box,Camera, Point, Rect } from "../core/geometry.ts";
import type { ChangeSet, History, Transaction } from "../core/history.ts";

export type Tool = "select" | "hand";
export type DragSetup={plan:MovePlan;alignment?:DragAlignment;copies?:ObjectCopies};
type PrepareDrag=(ids:readonly Id[],camera:Camera,copy:boolean)=>DragSetup|undefined;
type MarqueeHit=(world:Rect,topics:Map<Id,Set<Id>>)=>readonly Id[];
type MarqueeSelection={ids:readonly Id[];topics:Map<Id,Set<Id>>;count:number};
const emptyMarquee:MarqueeHit=()=>[];
function elementCount(ids:readonly Id[],topics:ReadonlyMap<Id,ReadonlySet<Id>>){
  let count=ids.length;
  for(const range of topics.values())count+=range.size-1; // A partial map stands for its selected topics.
  return count;
}
type Active = Readonly<{ point: Point; type: string }>;
type Gesture =
  | { kind: "pending"; id: number; start: Point; target?: Id; action: "drag" | "pan" | "marquee" | "tap" | "resize";
      shift:boolean; tapSelect:boolean; moved:boolean; copy?:boolean; bypass?:boolean; dragIds?:readonly Id[]; drag?:DragSetup; resize?:ResizeOptions&{item:Resizable} }
  | { kind: "pinch"; ids: [number, number]; midpoint: Point; distance: number }
  | { kind: "rotate"; id:number; item:Resizable; pivot:Point; start:Point; rawAngle:number; moved:boolean }
  | { kind:"pathTransform"; id:number; item:VectorPath; frame:PathFrame; box:Box; pivot:Point; start:Point;
      axis?:Point; moved:boolean; rawAngle:number; angle:number; scale:number }
  | { kind:"textWidth"; id:number; item:TextObject; edge:TextEdge; start:Point; moved:boolean }
  | { kind:"tableBand"; id:number; item:TableObject; divider:TableDivider; start:Point; moved:boolean }
  | { kind: "blocked" };
const sub = (a: Point, b: Point): Point => ({ x: a.x-b.x, y: a.y-b.y });
const dist = (a: Point, b: Point): number => Math.hypot(a.x-b.x,a.y-b.y);
const centre = (a: Point, b: Point): Point => ({ x:(a.x+b.x)/2, y:(a.y+b.y)/2 });

export class EditorSession {
  private state:History;
  private locked=new Set<Id>();
  private visibility=new LayerVisibility();
  get visibilityRevision():number{return this.visibility.revision;}
  get hiddenIds():ReadonlySet<Id>{return this.hiddenIdsFor(this.doc);}
  hiddenIdsFor(doc:BoardDocument):ReadonlySet<Id>{return this.visibility.hidden(doc);}
  isHidden(id:Id):boolean{return this.hiddenIds.has(id);}
  isDirectlyHidden(id:Id):boolean{return this.visibility.isDirectlyHidden(id);}
  hasHiddenEndpoint(id:Id):boolean{return this.visibility.hasHiddenEndpoint(this.doc,id);}
  onHiddenEdit?:()=>void;
  setLayerVisibility(ids:readonly Id[],visible:boolean):boolean{
    if(this.busy||!this.visibility.set(this.doc,ids,visible))return false;
    if(!visible){
      const remaining=this.picked.filter(id=>!this.isHidden(id));
      for(const id of this.topicRanges.keys())if(this.isHidden(id))this.topicRanges.delete(id);
      if(remaining.length!==this.picked.length){this.picked=Object.freeze(remaining);this.groupScope=this.scopeFor(remaining);}
    }
    this.emit();return true;
  }
  showAllLayers():boolean{
    if(this.busy||!this.visibility.clear())return false;
    this.emit();return true;
  }
  visibleSelection(ids:readonly Id[],scope?:Id,doc:BoardDocument=this.doc):readonly Id[]{
    const hidden=this.hiddenIdsFor(doc);
    if(!hidden.size)return expandGroupSelection(doc,ids,scope);
    return expandGroupSelection(doc,ids.filter(id=>!hidden.has(id)),scope).filter(id=>!hidden.has(id));
  }
  private locksRevision=0;
  onLockedEdit?:()=>void;
  private historyAccess?:{state:History;undo:boolean;redo:boolean};
  get history():History{return this.state;}
  get lockRevision():number{return this.locksRevision;}
  isLocked(id:Id):boolean{return this.locked.has(id);}
  anyLocked(ids:Iterable<Id>):boolean{
    if(this.locked.size)for(const id of ids)if(this.locked.has(id))return true;
    return false;
  }
  private countedLocks?:{ids:readonly Id[];revision:number;count:number};
  get lockedSelectionCount():number{
    const cached=this.countedLocks;
    if(cached?.ids===this.picked&&cached.revision===this.lockRevision)return cached.count;
    let count=0;if(this.locked.size)for(const id of this.picked)if(this.isLocked(id))count++;
    this.countedLocks={ids:this.picked,revision:this.lockRevision,count};return count;
  }
  get selectionLocked():boolean{return this.lockedSelectionCount>0;}
  setLayerLocks(ids:readonly Id[],on:boolean):boolean{
    if(this.busy||!ids.length||ids.some(id=>!objectById(this.doc,id)))return false;
    if(ids.every(id=>this.locked.has(id)===on))return false;
    for(const id of ids){if(on)this.locked.add(id);else this.locked.delete(id);}
    this.locksRevision++;this.historyAccess=undefined;this.emit();return true;
  }
  permitsOrder(order:readonly Id[],doc:BoardDocument=this.doc):boolean{
    return preservesLockedOrder(doc.order,order,this.locked)&&preservesLockedOrder(doc.order,order,this.hiddenIdsFor(doc));
  }
  private permittedHistory(){
    if(this.historyAccess?.state===this.state)return this.historyAccess;
    const allowed=(frame:History["past"][number]|undefined)=>Boolean(frame&&preservesLayerLocks(this.doc,frame.doc,frame.forward,this.locked));
    return this.historyAccess={state:this.state,undo:allowed(this.state.past.at(-1)),redo:allowed(this.state.future.at(-1))};
  }
  get canUndo():boolean{return this.permittedHistory().undo;}
  get canRedo():boolean{return this.permittedHistory().redo;}

  camera: Camera;
  private picked: readonly Id[] = [];
  private topicRanges=new Map<Id,Set<Id>>();
  get selectedTopics():ReadonlyMap<Id,ReadonlySet<Id>>{return this.topicRanges;}
  get selectedElementCount():number{return elementCount(this.picked,this.topicRanges);}
  private groupScope?:Id;
  preview: MovePreview | undefined;
  marquee: Rect | undefined;
  onMarqueeCommit?:()=>void;
  private marqueeCache?:{area:Rect;camera:Camera;picked:readonly Id[];ranges:ReadonlyMap<Id,ReadonlySet<Id>>;hit:MarqueeHit;result:MarqueeSelection};
  tool: Tool = "select";
  readonly pointers = new Map<number, Active>();
  private gesture?: Gesture;
  private savedRevision = -1;
  private sessionId = Symbol("board session");
  private listeners = new Set<(change?: ChangeSet) => void>();

  private prepareDrag?:PrepareDrag;
  constructor(doc: BoardDocument, camera: Camera,prepareDrag?:PrepareDrag) {
    this.state=createHistory(doc);this.camera=camera;this.prepareDrag=prepareDrag;
  }
  get doc(): BoardDocument { return this.history.doc; }
  get selection(): Id | undefined { return this.picked.at(-1); }
  get selectedIds(): readonly Id[] { return this.picked; }
  get dirty(): boolean { return this.savedRevision !== this.history.revision; }
  get generation(): symbol { return this.sessionId; }
  get busy(): boolean { return this.pointers.size > 0; }
  get navigating():boolean{return this.gesture?.kind==="pinch"||this.gesture?.kind==="pending"&&this.gesture.action==="pan";}
  get draggingObjects():boolean{return this.gesture?.kind==="pending"&&this.gesture.action==="drag";}
  get draggingCopies():boolean{return this.gesture?.kind==="pending"&&this.gesture.action==="drag"&&this.gesture.copy===true;}
  get alignmentGuides(){return this.gesture?.kind==="pending"?this.gesture.drag?.alignment?.guides:undefined;}
  get alignmentBypassed(){return this.gesture?.kind==="pending"&&this.gesture.bypass===true;}
  get rotating(): boolean { return this.gesture?.kind==="rotate"; }
  get pathTransforming():boolean {return this.gesture?.kind==="pathTransform";}
  get resizingText():boolean {return this.gesture?.kind==="textWidth";}
  get resizingTableAxis(){return this.gesture?.kind==="tableBand"?this.gesture.divider.axis:undefined;}
  get transforming():boolean {return this.rotating||this.pathTransforming||this.resizingText||Boolean(this.resizingTableAxis);}
  get pathGestureHint():string|undefined{
    const g=this.gesture;
    if(g?.kind!=="pathTransform")return;
    return g.axis?`等比缩放 ${Number((g.scale*100).toFixed(2))}% · Esc 取消`:
      `旋转增量 ${Number((g.angle*180/Math.PI).toFixed(1))}° · Shift 每 15° 吸附 · Esc 取消`;
  }
  get pathGestureBox():Box|undefined{
    const g=this.gesture;
    if(g?.kind!=="pathTransform")return;
    const width=g.box.width*g.scale,height=g.box.height*g.scale;
    return {at:{x:g.frame.center.x-width/2,y:g.frame.center.y-height/2},width,height,rotation:g.frame.rotation+g.angle};
  }
  listen(callback: (change?: ChangeSet) => void): () => void {
    this.listeners.add(callback); return () => this.listeners.delete(callback);
  }
  private emit(change?: ChangeSet): void { for (const listener of this.listeners) listener(change); }
  get editingGroup():Id|undefined{return this.groupScope;}
  get selectedGroup():Id|undefined{
    const group=flowGroupOf(this.doc,this.selection);
    if(!group||this.groupScope===group||this.visibleSelection(groupUnit(this.doc,group),group).length!==this.picked.length)return;
    return this.picked.every(id=>flowGroupOf(this.doc,id)===group)?group:undefined;
  }
  get canGroup():boolean{return !this.busy&&!this.groupScope&&!this.selectionLocked&&Boolean(groupableNodes(this.doc,this.picked));}
  groupSelection():boolean{
    if(this.busy||this.groupScope)return false;
    const nodes=groupableNodes(this.doc,this.picked);if(!nodes)return false;
    const id=allocateId("group"),members={...this.doc.flowGroups?.members};
    if(Object.hasOwn(members,id)||objectById(this.doc,id)||Object.hasOwn(this.doc.assets,id))return false;
    members[id]=nodes;
    return this.commitEdit({label:"创建流程组",patches:[{op:"setFlowGroups",members}]},this.generation,nodes);
  }
  ungroupSelection():boolean{
    const group=this.selectedGroup??this.groupScope;if(this.busy||!group||!this.doc.flowGroups)return false;
    const ids=groupUnit(this.doc,group),members={...this.doc.flowGroups.members};delete members[group];
    return this.commitEdit({label:"取消流程分组",patches:[{op:"setFlowGroups",members}]},this.generation,ids);
  }
  enterGroup(member?:Id):boolean{
    const group=member?flowGroupOf(this.doc,member):this.selectedGroup;
    if(this.busy||!group||this.groupScope===group)return false;
    const target=member??this.doc.flowGroups!.members[group].find(id=>!this.isHidden(id));
    if(!target||this.isHidden(target))return false;
    this.groupScope=group;this.keep([target]);this.emit();return true;
  }
  leaveGroup():boolean{
    if(this.busy||!this.groupScope)return false;
    const ids=groupUnit(this.doc,this.groupScope);this.groupScope=undefined;this.keep(ids);this.emit();return true;
  }
  private scopeFor(ids:readonly Id[]):Id|undefined{
    return this.groupScope&&ids.length&&ids.every(id=>flowGroupOf(this.doc,id)===this.groupScope)?this.groupScope:undefined;
  }
  private normalizedIds(ids:readonly Id[],scope?:Id){
    return [...new Set(this.visibleSelection(ids,scope))].filter(id=>Boolean(objectById(this.doc,id)));
  }
  private keep(ids:readonly Id[]):boolean {
    const previousScope=this.groupScope;
    this.groupScope=this.scopeFor(ids);
    const unique=this.normalizedIds(ids,this.groupScope);
    for(const [id,topics] of this.topicRanges){
      const map=this.doc.objects[id];
      if(!unique.includes(id)||map?.kind!=="mindmap")this.topicRanges.delete(id);
      else{
        for(const topic of topics)if(!Object.hasOwn(map.topics,topic))topics.delete(topic);
        if(!topics.size){this.topicRanges.delete(id);unique.splice(unique.indexOf(id),1);}
      }
    }
    if(unique.length===this.picked.length && unique.every((id,i)=>id===this.picked[i]))return previousScope!==this.groupScope;
    this.picked=Object.freeze(unique);return true;
  }
  private pick(id?:Id,shift=false):boolean {
    if (!shift){
      const hadTopics=this.topicRanges.size>0;if(hadTopics)this.topicRanges=new Map();
      return this.keep(id?[id]:[])||hadTopics;
    }
    if (!id) return false;
    if(!this.picked.includes(id))return this.keep([...this.picked,id]);
    const unit=new Set(expandGroupSelection(this.doc,[id],this.groupScope));
    return this.keep(this.picked.filter(item=>!unit.has(item)));
  }
  select(id?: Id, shift=false): void { if(this.pick(id,shift)){if(this.transforming||this.draggingObjects)this.cancel();else this.emit();} }
  selectAll():void { const inGroup=Boolean(this.groupScope)||this.topicRanges.size>0;if(this.topicRanges.size)this.topicRanges=new Map();this.groupScope=undefined;if(this.keep(this.doc.order)||inGroup){if(this.transforming||this.draggingObjects)this.cancel();else this.emit();} }
  setTool(tool: Tool): void { this.cancel(); this.tool = tool; this.emit(); }
  setCamera(camera: Camera): void { this.camera = camera; if(this.transforming||this.draggingObjects)this.cancel();else this.emit(); }
  zoomAt(screen: Point, factor: number): void { this.setCamera(zoomAt(this.camera, screen, this.camera.zoom * factor)); }
  pan(delta: Point): void { this.setCamera(panBy(this.camera, delta)); }
  wheel(screen: Point, delta: Point, zoom: boolean): void {
    if (this.busy) return;
    if (zoom) this.zoomAt(screen, Math.exp(Math.max(-1, Math.min(1, -delta.y * 0.003))));
    else this.pan({ x:-delta.x, y:-delta.y });
  }
  open(doc: BoardDocument, saved: boolean): void {
    this.resetPointers();
    const state=createHistory(doc);
    this.state=state;this.groupScope=undefined;this.visibility.clear();this.locked.clear();this.locksRevision++;this.historyAccess=undefined;
    this.savedRevision = saved ? 0 : -1;
    this.sessionId = Symbol("board session");
    this.keep([]);
    this.emit();
  }
  markSaved(generation: symbol, revision: number): void {
    if (generation !== this.sessionId || revision > this.history.revision || revision <= this.savedRevision) return;
    this.savedRevision = revision;
    this.emit();
  }
  undo(): void {
    this.cancel();
    if(!this.canUndo)return;
    const r=undo(this.history);
    if(r.state===this.history)return;
    this.state=r.state;this.keep(this.picked);this.emit(r.changeSet);
  }
  redo(): void {
    this.cancel();
    if(!this.canRedo)return;
    const r=redo(this.history);
    if(r.state===this.history)return;
    this.state=r.state;this.keep(this.picked);this.emit(r.changeSet);
  }
  private proposal(transaction:Transaction,report=false){
    try{
      const r=dispatch(this.history,transaction);
      if(r.state===this.state)return;
      if(!preservesLayerLocks(this.doc,r.state.doc,r.changeSet,this.locked)){
        if(report)this.onLockedEdit?.();return;
      }
      if(preservesLayerLocks(this.doc,r.state.doc,r.changeSet,this.hiddenIds))return r;
      if(report)this.onHiddenEdit?.();
    }catch(error){
      // An invalid final overlap or numeric transform must not publish partial history.
      if(!(error instanceof Error && error.name==="DocumentValidationError"))throw error;
    }
  }
  permitsEdit(transaction:Transaction):boolean{return !this.busy&&(!this.locked.size&&!this.hiddenIds.size||Boolean(this.proposal(transaction)));}
  private apply(transaction:Transaction):ChangeSet|undefined{
    const result=this.proposal(transaction,true);if(!result)return;
    this.state=result.state;return result.changeSet;
  }
  commitEdit(transaction:Transaction, generation: symbol, selected?: readonly Id[],placement?:History,series?:{start:History;head:History}):boolean {
    if(this.busy||this.generation!==generation||series&&series.head!==this.state)return false;
    const previous=this.state;
    const r=this.apply(transaction);
    if(!r)return false;
    const patch=transaction.patches[0];
    if(previous===placement&&transaction.patches.length===1&&patch.op==="putObject")this.state=completeInsertion(previous,this.state,patch.value.id);
    if(series){
      if(previous!==series.start)this.state=groupEdits(series.start,this.state,transaction.label);
      series.head=this.state;
    }
    this.keep(selected??this.picked);this.emit(r);return true;
  }
  moveSelection(delta:Point):boolean {
    if(this.busy||!this.picked.length||this.selectionLocked)return false;
    const r=this.apply({label:"微移对象",patches:movePatches(moveObjects(planMove(this.doc,this.picked,undefined,this.hiddenIds),delta))});
    if(r)this.emit(r);
    return Boolean(r);
  }
  transformSelection(values:ShapeTransform&ImageTransform):boolean {
    if(this.busy||this.picked.length!==1||!this.selection||!Number.isFinite(values.x)||!Number.isFinite(values.y))return false;
    const item=objectById(this.doc,this.selection);
    if(!item||item.kind!=="image"&&(values.imageRotation!==undefined||values.imageNaturalRatio))return false;
    if(values.shapeStyle&&item.kind!=="shape")return false;
    if(item.kind==="shape"||item.kind==="image"){
      const changed=item.kind==="image"?planImageTransform(this.doc,item,values):planShapeTransform(this.doc,item,values,this.hiddenIds);
      return Boolean(changed?.size&&this.commitEdit({label:"修改对象变换",patches:movePatches(changed)},this.generation));
    }
    if(item.kind==="path"){
      const next=transformPath(item,0,1,undefined,{x:values.x,y:values.y});
      return Boolean(next&&next!==item&&this.commitEdit({label:"变换整条路径",patches:[{op:"putObject",value:next}]},this.generation));
    }
    if(item.kind==="mindmap"){
      const changed=planMapOrigin(item,values.x,values.y);
      return Boolean(changed?.size&&this.commitEdit({label:"修改整张脑图位置",patches:movePatches(changed)},this.generation));
    }
    if(item.kind==="ink"){
      const next=transformCompletedInk(item,item,0,1,{x:values.x,y:values.y});
      return Boolean(next&&next!==item&&this.commitEdit({label:"变换笔迹",patches:[{op:"putObject",value:next}]},this.generation));
    }
    const origin=objectOrigin(item);
    if(!origin)return false;
    const delta={x:values.x-origin.x,y:values.y-origin.y};
    if(!delta.x&&!delta.y)return false;
    const moved=moveObjects(planMove(this.doc,this.picked,undefined,this.hiddenIds),delta);
    const r=this.apply({label:"修改对象变换",patches:movePatches(moved)});
    if(r)this.emit(r);
    return Boolean(r);
  }
  toggleRootFold(id: Id): boolean {
    if (this.busy) return false;
    const item = objectById(this.doc,id);
    if (item?.kind !== "mindmap") return false;
    const root = item.topics[item.rootId];
    const r = this.apply({ label:"展开或折叠脑图", patches:[{ op:"putObject", value:{
      ...item, topics:{ ...item.topics, [root.id]:{ ...root, collapsed:!root.collapsed } },
    } }] });
    if(r)this.emit(r);
    return Boolean(r);
  }
  down(id: number, type: string, screen: Point, hit: Id | undefined, hand: boolean, shift=false, intent?:BoxHandle|"copy",paintedPath?:Box): void {
    if (this.pointers.has(id)) return;
    this.pointers.set(id, { point:screen, type });
    if (this.pointers.size > 1) {
      this.clearPreview();
      const touch = [...this.pointers].filter(([,p]) => p.type === "touch");
      if (this.gesture?.kind !== "blocked" && this.pointers.size === 2 && touch.length === 2) {
        const [[a,p],[b,q]] = touch;
        this.gesture = { kind:"pinch", ids:[a,b], midpoint:centre(p.point,q.point), distance:dist(p.point,q.point) };
      } else this.gesture = { kind:"blocked" };
      this.emit();
      return;
    }
    const useHand = hand || this.tool === "hand";
    const copy=intent==="copy",options=copy?undefined:intent;
    const box=options&&!useHand&&!this.isLocked(options.id)&&this.picked.length===1&&this.selection===options.id?objectById(this.doc,options.id):undefined;
    if(options&&"divider" in options){
      if(!useHand&&hit===options.id&&this.selectedIds.length<=1&&!this.isLocked(hit)&&!this.isHidden(hit)){
        const item=objectById(this.doc,hit);
        if(item?.kind==="table"){
          this.keep([hit]);this.gesture={kind:"tableBand",id,item,divider:options.divider,start:screen,moved:false};
          this.emit();return;
        }
      }
    }else if(options&&"textEdge" in options){
      if(box?.kind==="text"){
        this.gesture={kind:"textWidth",id,item:box,edge:options.textEdge,start:screen,moved:false};
        this.emit();return;
      }
    }else if(options&&box?.kind==="path"){
      const frame=pathFrame(box),outline=pathHandleBox(frame,this.camera),grab=paintedPath??outline;
      // Measure the gesture on the handle the user saw, and apply only its delta to the committed contour.
      const pivot=worldToScreen(paintedPath?localToWorld({x:grab.width/2,y:grab.height/2},grab):frame.center,this.camera);
      const axis="corner" in options?sub(worldToScreen(cornerPoint(grab,options.corner),this.camera),pivot):undefined;
      this.gesture={kind:"pathTransform",id,item:box,frame,box:outline,pivot,start:screen,axis,moved:false,rawAngle:0,angle:0,scale:1};
      this.emit();return;
    }else if(options&&resizable(box)){
      if("rotate" in options){
        const pivot=worldToScreen(localToWorld({x:box.width/2,y:box.height/2},box),this.camera);
        this.gesture={kind:"rotate",id,item:box,pivot,start:screen,rawAngle:box.rotation,moved:false};
        this.emit();return;
      }
      this.gesture={kind:"pending",id,start:screen,target:options.id,action:"resize",shift:false,tapSelect:false,moved:false,resize:{...options,item:box}};
      return;
    }
    const target = !useHand && hit && !this.isHidden(hit) && objectById(this.doc,hit) ? hit : undefined;
    const isTouch = type === "touch";
    shift=shift&&!isTouch;
    const selected = target ? this.picked.includes(target) : false;
    let action: "pan"|"drag"|"tap"|"marquee" = useHand || (isTouch && (!target || !selected)) ? "pan" : target ? "drag" : isTouch ? "tap" : "marquee";
    const rawIds=target&&action==="drag"?(selected?this.picked:shift?[...this.picked,target]:[target]):undefined;
    const dragIds=rawIds?this.visibleSelection(rawIds,this.scopeFor(rawIds)):undefined;
    if(dragIds&&!copy&&this.anyLocked(dragIds))action=isTouch?"pan":"tap";
    this.gesture = { kind:"pending", id, start:screen, target, action, shift, tapSelect:isTouch && !useHand, moved:false,dragIds,copy };
  }
  setRotationSnap(snap:boolean):void {
    const g=this.gesture;
    if(g?.kind==="rotate"||g?.kind==="pathTransform"&&!g.axis){
      const pointer=this.pointers.get(g.id);
      if(pointer)this.move(g.id,pointer.point,snap);
    }
  }
  setMoveBypass(bypass:boolean):void{
    const g=this.gesture;
    if(g?.kind!=="pending"||g.action!=="drag"||!g.moved)return;
    const held=this.pointers.get(g.id);if(held)this.move(g.id,held.point,false,bypass);
  }
  move(id: number, screen: Point, snap=false,bypass=false): void {
    const old = this.pointers.get(id);
    if (!old) return;
    this.pointers.set(id, { ...old, point:screen });
    const g = this.gesture;
    if (!g || g.kind === "blocked") return;
    if (g.kind === "pinch") {
      const a = this.pointers.get(g.ids[0])?.point;
      const b = this.pointers.get(g.ids[1])?.point;
      if (!a || !b) return;
      const midpoint = centre(a,b), distance = dist(a,b);
      const scale = g.distance > 2 && distance > 2 ? distance / g.distance : 1;
      this.camera = moveZoomAnchor(this.camera, g.midpoint, midpoint, scale);
      g.midpoint = midpoint;
      g.distance = distance;
      this.emit();
    } else if(g.kind==="tableBand"&&g.id===id){
      const coord=g.divider.axis==="row"?"y":"x",travel=screen[coord]-g.start[coord];
      if(!g.moved&&Math.abs(travel)<(old.type==="touch"?8:3))return;
      g.moved=true;
      const next=resizeTableBand(g.item,g.divider,travel/this.camera.zoom);
      const shown=this.preview?.objects.get(g.item.id)??g.item;
      if(shown.kind==="table"&&shown.width===next.width&&shown.height===next.height)return;
      this.preview=next===g.item?undefined:{ids:[g.item.id],objects:new Map([[g.item.id,next]])};
      this.emit();
    } else if(g.kind==="textWidth"&&g.id===id){
      if(g.moved&&old.point.x===screen.x&&old.point.y===screen.y)return;
      const travel=textWidthTravel(g.item,g.start,screen);
      if(!g.moved&&Math.abs(travel)<(old.type==="touch"?8:3))return;
      g.moved=true;
      const next=resizeTextWidth(g.item,g.edge,travel/this.camera.zoom);
      const shown=this.preview?.objects.get(g.item.id)??g.item;
      if(shown.kind==="text"&&shown.width===next.width)return;
      this.preview=next===g.item?undefined:{ids:[g.item.id],objects:new Map([[g.item.id,next]])};
      this.emit();
    } else if(g.kind==="pathTransform"&&g.id===id){
      if(!g.moved&&dist(g.start,screen)<(old.type==="touch"?8:3))return;
      g.moved=true;
      let angle=0,scale=1;
      if(g.axis){
        const {x,y}=g.axis,delta=sub(screen,g.start);
        scale=1+(delta.x*x+delta.y*y)/(x*x+y*y);
      }else{
        const raw=dragRotation(0,g.pivot,g.start,screen,g.rawAngle);
        if(raw!==undefined)g.rawAngle=raw;
        angle=raw===undefined?NaN:constrainRotation(raw,0,snap);
      }
      const candidate=transformPath(g.item,angle,scale,g.frame);
      this.preview=candidate&&candidate!==g.item?{ids:[g.item.id],objects:new Map([[g.item.id,candidate]])}:undefined;
      g.angle=candidate?angle:0;g.scale=candidate?scale:1;
      this.emit();
    } else if(g.kind==="rotate"&&g.id===id){
      if(!g.moved&&dist(g.start,screen)<(old.type==="touch"?8:3))return;
      g.moved=true;
      g.rawAngle=dragRotation(g.item.rotation,g.pivot,g.start,screen,g.rawAngle)??g.rawAngle;
      const rotation=constrainRotation(g.rawAngle,g.item.rotation,snap);
      const previous=this.preview?.objects.get(g.item.id);
      if(rotation===(resizable(previous)?previous.rotation:g.item.rotation))return;
      this.preview=rotation===g.item.rotation?undefined:{ids:[g.item.id],objects:new Map([[g.item.id,{...g.item,rotation}]])};
      this.emit();
    } else if (g.kind==="pending"&&g.id === id) {
      const distance = dist(g.start, screen);
      if (g.action === "pan") {
        if (old.type === "touch" && !g.moved && distance < 8) return;
        const delta = sub(screen, g.moved ? old.point : g.start);
        if (delta.x || delta.y) { g.moved = true; this.pan(delta); }
        return;
      }
      if (!g.moved && distance < (old.type === "touch" ? 8 : 3)) return;
      g.moved=true;
      if(g.action==="resize"&&g.resize){
        const {id,item,corner,lockRatio}=g.resize;
        const delta=sub(screenToWorld(screen,this.camera),screenToWorld(g.start,this.camera));
        const minimum=item.kind==="table"?{width:item.cells[0].length*32,height:item.cells.length*24}:
          isCard(item)?{width:minimumCardWidth(item.content.kind),height:48}:undefined;
        let geometry=resizeAroundOpposite(item,corner,delta,lockRatio,minimum);
        if(isCard(item)&&geometry!==item){
          const height=cardLayout({...item,width:geometry.width}).height;
          if(geometry.height<height)geometry=resizeAroundOpposite(item,corner,delta,lockRatio,{width:minimum!.width,height});
        }
        this.preview={ids:[id],objects:new Map([[id,{...item,...geometry}]])};
        this.emit();return;
      }
      if(g.action==="marquee"){
        if(!this.marquee||old.point.x!==screen.x||old.point.y!==screen.y)this.marquee=rectBetween(g.start,screen);
        this.emit();return;
      }
      if(g.action!=="drag"||!g.dragIds)return;
      if(!g.drag){
        const prepared=this.prepareDrag?.(g.dragIds,this.camera,Boolean(g.copy));
        if(g.copy&&!prepared?.copies){g.action="tap";this.emit();return;}
        g.drag=prepared??{plan:planMove(this.doc,g.dragIds,undefined,this.hiddenIds)};
      }
      const {plan,alignment,copies}=g.drag;
      if(!plan.movers.length&&!plan.connectors.length)return;
      const raw=sub(screenToWorld(screen,this.camera),screenToWorld(g.start,this.camera));
      g.bypass=bypass;
      const delta=alignment?.resolve(raw,bypass)??raw;
      const objects=moveObjects(plan,delta);
      if(copies){
        // Fully bound connectors without bends follow their copied endpoints and
        // have no move patch of their own, but must still be drawn and inserted.
        this.preview=objects.size?{ids:copies.ids,objects:new Map(copies.ids.map(id=>[id,objects.get(id)??copies.objects.get(id)!]))}:undefined;
        this.emit();return;
      }
      if(this.anyLocked(objects.keys())){
        g.drag=undefined;g.action="tap";this.clearPreview();this.onLockedEdit?.();this.emit();return;
      }
      this.preview={ids:g.dragIds,objects};
      this.emit();
    }
  }
  private resolveMarquee(hit:MarqueeHit):MarqueeSelection|undefined{
    const area=this.marquee,g=this.gesture;
    if(!area||g?.kind!=="pending"||g.action!=="marquee")return;
    const cached=this.marqueeCache;
    if(cached?.area===area&&cached.camera===this.camera&&cached.picked===this.picked&&cached.ranges===this.topicRanges&&cached.hit===hit)return cached.result;
    const found=new Map<Id,Set<Id>>();
    const matches=hit(rectBetween(screenToWorld(area.min,this.camera),screenToWorld(area.max,this.camera)),found);
    const requested=g.shift?[...this.picked,...matches]:matches;
    const ids=this.normalizedIds(requested,this.scopeFor(requested));
    const topics=g.shift?new Map(this.topicRanges):found;
    if(g.shift){
      const selected=new Set(this.picked);
      for(const [map,range] of found){
        const previous=topics.get(map);
        if(previous)topics.set(map,new Set([...previous,...range]));
        else if(!selected.has(map))topics.set(map,range);
      }
    }
    const result={ids,topics,count:elementCount(ids,topics)};
    this.marqueeCache={area,camera:this.camera,picked:this.picked,ranges:this.topicRanges,hit,result};
    return result;
  }
  marqueeElementCount(hit:MarqueeHit):number{return this.resolveMarquee(hit)?.count??0;}
  invalidateMarqueeHits(){this.marqueeCache=undefined;}
  up(id: number, screen: Point, hitMarquee?:MarqueeHit, snap=false,bypass=false): void {
    if (!this.pointers.has(id)) return;
    const g = this.gesture;
    // pointerup supplies a final position even if no final pointermove was delivered.
    const editable=g?.kind==="pending"||g?.kind==="rotate"||g?.kind==="pathTransform"||g?.kind==="textWidth"||g?.kind==="tableBand";
    if(editable)this.move(id,screen,snap,bypass);
    this.pointers.delete(id);
    let change: ChangeSet | undefined;
    if (editable && g.id === id) {
      if(this.preview&&g.kind==="pending"&&g.drag?.copies){
        const {copies}=g.drag,patches=[...movePatches(this.preview.objects)];
        if(copies.groupPatch)patches.push(copies.groupPatch);
        change=this.apply({label:"拖动复制所选对象",patches});
        if(change)this.keep(copies.ids);
      } else if (this.preview) {
        this.keep(this.preview.ids);
        const label=g.kind==="tableBand"?(g.divider.axis==="row"?"调整表格行高":"调整表格列宽"):
          g.kind==="textWidth"?"调整文字行宽":g.kind==="pathTransform"?(g.axis?"等比缩放路径":"旋转路径"):g.kind==="rotate"?"旋转对象":g.action==="resize"?"调整对象尺寸":"移动对象";
        change=this.apply({label,patches:movePatches(this.preview.objects)});
      } else if (g.kind==="pending"&&g.action==="marquee" && this.marquee) {
        const result=this.resolveMarquee(hitMarquee??emptyMarquee)!;
        this.topicRanges=result.topics;
        this.keep(result.ids);
        this.onMarqueeCommit?.();
      } else if (g.kind==="pending"&&(g.action!=="pan" || (g.tapSelect&&!g.moved))) {
        if(g.moved&&g.dragIds)this.keep(g.dragIds);
        else this.pick(g.target,g.shift);
      }
    }
    this.clearPreview();
    this.gesture = this.pointers.size ? { kind:"blocked" } : undefined;
    this.emit(change);
  }
  private clearPreview():void { this.preview=undefined;this.marquee=undefined;this.marqueeCache=undefined; }
  pointerCancelled(id: number): void {
    if (!this.pointers.delete(id)) return;
    this.clearPreview();
    this.gesture = this.pointers.size ? { kind:"blocked" } : undefined;
    this.emit();
  }
  cancel(): void {
    if (!this.gesture && !this.preview && !this.marquee) return;
    this.clearPreview();
    this.gesture = this.pointers.size ? { kind:"blocked" } : undefined;
    this.emit();
  }
  resetPointers(): void {
    if (!this.gesture && !this.preview && !this.marquee && !this.pointers.size) return;
    this.pointers.clear();
    this.clearPreview();
    this.gesture = undefined;
    this.emit();
  }
}
