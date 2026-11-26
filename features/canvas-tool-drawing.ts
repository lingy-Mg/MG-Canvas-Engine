import {allocateId} from "../core/id.ts";
import {objectById} from "../core/document.ts";
import type {Endpoint,GroupMembers} from "../core/document.ts";
import type {Point} from "../core/geometry.ts";
import type {EditorSession} from "../session/editor.ts";
import type {AssetVault} from "./image-assets.ts";
import {compileFlowDrawing} from "./flow-drawing.ts";
import type {CompactFlowGraph,FlowDrawingInput} from "./flow-drawing.ts";
import {applyCanvasBatch} from "./canvas-tool-edits.ts";
import {CommandError} from "./board-commands.ts";
import {flowPlacement} from "./flow-placement.ts";
import type {DrawingViewport} from "./flow-placement.ts";

export function drawCanvasFlow(editor:EditorSession,vault:AssetVault,args:Record<string,unknown>,view:DrawingViewport){
  if(Object.hasOwn(args,"graph")===Object.hasOwn(args,"mermaid"))throw new CommandError("INVALID","Supply exactly one of graph or mermaid");
  const origin=args.origin as Point|undefined;
  const input:FlowDrawingInput=typeof args.mermaid==="string"?{mermaid:args.mermaid,origin}:{graph:args.graph as CompactFlowGraph,origin};
  const plan=compileFlowDrawing(input),{operations:planned,nodeIds,edgeIds,groups}=plan;
  const delta=origin?{x:0,y:0}:flowPlacement(editor.doc,plan,view);
  function move(p:Point):Point{
    const x=p.x+delta.x,y=p.y+delta.y;
    if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y))throw new CommandError("INVALID","Drawing exceeds safe integer world coordinates");
    return {x,y};
  }
  // Mermaid identifiers are local to a diagram. The mutation receipt retains this allocation across retries.
  const local=typeof args.mermaid==="string",prefix=local?allocateId("flow"):"";
  const ids=new Map<string,string>();
  function allocate(id:string,path:string){
    const actual=local?prefix+"."+ids.size+"."+id.slice(0,64):id;
    if(objectById(editor.doc,actual)||Object.hasOwn(editor.doc.assets,actual)||Object.hasOwn(editor.doc.flowGroups?.members??{},actual)){
      const error=new CommandError("CONFLICT","ID is already in use: "+actual);
      error.path=path;throw error;
    }
    ids.set(id,actual);
  }
  nodeIds.forEach((id,i)=>allocate(id,"graph.nodes["+i+"].id"));
  edgeIds.forEach((id,i)=>allocate(id,"graph.edges["+i+"].id"));
  groups.forEach((g,i)=>{allocate(g.id,"graph.groups["+i+"].id");allocate(g.titleId,"graph.groups["+i+"]");});
  const actual=(id:string)=>ids.get(id)!;
  const endpoint=(end:Endpoint):Endpoint=>end.kind==="anchor"?{...end,objectId:actual(end.objectId)}:{...end,point:move(end.point)};
  const operations:unknown[]=planned.map(op=>{
    const item=op.value,id=actual(item.id);
    if(item.kind==="connector")return {...op,value:{...item,id,from:endpoint(item.from),to:endpoint(item.to),waypoints:item.waypoints.map(move)}};
    move({x:item.at.x+item.width,y:item.at.y+item.height});
    return {...op,value:{...item,id,at:move(item.at)}};
  });
  const mappedGroups=groups.map(g=>({localId:g.id,id:actual(g.id),titleId:actual(g.titleId),nodeIds:g.nodeIds.map(actual)}));
  if(mappedGroups.length){
    const added:GroupMembers=Object.fromEntries(mappedGroups.map(g=>[g.id,[g.titleId,...g.nodeIds]]));
    operations.push({op:"groups",members:{...editor.doc.flowGroups?.members,...added}});
  }
  const committed=applyCanvasBatch(editor,vault,operations,"AI 创建流程图");
  return {...committed,origin:origin??delta,nodeIds:nodeIds.map(actual),edgeIds:edgeIds.map(actual),
    nodeIdMap:Object.fromEntries(nodeIds.map(id=>[id,actual(id)])),edgeIdMap:Object.fromEntries(edgeIds.map(id=>[id,actual(id)])),
    ...(mappedGroups.length?{groups:mappedGroups,groupIdMap:Object.fromEntries(mappedGroups.map(g=>[g.localId,g.id]))}:{})};
}
