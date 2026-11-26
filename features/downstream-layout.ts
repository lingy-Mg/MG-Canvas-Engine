import {resolveEndpoint,zeroLengthConnector} from "../core/document.ts";
import type {BoardDocument,Connector,Endpoint,Id,ShapeObject} from "../core/document.ts";
import {flowGroupOf,groupUnit} from "../core/flow-groups.ts";
import {gridPoint,portWorld,PORT_IDS} from "../core/geometry.ts";
import type {Point,PortId,Rect} from "../core/geometry.ts";
import {incidentConnectorIds} from "../core/history.ts";
import type {SceneProjection} from "../scene/projector.ts";
import type {EditorSession} from "../session/editor.ts";
import {boundFlowDirections,columnGap,localFootprint,longestRanks,overlap,packLanes,rowGap,strongComponents} from "./flow-layout.ts";

type Axis={along:"x"|"y";across:"x"|"y";sign:number};
type Link={peer:ShapeObject;direction:Point;fixed:boolean};
type Links={out:Link[];into:Link[]};
type Vertex={node:ShapeObject;links:Links;box:Rect};
type Occupancy=Pick<SceneProjection,"query">;
type Notice={state:"refused"|"unchanged";message:string;scope?:Id[]};
type Layout={
  state:"planned";root:Id;scope:Id[];nodes:ShapeObject[];lines:Connector[];
  doc:BoardDocument;generation:symbol;locks:number;visibility:number;group?:Id;
};
export type DownstreamPlan=Layout|Notice;
const axis=(along:"x"|"y",sign:number):Axis=>({along,across:along==="x"?"y":"x",sign});
const center=(node:ShapeObject):Point=>({x:node.at.x+node.width/2,y:node.at.y+node.height/2});
const end=(box:Rect,a:Axis)=>a.sign>0?box.max[a.along]:-box.min[a.along];
const span=(box:Rect,key:"x"|"y")=>box.max[key]-box.min[key];
const refused=(message:string):Notice=>({state:"refused",message});

function outlet(node:ShapeObject,port:PortId):Point{
  const p=portWorld({...node,at:{x:0,y:0}},node.shape,port);
  const x=p.x-node.width/2,y=p.y-node.height/2;
  return Math.abs(x)>=Math.abs(y)?{x:Math.sign(x),y:0}:{x:0,y:Math.sign(y)};
}
function connected(editor:EditorSession,node:ShapeObject):Links{
  const out:Link[]=[],into:Link[]=[];
  for(const id of incidentConnectorIds(editor.doc,node.id)){
    const line=editor.doc.objects[id];
    if(line.kind!=="connector"||editor.isHidden(id))continue;
    for(const [from,to] of boundFlowDirections(line)){
      const outgoing=from.objectId===node.id,peer=editor.doc.objects[outgoing?to.objectId:from.objectId];
      if(peer?.kind!=="shape"||peer.content||editor.isHidden(peer.id))continue;
      if(editor.editingGroup&&flowGroupOf(editor.doc,peer.id)!==editor.editingGroup)continue;
      const end=outgoing?from:to,field=end===line.from?"from":"to";
      const fixed=!mayRoute(editor,line,field);
      (outgoing?out:into).push({peer,direction:outlet(node,end.portId),fixed});
    }
  }
  return {out,into};
}
function mayRoute(editor:EditorSession,line:Connector,field:"from"|"to"){
  return (line.autoPorts===field||line.autoPorts==="both")&&line.arrow!=="both"&&!line.waypoints.length&&!editor.isLocked(line.id)&&
    !/^(yes|no|是|否)$/i.test(line.label.trim());
}
function reachable(root:Id,vertices:Map<Id,Vertex>,excluded:ReadonlySet<Id>):Vertex[]{
  const queue=[vertices.get(root)!],seen=new Set([root]);
  for(let i=0;i<queue.length;i++)for(const {peer} of queue[i].links.out){
    if(!seen.has(peer.id)&&!excluded.has(peer.id)){seen.add(peer.id);queue.push(vertices.get(peer.id)!);}
  }
  return queue;
}
function splitAxis(links:Link[],key:"x"|"y"){
  return links.some(link=>link.direction[key]>0)&&links.some(link=>link.direction[key]<0);
}
/** Opposing decision exits occupy separate lanes. Prefer the incoming flow direction or the next steps' outlets. */
function acrossSplit(vertex:Vertex,key:"x"|"y",vertices:Map<Id,Vertex>):Axis{
  const along=key==="x"?"y":"x";
  const arriving=vertex.links.into.reduce((sum,link)=>sum-(link.fixed?link.direction[along]:0),0);
  let leaving=0;
  for(const {peer} of vertex.links.out)for(const link of vertices.get(peer.id)!.links.out)if(link.fixed)leaving+=link.direction[along];
  const start=center(vertex.node)[along];
  const existing=vertex.links.out.reduce((sum,{peer})=>sum+center(peer)[along]-start,0);
  return axis(along,Math.sign(arriving)||Math.sign(leaving)||Math.sign(existing)||1);
}
function flowAxis(vertex:Vertex,vertices:Map<Id,Vertex>):Axis{
  const fixed=vertex.links.out.filter(link=>link.fixed),out=fixed.length?fixed:vertex.links.out;
  for(const key of ["x","y"] as const)if(splitAxis(out,key))return acrossSplit(vertex,key,vertices);
  const total=out.reduce((p,{direction:d})=>({x:p.x+d.x,y:p.y+d.y}),{x:0,y:0});
  const along=Math.abs(total.x)===Math.abs(total.y)?(out[0].direction.x?"x":"y"):Math.abs(total.x)>Math.abs(total.y)?"x":"y";
  return axis(along,Math.sign(total[along])||1);
}
/** A return to an incoming step behind the anchor must not pull the preceding chain into the layout. */
function upstreamOfAnchor(root:Vertex,vertices:Map<Id,Vertex>,a:Axis,doc:BoardDocument):Set<Id>{
  const direct=new Set(root.links.out.map(link=>link.peer.id)),excluded=new Set<Id>();
  const queue=root.links.into.map(link=>link.peer).filter(peer=>vertices.has(peer.id)&&!direct.has(peer.id));
  if(!queue.length)return excluded;
  // In a closed ring, placement alone cannot distinguish a preceding step from a misplaced tail.
  // Use the established diagram order to break that tie; an entry from outside the ring is stronger evidence.
  const preceding=new Set<Id>();
  for(const id of doc.order){if(id===root.node.id)break;preceding.add(id);}
  const origin=center(root.node)[a.along]*a.sign;
  for(let i=0;i<queue.length;i++){
    const node=queue[i],v=vertices.get(node.id);
    if(!v||node===root.node||direct.has(node.id)||excluded.has(node.id))continue;
    const entry=v.links.into.some(link=>!vertices.has(link.peer.id));
    if(!entry&&(!preceding.has(node.id)||center(node)[a.along]*a.sign>=origin))continue;
    excluded.add(node.id);for(const link of v.links.into)queue.push(link.peer);
  }
  return excluded;
}

function collapsesRoute(doc:BoardDocument,node:ShapeObject,scope:ReadonlyMap<Id,number>){
  const endpoint=(e:Endpoint)=>e.kind==="anchor"&&e.objectId===node.id?portWorld(node,node.shape,e.portId):resolveEndpoint(doc,e)!;
  for(const id of incidentConnectorIds(doc,node.id)){
    const link=doc.objects[id];if(link.kind!=="connector")continue;
    // Distinct nodes in the plan already occupy separate rows or columns.
    if([link.from,link.to].some(e=>e.kind==="anchor"&&e.objectId!==node.id&&scope.has(e.objectId)))continue;
    if(zeroLengthConnector(endpoint(link.from),endpoint(link.to),link.routing,link.waypoints))return true;
  }
  return false;
}
function translated(rect:Rect,at:Point):Rect{
  return {min:{x:at.x+rect.min.x,y:at.y+rect.min.y},max:{x:at.x+rect.max.x,y:at.y+rect.max.y}};
}
function include(extent:Rect,box:Rect):Rect{
  return {min:{x:Math.min(extent.min.x,box.min.x),y:Math.min(extent.min.y,box.min.y)},
    max:{x:Math.max(extent.max.x,box.max.x),y:Math.max(extent.max.y,box.max.y)}};
}

/** Keep neighboring outlets in port order. A shared successor inherits the average lane of all entering paths. */
function layerLanes(layer:number[],parents:Map<number,Link[]>,nodes:Vertex[],index:Map<Id,number>,centers:Point[],a:Axis,remaining:Int32Array){
  const sum=new Map<number,number>(),count=new Map<number,number>();
  for(const links of parents.values())for(const {peer} of links){
    const to=index.get(peer.id)!;count.set(to,(count.get(to)??0)+1);
  }
  for(const [from,links] of parents){
    // Single-parent siblings keep their spatial order. Shared targets need a stable tie-break across entering branches.
    const own=links.every(({peer})=>count.get(index.get(peer.id)!)===1);
    const side=(link:Link)=>link.fixed?link.direction[a.across]:0;
    const ordered=links.slice().sort((u,v)=>side(u)-side(v)||
      (own?center(u.peer)[a.across]-center(v.peer)[a.across]:0)||index.get(u.peer.id)!-index.get(v.peer.id)!);
    const sizes=ordered.map(link=>span(nodes[index.get(link.peer.id)!].box,a.across));
    const width=sizes.reduce((n,w)=>n+w,0)+(sizes.length-1)*rowGap;
    const offsets:number[]=[];let next=0;
    for(const size of sizes){offsets.push(next+size/2);next+=size+rowGap;}
    // Keep the longest continuation on its parent's axis. A fixed sideways outlet takes its own lane.
    let trunk=-1;
    for(let i=0;i<ordered.length;i++){
      const link=ordered[i];if(link.fixed&&link.direction[a.across])continue;
      if(trunk<0||remaining[index.get(link.peer.id)!]>remaining[index.get(ordered[trunk].peer.id)!])trunk=i;
    }
    const anchor=trunk<0||splitAxis(ordered.filter(link=>link.fixed),a.across)?width/2:offsets[trunk];
    // Reserve the outward lanes from the parent edge, accumulating the actual sizes of all siblings on that side.
    const reach=span(nodes[from].box,a.across)/2+rowGap;
    let low=-reach,high=reach;
    for(let i=0;i<ordered.length;i++){
      offsets[i]-=anchor;
      if(side(ordered[i])>0){offsets[i]=Math.max(offsets[i],high+sizes[i]/2);high=offsets[i]+sizes[i]/2+rowGap;}
    }
    for(let i=ordered.length-1;i>=0;i--)if(side(ordered[i])<0){
      offsets[i]=Math.min(offsets[i],low-sizes[i]/2);low=offsets[i]-sizes[i]/2-rowGap;
    }
    ordered.forEach((link,i)=>{
      const to=index.get(link.peer.id)!;
      sum.set(to,(sum.get(to)??0)+centers[from][a.across]+offsets[i]);
    });
  }
  const preferred=(i:number)=>sum.get(i)!/count.get(i)!;
  const order=layer.slice().sort((u,v)=>preferred(u)-preferred(v)||u-v);
  const lanes=packLanes(order.map(i=>({size:span(nodes[i].box,a.across),preferred:preferred(i)})),rowGap);
  return order.map((i,j)=>({i,across:lanes[j]}));
}

function arrange(nodes:Vertex[],vertices:Map<Id,Vertex>,a:Axis,editor:EditorSession,scene:Occupancy){
  const index=new Map(nodes.map((v,i)=>[v.node.id,i]));
  const links=nodes.map(v=>{
    const targets=new Map<Id,Link>();
    for(const link of v.links.out)if(index.has(link.peer.id)&&!targets.has(link.peer.id))targets.set(link.peer.id,link);
    return [...targets.values()];
  });
  const edges=links.map(row=>row.map(link=>index.get(link.peer.id)!));
  // Only cut edges inside cycles. Prefer steps nearer to the anchor before a join, even when a return enters its other branch.
  const scc=strongComponents(edges),position=new Int32Array(nodes.length),distance=new Int32Array(nodes.length).fill(-1);
  scc.order.forEach((node,i)=>position[node]=i);
  const queue=[0];distance[0]=0;
  for(let i=0;i<queue.length;i++)for(const to of edges[queue[i]])if(distance[to]<0){
    distance[to]=distance[queue[i]]+1;queue.push(to);
  }
  const forward=(from:number,to:number)=>scc.owner[from]!==scc.owner[to]||distance[from]<distance[to]||
    distance[from]===distance[to]&&position[from]<position[to];
  const dag=edges.map((row,from)=>row.filter(to=>forward(from,to)));
  const rank=longestRanks(dag),layers:number[][]=[],entering:Map<number,Link[]>[]=[];
  nodes.forEach((_,i)=>(layers[rank[i]]??=[]).push(i));
  links.forEach((row,from)=>{
    for(const link of row){
      const to=index.get(link.peer.id)!;if(!forward(from,to))continue;
      const parents=entering[rank[to]]??=new Map(),siblings=parents.get(from);
      if(siblings)siblings.push(link);else parents.set(from,[link]);
    }
  });
  const root=nodes[0],centers:Point[]=[center(root.node)],moved:ShapeObject[]=[];
  const remaining=new Int32Array(nodes.length),axes:Axis[]=[a];
  for(let level=layers.length-1;level>=0;level--)for(const from of layers[level])
    for(const to of dag[from])remaining[from]=Math.max(remaining[from],remaining[to]+1);
  const gap=dag.some(row=>row.length>1)?nodes.reduce((n,v)=>Math.max(n,Math.min(120,span(v.box,a.along)/2)),columnGap):columnGap;
  let extent=translated(root.box,root.node.at);
  for(let level=1;level<layers.length;level++){
    const parents=entering[level];
    for(const [from,exits] of parents)if(splitAxis(exits.filter(link=>link.fixed),a.along)){
      a=acrossSplit(nodes[from],a.along,vertices);break;
    }
    axes[level]=a;
    const lanes=layerLanes(layers[level],parents,nodes,index,centers,a,remaining);
    const depth=lanes.reduce((n,{i})=>Math.max(n,span(nodes[i].box,a.along)),0);
    let front=end(extent,a);
    for(;;){
      const next=front+gap;
      if(!Number.isFinite(next)||next<=front)return;
      const placed=lanes.map(({i,across})=>{
        const v=nodes[i],along=a.sign*(next+depth/2);
        const target=a.along==="x"?{x:along,y:across}:{x:across,y:along};
        const at=gridPoint({x:target.x-v.node.width/2,y:target.y-v.node.height/2});
        return {v,i,at,bounds:translated(v.box,at)};
      });
      let obstacle=front;
      for(const {v,at,bounds} of placed){
        if(!Number.isFinite(bounds.min.x+bounds.min.y+bounds.max.x+bounds.max.y)||span(bounds,"x")<=0||span(bounds,"y")<=0)return;
        if(collapsesRoute(editor.doc,{...v.node,at},index))obstacle=Math.max(obstacle,front+1>front?front+1:next);
        for(const other of scene.query(bounds)){
          if(index.has(other.id)||editor.isHidden(other.id)||editor.doc.objects[other.id]?.kind==="connector")continue;
          if(overlap(bounds,other.bounds))obstacle=Math.max(obstacle,end(other.bounds,a));
        }
      }
      if(obstacle>front){front=obstacle;continue;}
      for(const {v,i,at,bounds} of placed){
        const node={...v.node,at};centers[i]=center(node);extent=include(extent,bounds);
        if(at.x!==v.node.at.x||at.y!==v.node.at.y)moved.push(node);
      }
      break;
    }
  }
  const lines:Connector[]=[],seen=new Set<Id>();
  for(const {node} of nodes)for(const id of incidentConnectorIds(editor.doc,node.id)){
    if(seen.has(id))continue;
    seen.add(id);const line=editor.doc.objects[id];
    if(line.kind!=="connector"||!line.autoPorts||line.arrow==="both"||editor.isHidden(id))continue;
    for(const [source,target] of boundFlowDirections(line)){
      const from=index.get(source.objectId),to=index.get(target.objectId);
      if(from===undefined||to===undefined||!forward(from,to))continue;
      const direction=axes[rank[to]],reversed=line.arrow==="start";
      const face=(i:number,end:typeof source,field:"from"|"to",sign:number)=>{
        if(!mayRoute(editor,line,field))return end;
        const portId=PORT_IDS.find(port=>outlet(nodes[i].node,port)[direction.along]===direction.sign*sign);
        return !portId||portId===end.portId?end:{...end,portId};
      };
      const a=face(from,source,reversed?"to":"from",1),b=face(to,target,reversed?"from":"to",-1);
      if(a!==source||b!==target)lines.push({...line,from:reversed?b:a,to:reversed?a:b});
    }
  }
  return {nodes:moved,lines};
}

export function planDownstreamLayout(editor:EditorSession,scene:Occupancy):DownstreamPlan{
  const root=editor.selection&&editor.doc.objects[editor.selection];
  if(editor.busy||editor.selectedIds.length!==1||!root||root.kind!=="shape"||root.content||editor.isHidden(root.id)||editor.isLocked(root.id))
    return refused("请先选中一个可编辑的流程节点。");
  const vertices=new Map<Id,Vertex>(),queue=[root],seen=new Set([root.id]);
  for(let i=0;i<queue.length;i++){
    const node=queue[i],links=connected(editor,node);
    vertices.set(node.id,{node,links,box:localFootprint(node)});
    for(const {peer} of links.out)if(!seen.has(peer.id)){seen.add(peer.id);queue.push(peer);}
  }
  if(vertices.size===1)return {state:"unchanged",message:"此节点没有可排列的后续节点。"};
  const start=vertices.get(root.id)!,direction=flowAxis(start,vertices);
  const keep=upstreamOfAnchor(start,vertices,direction,editor.doc),nodes=keep.size?reachable(root.id,vertices,keep):[...vertices.values()];
  const scope=nodes.slice(1).map(v=>v.node.id);
  if(editor.anyLocked(scope))return refused("后续节点中有锁定图层，请先解锁。");
  const groups=new Set(nodes.map(v=>flowGroupOf(editor.doc,v.node.id)));
  const included=new Set([root.id,...scope]);
  for(const group of groups)if(group&&group!==editor.editingGroup&&groupUnit(editor.doc,group).some(id=>
    editor.isHidden(id)||editor.isLocked(id)||editor.doc.objects[id].kind==="shape"&&!included.has(id)))
    return refused("后续范围只覆盖流程组的一部分，请进入组内排列。");
  const moved=arrange(nodes,vertices,direction,editor,scene);
  if(!moved)return refused("节点尺寸或坐标超出可排列范围。");
  if(!moved.nodes.length&&!moved.lines.length)return {state:"unchanged",scope,message:scope.length+" 个后续节点已按当前流向排齐。"};
  return {state:"planned",root:root.id,scope,...moved,doc:editor.doc,generation:editor.generation,
    locks:editor.lockRevision,visibility:editor.visibilityRevision,group:editor.editingGroup};
}

export function applyDownstreamLayout(editor:EditorSession,plan:DownstreamPlan){
  if(plan.state!=="planned")return plan;
  if(editor.busy||editor.doc!==plan.doc||editor.generation!==plan.generation||editor.selection!==plan.root||editor.selectedIds.length!==1||
    editor.lockRevision!==plan.locks||editor.visibilityRevision!==plan.visibility||editor.editingGroup!==plan.group)
    return refused("画板或选区已变化，请重新预览。");
  const patches=[...plan.nodes.map(value=>({op:"putObject" as const,value})),...plan.lines.map(value=>({op:"putObject" as const,value,automaticRoute:true as const}))];
  return editor.commitEdit({label:"排列后续节点",patches},plan.generation)
    ?{state:"applied" as const,message:"已排列 "+plan.scope.length+" 个后续节点，可一步撤销。"}
    :refused("节点或连线无法放在预览位置，已保留原布局。");
}
