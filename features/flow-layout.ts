import {DEFAULT_SHAPE_STROKE} from "../core/document.ts";
import type {Connector,Endpoint,Id,ShapeObject} from "../core/document.ts";
import {boxBounds} from "../core/geometry.ts";
import type {Point,Rect} from "../core/geometry.ts";
import {flowGroupOf,groupUnit} from "../core/flow-groups.ts";
import {incidentConnectorIds} from "../core/history.ts";
import type {EditorSession} from "../session/editor.ts";
import type {SceneProjection} from "../scene/projector.ts";

type LayoutResult=Readonly<{state:"applied"|"unchanged"|"refused";message:string}>;
type FlowSelection=Pick<EditorSession,"doc"|"selectedIds"|"anyLocked"|"isLocked"|"isHidden"|"editingGroup"|"busy">;
type LayoutPlan=Readonly<{state:"refused"|"unchanged";message:string}|{state:"planned";nodes:ShapeObject[]}>;
const refused=(message:string)=>({state:"refused" as const,message});
export const columnGap=40,rowGap=28;
/** Move only overlapping runs, preserving the preferred centers of already separated lanes. */
export function packLanes(rows:readonly {size:number;preferred:number}[],gap:number):number[]{
  const blocks:{start:number;end:number;sum:number;size:number}[]=[],centers:number[]=[];
  let offset=0;
  for(const [row,{size,preferred}] of rows.entries()){
    const mid=offset+size/2;centers.push(mid);offset+=size+gap;
    let block={start:row,end:row,sum:preferred-mid,size:1};
    while(blocks.length){
      const prev=blocks[blocks.length-1];if(prev.sum/prev.size<=block.sum/block.size)break;
      blocks.pop();block={start:prev.start,end:row,sum:prev.sum+block.sum,size:prev.size+block.size};
    }
    blocks.push(block);
  }
  for(const b of blocks)for(let j=b.start;j<=b.end;j++)centers[j]+=b.sum/b.size;
  return centers;
}
const componentGap=64;
const epsilon=1e-8;

function selectedNodes(editor:FlowSelection):ShapeObject[]|string{
  if(editor.busy)return "请先结束当前手势。";
  const doc=editor.doc,picked=new Set(editor.selectedIds),groups=new Set<Id>();
  if(editor.anyLocked(picked))return "选区含锁定图层，请先解锁或改选。";
  for(const id of picked){
    const item=doc.objects[id];
    if(!item||editor.isHidden(id))return "选区已变化，请重新选择可见节点。";
    if(item.kind==="connector"){
      if(item.from.kind!=="anchor"||item.to.kind!=="anchor"||!picked.has(item.from.objectId)||!picked.has(item.to.objectId))
        return "请移出单独、跨选区或含自由端的连线。";
    }else if(item.kind!=="shape")return "请仅选择流程节点，可包含这些节点之间的连线。";
    const group=flowGroupOf(doc,id);
    if(group&&group!==editor.editingGroup)groups.add(group);
  }
  for(const group of groups){
    if(groupUnit(doc,group).some(id=>!picked.has(id)||editor.isHidden(id)||editor.isLocked(id)))
      return "流程组含隐藏、锁定或未选成员。请完整选择，或进入组内编辑。";
  }
  const nodes:ShapeObject[]=[];
  for(const id of doc.order){const item=doc.objects[id];if(picked.has(id)&&item.kind==="shape")nodes.push(item);}
  return nodes.length>=2?nodes:"请至少选择两个有连接关系的流程节点。";
}

/** A stack of DFS frames preserves finishing order even on very long chains. */
function finishOrder(edges:number[][]):number[]{
  const seen=new Uint8Array(edges.length),out:number[]=[];
  for(let i=0;i<edges.length;i++){
    if(seen[i])continue;
    const stack=[{id:i,next:0}];seen[i]=1;
    while(stack.length){
      const frame=stack[stack.length-1],neighbors=edges[frame.id];
      if(frame.next===neighbors.length){out.push(frame.id);stack.pop();continue;}
      const id=neighbors[frame.next++];if(seen[id])continue;
      seen[id]=1;stack.push({id,next:0});
    }
  }
  return out;
}
function partition(roots:number[],edges:number[][]){
  const owner=new Int32Array(edges.length).fill(-1),groups:number[][]=[];
  for(const first of roots){
    if(owner[first]!==-1)continue;
    const index=groups.length,group:number[]=[],stack=[first];owner[first]=index;
    while(stack.length){
      const node=stack.pop()!;group.push(node);
      for(const next of edges[node])if(owner[next]===-1){owner[next]=index;stack.push(next);}
    }
    groups.push(group);
  }
  return {owner,groups};
}

/** Longest distance from a source in an acyclic graph, including all paths to a join. */
export function longestRanks(edges:readonly Iterable<number>[]):Int32Array{
  const degree=new Int32Array(edges.length),depth=new Int32Array(edges.length);
  for(const targets of edges)for(const to of targets)degree[to]++;
  const queue=edges.flatMap((_,i)=>degree[i]?[]:[i]);
  for(let head=0;head<queue.length;head++){
    const from=queue[head];
    for(const to of edges[from]){
      depth[to]=Math.max(depth[to],depth[from]+1);if(--degree[to]===0)queue.push(to);
    }
  }
  return depth;
}

export function strongComponents(edges:number[][]){
  const incoming=edges.map(()=>[] as number[]);
  edges.forEach((next,i)=>{for(const j of next)incoming[j].push(i);});
  const order=finishOrder(edges).reverse();
  return {...partition(order,incoming),incoming,order};
}
/** Stable component bands and longest-path ranks for both arranging and creating flows. */
export function columnsByComponent(edges:number[][],spreadCycles=false):number[][][]{
  const scc=strongComponents(edges);
  const next=scc.groups.map(()=>new Set<number>());
  edges.forEach((targets,i)=>{
    const from=scc.owner[i];for(const j of targets){
      const to=scc.owner[j];if(to===from||next[from].has(to))continue;
      next[from].add(to);
    }
  });
  let rank:Int32Array;
  if(spreadCycles){
    // Keep the DFS-forward edges within each cycle. The remaining edges can return in an outside lane.
    const sequence=new Int32Array(edges.length);
    scc.order.forEach((node,i)=>sequence[node]=i);
    rank=longestRanks(edges.map((targets,i)=>targets.filter(j=>scc.owner[i]!==scc.owner[j]||sequence[i]<sequence[j])));
  }else{
    const depth=longestRanks(next);
    rank=Int32Array.from(scc.owner,component=>depth[component]);
  }
  const roots=edges.map((_,i)=>i);
  const weak=partition(roots,edges.map((targets,i)=>targets.concat(scc.incoming[i])));
  const bands=weak.groups.map(()=>[] as number[][]);
  for(const i of roots){
    const columns=bands[weak.owner[i]],level=rank[i];
    (columns[level]??=[]).push(i); // source document layer order breaks ties
  }
  // Components start with their first document member. Put isolated nodes last.
  return [...bands.filter((_,i)=>weak.groups[i].length>1),...bands.filter((_,i)=>weak.groups[i].length===1)];
}

type Anchor=Extract<Endpoint,{kind:"anchor"}>;
export function boundFlowDirections(line:Connector):[Anchor,Anchor][]{
  const {from,to,arrow}=line;
  if(from.kind!=="anchor"||to.kind!=="anchor"||from.objectId===to.objectId)return [];
  if(arrow==="both")return [[from,to],[to,from]];
  return arrow==="start"?[[to,from]]:[[from,to]];
}

function selectedEdges(editor:FlowSelection,nodes:ShapeObject[]):number[][]{
  const doc=editor.doc,index=new Map(nodes.map((node,i)=>[node.id,i])),seen=new Set<Id>();
  const outgoing=nodes.map(()=>new Set<number>());
  for(const node of nodes)for(const id of incidentConnectorIds(doc,node.id)){
    if(seen.has(id)||editor.isHidden(id))continue;
    seen.add(id);const line=doc.objects[id];
    if(line.kind!=="connector")continue;
    for(const [from,to] of boundFlowDirections(line)){
      const a=index.get(from.objectId),b=index.get(to.objectId);
      if(a!==undefined&&b!==undefined)outgoing[a].add(b);
    }
  }
  return outgoing.map(ids=>[...ids]);
}
export function localFootprint(node:ShapeObject):Rect{
  const b=boxBounds({...node,at:{x:0,y:0}});
  // Match the shape bounds used by the scene, including heavy outlines.
  const pad=(node.strokeWidth??0)>DEFAULT_SHAPE_STROKE?node.strokeWidth!/2:0;
  return {min:{x:b.min.x-pad,y:b.min.y-pad},max:{x:b.max.x+pad,y:b.max.y+pad}};
}
function positions(nodes:ShapeObject[],bands:number[][][]):ReadonlyMap<Id,{at:Point;bounds:Rect}>|undefined{
  const boxes=nodes.map(localFootprint);
  let left=Infinity,top=Infinity;
  nodes.forEach((n,i)=>{left=Math.min(left,n.at.x+boxes[i].min.x);top=Math.min(top,n.at.y+boxes[i].min.y);});
  // Use a stable integer starting edge. Round each following placement outward to keep the full gap.
  left=Math.floor(left+epsilon);top=Math.floor(top+epsilon);
  const result=new Map<Id,{at:Point;bounds:Rect}>();
  for(const [bandIndex,columns] of bands.entries()){
    let x=left,bottom=top;
    for(const [columnIndex,column] of columns.entries()){
      let y=top,right=x;
      for(const [rowIndex,i] of column.entries()){
        const b=boxes[i],at={x:Math.ceil(x-b.min.x-epsilon)+0,y:Math.ceil(y-b.min.y-epsilon)+0};
        const min={x:at.x+b.min.x,y:at.y+b.min.y},max={x:at.x+b.max.x,y:at.y+b.max.y};
        if(![min.x,min.y,max.x,max.y].every(Number.isFinite)||max.x<=min.x||max.y<=min.y)return;
        result.set(nodes[i].id,{at,bounds:{min,max}});
        right=Math.max(right,max.x);bottom=Math.max(bottom,max.y);y=max.y+rowGap;
        if(rowIndex+1<column.length&&y<=max.y)return;
      }
      x=right+columnGap;if(columnIndex+1<columns.length&&x<=right)return;
    }
    top=bottom+componentGap;if(bandIndex+1<bands.length&&top<=bottom)return;
  }
  return result;
}
export const overlap=(a:Rect,b:Rect)=>a.min.x<b.max.x&&a.max.x>b.min.x&&a.min.y<b.max.y&&a.max.y>b.min.y;

/** An explicit layout action only changes selected node positions. All routes are read-only. */
export function planFlowLayout(editor:FlowSelection,scene:Pick<SceneProjection,"query">):LayoutPlan{
  const nodes=selectedNodes(editor);if(typeof nodes==="string")return refused(nodes);
  const edges=selectedEdges(editor,nodes);
  if(!edges.some(row=>row.length))return refused("选区内没有连接两个不同节点的可见连线。");
  const dest=positions(nodes,columnsByComponent(edges));
  if(!dest)return refused("节点尺寸或坐标超出可整理范围。");
  const moved:ShapeObject[]=[];
  for(const node of nodes){
    const {at,bounds}=dest.get(node.id)!;
    if(Math.abs(at.x-node.at.x)<=epsilon&&Math.abs(at.y-node.at.y)<=epsilon)continue;
    for(const other of scene.query(bounds)){
      if(dest.has(other.id)||editor.isHidden(other.id)||editor.doc.objects[other.id]?.kind==="connector")continue;
      if(overlap(bounds,other.bounds))return refused("整理后会覆盖选区外的可见对象，请留出空间或调整选区。");
    }
    moved.push({...node,at});
  }
  return moved.length?{state:"planned",nodes:moved}:{state:"unchanged",message:"所选流程已按连接关系排好。"};
}

export function layoutSelectedFlow(editor:EditorSession,scene:Pick<SceneProjection,"query">):LayoutResult{
  const plan=planFlowLayout(editor,scene);
  if(plan.state!=="planned")return plan;
  const patches=plan.nodes.map(value=>({op:"putObject" as const,value}));
  if(!editor.commitEdit({label:"按连接关系整理流程",patches},editor.generation))
    return refused("整理后的节点或连线未通过校验，已保留原布局。");
  return {state:"applied",message:"已整理所选流程，可一步撤销。"};
}
