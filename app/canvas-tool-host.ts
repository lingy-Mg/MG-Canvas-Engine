import {isRecord,objectById} from "../core/document.ts";
import type {BoardObject} from "../core/document.ts";
import {flowGroupOf} from "../core/flow-groups.ts";
import {screenToWorld} from "../core/geometry.ts";
import {CommandError,reject} from "../features/board-commands.ts";
import {applyCanvasEdits} from "../features/canvas-tool-edits.ts";
import type {CanvasEdit} from "../features/canvas-tool-edits.ts";
import type {AssetVault} from "../features/image-assets.ts";
import type {DrawGroup} from "../scene/board.ts";
import {fitCanvas} from "./canvas-fit.ts";
import type {CanvasViewport} from "./canvas-fit.ts";
import type {SceneProjection} from "../scene/projector.ts";
import type {EditorSession} from "../session/editor.ts";
import {canvasToolDefinitions} from "../platform/canvas-tools.ts";
import type {CanvasToolPayload,CanvasToolResult,CanvasTools} from "../platform/canvas-tools.ts";
import {validateToolInput} from "../platform/canvas-tool-input.ts";
import type {createLiveCommands} from "../platform/live-commands.ts";
import {drawCanvasFlow} from "../features/canvas-tool-drawing.ts";
import {FlowDrawingError} from "../features/flow-drawing.ts";

type Args=Record<string,unknown>;
type Live=ReturnType<typeof createLiveCommands>;
type Hooks={editor:EditorSession;live:()=>Live;vault:()=>AssetVault;scene:SceneProjection;boardTitle?:()=>string;
  size:(action?:"view"|"placement")=>CanvasViewport;focusedTopic?:()=>{mapId:string;topicId:string}|undefined};
function title(item:BoardObject):string{
  switch(item.kind){
    case "shape":case "connector":return item.label;
    case "text":return item.text;
    case "mindmap":return item.topics[item.rootId].text;
    case "table":return item.cells[0]?.[0]?.text??"";
    case "image":return item.assetId;
    default:return "";
  }
}
function viewport({editor,size}:Hooks,area=size()){
  const {width,height,usableWidth=width,windowWidth,windowHeight,occlusions=[]}=area,{camera}=editor;
  return {width,height,usableWidth,windowWidth,windowHeight,occlusions,unit:"css-px",zoom:camera.zoom,offset:camera.offset,
    bounds:{min:screenToWorld({x:0,y:0},camera),max:screenToWorld({x:usableWidth,y:height},camera)}};
}
function screenText(groups:readonly DrawGroup[],zoom:number){
  return groups.flatMap(group=>{
    let min=Infinity,max=0;
    const add=(size:number)=>{min=Math.min(min,size);max=Math.max(max,size);};
    for(const item of group.items){
      if(item.kind==="nodeLabel"&&item.text)add(item.fontSize);
      else if(item.kind==="text"&&item.text)add(item.size);
      else if(item.kind==="textBlock"&&item.lines.some(Boolean))add(item.fontSize);
      else if(item.kind==="cardText")for(const run of item.layout.glyphs)if(run.text)add(run.size);
    }
    const px=(size:number)=>Math.round(size*zoom*100)/100;
    return max?[{id:group.id,minFontPx:px(min),maxFontPx:px(max)}]:[];
  });
}
function read(h:Hooks,args:Args,live:Live){
  const {editor:e,scene}=h,doc=e.doc,view=viewport(h),selected=e.selectedIds;
  let pool:readonly string[];
  if(args.ids!==undefined){
    if(args.scope&&args.scope!=="board")reject("INVALID","Use ids or a selection/viewport scope");
    pool=args.ids as string[];
    for(const id of pool)if(!objectById(doc,id))reject("NOT_FOUND","Unknown object ID: "+id);
  }else if(args.scope==="selection")pool=selected;
  else if(args.scope==="viewport")pool=scene.query(view.bounds).map(g=>g.id);
  else pool=doc.order;
  const query=(args.query as string|undefined)?.toLowerCase();
  if(query||args.kind)pool=pool.filter(id=>{
    const item=doc.objects[id];return (!args.kind||item.kind===args.kind)&&(!query||id.toLowerCase().includes(query)||title(item).toLowerCase().includes(query));
  });
  const full=args.detail==="full",offset=(args.offset as number|undefined)??0,limit=Math.min((args.limit as number|undefined)??20,full?10:100);
  const page=pool.slice(offset,offset+limit);
  const objects=page.map(id=>{
    const item=doc.objects[id],common={id,kind:item.kind,locked:e.isLocked(id),hidden:e.isHidden(id),group:flowGroupOf(doc,id)??null,bounds:scene.group(id)?.bounds};
    if(full)return {...common,object:item};
    return {...common,label:title(item).slice(0,160),...(item.kind==="connector"?{from:item.from,to:item.to}:{}),
      ...("at" in item?{at:item.at}:{}),...("width" in item?{width:item.width,height:item.height}:{})};
  });
  const topics=[];let topicCount=0;
  for(const [mapId,topicIds] of e.selectedTopics){
    topicCount+=topicIds.size;
    if(topics.length<50)for(const topicId of topicIds){topics.push({mapId,topicId});if(topics.length===50)break;}
  }
  return {...live.status(),board:{id:doc.id,title:h.boardTitle?.(),schemaVersion:doc.schemaVersion,objectCount:doc.order.length},
    selection:{count:selected.length,ids:selected.slice(0,100),focusedTopic:h.focusedTopic?.()??null,topicCount,topics},
    blockingReasons:live.blockers(),viewport:view,total:pool.length,offset,nextOffset:offset+page.length<pool.length?offset+page.length:null,objects,
    ...(args.ids||query||args.scope==="viewport"||args.scope==="selection"?{screenText:screenText(page.flatMap(id=>scene.group(id)??[]),view.zoom)}:{})};
}
function view(h:Hooks,args:Args,live:Live){
  const reasons=live.blockers();if(reasons.length)reject("BUSY","Finish the active edit first: "+reasons.join(", "));
  const ids=args.ids as string[]|undefined;
  if(args.action==="locate"&&!ids)reject("INVALID","locate requires explicit object IDs");
  const findGroup=(id:string)=>{
    const group=h.scene.group(id);
    if(!group)reject("NOT_FOUND","Object is missing or hidden: "+id);
    return group;
  };
  const groups=ids?ids.map(findGroup):h.scene.all();
  const measured=args.measureIds?(args.measureIds as string[]).map(findGroup):ids?groups:[];
  const area=h.size("view"),{width,height,usableWidth=width,occlusions=[]}=area;
  if(args.action==="fit")h.editor.setCamera(fitCanvas(groups,area));
  else{
    const bounds=h.scene.selectedBounds(ids!)!,zoom=h.editor.camera.zoom;
    const top=Math.max(0,...occlusions.filter(c=>c.edge==="top").map(c=>c.bottom));
    const bottom=Math.min(height,...occlusions.filter(c=>c.edge==="bottom").map(c=>c.top));
    h.editor.setCamera({zoom,offset:{x:usableWidth/2-(bounds.min.x+bounds.max.x)*zoom/2,y:(top+bottom)/2-(bounds.min.y+bounds.max.y)*zoom/2}});
  }
  return {revision:live.status().revision,viewport:viewport(h,area),screenText:screenText(measured,h.editor.camera.zoom)};
}
function result(payload:CanvasToolPayload):CanvasToolResult{
  // JSON results must not hand mutable references to the page's live receipt, document or camera to callers.
  const text=JSON.stringify(payload);
  return {content:[{type:"text",text}],structuredContent:JSON.parse(text),...(!payload.ok?{isError:true}:{})};
}
export function createCanvasTools(h:Hooks):CanvasTools{
  return {
    listTools:()=>structuredClone(canvasToolDefinitions),
    async callTool(name,raw={},signal){
      let live:Live|undefined;
      try{
        const tool=canvasToolDefinitions.find(t=>t.name===name);if(!tool)reject("NOT_FOUND","Unknown canvas tool: "+name);
        if(signal?.aborted)reject("CANCELLED","The tool call was cancelled");
        live=h.live();
        const args=structuredClone(raw);
        validateToolInput(tool.inputSchema,args);
        if(!isRecord(args))reject("INVALID","Expected an object");
        let data:Record<string,unknown>;
        if(name==="canvas_read")data=read(h,args,live);
        else if(name==="canvas_view")data=view(h,args,live);
        else data=await live.mutate(name,args,()=>{
          if(name==="canvas_history")return live!.stepHistory(args.action as "undo"|"redo");
          if(name==="canvas_draw_flow"){
            const {width,height,usableWidth=width}=h.size("placement");
            return drawCanvasFlow(h.editor,h.vault(),args,{scene:h.scene,width:usableWidth,height,camera:h.editor.camera});
          }
          return applyCanvasEdits(h.editor,h.vault(),args.operations as CanvasEdit[],args.label as string|undefined);
        },signal);
        return result({ok:true,...data});
      }catch(error){
        const command=error instanceof CommandError?error:undefined,drawing=error instanceof FlowDrawingError?error:undefined;
        return result({ok:false,code:command?.code??"INVALID",message:error instanceof Error?error.message:String(error),
          revision:live?.status().revision,operationIndex:command?.operationIndex,path:command?.path??drawing?.path,line:drawing?.line,column:drawing?.column});
      }
    },
  };
}
