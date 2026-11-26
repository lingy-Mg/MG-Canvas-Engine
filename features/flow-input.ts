import { objectById, resolveEndpoint, zeroLengthConnector } from "../core/document.ts";
import { gridPoint, rectBetween, screenToWorld } from "../core/geometry.ts";
import type { Connector, Endpoint, Id, ShapeObject } from "../core/document.ts";
import type { Box, Point, Rect } from "../core/geometry.ts";
import {flowGroupOf} from "../core/flow-groups.ts";
import type { EditorSession } from "../session/editor.ts";
import { DEFAULT_FLOW_ROUTE,addWaypoint, anchoredFlowPath, connectDroppedNode, connectFlow, connectToNewNode, createFlowNode, flowHandles, free, isFlowPreset, pickFlowHandle, pickPort, planConnectedNode, removeWaypoint, setConnectorEnd, setWaypoint, shapePorts } from "./flow.ts";
import {placementBox,placementDragged} from "./placement.ts";
import {directionalTarget,endpointTarget} from "./flow-target.ts";
import type { DropNode, FlowHandle, Port, Preset } from "./flow.ts";

export type FlowMode=Preset|"line"|"connect";
type Action=Readonly<{kind:"new";from:Endpoint;route:"straight"|typeof DEFAULT_FLOW_ROUTE;generation:symbol}
  | {kind:"rebind";id:Id;field:"from"|"to";generation:symbol}
  | {kind:"waypoint";id:Id;index:number;generation:symbol}
  | {kind:"shape";preset:Preset;generation:symbol}>;
type Pointer={id:number;type:string;start:Point;current:Point;action:Action;continuation:boolean;dragged:boolean};
type LinkAction=Extract<Action,{kind:"new"|"rebind"}>;
type Destination={end:Endpoint;point:Point;node?:ShapeObject;autoTarget?:boolean};
export type ConnectionDrop=Readonly<{from:Port["end"];point:Point;history:EditorSession["history"];generation:symbol}>;
export type FlowMarker=Readonly<{kind:"output"|"input"|"origin"|"endpoint"|"waypoint";point:Point;active?:boolean;selected?:boolean}>;
export type FlowDecor=Readonly<{ markers:readonly FlowMarker[]; draft?:readonly Point[];arrow?:Connector["arrow"] }>;
/** Canonical document shape IDs overlapping the rectangle, in bottom-to-top order. */
type PortCandidates=(world:Rect)=>readonly Id[];
const PORT_TOUCH_RADIUS=17, PORT_MOUSE_RADIUS=9;
const TARGET_MOUSE_RADIUS=20,TARGET_TOUCH_RADIUS=30,DIRECTION_RADIUS=280;
type ObjectQuery=(screen:Point,touch?:boolean)=>Id|undefined;
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
const samePort=(a:Endpoint|undefined,b:Endpoint)=>a?.kind==="anchor"&&b.kind==="anchor"&&a.objectId===b.objectId&&a.portId===b.portId;
const dragMoved=(from:Point,to:Point,type:string)=>distance(from,to)>=(type==="touch"?9:3);
function shapeOutline(box:Pick<Box,"at"|"width"|"height">,preset:Preset):Point[]{
  const {x,y}=box.at,w=box.width,h=box.height;
  const corners=preset==="decision"?[[x+w/2,y],[x+w,y+h/2],[x+w/2,y+h],[x,y+h/2]]:
    preset==="triangle"?[[x+w/2,y],[x+w,y+h],[x,y+h]]:
    [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  return [...corners,corners[0]].map(([x,y])=>({x,y}));
}

/** Gesture state, no DOM and no document edits before a completed gesture. */
export class FlowInput {
  mode:FlowMode|undefined;
  pointer:Pointer|undefined;
  pending:Action|undefined;
  private released?:ConnectionDrop;
  private focusedPin?:{line:Connector;index:number;selection:readonly Id[];generation:symbol};
  private screen?:Point;
  private hovered?:Id;
  private touch=false;
  private editor:EditorSession;
  private hit:ObjectQuery;
  private candidates?:PortCandidates;
  constructor(editor:EditorSession,hit:ObjectQuery,candidates?:PortCandidates){this.editor=editor;this.hit=hit;this.candidates=candidates;}
  setMode(mode?:FlowMode){this.cancel();this.mode=mode;}
  cancel(clearMode=false){this.pointer=undefined;this.pending=undefined;this.released=undefined;this.focusedPin=undefined;this.screen=undefined;this.hovered=undefined;this.touch=false;if(clearMode)this.mode=undefined;}
  clearHover(){if(!this.pointer){this.screen=undefined;this.hovered=undefined;}}
  get drop():ConnectionDrop|undefined{
    const drop=this.released;
    if(drop&&(drop.history!==this.editor.history||drop.generation!==this.editor.generation||this.editor.isHidden(drop.from.objectId)))this.released=undefined;
    return this.released;
  }
  get working():boolean{return Boolean(this.pointer||this.pending||this.drop);}
  get shapeTool(){return isFlowPreset(this.mode)?this.mode:undefined;}
  get shapePointer(){return this.pointer?.action.kind==="shape"?this.pointer:undefined;}
  finishDrop(drop:ConnectionDrop,preset?:DropNode):boolean{
    if(this.drop!==drop)return false;
    this.released=undefined;
    return Boolean(preset?connectDroppedNode(this.editor,drop.from,drop.point,preset):connectFlow(this.editor,drop.from,free(drop.point)));
  }
  private single():Id|undefined{return this.editor.selectedIds.length===1&&!this.editor.selectionLocked?this.editor.selection:undefined;}
  get selectedWaypoint(){
    const pin=this.focusedPin;
    if(pin&&(pin.generation!==this.editor.generation||pin.selection!==this.editor.selectedIds||
      this.single()!==pin.line.id||this.editor.doc.objects[pin.line.id]!==pin.line))this.focusedPin=undefined;
    return this.focusedPin;
  }
  selectWaypoint(id:Id,index:number):boolean{
    const line=objectById(this.editor.doc,id);
    if(this.single()!==id||line?.kind!=="connector"||line.routing==="straight"||!Number.isInteger(index)||!line.waypoints[index])return false;
    this.focusedPin={line,index,selection:this.editor.selectedIds,generation:this.editor.generation};
    return true;
  }
  removeSelectedWaypoint():boolean{
    const pin=this.selectedWaypoint;
    if(!pin||this.working)return false;
    const removed=removeWaypoint(this.editor,pin.line.id,pin.index);
    if(removed)this.focusedPin=undefined;
    return removed;
  }
  private sourceIds():ReadonlySet<Id>|undefined{
    if(this.mode==="connect"||this.working)return undefined;
    const ids=new Set<Id>();
    const single=this.single();if(single)ids.add(single);
    if(this.hovered&&!this.editor.isHidden(this.hovered)&&!this.editor.isLocked(this.hovered)&&(!flowGroupOf(this.editor.doc,this.hovered)||flowGroupOf(this.editor.doc,this.hovered)===this.editor.editingGroup))ids.add(this.hovered);
    return ids;
  }
  private nearby(point:Point,r:number):readonly Id[]{
    const ids=this.candidates?.({min:{x:point.x-r,y:point.y-r},max:{x:point.x+r,y:point.y+r}})??this.editor.doc.order;
    return this.editor.hiddenIds.size?ids.filter(id=>!this.editor.isHidden(id)):ids;
  }
  private port(screen:Point,touch:boolean,allow?:ReadonlySet<Id>,press=false):Port|undefined{
    if(allow?.size===0)return undefined;
    const point=screenToWorld(screen,this.editor.camera);
    const body=press&&!this.mode?objectById(this.editor.doc,this.hit(screen,touch)??""):undefined;
    const radius=body?.kind==="shape"?(touch?6:5):(touch?PORT_TOUCH_RADIUS:PORT_MOUSE_RADIUS);
    const r=radius/this.editor.camera.zoom;
    return pickPort(this.editor.doc,point,r,allow,this.nearby(point,r));
  }
  private directional(source:Port):Port|undefined{
    const r=DIRECTION_RADIUS/this.editor.camera.zoom;
    return directionalTarget(this.editor.doc,this.nearby(source.point,r),source,r);
  }
  /** Preview and release resolve the same final screen sample, including a release
   * with no preceding move event or a change of camera during two-tap input. */
  private destination(action:LinkAction,screen:Point,touch:boolean,pointer?:Pointer):Destination|undefined{
    const doc=this.editor.doc,camera=this.editor.camera,point=screenToWorld(screen,camera);
    const empty={end:free(point),point:gridPoint(point)};
    if(action.kind==="new"&&action.route==="straight")return empty;
    const line=action.kind==="rebind"?objectById(doc,action.id):undefined;
    const fixed=action.kind==="new"?action.from:line?.kind==="connector"?line[action.field==="from"?"to":"from"]:undefined;
    const origin=fixed&&resolveEndpoint(doc,fixed);
    if(!fixed||!origin)return;
    const tap=pointer&&!pointer.dragged&&!dragMoved(pointer.start,screen,pointer.type);
    if(action.kind==="new"&&fixed.kind==="anchor"&&tap&&!pointer.continuation){
      if(!touch||this.mode!=="connect"){
        const target=this.directional({end:fixed,point:origin});
        return target&&{...target,autoTarget:true};
      }
      return;
    }
    const pins=line?.kind==="connector"&&line.routing!=="straight"?line.waypoints:[];
    const approach=action.kind==="rebind"?(action.field==="from"?pins[0]:pins.at(-1))??origin:origin;
    const radius=(touch?TARGET_TOUCH_RADIUS:TARGET_MOUSE_RADIUS)/camera.zoom;
    const route=line?.kind==="connector"?line.routing:DEFAULT_FLOW_ROUTE;
    const allowLoop=!zeroLengthConnector(origin,origin,route,pins);
    const portRadius=(touch?PORT_TOUCH_RADIUS:PORT_MOUSE_RADIUS)/camera.zoom;
    const target=endpointTarget(doc,this.nearby(point,radius),point,radius,portRadius,fixed,approach,allowLoop);
    if(target)return {...target,autoTarget:distance(point,target.point)>portRadius};
    // The explicit two-tap Connect tool also offers its existing add-a-node
    // operation on blank space. A continuous drag previews its free endpoint.
    if(action.kind==="new"&&this.mode==="connect"&&(pointer?pointer.continuation&&tap:this.pending===action)){
      if(this.hit(screen,touch))return;
      const plan=planConnectedNode(doc,action.from,point,"process","~preview-node","~preview-line");
      if(!plan)return;
      const port=shapePorts(plan.node).find(p=>samePort(plan.line.to,p.end))!;
      return {...port,node:plan.node};
    }
    if(!zeroLengthConnector(origin,empty.point,route,pins))return empty;
  }
  private handle(screen:Point,touch:boolean):FlowHandle|undefined{
    if(this.mode&&this.mode!=="connect")return undefined;
    return pickFlowHandle(flowHandles(this.editor.doc,this.single()),screenToWorld(screen,this.editor.camera),(touch?15:8)/this.editor.camera.zoom);
  }
  waypointAt(screen:Point,touch:boolean){
    const handle=this.handle(screen,touch);
    return handle?.kind==="waypoint"?handle:undefined;
  }
  private actionForHandle(hit:FlowHandle):Action{
    const generation=this.editor.generation;
    return hit.kind==="endpoint"?{kind:"rebind",id:hit.id,field:hit.field,generation}:{kind:"waypoint",id:hit.id,index:hit.index,generation};
  }
  beginRebind(id:Id,field:"from"|"to"):boolean{
    if(this.editor.isHidden(id)||this.editor.isLocked(id)||objectById(this.editor.doc,id)?.kind!=="connector")return false;
    this.cancel();this.mode="connect";this.pending={kind:"rebind",id,field,generation:this.editor.generation};return true;
  }
  down(id:number,type:string,screen:Point):boolean{
    if(this.pointer||this.drop)return false;
    this.focusedPin=undefined;
    const generation=this.editor.generation,touch=type==="touch";
    const world=screenToWorld(screen,this.editor.camera);
    const continuation=Boolean(this.pending);
    let action=this.pending;
    if(!action){
      if(isFlowPreset(this.mode))action={kind:"shape",preset:this.mode,generation};
      else if(this.mode==="line")action={kind:"new",route:"straight",from:free(world),generation};
      else{
        const port=this.port(screen,touch,this.sourceIds(),true);
        const handle=this.handle(screen,touch);
        if(port&&this.mode==="connect")action={kind:"new",route:DEFAULT_FLOW_ROUTE,from:port.end,generation};
        else if(handle)action=this.actionForHandle(handle);
        else if(port)action={kind:"new",route:DEFAULT_FLOW_ROUTE,from:port.end,generation};
      }
    }
    if(!action)return false;
    if(action.kind==="waypoint")this.selectWaypoint(action.id,action.index);
    this.screen=screen;this.touch=touch;
    this.pointer={id,type,start:screen,current:screen,action,continuation,dragged:false};
    return true;
  }
  move(id:number,screen:Point,touch=false){
    if(this.drop||this.pointer&&this.pointer.id!==id)return;
    this.screen=screen;this.touch=touch;
    if(this.pointer){
      this.pointer.current=screen;
      this.pointer.dragged||=this.pointer.action.kind==="shape"?placementDragged(this.pointer.start,screen):dragMoved(this.pointer.start,screen,this.pointer.type);
      return;
    }
    if(this.shapeTool)return;
    const idAt=this.hit(screen,touch), shape=idAt?objectById(this.editor.doc,idAt):undefined;
    if(shape?.kind==="shape")this.hovered=shape.id;
    else if(!this.hovered||!this.port(screen,touch,new Set([this.hovered])))this.hovered=undefined;
  }
  up(id:number,screen:Point):boolean {
    const pointer=this.pointer;
    if(!pointer||pointer.id!==id)return false;
    this.pointer=undefined;this.screen=screen;
    const {action,type,start,continuation}=pointer;
    const moved=dragMoved(start,screen,type), world=screenToWorld(screen,this.editor.camera);
    if(action.generation!==this.editor.generation){this.cancel(true);return true;}
    if(action.kind==="shape"){
      const dragged=pointer.dragged||placementDragged(start,screen);
      const bounds=placementBox(action.preset,screen,this.editor.camera,dragged?start:undefined);
      createFlowNode(this.editor,action.preset,world,{...bounds,rotation:0});
      this.setMode();return true;
    }
    if(action.kind==="waypoint"){
      if(moved&&this.selectedWaypoint&&setWaypoint(this.editor,action.id,action.index,world))this.selectWaypoint(action.id,action.index);
      return true;
    }
    const target=this.destination(action,screen,type==="touch",pointer);
    if(!continuation&&!pointer.dragged&&!moved&&(action.kind==="rebind"||target?.end.kind!=="anchor")){
      this.pending=action;return true;
    }
    this.pending=undefined;
    if(!target)return true;
    if(action.kind==="rebind")setConnectorEnd(this.editor,action.id,action.field,target.end);
    else if(target.node)connectToNewNode(this.editor,action.from,world);
    else if(action.from.kind==="anchor"&&target.end.kind==="free"&&(moved||pointer.dragged)&&!this.hit(screen,type==="touch")){
      this.released={from:action.from,point:world,history:this.editor.history,generation:action.generation};
    }
    else connectFlow(this.editor,action.from,target.end,action.route,target.autoTarget);
    return true;
  }
  addWaypointAt(screen:Point):boolean{
    const id=this.single();
    return Boolean(id&&!this.handle(screen,false)&&this.hit(screen)===id&&addWaypoint(this.editor,id,screenToWorld(screen,this.editor.camera)));
  }
  decor(viewport?:Readonly<{width:number;height:number}>,preview?:Connector):FlowDecor{
    const doc=this.editor.doc, id=this.single();
    const drop=this.drop;
    if(drop){
      const origin=resolveEndpoint(doc,drop.from)!;
      return {markers:[{kind:"origin",point:origin}],arrow:"end",
        draft:anchoredFlowPath(origin,gridPoint(drop.point),DEFAULT_FLOW_ROUTE,[],drop.from,undefined,key=>objectById(doc,key),{portCurve:true})};
    }
    if(this.shapeTool||this.mode==="line")return {markers:[],draft:this.draft()};
    const screen=this.screen;
    let action=this.pointer?.action??this.pending;
    const allowed=this.sourceIds(),touch=this.pointer?this.pointer.type==="touch":this.touch;
    const hover=screen&&!action?this.port(screen,touch,allowed,!this.mode):undefined;
    let target:Destination|undefined;
    if(screen&&action&&(action.kind==="new"||action.kind==="rebind"))target=this.destination(action,screen,touch,this.pointer);
    else if(hover&&!touch&&(this.mode==="connect"||!this.handle(screen!,false))){
      target=this.directional(hover);
      if(target)action={kind:"new",from:hover.end,route:DEFAULT_FLOW_ROUTE,generation:this.editor.generation};
    }
    const source=action?.kind==="new"?action.from:undefined;
    const markers:FlowMarker[]=[];
    const pad=PORT_TOUCH_RADIUS, camera=this.editor.camera;
    const bounds=viewport?rectBetween(screenToWorld({x:-pad,y:-pad},camera),
      screenToWorld({x:viewport.width+pad,y:viewport.height+pad},camera)):undefined;
    const ids=allowed&&target?.end.kind==="anchor"?new Set([...allowed,target.end.objectId]):allowed??(bounds&&this.candidates?.(bounds))??doc.order;
    for(const id of ids){
      const object=objectById(doc,id);
      if(object?.kind!=="shape"||this.editor.isHidden(id))continue;
      for(const p of shapePorts(object)){
        if(bounds&&(p.point.x<bounds.min.x||p.point.x>bounds.max.x||p.point.y<bounds.min.y||p.point.y>bounds.max.y))continue;
        const origin=samePort(source,p.end);
        markers.push({point:p.point,kind:origin?"origin":action?"input":"output",active:samePort(action?target?.end:hover?.end,p.end)});
      }
    }
    const hot=screen?this.handle(screen,this.pointer?.type==="touch"):undefined;
    const selected=this.selectedWaypoint;
    for(const handle of flowHandles(doc,id,preview)){
      const active=hot?.id===handle.id&&(hot.kind==="endpoint"&&handle.kind==="endpoint"&&hot.field===handle.field||
        hot.kind==="waypoint"&&handle.kind==="waypoint"&&hot.index===handle.index);
      if(handle.kind==="waypoint"&&selected?.index===handle.index&&selected.line.id===handle.id){
        const dragging=this.pointer?.action.kind==="waypoint"&&this.pointer;
        const point=dragging&&dragMoved(dragging.start,dragging.current,dragging.type)?gridPoint(screenToWorld(dragging.current,camera)):handle.point;
        markers.push({point,kind:"waypoint",active:true,selected:true});
      }else markers.push({point:handle.point,kind:handle.kind,active});
    }
    if(target?.node)markers.push({point:target.point,kind:"input",active:true});
    const line=action?.kind==="rebind"?objectById(doc,action.id):undefined;
    const arrow=action?.kind==="new"&&action.route!=="straight"?"end":line?.kind==="connector"?line.arrow:undefined;
    return {markers,draft:this.draft(target,action),arrow};
  }
  private draft(target?:Destination,a=this.pointer?.action??this.pending):readonly Point[]|undefined{
    const screen=this.screen;
    if(!a||!screen)return;
    const world=gridPoint(screenToWorld(screen,this.editor.camera));
    if(a.kind==="shape"){
      const p=this.pointer;
      if(!p?.dragged)return;
      return shapeOutline(placementBox(a.preset,screen,this.editor.camera,p.start),a.preset);
    }
    const lookup=(id:Id)=>id===target?.node?.id?target.node:objectById(this.editor.doc,id);
    if(a.kind==="new"){
      if(a.route!=="straight"&&!target)return;
      const origin=resolveEndpoint(this.editor.doc,a.from);
      if(origin)return anchoredFlowPath(origin,a.route==="straight"?world:target?.point??world,a.route,[],a.from,target?.end,lookup,{portCurve:true});
      return;
    }
    const line=objectById(this.editor.doc,a.id);
    if(line?.kind!=="connector")return;
    let from=resolveEndpoint(this.editor.doc,line.from),to=resolveEndpoint(this.editor.doc,line.to);
    if(!from||!to)return;
    let waypoints=line.waypoints;
    if(a.kind==="rebind"){
      if(!target)return;
      if(a.field==="from")from=target.point;
      else to=target.point;
    }else waypoints=waypoints.map((p,i)=>i===a.index?world:p);
    return anchoredFlowPath(from,to,line.routing,waypoints,
      a.kind==="rebind"&&a.field==="from"?target?.end:line.from,
      a.kind==="rebind"&&a.field==="to"?target?.end:line.to,lookup,line);
  }
}
