import type { BoardDocument,BoardObject,Connector,Id } from "../core/document.ts";
import type { Rect } from "../core/geometry.ts";
import {gridPoint} from "../core/geometry.ts";
import type { ChangeSet } from "../core/history.ts";
import { alignmentBounds,mergeBounds,projectGeometry } from "./board.ts";
import {hasConnectorLabel,labelIndexBounds,placeConnectorLabels} from "./connector-labels.ts";
import {DragAlignment} from "../session/drag-alignment.ts";
import {planMove} from "../session/transform.ts";
import type {ObjectCopies} from "../session/transform.ts";
import type { DrawGroup,Scene } from "./board.ts";
import type {PaintedTopic} from "./mindmap-motion.ts";
import {cellRange,SceneGrid} from "./spatial-grid.ts";
import type {GridQueryWork} from "./spatial-grid.ts";

export type SceneOverride=Readonly<{objects:ReadonlyMap<Id,BoardObject>;extra?:readonly Id[];topicLayouts?:ReadonlyMap<Id,readonly PaintedTopic[]>}>;
export type AlignmentQueryWork=Readonly<{cells:number;memberships:number;spanning:number;objects:number;returned:number;limited:boolean}>;
export type ProjectionUpdate=Readonly<{mode:"none"|"full"|"incremental";projected:number}>;
// Optional drag assistance gives way to free movement above either budget.
const SNAP_CELLS=256,SNAP_ENTRIES=512;
const finite=(b:Rect)=>[b.min.x,b.min.y,b.max.x,b.max.y].every(Number.isFinite);
const overlaps=(a:Rect,b:Rect)=>a.min.x<=b.max.x&&b.min.x<=a.max.x&&a.min.y<=b.max.y&&b.min.y<=a.max.y;
function endpoints(connector:Connector):Set<Id>{
  const result=new Set<Id>();
  if(connector.from.kind==="anchor")result.add(connector.from.objectId);
  if(connector.to.kind==="anchor")result.add(connector.to.objectId);
  return result;
}

export class SceneProjection {
  private identity=new Map<Id,DrawGroup>();
  private doc:BoardDocument;
  private ordered:Scene|undefined;
  private adjacency=new Map<Id,Set<Id>>();
  private hidden:ReadonlySet<Id>=new Set();
  private grid=new SceneGrid();
  private visibleLabels=0;
  private alignmentSpanning=new Set<Id>();
  private rank=new Map<Id,number>();
  constructor(doc:BoardDocument){this.doc=doc;this.reset(doc);}
  private reset(doc:BoardDocument):ProjectionUpdate{
    this.doc=doc;this.identity.clear();this.adjacency.clear();this.grid.clear();this.alignmentSpanning.clear();this.visibleLabels=0;
    this.resetRank();
    const next=projectGeometry(doc);
    for(const group of next)this.registerGroup(group);
    if(this.visibleLabels)for(const group of placeConnectorLabels(next.filter(g=>!this.hidden.has(g.id)),area=>this.labelNeighbors(area)))
      this.identity.set(group.id,group);
    this.ordered=this.hidden.size||this.visibleLabels?undefined:next;
    for(const item of Object.values(doc.objects))if(item.kind==="connector")this.registerEdge(item);
    return {mode:"full",projected:next.length};
  }
  private resetRank():void{this.rank.clear();this.doc.order.forEach((id,index)=>this.rank.set(id,index));}
  private registerGroup(group:DrawGroup):void{
    this.identity.set(group.id,group);
    if(!this.hidden.has(group.id))this.indexGroup(group);
  }
  private indexGroup(group:DrawGroup):void{
    if(hasConnectorLabel(group))this.visibleLabels++;
    const fine=this.grid.add(group.id,labelIndexBounds(group));
    if(!fine&&this.doc.objects[group.id]?.kind!=="connector")this.alignmentSpanning.add(group.id);
  }
  private unregisterGroup(id:Id):void{
    const group=this.identity.get(id);
    if(group&&!this.hidden.has(id))this.unindexGroup(group);
    this.identity.delete(id);
  }
  private unindexGroup(group:DrawGroup):void{
    if(hasConnectorLabel(group))this.visibleLabels--;
    this.grid.remove(group.id,labelIndexBounds(group));this.alignmentSpanning.delete(group.id);
  }
  private labelNeighbors(area:Rect,patch:ReadonlyMap<Id,DrawGroup>=EMPTY):DrawGroup[]{
    const candidates=new Set<Id>();
    const indexed=this.grid.collect(area,this.identity.size,candidates);
    const groups:DrawGroup[]=[];
    for(const id of indexed?candidates:this.identity.keys()){
      if(patch.has(id)||this.hidden.has(id))continue;
      const g=this.identity.get(id)!;
      if(overlaps(area,labelIndexBounds(g)))groups.push(g);
    }
    for(const g of patch.values())if(!this.hidden.has(g.id)&&overlaps(area,labelIndexBounds(g)))groups.push(g);
    return groups;
  }
  private refreshLabels(changed:readonly DrawGroup[],patch?:Map<Id,DrawGroup>):void{
    if(!this.visibleLabels&&!changed.some(hasConnectorLabel))return;
    const near=(area:Rect)=>this.labelNeighbors(area,patch),seeds=new Set<DrawGroup>();
    for(const group of changed)for(const g of near(labelIndexBounds(group)))if(hasConnectorLabel(g))seeds.add(g);
    for(const g of placeConnectorLabels(seeds,near,true)){
      if(!patch)this.identity.set(g.id,g);
      else if(patch.has(g.id)||g!==this.identity.get(g.id))patch.set(g.id,g);
    }
  }
  /** Keep canonical geometry and adjacency available for restore and undo.
   * Only paintable groups occupy viewport and snap candidate budgets. */
  setHidden(ids:ReadonlySet<Id>):void{
    if(ids===this.hidden)return;
    const previous=this.hidden;this.hidden=ids;this.ordered=undefined;
    const changed:DrawGroup[]=[];
    for(const id of ids)if(!previous.has(id)){const g=this.identity.get(id);if(g){this.unindexGroup(g);changed.push(g);}}
    for(const id of previous)if(!ids.has(id)){const g=this.identity.get(id);if(g){this.indexGroup(g);changed.push(g);}}
    this.refreshLabels(changed);
  }
  private registerEdge(connector:Connector):void{
    for(const id of endpoints(connector)){
      let nodes=this.adjacency.get(id);if(!nodes){nodes=new Set();this.adjacency.set(id,nodes);}
      nodes.add(connector.id);
    }
  }
  private unregisterEdge(connector:Connector):void{
    for(const id of endpoints(connector)){
      const nodes=this.adjacency.get(id);
      if(nodes){nodes.delete(connector.id);if(!nodes.size)this.adjacency.delete(id);}
    }
  }
  paintOrder(id:Id):number{return this.rank.get(id)??this.doc.order.length;}

  /** Accept exactly the authoritative ChangeSet for this preceding document. A
   * new board/missing delta/global style/broad edit deliberately falls back. */
  update(doc:BoardDocument,change?:ChangeSet):ProjectionUpdate{
    if(doc===this.doc)return {mode:"none",projected:0};
    if(!change||doc.id!==this.doc.id||doc.schemaVersion!==this.doc.schemaVersion||change.themeChanged)return this.reset(doc);
    const direct=new Set([...change.added,...change.updated,...change.removed]);
    const dirty=new Set([...direct,...change.invalidatedMaps,...change.invalidatedConnectors]);
    if(dirty.size>Math.max(512,doc.order.length*.22))return this.reset(doc);
    for(const id of direct){
      const before=this.doc.objects[id],after=doc.objects[id];
      if(before?.kind==="connector")this.unregisterEdge(before);
      if(after?.kind==="connector")this.registerEdge(after);
    }
    this.doc=doc;
    if(change.orderChanged)this.resetRank();
    if(dirty.size||change.orderChanged)this.ordered=undefined;
    const before=[...dirty].flatMap(id=>this.group(id)??[]);
    for(const id of dirty)this.unregisterGroup(id);
    const updated=projectGeometry(doc,undefined,[...dirty]);
    for(const group of updated)this.registerGroup(group);
    this.refreshLabels([...before,...updated]);
    return {mode:"incremental",projected:updated.length};
  }

  overlay(override?:SceneOverride):ReadonlyMap<Id,DrawGroup>{
    if(!override||!override.objects.size&&!override.topicLayouts?.size)return EMPTY;
    const dirty=new Set(override.objects.keys());
    for(const id of override.topicLayouts?.keys()??[])dirty.add(id);
    for(const [id,value] of override.objects)if(value.kind==="shape")for(const link of this.adjacency.get(id)??[])dirty.add(link);
    const ids=[...dirty].filter(id=>!this.hidden.has(id)),before=ids.flatMap(id=>this.group(id)??[]);
    const updated=projectGeometry(this.doc,override,ids),patch=new Map(updated.map(g=>[g.id,g]));
    this.refreshLabels([...before,...updated],patch);
    return patch;
  }
  group(id:Id,patch:ReadonlyMap<Id,DrawGroup>=EMPTY){
    if(!this.hidden.has(id))return patch.get(id)??this.identity.get(id);
  }
  selectedBounds(ids:readonly Id[],patch:ReadonlyMap<Id,DrawGroup>=EMPTY){
    let result:Rect|undefined;
    for(const id of ids){
      const group=this.group(id,patch);
      if(group)result=mergeBounds(result,group.bounds);
    }
    return result;
  }
  all(patch:ReadonlyMap<Id,DrawGroup>=EMPTY):Scene{
    const scene=this.ordered??=this.doc.order.flatMap(id=>{const group=this.identity.get(id);return group&&!this.hidden.has(id)?[group]:[];});
    if(!patch.size)return scene;
    return [...scene.map(group=>patch.get(group.id)??group),...[...patch.values()].filter(group=>!this.hidden.has(group.id)&&!this.identity.has(group.id))];
  }
  /** Search the immediate neighborhood first. A long spacing strip only contributes
   * targets if we can see all of its intervening objects within the same budget. */
  private alignmentTargets(near:Rect,strips:readonly Rect[],excluded:ReadonlySet<Id>,audit?:(work:AlignmentQueryWork)=>void){
    const targets:{id:Id;bounds:Rect}[]=[];
    let lookups=0,memberships=0,spanning=0,objects=0;
    const finish=(limited=false)=>{
      audit?.({cells:lookups,memberships,spanning,objects,returned:targets.length,limited});
      return targets;
    };
    const ids=new Set<Id>(),searched:Rect[]=[],visited=new Set<string>();
    const fineBudget=SNAP_ENTRIES-this.alignmentSpanning.size;
    const collect=(rect:Rect)=>{
      const range=cellRange(rect);
      if(!range.safe||range.count>SNAP_CELLS)return false;
      for(let y=range.y1;y<=range.y2;y++)for(let x=range.x1;x<=range.x2;x++){
        const key=x+":"+y;
        if(visited.has(key))continue;
        if(lookups===SNAP_CELLS)return false;
        const bucket=this.grid.fineMembers(x,y);lookups++;
        if(bucket&&memberships+bucket.size>fineBudget)return false;
        visited.add(key);
        if(bucket)for(const id of bucket){ids.add(id);memberships++;}
      }
      searched.push(rect);return true;
    };
    if(fineBudget<0||!collect(near))return finish(true);
    for(const strip of strips)collect(strip);
    for(const id of this.alignmentSpanning){ids.add(id);spanning++;}
    for(const id of ids){
      if(excluded.has(id))continue;
      const group=this.identity.get(id);
      if(!group||!searched.some(rect=>overlaps(group.bounds,rect)))continue;
      const item=this.doc.objects[id];objects++;
      if(item.kind==="connector")continue;
      const bounds=alignmentBounds(item,group.bounds);
      if(finite(bounds)&&searched.some(rect=>overlaps(bounds,rect)))targets.push({id,bounds});
    }
    return finish();
  }

  private dragAlignment(source:Rect|undefined,viewport:Rect,zoom:number,excluded:ReadonlySet<Id>,audit?:(work:AlignmentQueryWork)=>void){
    if(!source||!finite(source)||!finite(viewport)||zoom<=0||!Number.isFinite(zoom))return;
    const doc=this.doc;
    return new DragAlignment(source,viewport,zoom,(near,strips)=>this.doc===doc?this.alignmentTargets(near,strips,excluded,audit):[]);
  }
  prepareCopyDrag(copies:ObjectCopies,viewport:Rect,zoom:number){
    const items=[...copies.objects.values()];
    const plan={movers:items.filter(item=>item.kind!=="connector"),connectors:items.filter(item=>item.kind==="connector")};
    let source:Rect|undefined;
    for(const group of projectGeometry(this.doc,copies,copies.ids)){
      const item=copies.objects.get(group.id)!;
      if(item.kind!=="connector")source=mergeBounds(source,alignmentBounds(item,group.bounds));
    }
    // Original objects remain available as committed alignment and spacing targets.
    return {copies,plan,alignment:this.dragAlignment(source,viewport,zoom,new Set(copies.ids))};
  }
  prepareDrag(selected:readonly Id[],viewport:Rect,zoom:number,audit?:(work:AlignmentQueryWork)=>void,
    display?:ReadonlyMap<Id,BoardObject>,patch?:ReadonlyMap<Id,DrawGroup>){
    const excluded=new Set(selected),lines=new Set<Connector>(),doc=this.doc;
    let source:Rect|undefined;
    for(const id of excluded){
      const item=display?.get(id)??doc.objects[id];
      if(!item||this.hidden.has(id))continue;
      if(item.kind==="connector"){lines.add(item);continue;}
      if(item.kind==="shape")for(const edge of this.adjacency.get(id)??[]){
        const line=doc.objects[edge];if(line.kind==="connector")lines.add(line);
      }
      const group=this.group(id,patch);
      if(group)source=mergeBounds(source,alignmentBounds(item,group.bounds));
    }
    let plan=planMove(doc,selected,lines,this.hidden);
    if(display?.size){
      // Take over the visible layout pose. Drag transactions keep integer document coordinates.
      const movers=plan.movers.map(item=>{
        const pose=display.get(item.id);
        if(!pose||pose.kind==="connector")return item;
        return pose.kind==="mindmap"?{...pose,origin:gridPoint(pose.origin)}:{...pose,at:gridPoint(pose.at)};
      });
      const connectors=plan.connectors.map(line=>{
        const pose=display.get(line.id);if(pose?.kind!=="connector")return line;
        const endpoint=(e:Connector["from"])=>e.kind==="free"?{...e,point:gridPoint(e.point)}:e;
        return {...pose,from:endpoint(pose.from),to:endpoint(pose.to),waypoints:pose.waypoints.map(gridPoint)};
      });
      plan={movers,connectors};
    }
    return {plan,alignment:this.dragAlignment(source,viewport,zoom,excluded,audit)};
  }
  query(rect:Rect,patch:ReadonlyMap<Id,DrawGroup>=EMPTY,include:readonly Id[]=[],audit?:(work:GridQueryWork)=>void):Scene{
    const candidates=new Set<Id>(),always=new Set(include);
    if(!this.grid.collect(rect,Math.max(0,this.identity.size-this.hidden.size),candidates,audit)){
      // A crowded/very broad query is cheaper in paint order, without deduplication or a sort.
      const result:DrawGroup[]=[];
      for(const original of this.all()){
        const group=patch.get(original.id)??original;
        if(always.has(group.id)||overlaps(group.bounds,rect))result.push(group);
      }
      for(const [id,group] of patch)
        if(!this.hidden.has(id)&&!this.identity.has(id)&&(always.has(id)||overlaps(group.bounds,rect)))result.push(group);
      return result;
    }
    for(const id of patch.keys())candidates.add(id);
    for(const id of always)candidates.add(id);
    const result:DrawGroup[]=[];
    for(const id of candidates){
      if(this.hidden.has(id))continue;
      const group=patch.get(id)??this.identity.get(id);
      if(group&&(always.has(id)||overlaps(group.bounds,rect)))result.push(group);
    }
    result.sort((a,b)=>this.paintOrder(a.id)-this.paintOrder(b.id));
    return result;
  }
}
const EMPTY:ReadonlyMap<Id,DrawGroup>=new Map();
