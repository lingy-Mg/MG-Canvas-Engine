import { captureClipboard, prepareClipboardCut, prepareDragCopies, decodeClipboard, isCanvasClipboardText, duplicateClipboardSelection, encodeClipboard, pasteClipboard } from "../features/clipboard.ts";
import { allocateId } from "../core/id.ts";
import {cellAt,createTable} from "../features/table.ts";
import {hitTableDivider} from "../features/table-geometry.ts";
import {CanvasTables} from "./table-editor.ts";
import {markdownState} from "../features/markdown-format.ts";
import type {MarkdownAction} from "../features/markdown-format.ts";
import {isCard} from "../core/document.ts";
import type {CardObject} from "../core/document.ts";
import {MAX_CARD_TEXT} from "../core/card.ts";
import type {CardKind} from "../core/card.ts";
import {cardName,cardInk,cardOffsetAt,fittedCard,hasMarkdown,newCard} from "../features/card-content.ts";
import {cardCapabilities,stickyCapabilities,styledCard} from "./card-editor.ts";
import {placementBox,stickyColors,TextPlacement} from "./text-placement.ts";
import {placementDragged} from "../features/placement.ts";
import type {History} from "../core/history.ts";
import {worldToLocal} from "../core/geometry.ts";
import {PathInput} from "../features/path-input.ts";
import {MAX_PATH_VERTICES} from "../core/document.ts";
import type {VectorPath} from "../core/document.ts";
import { InkInput } from "../features/ink-input.ts";
import { eraserHitsInk } from "../features/ink.ts";
import { inkToolbar } from "./ink-toolbar.ts";
import {appleShortcuts,dockContextKey,dockEscapeKey,dockHistory,dockTitle,dockTool} from "./dock-shortcuts.ts";
import type { InkAction,InkPointer } from "../features/ink-input.ts";
import { arrangeSelection, canArrange } from "../features/arrange.ts";
import type { ArrangeCommand } from "../features/arrange.ts";
import { objectById } from "../core/document.ts";
import type { ChangeSet } from "../core/history.ts";
import type { BoardDocument,BoardObject,Connector,Id,MindMap,ShapeObject,TextObject } from "../core/document.ts";
import { boxBounds,clientToScreen,normalizeWheel,portWorld,PORT_IDS,rectBetween,screenToWorld,worldToScreen } from "../core/geometry.ts";
import type { Box,Camera,Point,Rect } from "../core/geometry.ts";
import {flowGroupOf,groupUnit} from "../core/flow-groups.ts";
import { EditorSession } from "../session/editor.ts";
import type {DragSetup} from "../session/editor.ts";
import {liveProperties,publishingProperty,resetPropertyPanel} from "./property-draft.ts";
import {pathFrame,pathHandleBox,pathStrokeBox} from "../core/path-transform.ts";
import {pathInspector} from "./path-inspector.ts";
import {contentProperties} from "./content-properties.ts";
import { selectionProperties } from "./selection-properties.ts";
import {imageProperties} from "./image-properties.ts";
import {inkProperties} from "./ink-properties.ts";
import {textProperties} from "./text-properties.ts";
import {shapeProperties} from "./shape-properties.ts";
import {planShapeTransform} from "../session/shape-properties.ts";
import {DEFAULT_SHAPE_STROKE} from "../core/document.ts";
import {movePatches} from "../session/transform.ts";
import {mindProperties} from "./topic-properties.ts";
import {connectorProperties} from "./connector-properties.ts";
import { flowLabelBox, hitDetail, marqueeHit, mergeBounds, topicPaint, topicLabelBox } from "../scene/board.ts";
import {PointerFeedback,hitOutline,type HoverOutline} from "../renderers/canvas2d/pointer-feedback.ts";
import {textFrame} from "../features/plain-text.ts";
import type { DrawGroup,SceneHit } from "../scene/board.ts";
import { SceneProjection } from "../scene/projector.ts";
import {SceneMotion} from "../scene/motion.ts";
import { cornerPoint,hitResizeHandle,hitRotationHandle,RESIZE_CORNERS,resizable,rotationHandle } from "../session/resize.ts";
import type { BoxHandle } from "../session/resize.ts";
import {hitTextWidthGrip,textWidthCursor} from "../session/text-width.ts";
import { CanvasView } from "../renderers/canvas2d/canvas.ts";
import { CameraRaster } from "../renderers/canvas2d/camera-raster.ts";
import { FrameMeter } from "./frame-meter.ts";
import { FrameTrace } from "./frame-trace.ts";
import { FramePace,frameRate } from "./frame-pace.ts";
import { autoLabelInk,parseTheme,resolveTheme,standaloneInk,THEME_STORAGE_KEY } from "../platform/theme.ts";
import {automaticTextColor} from "../core/text-style.ts";
import {TextFormatBar,standaloneCapabilities,formatSeries} from "./text-format-bar.ts";
import type {FormatChange,FormatGesture,ScreenArea} from "./text-format-bar.ts";
import {placeSelectionCount} from "./selection-count.ts";
import type { WorkspaceTheme } from "../platform/theme.ts";
import {SaveConflictError} from "../platform/store.ts";
import {isProtected,openLocalBoardCopies} from "../platform/local-board-copies.ts";
import type {Copies,CopySlot} from "../platform/local-board-copies.ts";
import {prepareBrowserRecovery} from "../platform/browser-recovery.ts";
import type {WorkspaceRecovery} from "../platform/workspace-recovery.ts";
import type {DraftTarget,TextDraft,WorkspaceData} from "../platform/workspace-store.ts";
import { decodeProject, encodeProject,MAX_PROJECT_CHARS,readProjectNames } from "../platform/project.ts";
import type { ProjectNames,ProjectPackage } from "../platform/project.ts";
import { AssetVault,MAX_IMAGE_BYTES } from "../features/image-assets.ts";
import {graphemePrefix,isTextKey} from "../features/text-layout.ts";
import {TopicTree} from "./topic-tree.ts";
import {kindNames as names,layerTitle as title,layerQuery,LayerSearch,LAYER_PAGE_SIZE,layerPageIds,pageOfLayer} from "./layer-search.ts";
import { MAX_LABEL_LENGTH,MAX_TEXT_LENGTH } from "../features/plain-text.ts";
import { createText,deleteStandalone,duplicateStandalone,importStandalone,moveStandaloneLayer,planTextStyle,referencedAssetIds,saveText,setTextStyle } from "../features/standalone.ts";
import { decodeBrowserImage, ImageCache, releaseBitmap } from "./image-cache.ts";
import { limitTextInput,TextOverlay } from "./text-editor.ts";
import {layoutSelectedFlow} from "../features/flow-layout.ts";
import {DownstreamAction} from "./downstream-action.ts";
import { addDownstream } from "../features/flow-keyboard.ts";
import { FlowInput } from "../features/flow-input.ts";
import type { ConnectionDrop, FlowMode } from "../features/flow-input.ts";
import type { DropNode } from "../features/flow.ts";
import { addWaypoint, createFlowNode, deleteBoardSelection, deleteFlowSelection, detachConnectorEnd, removeWaypoint, setFlowNodeLabel, withFlowNodeLabel } from "../features/flow.ts";
import { MindMapInput } from "../features/mindmap-input.ts";
import { deleteTopic,finishTopicDraft,foldTopic,getMap,newMindDraft,parentIndex,reorderTopic,topicDraft,withTopicInput } from "../features/mindmap.ts";
import type { TopicDraft,TopicRelation,TopicRef } from "../features/mindmap.ts";
import { topicBox,topicTier } from "../features/mindmap-layout.ts";
import { demo,demoTitle } from "./demo.ts";
import { attachBridge, watchInspector } from "./cli-bridge.ts";
import {attachDesktopBridge,isDesktopWorkbench} from "./desktop-bridge.ts";
import {createCanvasTools} from "./canvas-tool-host.ts";
import type {CanvasToolPayload} from "../platform/canvas-tools.ts";
import {fitCanvas} from "./canvas-fit.ts";
import type {CanvasControl,CanvasViewport} from "./canvas-fit.ts";
import {exposeCanvasTools} from "./canvas-webmcp.ts";
import {createLiveCommands} from "../platform/live-commands.ts";
import {reject} from "../features/board-commands.ts";
import type { BlockReason } from "../platform/live-commands.ts";

import {flushSync} from "react-dom";
import {bindPropertyForm,propertyWidget} from "./property-view.ts";
import {createViewportFrameRequest,observeViewportSize} from "./viewport-lifecycle.ts";
import type {WorkspaceUI,LayerEntry,MenuEntry} from "./react/workspace-ui.ts";

import type {WorkspaceSource} from "./workspace-source.ts";

export function startEditor(hosts:{viewport:HTMLElement;canvas:HTMLCanvasElement;feedback:HTMLCanvasElement},ui:WorkspaceUI,source:WorkspaceSource){
const root=hosts.viewport.closest<HTMLElement>("#workspace")!.parentElement!;
const lifetime=new AbortController();
type NativeEvents=HTMLElementEventMap&WindowEventMap&DocumentEventMap&{pointerrawupdate:PointerEvent};
function listen<K extends keyof NativeEvents>(target:EventTarget|undefined|null,type:K,callback:(event:NativeEvents[K])=>void,options:boolean|AddEventListenerOptions={}){
  if(!target)return;
  const opts=typeof options==="boolean"?{capture:options}:options;
  target.addEventListener(type,callback as EventListener,{...opts,signal:opts.signal?AbortSignal.any([opts.signal,lifetime.signal]):lifetime.signal});
}
let mounted=false;
// A discrete edit may immediately measure or focus the new React children.
const present=(fn:()=>void)=>{if(mounted)flushSync(fn);else fn();};
const cleanups:Array<()=>void>=[];
const required = <T extends HTMLElement>(id:string):T => {
  const el = root.querySelector("#"+id);
  if (!el) throw new Error("missing app element "+id);
  return el as T;
};
const {canvas,viewport}=hosts;
const topControls=root.querySelectorAll<HTMLElement>("#view-zoom, #diagnostics-toggle, #frame-meter, #viewport .frame-rate");
const mainDock=required("main-tools"),creationTools=required("creation-tools"),creationToggle=required("toggle-creation");
const diagnostics=required<HTMLDetailsElement>("diagnostics");
const diagnosticsToggle=required("diagnostics-toggle");
const compactTools=window.matchMedia("(max-width: 800px)");
const compactProperties=window.matchMedia("(max-width: 760px), (max-height: 520px)");
const bottomControls=root.querySelectorAll<HTMLElement>(".tool-strip");
const layers = required("layers");
const inspector=required("inspector");
const otherCopyButton = required<HTMLButtonElement>("open-other");
const legacyCopyButton = required<HTMLButtonElement>("open-legacy");
const fourthCopyButton = required<HTMLButtonElement>("open-fourth");
const fifthCopyButton = required<HTMLButtonElement>("open-fifth");
const sixthCopyButton = required<HTMLButtonElement>("open-sixth");
const alternateButtons=[otherCopyButton,legacyCopyButton,fourthCopyButton,fifthCopyButton,sixthCopyButton,required<HTMLButtonElement>("open-seventh"),required<HTMLButtonElement>("open-eighth")];
const appleKeys=appleShortcuts(navigator);
const undoTitle=dockTitle("undo","撤销",appleKeys),redoTitle=dockTitle("redo","重做",appleKeys);
const segmentPicker=required<HTMLInputElement>("path-segment");
const fitButton=required<HTMLButtonElement>("fit");
const bridgePage=source.kind==="cli";
const embeddedProject=source.kind==="local"?source.embeddedProject:undefined;
const desktop=!bridgePage&&!embeddedProject&&isDesktopWorkbench();
let liveCommands: Awaited<ReturnType<typeof attachBridge>>|undefined;
const view = new CanvasView(canvas,{cardPlaceholders:true,overviewDetail:true});
const pointerFeedback=new PointerFeedback(hosts.feedback);
const motion=new SceneMotion(),motionPreference=window.matchMedia?.("(prefers-reduced-motion: no-preference)");
listen(motionPreference,"change",()=>{if(!motionPreference.matches){motion.clear();scenePatchDirty=true;invalidate();}});
const frameMeter=new FrameMeter(next=>ui.frameMeter.set(next));
const editor = new EditorSession(demo,{ offset:{ x:0,y:0 },zoom:1 },prepareObjectDrag);
let projectNames:ProjectNames={};
function updateProjectHeading(){
  const stem=projectNames.fileName?.replace(/\.(mgcanvas|json)$/i,"").trim();
  const name=projectNames.title||stem||(editor.doc.id===demo.id?demoTitle:editor.doc.id);
  ui.patch("project-title",{caption:name,title:name});
  if(desktop)document.title=name+" · MG Canvas";
}
updateProjectHeading();
const flow = new FlowInput(editor,targetAt,flowCandidates);
let menuDrop:ConnectionDrop|undefined;
const mind = new MindMapInput(editor,targetAt,startTopic,topicAppearanceMap,id=>motion.topics.liveRows(id));
editor.onMarqueeCommit=()=>mind.reset();
const ink=new InkInput();
const paths=new PathInput(editor);
let inkArmed=false,fingerInk=false,inkGeneration:symbol|undefined;
const inkTools=inkToolbar(ui,focusCanvas=>{updateChrome();if(focusCanvas)canvas.focus({preventScroll:true});});
const erasedInk=new Map<Id,BoardObject>();
let mindDraft:TopicDraft|undefined;
let committingTopic:MindMap|undefined;
let paletteOpen=false;
let width=0,height=0,ratio=1;
let fitPending=true;
type WorkspacePanel="layers";
const compactPanels=window.matchMedia?.("(max-width: 760px)");
let panel:WorkspacePanel|undefined;
let saving=0,importing=0,reopening=false,textArmed=false;
let tableArmed=false;
let cardArmed:CardKind|undefined;
let textPointer:{ id:number; type:string; start:Point; current:Point; moved?:boolean }|undefined;
let nodeTap:{id:number;start:Point;finish:()=>void}|undefined;
let vault=new AssetVault();
const textOverlay=new TextOverlay(viewport,placeOverlay);
const stickyPalette=required("sticky-palette");
const placement=new TextPlacement(required("placement-preview"),ui,()=>canvas.focus({preventScroll:true}));
let recovery:WorkspaceRecovery|undefined;
let confirmRecoveredWorkspace=false;
const formatBar=new TextFormatBar(viewport,inspector,redo=>{
  if(textOverlay.card){textOverlay.card.history(redo);return true;}
  if(textOverlay.active||editor.busy||reopening)return false;
  changeHistory(redo);placeOverlay();return true;
});
formatBar.bindEditor(editor);
const selectionBadge=required("selection-count");
const selectionObstacles=[formatBar.root,inspector,...["format-options","view-zoom","flow-help","frame-meter","main-tools","layers-panel"].map(id=>root.querySelector<HTMLElement>("#"+id))];
listen(formatBar.root,"click",()=>{if(!selectionBadge.hidden)invalidate();});
const tables=new CanvasTables(editor,textOverlay,canvas,viewport,()=>{if(tables.table)updateSelectionControls();updateChrome();invalidate();},clipboardStatus);
formatBar.register(()=>{
  const table=tables.table;
  if(!table||reopening||editor.isLocked(table.id)||(!tables.editing&&!wholePathMode())||editor.draggingCopies&&editor.preview){
    tables.hide();return;
  }
  const preview=editor.preview?.objects.get(table.id);
  return tables.place(preview?.kind==="table"?preview:table,{left:0,top:0,right:unobstructedWidth(),bottom:height},activeTheme);
});
let textFormatDraft:TextObject|undefined;
formatBar.register(()=>{
  const editing=textOverlay.card,id=editor.selection;
  const item=editing?.item??(id&&editor.selectedIds.length===1?(editor.preview?.objects.get(id)??editor.doc.objects[id]):undefined);
  if(!isCard(item)||reopening||editor.isHidden(item.id)||editor.isLocked(item.id)||!editing&&(!wholePathMode()||editor.draggingCopies))return;
  const box=boxBounds(item),a=worldToScreen(box.min,editor.camera),b=worldToScreen(box.max,editor.camera);
  const style=item.content,generation=editor.generation;
  const top=editing?a.y:Math.min(a.y,rotationHandle(item,editor.camera).knob.y-5);
  return {anchor:{left:a.x,top,right:b.x,bottom:b.y},target:{id:item.id,layout:style.kind,markdown:style.kind==="markdown"?markdownState(item.label,editing?.selection()??{start:0,end:0}):undefined,
    command:(action:MarkdownAction)=>{if(!editing&&editor.selection===item.id&&editor.doc.objects[item.id]===item)startCard(item);textOverlay.card?.markdown(action);},capabilities:style.kind==="sticky"?stickyCapabilities:cardCapabilities,backgroundColors:style.kind==="sticky"?stickyColors:undefined,
    values:{color:cardInk(item,activeTheme),autoInk:!style.color,background:item.fill==="transparent"?undefined:item.fill,
      fontFamily:style.fontFamily??"system",fontSize:style.fontSize,fontWeight:style.fontWeight??400,italic:Boolean(style.italic),
      strike:style.strike,underline:style.underline,align:style.align??"left"},get composing(){return editing?.composing;},
    apply:(change:FormatChange,gesture?:FormatGesture)=>{
      if(editing&&textOverlay.card===editing){editing.apply(change,gesture);return;}
      const current=editor.doc.objects[item.id];
      if(textOverlay.active||editor.busy||editor.generation!==generation||editor.selection!==item.id||editor.selectionLocked||!isCard(current))return;
      if(change.list||change.link){startCard(current);textOverlay.card?.apply(change);return;}
      const next=fittedCard(styledCard(current,change));
      editor.commitEdit({label:"设置"+cardName(style.kind)+"格式",patches:[{op:"putObject",value:next}]},generation,undefined,undefined,formatSeries(gesture,editor.history));
    },focus:()=>{if(textOverlay.card)textOverlay.card.focus();else canvas.focus({preventScroll:true});}}};
});
const cameraRaster=new CameraRaster();
const frameTrace=new FrameTrace();
const pace=new FramePace(),rateSelect=required<HTMLSelectElement>("frame-rate"),rateKey="mg-canvas:workspace-frame-rate";
try{rateSelect.value=frameRate(window.localStorage.getItem(rateKey));}catch{rateSelect.value="unlimited";}
pace.set(frameRate(rateSelect.value));frameMeter.setCap(frameRate(rateSelect.value));
ui.on("frame-rate","change",()=>{
  const rate=frameRate(rateSelect.value);
  pace.set(rate);frameMeter.setCap(rate);
  try{window.localStorage.setItem(rateKey,rate);}catch{/* This session keeps the chosen limit. */}
  invalidate();
});
const imageCache=new ImageCache(()=>{cameraRaster.clear();priorPaint=undefined;invalidate();});
const requestDisplay=createViewportFrameRequest(displayFrame,lifetime.signal);
let repaintMain=false,hoverPoint:Point|undefined,hoveringConnection=false;
let priorPaint:{camera:Camera;doc:BoardDocument;patch:ReadonlyMap<Id,DrawGroup>;visibility:number;selection:readonly Id[];
  width:number;height:number;ratio:number;theme:WorkspaceTheme;assets:Set<Id>;drag?:Rect;canDamage:boolean}|undefined;
let cameraSettle:ReturnType<typeof setTimeout>|undefined;
let sharpenNext=false;
const snapStorageKey="mg-canvas:workspace-drag-snap";
let space=false,snapMoves=false;
try{snapMoves=window.localStorage?.getItem(snapStorageKey)==="on";}catch{/* Keep the first-use default in this session. */}
const projector = new SceneProjection(editor.doc);
const downstream=new DownstreamAction(editor,projector,fromHover=>{
  if(reopening||!wholePathMode()||editor.busy||(fromHover&&formatBar.hasOpenOptions))return false;
  formatBar.close();updateScene();return true;
},()=>{updateChrome();invalidate();},message=>{
  savedHint=message;updateStatus();canvas.focus({preventScroll:true});
},lifetime.signal,formatBar.downstreamButton);
let scenePatchDirty=false;
let scenePatch:ReadonlyMap<string,DrawGroup>=new Map();
let lastPick:{screen:Point;touch:boolean;camera:Camera;doc:BoardDocument;patch:typeof scenePatch;visibility:number;
  point:Point;tolerance:number;near:readonly DrawGroup[];hit?:SceneHit}|undefined;
let inspectorDraft:{form:HTMLElement;reset():boolean;dispose():void;syncMode?():void;syncTheme?(theme:WorkspaceTheme):void}|undefined;
let sceneDoc = editor.doc;
let scenePreview = editor.preview;
let lastSceneDraft:TopicDraft|undefined;
let lastRevealed:MindMap|undefined;
let layersDoc:typeof editor.doc|undefined;
let layerSelection:readonly string[]=[];
let layerRows=new Map<Id,LayerEntry>(),rowSerial=0;
function layerElement(id:Id){return layers.querySelector<HTMLButtonElement>('[data-id="'+CSS.escape(id)+'"]');}
let renderedLocks=-1,renderedVisibility=-1;
const lockButton=required<HTMLButtonElement>("layer-lock"),unlockButton=required<HTMLButtonElement>("layer-unlock");
const layerSearch=new LayerSearch(),layerPanel=required("layers-panel"),searchClear=required<HTMLButtonElement>("layer-search-clear");
let listedLayers:readonly Id[]=[],layerTerm="",searchInput:HTMLInputElement;
let composingLayerSearch=false,layerCompositionEnd=-Infinity;
let searchMapId:Id|undefined;
const topicTree=new TopicTree(required("topic-tree"),model=>present(()=>ui.topics.set(model)),{
  choose:chooseTreeTopic,
  history:redo=>{if(!lockControlsBusy())changeHistory(redo);},
  reorder:(ref,delta)=>{if(!lockControlsBusy()&&mind.selected?.mapId===ref.mapId&&mind.selected.topicId===ref.topicId)reorderTopic(editor,ref,delta);},
  edit:(ref,action)=>{if(chooseTreeTopic(ref))requestTopic(action==="rename"?undefined:action,true,true);},
  search:()=>searchInput?.focus({preventScroll:true}),
  clear:()=>{clearLayerInput();applyLayerSearch("");},
  canvas:()=>{dismissCanvasPanel();canvas.focus({preventScroll:true});},
});
let layerReturn:{page:number;anchor?:Id;scroll:number;selection?:Id}|undefined;
let layerPage=0,renderedLayerPage=-1,layerSession=editor.generation;
let savedHint:string|undefined;
editor.onHiddenEdit=()=>{savedHint="本次操作会修改隐藏图层，先显示相关图层即可继续。";updateStatus();};
editor.onLockedEdit=()=>{savedHint="本次操作涉及锁定图层，请先在图层面板解锁。";updateStatus();};
let storageRead:"checking"|"ready"|"failed"="checking";
let unopenedLocalBoard=false;
const copyLabels={table:"表格副本",group:"流程组副本",curve:"曲线副本",path:"路径副本",ink:"手写副本",protected:"当前副本",indexed:"旧主副本",fallback:"旧备用"};
let activeCopy:CopySlot|undefined, defaultCopy:CopySlot|undefined;
let importedVersion:BoardDocument["schemaVersion"]|undefined;
let hasStorage=false, requireChoice=false, unreadableCopy=false;
let recoveryChoices:CopySlot[]=[];
let saveConflict=false;
const localCopies=bridgePage?undefined:openLocalBoardCopies(window,lifetime.signal);

async function inspectCopies():Promise<Copies>{
  const result=await localCopies!.inspect();
  lifetime.signal.throwIfAborted();
  ({available:hasStorage,unreadable:unreadableCopy,requireChoice,defaultCopy,choices:recoveryChoices}=result);
  return result.copies;
}
function alternateCopies(selected:CopySlot|undefined):CopySlot[]{
  return recoveryChoices.filter(slot=>slot!==selected);
}
function writeSlot(){
  return localCopies?.target(editor.doc.schemaVersion,importedVersion,activeCopy);
}
function canSaveLocally():boolean{
  if(storageRead!=="ready"||saveConflict||!activeCopy)return false;
  const target=writeSlot();
  if(!target)return false;
  if(target==="fallback")return activeCopy==="fallback";
  return activeCopy===target||localCopies!.vacant(target);
}

const glyphs: Record<BoardObject["kind"],string> = { shape:"□",connector:"↗",mindmap:"⤳",text:"T",image:"▧",ink:"✎",path:"⌁",table:"⊞" };
function node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string):HTMLElementTagNameMap[K] {
  const e=document.createElement(tag);
  if (text!==undefined) e.textContent=text;
  if (cls) e.className=cls;
  return e;
}
function withinLayerPage(id:Id,source=listedLayers):boolean{
  const page=pageOfLayer(source,id);if(page<0)return false;
  layerPage=page;return true;
}
function showLayer(id:Id,focus=false){
  const row=layerElement(id);
  if(focus)row?.focus({preventScroll:true});
  row?.scrollIntoView?.({block:"nearest",inline:"nearest"});
}
function applyLayerSearch(raw:string,locate?:Id){
  ui.patch("layer-search-clear",{hidden:!raw});
  const query=layerQuery(raw);if(query===layerTerm)return;
  let reveal:Id|undefined,scroll=0;
  if(!layerTerm)layerReturn={page:layerPage,anchor:layerRows.keys().next().value,scroll:layerPanel.scrollTop,selection:editor.selection};
  layerPage=0;
  if(!query&&layerReturn){
    reveal=locate??(editor.selection!==layerReturn.selection?editor.selection:undefined);
    layerPage=layerReturn.page;
    if(reveal)withinLayerPage(reveal,editor.doc.order);
    else{
      if(layerReturn.anchor)withinLayerPage(layerReturn.anchor,editor.doc.order);
      scroll=layerReturn.scroll;
    }
    layerReturn=undefined;
  }
  layerTerm=query;updateLayers();
  layerPanel.scrollTop=scroll;
  if(reveal)showLayer(reveal);
}
function layerSearchKey(event:KeyboardEvent){
  if(event.key!=="Escape"||composingLayerSearch||event.isComposing||event.keyCode===229||performance.now()-layerCompositionEnd<45||
    event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
  event.preventDefault();event.stopPropagation();if(event.repeat)return;
  if(searchInput.value){
    searchInput.value="";searchInput.focus({preventScroll:true});applyLayerSearch("");
  }else canvas.focus({preventScroll:true});
}
function mountLayerSearch(){
  const oldFocus=searchInput&&document.activeElement===searchInput;
  if(searchInput)present(()=>ui.searchVersion.set(ui.searchVersion.read()+1));
  const input=required<HTMLInputElement>("layer-search"),generation=editor.generation;
  searchInput=input;composingLayerSearch=false;layerCompositionEnd=-Infinity;
  ui.patch("layer-search-clear",{hidden:true});
  const active=(event:Event)=>event.target===input&&input===searchInput&&editor.generation===generation;
  ui.on("layer-search","compositionstart",event=>{if(active(event))composingLayerSearch=true;});
  ui.on("layer-search","compositionend",event=>{
    if(!active(event))return;composingLayerSearch=false;layerCompositionEnd=performance.now();applyLayerSearch(input.value);
  });
  ui.on("layer-search","input",event=>{
    if(active(event)&&!composingLayerSearch&&!(event as InputEvent).isComposing)applyLayerSearch(input.value);
  });
  ui.on("layer-search","keydown",event=>{if(active(event))layerSearchKey(event);});
  if(oldFocus)input.focus({preventScroll:true});
}
function clearLayerInput(){
  // A late native compositionend belongs to the detached field after an explicit clear.
  if(composingLayerSearch)mountLayerSearch();else searchInput.value="";
}
function updateLayers(change?:ChangeSet){
  const newBoard=layerSession!==editor.generation,locksChanged=renderedLocks!==editor.lockRevision;
  const visibilityChanged=renderedVisibility!==editor.visibilityRevision;
  renderedLocks=editor.lockRevision;renderedVisibility=editor.visibilityRevision;
  if(newBoard){
    layerTerm="";layerPage=0;layerReturn=undefined;layerSession=editor.generation;layerPanel.scrollTop=0;ui.patch("layer-search-clear",{hidden:true});
  }
  const map=editor.selectedIds.length===1&&editor.selection?getMap(editor,editor.selection):undefined;
  const scopeChanged=searchMapId!==map?.id;
  if(!searchInput||newBoard||scopeChanged&&composingLayerSearch){
    mountLayerSearch();searchInput.value=layerTerm;ui.patch("layer-search-clear",{hidden:!layerTerm});
  }
  if(scopeChanged||newBoard){
    ui.patch("layer-search",{placeholder:map?"搜索图层或当前脑图主题":"搜索图层名称",
      "aria-label":map?"按名称搜索图层及当前脑图的全部主题":"按名称搜索图层","aria-controls":map?"layers topic-tree-list":"layers"});
    searchMapId=map?.id;
  }
  topicTree.sync(map,mind.selected?.mapId===map?.id?mind.selected?.topicId:undefined,Boolean(map&&editor.isLocked(map.id)),editor.generation,layerTerm);
  const before=listedLayers;
  listedLayers=layerSearch.list(editor.doc,layerTerm,change);
  const listChanged=before!==listedLayers;
  const focusedId=keyboardLayer(document.activeElement)?.dataset.id;
  const selectionChanged=layerSelection!==editor.selectedIds,selected=editor.selection;
  // Keep the focused result on its page when it remains part of the new selection.
  const follow=selectionChanged&&selected&&!layerRows.has(selected)&&
    !(focusedId&&editor.selectedIds.includes(focusedId))&&withinLayerPage(selected);
  if(focusedId&&listChanged&&!newBoard)withinLayerPage(focusedId);
  const count=listedLayers.length,pages=Math.max(1,Math.ceil(count/LAYER_PAGE_SIZE));
  layerPage=Math.min(layerPage,pages-1);
  if(newBoard||listChanged||renderedLayerPage!==layerPage||selectionChanged||locksChanged||visibilityChanged||layersDoc!==editor.doc){
    const ids=layerPageIds(listedLayers,layerPage),next=new Map<Id,LayerEntry>(),picked=new Set(editor.selectedIds);
    const orderChanged=layersDoc?.order!==editor.doc.order;
    for(const id of ids){
      const old=layerRows.get(id),object=editor.doc.objects[id],label=title(object),group=flowGroupOf(editor.doc,id);
      const locked=editor.isLocked(id),hidden=editor.isHidden(id),restore=hidden?restoreCaption(id):"";
      const entry:LayerEntry={id,key:!old||newBoard||orderChanged&&focusedId===id?++rowSerial:old.key,
        kind:object.kind,glyph:glyphs[object.kind],group,label,locked,hidden,selected:picked.has(id),
        title:(group?groupName(group)+" · ":"")+label+(locked?" · 已锁定":"")+(hidden?" · 已隐藏 · "+restore:""),
        accessible:label+(locked?"，已锁定":"")+(hidden?"，已隐藏，"+restore:""),
        visibility:hidden?(editor.hasHiddenEndpoint(id)?"显示线及端点":"已隐藏 · 显示"):""};
      next.set(id,old&&Object.keys(entry).every(k=>Reflect.get(entry,k)===Reflect.get(old,k))?old:entry);
    }
    renderedLayerPage=layerPage;
    const rows=[...next.values()],before=ui.layers.read();
    layerRows=next;
    if(rows.length!==before.length||rows.some((r,i)=>r!==before[i])){
      present(()=>ui.layers.set(rows));
      if(focusedId)(newBoard?canvas:layerElement(focusedId)??(layerTerm?searchInput:canvas)).focus({preventScroll:true});
    }
  }
  if(follow&&selected)showLayer(selected);
  layersDoc=editor.doc;layerSelection=editor.selectedIds;
  const canLocate=Boolean(selected&&!layerRows.has(selected));
  ui.patch("layer-paging",{hidden:pages<2&&!canLocate});
  ui.patch("layer-page-controls",{hidden:pages<2});
  ui.patch("layer-page-read",{caption:(layerPage+1)+" / "+pages+" 页（"+count+" 层）"});
  ui.patch("layer-newer",{disabled:layerPage===0});
  ui.patch("layer-older",{disabled:layerPage+1>=pages});
  ui.patch("layer-locate",{disabled:!canLocate});
  const message=layerTerm?(map?"整板图层匹配 "+count+" 项":count?"找到 "+count+" 个图层":"未找到匹配图层"):"";
  ui.patch("layer-results",{hidden:!message,caption:message});
}
function wholePathMode(){
  return !paths.mode&&!inkArmed&&!textArmed&&!textOverlay.active&&!mind.active&&!mind.armed&&
    (!flow.mode||flow.mode==="connect")&&!flow.working&&!space&&editor.tool==="select";
}
type GroupAction="group"|"ungroup"|"enter"|"leave";
const groupLabels:Record<GroupAction,string>={group:"创建流程组",ungroup:"取消分组",enter:"编辑组成员",leave:"退出组内编辑"};
const groupKeys:Record<GroupAction,string>={group:"Ctrl/⌘+G",ungroup:"Ctrl/⌘+Shift+G",enter:"Enter",leave:"Esc"};
function availableGroupActions():GroupAction[]{
  const group=editor.editingGroup??editor.selectedGroup;
  if(group){
    const scope:GroupAction=editor.editingGroup?"leave":"enter";
    const unit=groupUnit(editor.doc,group);
    return editor.anyLocked(unit)||unit.some(id=>editor.isHidden(id))?[scope]:[scope,"ungroup"];
  }
  return editor.canGroup?["group"]:[];
}
function invokeGroup(action:GroupAction,member?:Id):boolean{
  if(reopening||textOverlay.active||paths.mode||inkArmed||textArmed||mind.active||mind.armed||flow.working||editor.busy)return false;
  if(action==="enter")return editor.enterGroup(member);
  if(action==="leave")return editor.leaveGroup();
  if(action==="ungroup")return editor.ungroupSelection();
  return editor.groupSelection();
}
function groupName(id:Id):string{
  const first=editor.doc.flowGroups?.members[id]?.[0];
  return first?"流程组 · "+title(editor.doc.objects[first]):"流程组";
}
const auxiliaryProperties:Array<()=>void>=[];
function releaseProperties(){
  inspectorDraft?.dispose();inspectorDraft=undefined;
  for(const release of auxiliaryProperties.splice(0))release();
}
function updateSelectionControls(change?:ChangeSet) {
  releaseProperties();resetPropertyPanel(editor);
  updateLayers(change);
  const item = editor.selectedIds.length===1 && editor.selection ? objectById(editor.doc,editor.selection) : undefined;
  const sections:{key:string;label:string;parts:HTMLElement[]}[]=[],direct:HTMLElement[]=[];
  const inside=node("div",undefined,"object-field-pages");
  auxiliaryProperties.push(bindPropertyForm(editor,inside));
  let owner=JSON.stringify(editor.selectedIds);
  const add=(key:string,label:string,...parts:HTMLElement[])=>{
    const valid=parts.filter(Boolean);if(valid.length)sections.push({key,label,parts:valid});
  };
  const enabled=()=>!reopening&&!textOverlay.active&&!ink.drawing&&!flow.working;
  if(!editor.selectionLocked&&editor.selectedIds.length>1){
    inspectorDraft=selectionProperties(editor);inside.append(inspectorDraft.form);
    for(const group of Array.from(inspectorDraft.form.children) as HTMLElement[]){
      const title=group.children[0]?.textContent??"共同外观";add(title,title,group);
    }
  }else if(item&&!editor.selectionLocked){
    if(isCard(item)||item.kind==="table"){
      inspectorDraft=contentProperties(editor,item,enabled);
      add("geometry","变换",inspectorDraft.form);
    }else if(item.kind==="shape"){
      inspectorDraft=shapeProperties(editor,item,enabled);
      direct.push(downstream.button);
      const [geometry,style]=Array.from(inspectorDraft.form.children) as HTMLElement[],label=nodeForm(item,inside);
      add("geometry","变换",geometry);add("outline","线宽与颜色",style);add("label","节点文字",label);inside.append(label);
    }else if(item.kind==="image"){
      const image=imageProperties(editor,item,enabled);inspectorDraft=image;
      add("geometry","变换",image.form);direct.push(image.actions);
    }else if(item.kind==="connector"){
      const properties=connectorProperties(editor,item,enabled);
      inspectorDraft=properties;direct.push(properties.routes);
      const [label,style]=Array.from(inspectorDraft.form.children) as HTMLElement[],ends=connectorActions(item,inside);
      add("line","连线样式",style);add("label","标签",label);add("ends","端点与折点",ends);inside.append(ends);
    }else if(item.kind==="ink"&&!ink.drawing){
      inspectorDraft=inkProperties(editor,item,enabled);
      const [geometry,paint]=Array.from(inspectorDraft.form.children) as HTMLElement[];
      add("ink","笔迹样式",paint);add("geometry","变换",geometry);
    }else if(item.kind==="path"){
      const canStyle=()=>!reopening&&(wholePathMode()||paths.mode==="anchors"&&!paths.pointer&&!paths.inserting);
      inspectorDraft=pathInspector(editor,item,wholePathMode,canStyle,()=>{const current=editor.doc.objects[item.id];if(current?.kind==="path")beginPathMode(current);});
      const [geometry,style,vertices]=Array.from(inspectorDraft.form.children) as HTMLElement[];
      add("path","路径样式",style);add("geometry","变换",geometry);direct.push(vertices);
    }else if(item.kind==="text"){
      inspectorDraft=textProperties(editor,item,enabled,activeTheme);
      const [geometry,style,colors]=Array.from(inspectorDraft.form.children) as HTMLElement[];
      add("geometry","变换",geometry);
      const details=propertyWidget(inspectorDraft.form,{kind:"disclosure",label:"完整文字属性",parts:[style,colors],className:"advanced-properties"});
      add("actions","更多",details);
    }else if(item.kind==="mindmap"&&(editor.selectedTopics.get(item.id)?.size??0)<2){
      const selected=focusedMapTopic(item),row=selected?topicBox(mind.displayMap(item),selected.topicId):undefined;
      owner=JSON.stringify([item.id,selected?.topicId??null]);
      const properties=mindProperties(editor,item,selected,row,activeTheme,
        ()=>focusedMapTopic(item)?.topicId===selected?.topicId&&!lockControlsBusy()&&!mindDraft,
        {focus:enterMind,rename:ref=>{enterMind(ref);requestTopic();},remove:deleteFocusedTopic});
      inspectorDraft=properties;sections.push(...properties.sections);
    }
    if(inspectorDraft&&!inside.contains(inspectorDraft.form))inside.append(inspectorDraft.form);
    if(item.kind==="text"||item.kind==="image"||item.kind==="ink"){
      const actions=node("div",undefined,"object-utilities");
      const current=()=>inspector.contains(actions)&&editor.selection===item.id&&!editor.selectionLocked;
      for(const [key,label,fn] of [["copy","复制",()=>duplicateStandalone(editor)],["delete","删除",()=>deleteStandalone(editor)],
        ["up","上移一层",()=>moveStandaloneLayer(editor,1)],["down","下移一层",()=>moveStandaloneLayer(editor,-1)]] as const){
        const i=editor.doc.order.indexOf(item.id);
        actionButton(actions,inside,label,()=>{if(current())fn();},{disabled:key==="up"&&i===editor.doc.order.length-1||key==="down"&&i===0}).dataset.action=key;
      }
      if(item.kind==="text")actionButton(actions,inside,"编辑文字",()=>{const t=editor.doc.objects[item.id];if(current()&&t?.kind==="text")startText(t);});
      const more=sections.find(s=>s.key==="actions");
      if(more)more.parts.unshift(actions);else add("actions","操作",actions);
      inside.append(actions);
    }
  }
  const group=availableGroupActions();
  if(group.length){
    const box=node("div",undefined,"standalone-actions");
    for(const action of group){
      const b=actionButton(box,inside,groupLabels[action],()=>{if(invokeGroup(action))canvas.focus({preventScroll:true});});
      b.dataset.groupAction=action;b.title=groupKeys[action];
    }
    add("group","流程组",box);inside.append(box);
  }
  inspector.replaceChildren(inside);formatBar.configure(owner,sections,direct);

}
function focusedMapTopic(map:MindMap):TopicRef|undefined{
  if(mind.selected?.mapId===map.id)return mind.selected;
  const range=editor.selectedTopics.get(map.id);
  if(range?.size===1)return {mapId:map.id,topicId:range.values().next().value!};
}
function actionButton(parent:HTMLElement,owner:HTMLElement,label:string,run:()=>void,options:{disabled?:boolean;title?:string}={}){
  return propertyWidget(parent,{kind:"action",label,run,...options},owner) as HTMLButtonElement;
}
function nodeForm(item:ShapeObject,owner:HTMLElement):HTMLDivElement{
  const block=node("div",undefined,"flow-properties"),form=node("form",undefined,"transform");
  const live=liveProperties(editor,form,()=>inspector.contains(block)&&!textOverlay.active&&!reopening);
  auxiliaryProperties.push(live.dispose);
  const label=propertyWidget(form,{kind:"input",name:"flow-label",label:"节点文字",caption:"节点文字",className:"flat-input"});
  const input=label.querySelector("input")!;input.id="flow-label";
  limitTextInput(input,Math.max(item.label.length,MAX_LABEL_LENGTH));
  live.input(input,"修改节点文字",d=>(d.objects[item.id] as ShapeObject).label,d=>withFlowNodeLabel(d.objects[item.id] as ShapeObject,input.value));
  block.append(form);
  actionButton(block,owner,"删除节点",()=>{if(live.current())deleteFlowSelection(editor);}).dataset.action="delete";
  return block;
}
function connectorActions(item:Connector,owner:HTMLElement):HTMLDivElement{
  const block=node("div",undefined,"flow-properties");
  function run(fn:()=>void){
    if(!inspector.contains(block)||editor.busy||textOverlay.active||reopening||editor.selection!==item.id)return;
    inspectorDraft?.reset();fn();
  }
  block.append(node("h3","端点绑定"));
  for(const field of ["from","to"] as const){
    const endpoint=node("div",undefined,"endpoint-rows"),name=field==="from"?"起点":"终点";
    endpoint.append(node("span",name+" · "+(item[field].kind==="anchor"?"绑定":"自由")));
    actionButton(endpoint,owner,"重绑",()=>run(()=>{setFlowMode("connect");if(flow.beginRebind(item.id,field)){dismissCanvasPanel();updateChrome();invalidate();}}));
    if(item[field].kind==="anchor")actionButton(endpoint,owner,"解绑",()=>run(()=>detachConnectorEnd(editor,item.id,field)));
    block.append(endpoint);
  }
  const waypoints=node("div",undefined,"flow-properties");
  waypoints.append(node("h3","手动拐点"));
  actionButton(waypoints,owner,"添加拐点",()=>run(()=>addWaypoint(editor,item.id)));
  for(let i=0;i<item.waypoints.length;i++){
    const row=node("form",undefined,"waypoint-row"),live=liveProperties(editor,row,()=>inspector.contains(block)&&!textOverlay.active&&!reopening);
    auxiliaryProperties.push(live.dispose);
    row.append(node("span",String(i+1)));
    for(const axis of ["x","y"] as const){
      live.number(row,"pin"+i+axis,"拐点 "+(i+1)+" "+axis.toUpperCase(),d=>(d.objects[item.id] as Connector).waypoints[i][axis],(d,n)=>{
        const line=d.objects[item.id] as Connector;
        return {...line,waypoints:line.waypoints.map((p,k)=>k===i?{...p,[axis]:n}:p)};
      },undefined,undefined,true);
    }
    live.watch(()=>{row.hidden=(editor.doc.objects[item.id] as Connector).routing==="straight";});
    actionButton(row,owner,"删除",()=>run(()=>removeWaypoint(editor,item.id,i)),{title:"删除第 "+(i+1)+" 个手动拐点"});
    waypoints.append(row);
  }
  block.append(waypoints);
  actionButton(block,owner,"删除连线",()=>run(()=>deleteFlowSelection(editor))).dataset.action="delete";
  return block;
}
function updateStatus() {
  if(lifetime.signal.aborted)return;
  const selected=activeCopy??defaultCopy;
  const alternates=alternateCopies(selected),target=writeSlot();
  const auto=recovery?.state==="saved"?"已自动保存到此浏览器":recovery?.state==="pending"?"正在自动保存…":undefined;
  const caption=saving?"保存中…":reopening?"正在打开…":importing?"导入图片…":(recovery?.state==="conflict"?"另一标签页已更新现场，请先导出当前修改，再刷新。":
    recovery?.state==="startup-edited"?"读取上次现场时已有新编辑，请先导出当前修改，再刷新恢复。":
    recovery?.state==="failed"?"自动保存失败，正在重试。可导出工程备份。":
    recovery?.state==="unavailable"?"现场存储不可用，可手动保存或导出工程。":undefined) ?? (savedHint&&auto?savedHint+" · "+auto:savedHint) ?? (
    bridgePage?(editor.dirty?"CLI 会话 · 磁盘有待保存的修改":"CLI 会话 · 已从磁盘同步"):
    storageRead==="checking"?"正在检查本地画板…":
    !hasStorage?"浏览器无法持久保存，请导出项目":
    saveConflict?"另一标签页已保存；请先导出当前修改，再重开":
    storageRead==="failed"?"本地画板读取失败，可重试打开或导出当前项目":
    requireChoice&&!activeCopy?(unreadableCopy?"有本地副本无法核对，请选择打开":"发现不同的本地副本，请选择打开"):
    auto?auto:
    unopenedLocalBoard?"已有本地画板，覆盖前会询问":
    (editor.doc.schemaVersion===6||importedVersion===6)&&!localCopies?.hasIndexed()?"浏览器不能保存表格副本，请导出项目":
    activeCopy&&target==="table"&&activeCopy!==target?(localCopies!.vacant("table")?"首次保存会另建表格副本，保留原件":"表格副本已有数据或无法核对，请重开或导出"):
    (editor.doc.schemaVersion===5||importedVersion===5)&&!localCopies?.hasIndexed()?"浏览器不能保存流程组副本，请导出项目":
    activeCopy&&target==="group"&&activeCopy!==target?(localCopies!.vacant("group")?"首次保存会另建流程组副本，保留原件":"流程组副本已有数据或无法核对，请重开或导出"):
    (editor.doc.schemaVersion===4||importedVersion===4)&&!localCopies?.hasIndexed()?"浏览器不能保存曲线副本，请导出项目":
    activeCopy&&target==="curve"&&activeCopy!==target?(localCopies!.vacant("curve")?"首次保存会另建曲线副本，保留其他版本":"曲线副本已有数据或无法核对，请重开或导出"):
    (editor.doc.schemaVersion===3||importedVersion===3)&&!localCopies?.hasIndexed()?"浏览器不能保存路径副本，请导出项目":
    activeCopy&&target==="path"&&activeCopy!==target?(localCopies!.vacant("path")?"首次保存会另建路径副本，保留原件":"路径副本已有数据或无法核对，请重开或导出"):
    editor.doc.schemaVersion===2&&!localCopies?.hasIndexed()?"浏览器不能保存手写副本，请导出项目":
    activeCopy&&activeCopy!==writeSlot()&&localCopies?.hasIndexed()&&!localCopies!.vacant(writeSlot()==="ink"?"ink":"protected")?(writeSlot()==="ink"?"手写副本已存在，请打开它或导出当前画板":"旧副本可以查看或导出，不会覆盖当前副本"):
    activeCopy&&activeCopy!==writeSlot()&&localCopies?.hasIndexed()?(writeSlot()==="ink"?"首次保存会另建手写副本，保留原件":"旧副本；首次保存会另建当前副本"):
    editor.dirty?"未保存":"已保存到此浏览器");
  ui.patch("status",{caption,title:caption,"data-workspace":recovery?.state});
  ui.patch("save",{disabled:Boolean(reopening||ink.drawing||(bridgePage?!liveCommands:!canSaveLocally())),
    ...(bridgePage?{title:"保存到工程文件（Ctrl+S）","aria-label":"保存到工程文件"}:{})});
  const labeled=Boolean(alternates.length&&selected);
  ui.patch("open",{disabled:reopening||storageRead==="checking"||!selected,caption:labeled?copyLabels[selected!]:"重开",
    title:labeled?"打开本地"+copyLabels[selected!]:"打开当前使用的本地画板"});
  for(const [index,button] of alternateButtons.entries()){
    const slot=alternates[index];
    ui.patch(button.id,{hidden:!slot,disabled:reopening||storageRead==="checking",
      ...(slot?{caption:copyLabels[slot],title:"打开本地"+copyLabels[slot]}:{})});
  }
  ui.patch("project-open",{disabled:reopening||bridgePage});
  ui.patch("project-export",{disabled:reopening});
  ui.patch("tool-image",{disabled:reopening});
}
function setPressed(id:string,pressed:boolean){ui.patch(id,{selected:pressed});}
function dragSnapHint():string{
  if(!snapMoves)return editor.draggingCopies?"拖动副本 · 松手放置 · Esc 取消":"自由拖动 · Esc 取消";
  if(editor.alignmentBypassed)return "吸附已暂停 · 松开 Alt / Option 恢复 · Esc 取消";
  const labels:string[]=[];
  for(const axis of ["x","y"] as const){
    const guide=editor.alignmentGuides?.find(g=>g.axis===axis);
    if(!guide)continue;
    if(guide.kind==="spacing")labels.push((axis==="x"?"水平间距 ":"垂直间距 ")+guide.label);
    else{
      const anchors=axis==="x"?["左边","竖直中线","右边"]:["顶边","水平中线","底边"];
      labels.push(guide.source===guide.edge?anchors[guide.source]+"对齐":anchors[guide.source]+"贴"+anchors[guide.edge]);
    }
  }
  const alignment=labels.join(" · ")||"未吸附";
  return editor.draggingCopies?"拖动副本 · "+alignment+" · Esc 取消":alignment+" · 按住 Alt / Option 暂停吸附 · Esc 取消";
}
function updateChrome() {
  placement.arm(textArmed?(tableArmed?"table":cardArmed??"text"):flow.shapeTool);
  inspectorDraft?.syncMode?.();
  const drawing=paths.mode==="draw",editingAnchors=paths.mode==="anchors";
  setPressed("tool-path",drawing);
  ui.patch("path-tools",{hidden:!paths.mode||textOverlay.active});
  const finishCaption=editingAnchors?"完成编辑":"完成开放路径";
  ui.patch("path-finish",{caption:finishCaption,shortcut:!paths.inserting,title:paths.inserting?finishCaption:dockTitle("path-finish",finishCaption,appleKeys),
    disabled:Boolean(paths.pointer)||drawing&&paths.points.length<2});
  ui.patch("path-segment-label",{hidden:!editingAnchors});
  ui.patch("path-convert",{hidden:!editingAnchors,disabled:Boolean(paths.pointer)||paths.inserting,caption:paths.curved?"转为直线":"转为曲线"});
  ui.patch("path-part",{hidden:!editingAnchors||!paths.curved,disabled:Boolean(paths.pointer)||paths.inserting,value:paths.part});
  ui.patch("path-insert",{hidden:!editingAnchors,selected:paths.inserting,disabled:Boolean(paths.pointer)||!paths.canInsert,
    title:paths.canInsert?dockTitle("path-insert","切换插点，插点时按 Enter 在选中段的中点插入"):"已达到路径或画板顶点上限"});
  ui.patch("path-segment",{disabled:Boolean(paths.pointer),...(editingAnchors?{max:String(paths.segmentCount)}:{})});
  if(editingAnchors&&document.activeElement!==segmentPicker)segmentPicker.value=String(paths.segment+1);
  ui.patch("path-close",{hidden:!drawing,disabled:Boolean(paths.pointer)||paths.points.length<3});
  setPressed("tool-ink",inkArmed);setPressed("ink-finger",fingerInk);inkTools.sync(ink.erasing);
  ui.patch("ink-tools",{hidden:!inkArmed||textOverlay.active});
  setPressed("tool-select",editor.tool==="select"&&!drawing&&!inkArmed&&!textArmed&&!flow.mode&&!mind.armed&&!mind.active);
  setPressed("tool-hand",editor.tool==="hand"&&!textArmed);
  setPressed("tool-connect",flow.mode==="connect");
  setPressed("tool-shapes",Boolean(flow.mode&&flow.mode!=="connect"));
  setPressed("tool-mind",mind.armed||mind.active);
  const focused=mind.selected, map=focused&&getMap(editor,focused.mapId), topic=map&&focused?map.topics[focused.topicId]:undefined;
  ui.patch("mind-tools",{hidden:!topic});
  ui.patch("mind-sibling",{disabled:Boolean(map&&topic?.id===map.rootId)});
  ui.patch("mind-fold",{disabled:!topic?.childIds.length,caption:topic?.collapsed?"展开":"折叠"});
  ui.patch("tool-shapes",{"aria-expanded":paletteOpen});
  ui.patch("shape-palette",{hidden:!paletteOpen});
  const box=selectionBox();
  const selectedPin=flow.selectedWaypoint;
  const selectedObject=editor.selectedIds.length===1&&editor.selection?editor.doc.objects[editor.selection]:undefined;
  const guidance=downstream.hint??(textOverlay.active?"点其他位置完成编辑 · Esc 取消":
    drawing?(paths.points.length===MAX_PATH_VERTICES?"已达到顶点上限，请完成路径":"逐点放置 · Enter 完成开放路径 · 点起点闭合 · Esc 取消"):
    paths.inserting?"点线上位置插入，避开端点 · Enter 取选中段中点 · Esc 取消":
    editingAnchors?"点线选段 · 方点移动顶点，圆点调整曲线 · I 插入顶点":
    editor.draggingObjects&&editor.preview?dragSnapHint():
    editor.resizingText&&box?.kind==="text"?`行宽 ${Number(box.width.toFixed(2))} · 松手应用 · Esc 取消`:
    editor.pathTransforming?(editor.pathGestureHint??""):
    editor.rotating&&box?`旋转 ${Math.round(box.rotation*180/Math.PI)}° · Shift 每 15° 吸附 · Esc 取消`:
    ink.panning?"中键平移中 · 松开继续书写":
    inkArmed?(ink.erasing||inkTools.eraser?"划过笔迹即可擦除整笔 · Esc 取消":"压感随轻重，普通输入使用所选线宽")+" · 中键平移 · "+(fingerInk?"单指书写，双指缩放":"手指平移/缩放"):
    mind.armed?"点画布放置脑图":
    mind.active&&topic?.id===map?.rootId?"直接输入改名 · Tab 新增分支 · 拖动根节点移动整图":
    mind.active?"直接输入改名 · Tab 子主题 · Enter 同级"+(topic&&map?.topics[map.rootId].childIds.includes(topic.id)?" · 上下拖动排序，跨根换侧":" · 拖到节点中部改挂，上下缘排序"):
    flow.drop?"选择终点节点 · Esc 仅保留连线":
    flow.pending?.kind==="rebind"?"点附近图形绑定端点，或点空白设为自由端":
    flow.pending?.kind==="new"?(flow.pending.route==="straight"?"点一下直线终点":flow.mode==="connect"?"点附近图形连接，或点空白补一个流程框":"点附近图形连接，或点空白留下自由端"):
    flow.pointer?.action.kind==="rebind"?"靠近图形吸附端口 · 拖至空白留下自由端 · Esc 取消":
    flow.pointer?.action.kind==="new"&&flow.pointer.action.route!=="straight"?"靠近图形吸附端口 · 在空白处松手选择节点 · Esc 取消":
    flow.pointer?.action.kind==="waypoint"?"拖动手动拐点 · 松手应用 · Esc 取消":
    selectedPin?"已选手动拐点 "+(selectedPin.index+1)+" · Delete 删除 · Esc 取消选择":
    flow.mode==="connect"?"从端口拖向附近图形 · 触屏可依次点起点和终点":
    flow.mode==="line"?"拖出自由直线，或分别点起点和终点":
    flow.mode?"拖出图形大小，或点一下放置默认大小":
    editor.editingGroup?"组内编辑 · Esc 返回整组":
    editor.doc.flowGroups&&editor.selectedGroup?"拖动整组 · 双击成员或按 Enter 进入组内":
    selectedObject?.kind==="connector"&&selectedObject.routing==="orthogonal"&&!editor.selectionLocked?
      (selectedObject.waypoints.length?"方形是手动拐点 · 右键可删除 · 其余折弯由走线自动生成":"自动折线 · 双击线段添加手动拐点"):
    cardArmed?"点画布放置"+cardName(cardArmed):
    tableArmed?"点画布放置表格":
    box?.kind==="table"?(tables.range?"直接输入编辑 · Shift 点选范围 · 拖格线调行高列宽":"拖格线调行高列宽 · 拖表体移动 · 拖四角缩放"):
    box?.kind==="text"?"直接输入或双击编辑 · 拖左右手柄改变行宽":
    box?.kind==="path"?"拖角点等比缩放 · 拖圆柄旋转 · 编辑顶点可调整局部轮廓":
    isCard(box)?"点文字编辑 · 拖动移动 · 拖角点调整大小":box?.kind==="shape"?"直接输入改名 · Tab 连接下一步 · 拖圆柄旋转":box?"拖圆柄旋转 · Shift 每 15° 吸附":"");

  ui.patch("flow-help",{hidden:!guidance,caption:guidance});
  setPressed("tool-text",textArmed&&!tableArmed&&!cardArmed);
  setPressed("tool-document",cardArmed==="markdown");
  setPressed("tool-sticky",cardArmed==="sticky");
  ui.patch("document-tools",{hidden:cardArmed!=="markdown"});
  setPressed("tool-table",tableArmed);
  ui.patch("layers-panel",{inert:ink.drawing});
  const tableAxis=editor.resizingTableAxis;
  canvas.style.cursor=tableAxis?(tableAxis==="row"?"row-resize":"col-resize"):ink.panning?"grabbing":editor.draggingCopies?"copy":paths.mode?(paths.pointer&&editingAnchors&&!paths.inserting?"grabbing":"crosshair"):editor.resizingText&&box?.kind==="text"?textWidthCursor(box.rotation):editor.transforming?"grabbing":inkArmed?inkTools.cursor:textArmed?"text":mind.armed||flow.mode||flow.pointer?"crosshair":editor.preview?"move":editor.tool==="hand"||space?"grab":"default";
  const undoDisabled=!editor.canUndo&&!textOverlay.active,redoDisabled=!editor.canRedo;
  ui.patch("undo",{disabled:undoDisabled,title:undoDisabled&&editor.history.past.length?dockTitle("undo","解锁相关图层后可撤销",appleKeys):undoTitle});
  ui.patch("redo",{disabled:redoDisabled,title:redoDisabled&&editor.history.future.length?dockTitle("redo","解锁相关图层后可重做",appleKeys):redoTitle});
  const restricted=lockControlsBusy(),ids=editor.selectedIds;
  ui.patch("layer-hide",{disabled:restricted||!ids.length});
  ui.patch("layer-show-all",{hidden:!editor.hiddenIds.size,disabled:restricted});
  ui.patch("layer-unlock",{hidden:!editor.selectionLocked,disabled:restricted});
  ui.patch("layer-lock",{hidden:ids.length>0&&editor.lockedSelectionCount===ids.length,disabled:!ids.length||restricted});
  ui.patch("zoom-read",{caption:editor.camera.zoom<.01?"<1%":Math.round(editor.camera.zoom*100)+"%"});
  updateStatus();
}
let previousDoc=editor.doc;
let previousDrag=false,writingInk=false;
let holdingExitImages=false;
let paintedLayout:ReadonlyMap<Id,BoardObject>|undefined;
let previousTopics:typeof editor.selectedTopics|undefined;
let previousSelection:readonly string[]|undefined,previousLocks=-1,previousVisibility=-1;
cleanups.push(editor.listen(change=>{
  if(previousDoc!==editor.doc){
    const animate=change&&previousDoc.id===editor.doc.id&&motionPreference?.matches&&!document.hidden&&width&&height;
    const old=animate?motion.capture(change,id=>projector.group(id,scenePatch),id=>projector.paintOrder(id)):undefined;
    if(sceneDoc!==editor.doc){projector.update(editor.doc,change);sceneDoc=editor.doc;scenePatchDirty=true;}
    if(old&&change){
      const region=rectBetween(screenToWorld({x:-32,y:-32},editor.camera),screenToWorld({x:width+32,y:height+32},editor.camera));
      motion.transition(previousDoc,editor.doc,change,old,id=>projector.group(id),region,performance.now(),previousDrag,writingInk,committingTopic,paintedLayout);
    }else motion.clear();
    scenePatchDirty=true;
  }
  previousDrag=Boolean(editor.preview||paths.preview);
  if(previousDoc!==editor.doc||previousSelection!==editor.selectedIds||previousLocks!==editor.lockRevision||
    previousVisibility!==editor.visibilityRevision||!wholePathMode()||editor.busy)downstream.cancel();
  tables.sync();
  paths.sync();mind.sync();
  if (previousDoc!==editor.doc) {
    recovery?.changed();
    savedHint=undefined;
    vault.retain(referencedAssetIds(editor));
    const activeAssets=new Set(Object.keys(editor.doc.assets)),departing=motion.departingImageAssets;
    holdingExitImages=false;
    for(const id of departing)if(!activeAssets.has(id)){holdingExitImages=true;activeAssets.add(id);}
    imageCache.retain(activeAssets);
  }
  projector.setHidden(editor.hiddenIds);
  updateChrome();
  const changedSelection=previousSelection!==editor.selectedIds||previousTopics!==editor.selectedTopics||previousLocks!==editor.lockRevision||previousVisibility!==editor.visibilityRevision;
  if(changedSelection||previousDoc!==editor.doc&&!publishingProperty(editor))updateSelectionControls(change);
  else if(previousDoc!==editor.doc)updateLayers(change);
  previousTopics=editor.selectedTopics;
  previousVisibility=editor.visibilityRevision;
  previousLocks=editor.lockRevision;previousDoc=editor.doc; previousSelection=editor.selectedIds;
  invalidate();
}));
function updateScene(){
  const changed=sceneDoc!==editor.doc;
  if(changed){projector.update(editor.doc);sceneDoc=editor.doc;}
  projector.setHidden(editor.hiddenIds);
  const preview=paths.preview??editor.preview;
  const revealed=mind.revealed;
  if(changed||scenePatchDirty||scenePreview!==preview||lastSceneDraft!==mindDraft||lastRevealed!==revealed){
    const objects=motion.objects.size?new Map([...motion.objects,...(preview?.objects??[])]):preview?.objects;
    const moving=revealed&&objects?.get(revealed.id);
    const shown=mindDraft?mind.displayMap(mindDraft.map,mindDraft.topicId):moving?.kind==="mindmap"?mind.displayMap(moving):revealed;
    const override=shown?{objects:new Map(objects).set(shown.id,shown),extra:mindDraft&&!mindDraft.before?[shown.id]:[]}:
      objects&&motion.objects.size?{...preview,objects}:preview;
    const previousPatch=scenePatch;
    scenePatch=projector.overlay(motion.topics.active?{objects:override?.objects??new Map(),extra:override?.extra,topicLayouts:motion.topics.layouts}:override);
    if(editor.marquee&&(changed||previousPatch!==scenePatch))editor.invalidateMarqueeHits();
    scenePreview=preview;lastSceneDraft=mindDraft;lastRevealed=revealed;scenePatchDirty=false;
  }
}
function prepareObjectDrag(ids:readonly Id[],camera:Camera,copy:boolean):DragSetup|undefined{
  const region={min:screenToWorld({x:0,y:0},camera),max:screenToWorld({x:width,y:height},camera)};
  if(copy){
    try{
      const copies=prepareDragCopies(editor,ids,vault);
      return copies?projector.prepareCopyDrag(copies,region,camera.zoom):undefined;
    }catch(error){clipboardFailure("无法复制所选对象",error);return;}
  }
  return projector.prepareDrag(ids,region,camera.zoom,undefined,motion.objects,scenePatch);
}
function dragAlt(event:MouseEvent|KeyboardEvent){
  return event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.getModifierState?.("AltGraph");
}
function bypassAlignment(event:MouseEvent|KeyboardEvent){
  return !snapMoves||!editor.draggingCopies&&dragAlt(event);
}
function flowCandidates(bounds:Rect){
  updateScene();
  // Use canonical poses; draft overlays belong to other tools and cannot bind ports.
  return projector.query(bounds).flatMap(({id})=>objectById(editor.doc,id)?.kind==="shape"?[id]:[]);
}
function displayPatch(){
  updateScene();
  return scenePatch;
}
function hitCanvasMarquee(box:Rect,topics:Map<Id,Set<Id>>){
  return marqueeHit(projector.query(box,displayPatch()),box,topics);
}
function visibleScene(selected:readonly string[],patch?:ReadonlyMap<Id,DrawGroup>){
  const rect=rectBetween(screenToWorld({x:-32,y:-32},editor.camera),screenToWorld({x:width+32,y:height+32},editor.camera));
  const scene=projector.query(rect,patch??displayPatch(),selected);
  return erasedInk.size?scene.filter(group=>!erasedInk.has(group.id)):scene;
}
function selectionBox(){
  // Idle Connect permits box handles; a pending line owns its gesture.
  const ids=editor.draggingObjects&&editor.preview?editor.preview.ids:editor.selectedIds;
  if(!wholePathMode()||ids.length!==1||editor.isLocked(ids[0]))return;
  const id=ids[0];
  const item=editor.preview?.objects.get(id)??motion.objects.get(id)??objectById(editor.doc,id);
  if(resizable(item))return item;
  if(item?.kind==="text"&&!flow.mode)return {...item,...textFrame(item)};
  if(item?.kind==="path"){
    const frame=pathFrame(item);
    return {id,kind:item.kind,...(editor.pathGestureBox??pathHandleBox(frame,editor.camera)),outline:pathStrokeBox(frame,item.strokeWidth)};
  }
}
function boxHandleAt(screen:Point,touch=false,shift=false,allowDivider=true):BoxHandle|undefined{
  const item=selectionBox();
  if(item?.kind==="text"){
    const textEdge=hitTextWidthGrip(item,editor.camera,screen,touch,{width,height});
    if(textEdge)return {id:item.id,textEdge};
  }else if(item){
    if(item.kind!=="table"&&hitRotationHandle(item,editor.camera,screen,touch))return {id:item.id,rotate:true};
    const corner=hitResizeHandle(item,editor.camera,screen,touch);
    if(corner)return {id:item.id,corner,lockRatio:shift||(item.kind==="image"&&item.lockAspect!==false)};
  }
  if(!allowDivider||shift||editor.doc.schemaVersion!==6||editor.selectedIds.length>1||!wholePathMode())return;
  const {near,point,hit}=pickArea(screen,touch),front=hit?.group.id;
  for(let i=near.length-1;i>=0;i--){
    const id=near[i].id,table=editor.doc.objects[id];
    if(table?.kind==="table"&&!editor.isLocked(id)){
      const divider=hitTableDivider(table,point,(touch?9:5)/editor.camera.zoom);
      if(divider)return {id,divider};
    }
    // The outermost divider also responds just outside the table, up to any object above it.
    if(id===front)break;
  }
}
function handleCursor(handle:BoxHandle):string{
  if("divider" in handle)return handle.divider.axis==="row"?"row-resize":"col-resize";
  if("rotate" in handle)return "grab";
  const box=selectionBox();
  if("textEdge" in handle)return textWidthCursor(box?.rotation??0);
  if(box?.kind!=="path")return handle.corner==="nw"||handle.corner==="se"?"nwse-resize":"nesw-resize";
  const corner=cornerPoint(box,handle.corner);
  const angle=Math.atan2(corner.y-box.at.y-box.height/2,corner.x-box.at.x-box.width/2);
  return ["ew-resize","nwse-resize","ns-resize","nesw-resize"][(Math.round(angle/(Math.PI/4))+4)%4];
}
function pointerOutline():HoverOutline|undefined{
  if(!hoverPoint||editor.busy||editor.tool!=="select"||space||reopening||inkArmed||textArmed||textOverlay.active||
    paths.mode||mind.armed||mind.pointer||flow.working||flow.mode&&flow.mode!=="connect"||downstream.scope)return;
  const hit=pickArea(hoverPoint,false).hit;
  if(!hit)return;
  const id=flowGroupOf(editor.doc,hit.group.id),visibility=editor.visibilityRevision;
  if(id&&id!==editor.editingGroup){
    const members=groupUnit(editor.doc,id);
    return {owner:members,visibility,parts:()=>members.flatMap(member=>projector.group(member,scenePatch)??[])};
  }
  return {owner:hit.group,topic:hit.topicId,visibility,parts:()=>[hitOutline(hit)]};
}
function flowFeedback(){
  return flow.shapeTool||downstream.scope||editor.marquee||paths.mode||inkArmed||textArmed||textOverlay.active||editor.preview||motion.objects.size&&!flow.working||space||editor.tool==="hand"||mind.active||mind.armed?
    undefined:flow.decor({width,height});
}
function passiveFlow(){return !flow.mode&&!flow.working;}
function requestPointerFeedback(){
  frameMeter.request();
  requestDisplay();
}
function invalidate(){
  if(lifetime.signal.aborted)return;
  frameMeter.request();
  repaintMain=true;
  requestDisplay();
}
function displayFrame(timestamp:number){
    if(!pace.ready(Number.isFinite(timestamp)?timestamp:performance.now())){requestDisplay();return;}
    const frameRequest=frameMeter.started();
    if(!repaintMain){
      const decor=passiveFlow()?flowFeedback():undefined;
      const updated=pointerFeedback.draw(pointerOutline(),decor,editor.camera,activeTheme,width,height,ratio);
      const preview=Boolean(decor?.draft&&decor.arrow);
      if(passiveFlow()&&hoveringConnection!==preview){hoveringConnection=preview;placeOverlay(preview);}
      if(updated)frameMeter.rendered(timestamp,frameRequest,pace.expectedGap());
      return;
    }
    repaintMain=false;
    const traceStart=performance.now(),sharpen=sharpenNext;
    sharpenNext=false;
    if(motion.active&&motion.tick(Number.isFinite(timestamp)?timestamp:performance.now()))scenePatchDirty=true;
    const dpr=window.devicePixelRatio||1;
    if(width&&height&&dpr!==ratio){ratio=dpr;view.size(width,height,dpr);}
    placement.paint(editor.camera,space||editor.busy||reopening,flow.shapePointer);
    const copying=editor.draggingCopies&&Boolean(editor.preview);
    // Keep the latest stroke available for copy and undo without painting a
    // selection frame across the next line of handwriting.
    const selected=inkArmed||textOverlay.active||mind.active&&!copying?[]:(editor.preview?.ids??editor.selectedIds);
    const editing=mindDraft?{objectId:mindDraft.map.id,topicId:mindDraft.topicId}:
      textOverlay.id?{objectId:textOverlay.id,cell:tables.editing,card:Boolean(textOverlay.card)}:undefined;
    const paintedImages=new Set<Id>();
    const outlined=editor.selectedTopics.size?selected.filter(id=>!editor.selectedTopics.has(id)):selected;
    const proposed=downstream.poses;
    paintedLayout=proposed&&new Map(proposed.map(item=>[item.id,item]));
    const flowDecor=flowFeedback(),passive=passiveFlow();
    const mindDecor=textOverlay.active||copying||inkArmed?undefined:mind.decor();
    const resize=downstream.scope||editor.marquee?undefined:selectionBox();
    const camera=editor.camera,old=priorPaint;
    const stable=old?.doc===editor.doc&&old.visibility===editor.visibilityRevision&&old.width===width&&old.height===height&&
      old.ratio===ratio&&old.theme===activeTheme;
    const cameraChanged=old?.camera!==camera;
    const canDamage=!motion.active&&!editing&&!editor.marquee&&!paths.mode&&!ink.drawing&&!erasedInk.size&&!mind.pointer&&
      (passive||!flowDecor)&&!downstream.patch&&!editor.alignmentGuides?.length&&!mindDecor?.range?.length&&!mindDecor?.drop;
    const sampleBitmap=(image:Id)=>{paintedImages.add(image);return imageCache.get(image);};
    updateScene();
    if(!stable||old.patch!==scenePatch)cameraRaster.clear();
    const traceScene=performance.now();
    let content:ReturnType<CameraRaster["paint"]>,damage:Rect|undefined,drag:Rect|undefined;
    const large=editor.doc.order.length>=120;
    if(large&&stable&&cameraChanged&&canDamage&&!scenePatch.size&&resize?.kind!=="text"&&!editor.preview){
      content=cameraRaster.paint(camera,width,height,ratio,activeTheme,region=>projector.query(region),sampleBitmap,paintedImages);
      if(content){
        clearTimeout(cameraSettle);
        cameraSettle=setTimeout(()=>{
          cameraSettle=undefined;sharpenNext=true;repaintMain=true;requestDisplay();
        },120);
      }
    }
    const traceCache=performance.now();
    if(large&&canDamage&&stable&&!cameraChanged&&old.canDamage&&old.selection===editor.selectedIds&&editor.draggingObjects&&editor.preview){
      for(const id of scenePatch.keys()){
        const next=scenePatch.get(id),before=projector.group(id);
        if(next)drag=mergeBounds(drag,next.bounds);
        if(!old.drag&&before)drag=mergeBounds(drag,before.bounds);
      }
      if(drag){
        const total=old.drag?mergeBounds(drag,old.drag):drag;
        const a=worldToScreen(total.min,camera),b=worldToScreen(total.max,camera);
        const min={x:Math.max(0,Math.floor((a.x-52)*ratio)/ratio),y:Math.max(0,Math.floor((a.y-52)*ratio)/ratio)};
        const max={x:Math.min(width,Math.ceil((b.x+52)*ratio)/ratio),y:Math.min(height,Math.ceil((b.y+52)*ratio)/ratio)};
        if(max.x>min.x&&max.y>min.y&&(max.x-min.x)*(max.y-min.y)<width*height*.38){
          damage={min,max};
          for(const image of old.assets)paintedImages.add(image);
        }
      }
    }
    if(!content&&cameraSettle!==undefined){clearTimeout(cameraSettle);cameraSettle=undefined;}
    const visible=damage?projector.query({
      min:screenToWorld({x:damage.min.x-32,y:damage.min.y-32},camera),
      max:screenToWorld({x:damage.max.x+32,y:damage.max.y+32},camera)
    },scenePatch,selected):content?selected.flatMap(id=>projector.group(id,scenePatch)??[]):visibleScene(selected,downstream.patch);
    const displayed=motion.active?motion.drawList(visible,id=>projector.paintOrder(id)):visible;
    const traceQuery=performance.now();
    const frame=view.draw(displayed,camera,downstream.scope??outlined,editor.marquee,sampleBitmap,editing,passive?undefined:flowDecor,
      mindDecor,resize,ink.preview,paths.decor(),editor.alignmentGuides,motion.active?motion.paint:undefined,{content,damage});
    const traceCanvas=performance.now();
    priorPaint={camera,doc:editor.doc,patch:scenePatch,visibility:editor.visibilityRevision,selection:editor.selectedIds,
      width,height,ratio,theme:activeTheme,assets:paintedImages,drag,canDamage:canDamage&&!content};
    imageCache.updateVisible(paintedImages,vault);
    if(holdingExitImages&&!motion.active){imageCache.retain(new Set(Object.keys(editor.doc.assets)));holdingExitImages=false;}
    pointerFeedback.draw(pointerOutline(),passive?flowDecor:undefined,editor.camera,activeTheme,width,height,ratio);
    hoveringConnection=Boolean(flowDecor?.draft&&flowDecor.arrow);
    placeOverlay(hoveringConnection);
    if(frame&&!downstream.scope&&!textOverlay.active&&!inkArmed){
      const count=editor.marquee?editor.marqueeElementCount(hitCanvasMarquee):
        editor.preview?outlined.length+(mindDecor?.range?.length??0):editor.selectedElementCount;
      const rect=viewport.getBoundingClientRect();
      placeSelectionCount(selectionBadge,frame,count,overlayViewport(rect),rect,selectionObstacles);
    }else selectionBadge.hidden=true;
    if(menuDrop)placeArrange();
    frameTrace.record(timestamp,frameRequest,{start:traceStart,scene:traceScene,cache:traceCache,query:traceQuery,canvas:traceCanvas,end:performance.now()},
      {phase:cameraChanged?(old&&old.camera.zoom!==camera.zoom?"zoom":"pan"):editor.draggingObjects?"drag":sharpen?"settle":"edit",
        paint:content?"bitmap":damage?"damage":"full",cache:content?cameraRaster.work:"none",zoom:camera.zoom,
        canvasGroups:displayed.length,cacheGroups:content?cameraRaster.queriedGroups:0,selected:selected.length});
    frameMeter.rendered(timestamp,frameRequest,pace.expectedGap());
    if(motion.active)invalidate();
}
function overlayViewport(rect:DOMRect):ScreenArea{
  const visual=window.visualViewport;
  const x=visual?visual.offsetLeft-rect.left:0, y=visual?visual.offsetTop-rect.top:0;
  return {
    left:Math.max(0,x),top:Math.max(0,y),
    right:Math.min(unobstructedWidth(),x+(visual?.width??width)),
    bottom:Math.min(height,y+(visual?.height??height)),
  };
}
function placeOverlay(previewingConnection=false){
  if(previewingConnection||editor.marquee){formatBar.hide();return;}
  const external=formatBar.activeTarget();
  formatBar.propertiesEnabled=!textOverlay.active;
  if(!external&&!textOverlay.active&&(!editor.selectedIds.length||editor.selectionLocked)){formatBar.hide();return;}
  const rect=viewport.getBoundingClientRect(),available=overlayViewport(rect);
  textOverlay.place(editor.camera,available,activeTheme,textOverlay.card?view.labelBackdrop(textOverlay.card.item.id):undefined);
  const dockTop=Math.min(...Array.from(bottomControls,el=>!el.getClientRects().length
    ?height:el.getBoundingClientRect().top-rect.top));
  const barSpace={...available,bottom:Math.min(available.bottom,dockTop-6)};
  formatBar.docked=Boolean(panel&&compactPanels?.matches);
  formatBar.sheet=compactProperties.matches;
  formatBar.sheetRight=formatBar.sheet?diagnosticsToggle.getBoundingClientRect().left-rect.left-4:undefined;
  const zoom=required("view-zoom").getBoundingClientRect();
  formatBar.occupied={left:zoom.left-rect.left,right:zoom.left+zoom.width-rect.left,top:zoom.top-rect.top,bottom:zoom.top+zoom.height-rect.top};
  if(external){
    const frame=textOverlay.card?.frame.getBoundingClientRect();
    const anchor=frame?{left:frame.left-rect.left,top:frame.top-rect.top,right:frame.right-rect.left,bottom:frame.bottom-rect.top}:external.anchor;
    formatBar.show(external.target,anchor,barSpace);return;
  }
  const id=editor.selection;
  const selected=id&&(editor.preview?.objects.get(id)??motion.objects.get(id)??editor.doc.objects[id]);
  if(!textOverlay.active&&editor.selectedIds.length===1&&selected&&selected.kind==="shape"&&!isCard(selected)&&editor.tool==="select"&&!editor.selectionLocked&&!editor.isHidden(selected.id)&&
    !reopening&&!textArmed&&!inkArmed&&!mind.armed&&!mind.active&&!paths.mode&&!flow.working){
    const camera=editor.camera,bounds=boxBounds(selected),a=worldToScreen(bounds.min,camera),b=worldToScreen(bounds.max,camera);
    const handles=[rotationHandle(selected,camera).knob,...RESIZE_CORNERS.map(c=>worldToScreen(cornerPoint(selected,c),camera)),
      ...PORT_IDS.map(p=>worldToScreen(portWorld(selected,selected.shape,p),camera))];
    const generation=editor.generation;
    formatBar.showShape({id:selected.id,fill:selected.fill,stroke:selected.stroke,focus:()=>canvas.focus({preventScroll:true}),apply(key,color,gesture){
      const item=editor.doc.objects[selected.id];
      if(item?.kind!=="shape"||editor.selection!==item.id||editor.selectedIds.length!==1||editor.generation!==generation||editor.selectionLocked||editor.busy||textOverlay.active)return;
      const changes=planShapeTransform(editor.doc,item,{x:item.at.x,y:item.at.y,shapeStyle:{rotation:item.rotation,strokeWidth:item.strokeWidth??DEFAULT_SHAPE_STROKE,[key]:color}});
      if(changes?.size){inspectorDraft?.reset();editor.commitEdit({label:key==="fill"?"设置形状填充":"设置形状边框色",patches:movePatches(changes)},generation,undefined,undefined,formatSeries(gesture,editor.history));}
    }},{left:a.x,top:Math.min(a.y,handles[0].y-5),right:b.x,bottom:Math.max(b.y,handles[0].y+5)},barSpace,handles);return;
  }
  if(!textOverlay.active&&!reopening&&!textArmed&&!inkArmed&&!flow.working&&!editor.draggingCopies&&
    (editor.selectedIds.length>1||selected&&selected.kind!=="text"&&selected.kind!=="shape")){
    const camera=editor.camera,topic=selected&&selected.kind==="mindmap"&&focusedMapTopic(selected);
    const row=topic&&selected&&selected.kind==="mindmap"?topicBox(mind.displayMap(selected),topic.topicId,motion.topics.liveRows(selected.id)):undefined;
    const bounds=row?boxBounds(row.box):projector.selectedBounds(editor.selectedIds,displayPatch());
    if(bounds&&formatBar.hasTools){
      const a=worldToScreen(bounds.min,camera),b=worldToScreen(bounds.max,camera);
      const box=selectionBox(),handles=box&&box.kind!=="table"?[rotationHandle(box,camera).knob]:[];
      formatBar.showObject({left:a.x,top:Math.min(a.y,...handles.map(h=>h.y-5)),right:b.x,bottom:b.y},barSpace,handles);return;
    }
  }
  const item=textFormatDraft??(!textOverlay.active&&selected&&selected.kind==="text"?selected:undefined);
  if(!item||editor.isLocked(item.id)||editor.isHidden(item.id)||reopening||(!textOverlay.active&&(editor.tool!=="select"||textArmed||inkArmed||mind.armed||mind.active||paths.mode||flow.working))){formatBar.hide();return;}
  const field=textOverlay.field;
  let anchor:ScreenArea;
  if(field){
    const box=field.getBoundingClientRect();
    anchor={left:box.left-rect.left,top:box.top-rect.top,right:box.left-rect.left+box.width,bottom:box.top-rect.top+box.height};
  }else{
    const box=boxBounds(textFrame(item)),a=worldToScreen(box.min,editor.camera),b=worldToScreen(box.max,editor.camera);
    anchor={left:a.x,top:a.y,right:b.x,bottom:b.y};
  }
  const generation=editor.generation;
  const apply=(change:FormatChange,gesture?:FormatGesture)=>{
    if(editor.generation!==generation||editor.isLocked(item.id)||editor.isHidden(item.id)||reopening)return;
    const original=editor.doc.objects[item.id];
    const draft=textFormatDraft??(original?.kind==="text"?original:item);
    const values={fontSize:draft.fontSize,color:draft.color,align:draft.align,width:draft.width,...change};
    if(textFormatDraft?.id===item.id){
      const next=planTextStyle(draft,values);
      if(next&&next!==draft){textFormatDraft=next;textOverlay.restyle(next);}
    }else if(!textOverlay.active&&editor.selection===item.id&&original===draft){inspectorDraft?.reset();setTextStyle(editor,draft,values,formatSeries(gesture,editor.history));}
  };
  // Reserve the bottom dock and visible overlay panel when placing the toolbar.
  formatBar.show({id:item.id,layout:"text",capabilities:standaloneCapabilities,values:{color:standaloneInk(item,activeTheme),autoInk:automaticTextColor(item),
    background:item.background,fontFamily:item.fontFamily??"system",fontSize:item.fontSize,fontWeight:item.fontWeight??500,italic:Boolean(item.italic),align:item.align},
    get composing(){return textOverlay.inComposition;},apply,focus:()=>{const target=textOverlay.field??canvas;if(document.activeElement!==target)target.focus({preventScroll:true});}
  },anchor,barSpace);
}
listen(window.visualViewport,"resize",()=>placeOverlay());
listen(window.visualViewport,"scroll",()=>placeOverlay());
function unobstructedWidth(canvasWidth=width){
  if(!panel||compactPanels?.matches)return canvasWidth;
  const edge=required(panel+"-panel").getBoundingClientRect().left-viewport.getBoundingClientRect().left;
  return edge>canvasWidth/2&&edge<canvasWidth?edge:canvasWidth;
}
function canvasViewport(revealCanvas=false):CanvasViewport{
  // The compact layer sheet can cover almost the entire board.
  if(revealCanvas&&compactPanels?.matches)dismissCanvasPanel();
  const w=viewport.clientWidth,h=viewport.clientHeight,rect=viewport.getBoundingClientRect();
  const usableWidth=unobstructedWidth(w),occlusions:CanvasControl[]=[];
  function measure(elements:Iterable<HTMLElement>,edge:CanvasControl["edge"]){
    for(const el of elements){
      if(!el.getClientRects().length||el.closest(".diagnostic-controls")&&!diagnostics.open)continue;
      const r=el.getBoundingClientRect(),left=Math.max(0,r.left-rect.left),right=Math.min(usableWidth,r.right-rect.left);
      const top=Math.max(0,r.top-rect.top),bottom=Math.min(h,r.bottom-rect.top);
      if(right>left&&bottom>top)occlusions.push({id:el.id||"frame-rate",edge,left,right,top,bottom});
    }
  }
  measure(topControls,"top");
  measure(bottomControls,"bottom");
  if(creationOpen())measure([creationTools],"bottom");
  return {width:w,height:h,usableWidth,windowWidth:window.innerWidth,windowHeight:window.innerHeight,occlusions};
}
function fit(){
  if(ink.drawing)return;
  fitPending=true;
  size();
}
function size(){
  const w=viewport.clientWidth,h=viewport.clientHeight,dpr=window.devicePixelRatio || 1;
  if(!w||!h)return;
  const resized=w!==width||h!==height;
  if(resized||ratio!==dpr){
    if(resized&&ink.drawing)applyInkActions(ink.interrupt());
    const shift={x:(w-width)/2,y:(h-height)/2};
    width=w;height=h;ratio=dpr;
    view.size(w,h,dpr);
    if(resized&&!fitPending)editor.pan(shift);
    else invalidate();
  }
  // An opened board may arrive while the canvas is hidden. Consume its fit once layout exists.
  if(fitPending){
    fitPending=false;
    updateScene();
    const draft=textOverlay.worldBox;
    editor.setCamera(fitCanvas(projector.all(scenePatch),canvasViewport(true),draft&&boxBounds(draft)));
  }
}
const themeMedia=window.matchMedia?.("(prefers-color-scheme: dark)");
const themeChoices=(["light","dark","system"] as const).map(preference=>({
  preference,input:required<HTMLInputElement>("theme-"+preference),
}));
let themePreference=parseTheme(undefined);
let activeTheme:WorkspaceTheme="light";
try{themePreference=parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY));}catch{/* preference is optional */}
function updateTheme(){
  const resolved=resolveTheme(themePreference,themeMedia?.matches??false);
  if(document.documentElement)document.documentElement.dataset.workspaceTheme=resolved;
  const changed=activeTheme!==resolved;
  activeTheme=resolved;
  if(changed)inspectorDraft?.syncTheme?.(resolved);
  view.setTheme(resolved);
  for(const {input,preference} of themeChoices)ui.patch(input.id,{checked:preference===themePreference});
  invalidate();
}
for(const {input,preference} of themeChoices)ui.on(input.id,"change",()=>{
  if(!input.checked)return;
  themePreference=preference;
  updateTheme();
  try{window.localStorage.setItem(THEME_STORAGE_KEY,themePreference);}catch{/* still valid for this session */}
});
listen(themeMedia,"change",()=>{if(themePreference==="system")updateTheme();});
updateTheme();
observeViewportSize(viewport,size,lifetime.signal);
setPanel(undefined);
size();updateSelectionControls();updateChrome();invalidate();

function local(event:PointerEvent|WheelEvent,bounds=canvas.getBoundingClientRect()):Point {
  return clientToScreen({x:event.clientX,y:event.clientY},{x:bounds.left,y:bounds.top});
}
function topicAppearanceMap(map:MindMap):MindMap|undefined{
  const moved=editor.preview?.objects.get(map.id);
  if(moved?.kind==="mindmap")return mind.displayMap(moved);
}
function pickArea(screen:Point,touch:boolean){
  updateScene();
  const cached=lastPick;
  if(cached&&cached.screen.x===screen.x&&cached.screen.y===screen.y&&cached.touch===touch&&cached.camera===editor.camera&&
    cached.doc===editor.doc&&cached.patch===scenePatch&&cached.visibility===editor.visibilityRevision)return cached;
  const point=screenToWorld(screen,editor.camera),tolerance=(touch?10:5)/editor.camera.zoom;
  const bounds={min:{x:point.x-tolerance,y:point.y-tolerance},max:{x:point.x+tolerance,y:point.y+tolerance}};
  const near=projector.query(bounds,scenePatch);
  return lastPick={screen,touch,camera:editor.camera,doc:editor.doc,patch:scenePatch,visibility:editor.visibilityRevision,
    near,point,tolerance,hit:hitDetail(near,point,tolerance)};
}
function targetAt(screen:Point,touch=false){
  return pickArea(screen,touch).hit?.group.id;
}
function sweepEraser(points:readonly Point[],radius:number){
  updateScene();
  for(let i=points.length===1?0:1;i<points.length;i++){
    const from=points[Math.max(0,i-1)],to=points[i];
    const bounds={min:{x:Math.min(from.x,to.x)-radius,y:Math.min(from.y,to.y)-radius},
      max:{x:Math.max(from.x,to.x)+radius,y:Math.max(from.y,to.y)+radius}};
    for(const group of projector.query(bounds)){
      if(erasedInk.has(group.id)||editor.isLocked(group.id))continue;
      const shape=group.items[0],item=objectById(editor.doc,group.id);
      if(shape?.kind==="ink"&&item?.kind==="ink"&&eraserHitsInk(shape.points,from,to,radius))erasedInk.set(group.id,item);
    }
  }
}
function applyInkActions(actions:readonly InkAction[]){
  const before=editor.doc;
  let update=false;
  for(const action of actions){
    if(action.kind==="nav"){
      const p=action.pointer;
      if(action.phase==="down")editor.down(p.id,"touch",p.at,undefined,true);
      else if(action.phase==="move")editor.move(p.id,p.at);
      else if(action.phase==="up")editor.up(p.id,p.at);
      else editor.pointerCancelled(p.id);
    }else if(action.kind==="nav-reset")editor.resetPointers();
    else if(action.kind==="pan")editor.pan(action.delta);
    else if(action.kind==="pan-start"||action.kind==="pan-end")updateChrome();
    else if(action.kind==="stroke-start"){erasedInk.clear();inkGeneration=editor.generation;update=true;}
    else if(action.kind==="erase-sweep"){sweepEraser(action.points,action.radius);}
    else if(action.kind==="erase-commit"){
      const generation=inkGeneration,targets=[...erasedInk.values()];
      erasedInk.clear();inkGeneration=undefined;update=true;
      if(generation===editor.generation&&!reopening&&targets.length&&targets.every(item=>objectById(editor.doc,item.id)===item)){
        writingInk=true;
        try{editor.commitEdit({label:"擦除手写笔迹",patches:targets.map(item=>({op:"removeObject",id:item.id}))},generation);}
        finally{writingInk=false;}
      }
    }
    else if(action.kind==="stroke-commit"){
      const generation=inkGeneration;inkGeneration=undefined;update=true;
      if(generation&&generation===editor.generation&&!reopening){
        const pieces=action.preceding?[...action.preceding,action.stroke]:[action.stroke];
        const objects=pieces.map(stroke=>({id:allocateId("ink"),kind:"ink" as const,...stroke}));
        writingInk=true;
        try{
          if(!editor.commitEdit({label:"添加手写笔迹",patches:objects.map(value=>({op:"putObject",value}))},generation,objects.map(o=>o.id)))
            savedHint="无法添加笔迹，可能已达到项目容量。";
        }finally{writingInk=false;}
      }
    }else if(action.kind==="stroke-cancel"){
      erasedInk.clear();inkGeneration=undefined;update=true;
      if(action.reason==="sample-limit")savedHint="这笔太长，未保存。请分几笔写。";
    }
  }
  if(update){
    // Pointer cancellation can leave the same selected stroke and history in place.
    // Retire its old form on contact, then restore a fresh one when contact ends.
    if(editor.doc===before&&editor.selectedIds.length===1&&editor.doc.objects[editor.selectedIds[0]]?.kind==="ink")updateSelectionControls();
    updateChrome();
  }
  if(actions.length)invalidate();
}
function refreshPath(){updateChrome();invalidate();}
function beginPathMode(item?:VectorPath){
  if(reopening||textOverlay.active||editor.busy||ink.drawing||item&&(item!==editor.doc.objects[item.id]||editor.isLocked(item.id)))return;
  setInkMode(false);exitMind();setFlowMode();armText(false);editor.setTool("select");editor.select(item?.id);
  paths.start(item);setPanel(undefined);canvas.focus({preventScroll:true});refreshPath();
}
function endPath(closed:boolean){
  if(paths.mode==="anchors"){if(!paths.pointer)paths.cancel();}
  else paths.finish(closed);
  refreshPath();canvas.focus({preventScroll:true});
}
ui.on("tool-path","click",()=>{
  if(paths.mode==="draw"){paths.cancel();refreshPath();}else beginPathMode();
});

ui.on("path-segment","change",()=>{
  paths.choose(Number(segmentPicker.value)-1);segmentPicker.value=String(paths.segment+1);refreshPath();
});
const pathPart=required<HTMLSelectElement>("path-part");
ui.on("path-part","change",()=>{
  const part=pathPart.value;
  if(!paths.pointer&&(part==="auto"||part==="vertex"||part==="out"||part==="in"))paths.part=part;
  canvas.focus({preventScroll:true});refreshPath();
});
ui.on("path-insert","click",()=>{paths.armInsert();canvas.focus({preventScroll:true});refreshPath();});
ui.on("path-convert","click",()=>{paths.toggle();canvas.focus({preventScroll:true});refreshPath();});
ui.on("path-finish","click",()=>endPath(false));
ui.on("path-close","click",()=>endPath(true));
function releasePathPointer(id?:number){
  if(id!==undefined&&canvas.hasPointerCapture?.(id))canvas.releasePointerCapture(id);
}
function cancelPathStep(){
  const id=paths.pointer?.id;
  if(paths.inserting)paths.stopInsert();else paths.cancel();
  releasePathPointer(id);refreshPath();
}
ui.on("path-cancel","click",()=>{cancelPathStep();canvas.focus({preventScroll:true});});
function resetInspectorForCanvas(){
  return inspectorDraft?.reset()??false;
}
function setInkMode(active:boolean){
  if(active)paths.cancel();
  if(inkArmed===active||active&&(textOverlay.active||reopening))return;
  resetInspectorForCanvas();
  if(active){
    exitMind();setFlowMode();armText(false);nodeTap=undefined;editor.resetPointers();editor.setTool("select");editor.select();
    dismissArrange();canvas.focus({preventScroll:true});
  }else applyInkActions(ink.interrupt());
  if("onpointerrawupdate" in canvas){
    if(active)listen(canvas,"pointerrawupdate",onRawInkMotion,{passive:true});
    else canvas.removeEventListener("pointerrawupdate",onRawInkMotion);
  }
  inkArmed=active;updateChrome();invalidate();
}
ui.on("tool-ink","click",()=>setInkMode(!inkArmed));
ui.on("ink-finger","click",()=>{
  if(ink.drawing)return;
  fingerInk=!fingerInk;updateChrome();canvas.focus({preventScroll:true});
});
function penEraser(event:PointerEvent):boolean{
  return event.pointerType==="pen"&&(event.button===5||(event.buttons&32)!==0);
}
function middleInkPan(event:PointerEvent,phase:"down"|"move"|"up"):boolean{
  if(!inkArmed||reopening||event.pointerType!=="mouse")return false;
  const middle=phase!=="up"&&((event.buttons&4)!==0||phase==="down"&&event.button===1);
  if(!middle&&!ink.panning)return false;
  const mouse:InkPointer={id:event.pointerId,device:"mouse",at:local(event),pressure:event.pressure,
    primaryTip:(event.buttons&1)!==0,timeStamp:event.timeStamp};
  event.preventDefault();
  if(!ink.panning){
    applyInkActions(ink.beginPan(mouse));
    canvas.focus({preventScroll:true});
    try{canvas.setPointerCapture(mouse.id);}catch{applyInkActions(ink.cancel(mouse.id));}
  }else{
    applyInkActions(ink.panTo(mouse));
    if(!middle)applyInkActions(ink.endPan(mouse,{camera:editor.camera,fingerInk,brush:inkTools.brush(),
      eraserDiameterCss:inkTools.eraser?inkTools.eraserDiameter:undefined}));
  }
  return true;
}
function inkDown(event:PointerEvent):boolean{
  const id=event.pointerId,device=event.pointerType||"mouse";
  if(!inkArmed&&!ink.owns(id))return false;
  if(!inkArmed||textOverlay.active||reopening)return true;
  if(device!=="pen"&&device!=="touch"&&device!=="mouse")return true;
  const hardwareEraser=penEraser(event);
  const pointer:InkPointer={id,device,at:local(event),primaryTip:event.button===0||hardwareEraser,pressure:event.pressure,timeStamp:event.timeStamp};
  applyInkActions(ink.down(pointer,{camera:editor.camera,fingerInk,
    brush:inkTools.brush(),eraserDiameterCss:hardwareEraser||inkTools.eraser?inkTools.eraserDiameter:undefined}));
  if(ink.owns(id)){
    if(device!=="touch")canvas.focus({preventScroll:true});
    event.preventDefault();try{canvas.setPointerCapture(id);}catch{}
  }
  return true;
}
listen(canvas,"pointerdown",event=>{
  hoverPoint=undefined;requestPointerFeedback();
  if(middleInkPan(event,"down"))return;
  const finishedText=textOverlay.finishOutside(canvas);
  startCanvasPointer(event,finishedText);
});
function startCanvasPointer(event:PointerEvent,finishedText:boolean){
  if(event.button!==0 && event.button!==1 && !(inkArmed&&penEraser(event))) return;
  resetInspectorForCanvas();
  if(inkDown(event))return;
  if(textOverlay.active)return;
  event.preventDefault();
  if(event.pointerType!=="touch")canvas.focus({preventScroll:true});
  const p=local(event);
  if(paths.mode){
    const first=paths.pointer;
    if(first?.type==="touch"&&event.pointerType==="touch"&&first.id!==event.pointerId){
      paths.cancel();
      editor.down(first.id,"touch",first.current,undefined,true);
      editor.down(event.pointerId,"touch",p,undefined,true);
      try{canvas.setPointerCapture(event.pointerId);}catch{editor.pointerCancelled(event.pointerId);}
      refreshPath();return;
    }
    if(first)return;
    if(event.button===0&&!space&&paths.down(event.pointerId,event.pointerType,p)){
      canvas.focus({preventScroll:true});
      try{canvas.setPointerCapture(event.pointerId);}catch{paths.cancel();}
      refreshPath();return;
    }
    paths.cancel();refreshPath();
  }
  if(textArmed){
    const type=event.pointerType, first=textPointer;
    if(editor.busy||space||event.button===1)editor.down(event.pointerId,type,p,undefined,true);
    else if(first?.type==="touch"&&type==="touch"&&first.id!==event.pointerId){
      textPointer=undefined;
      editor.down(first.id,"touch",first.current,undefined,true);
      editor.down(event.pointerId,"touch",p,undefined,true);
    }else if(!first&&event.button===0)textPointer={id:event.pointerId,type,start:p,current:p};
    else textPointer=undefined;
    try{canvas.setPointerCapture(event.pointerId);}catch{}
    return;
  }
  const touch=event.pointerType==="touch";
  nodeTap=undefined;
  const first=flow.pointer??mind.pointer;
  const handle=!first&&!editor.busy&&!space&&event.button===0?boxHandleAt(p,touch,event.shiftKey,!event.altKey&&!event.ctrlKey&&!event.metaKey):undefined;
  const mindPress=!first&&!editor.busy&&!space&&event.button===0&&(!event.shiftKey||!mind.armed)&&editor.tool==="select"&&
    (!flow.mode||flow.mode==="connect")&&!flow.working;
  const copyTarget=dragAlt(event)&&!handle&&!first&&!editor.busy&&!space&&event.button===0&&editor.tool==="select"&&
    !mind.armed&&!flow.working&&(!flow.mode||flow.mode==="connect")?targetAt(p,touch):undefined;
  const topic=mindPress&&!mind.armed?mind.at(p,touch):undefined;
  const root=topic&&getMap(editor,topic.mapId)?.rootId===topic.topicId?topic:undefined;
  const renameOnTap=mindPress&&!finishedText&&!event.shiftKey&&!event.altKey&&!event.ctrlKey&&!event.metaKey;
  const sameTopic=topic&&mind.selected?.mapId===topic.mapId&&mind.selected.topicId===topic.topicId;
  if(first?.type==="touch"&&touch){
    // The original pointer already has capture. Hand both contacts back to the
    // same camera owner when a second finger cancels a feature gesture.
    flow.cancel();mind.cancelPointer();
    editor.down(first.id,"touch",first.current,undefined,true);
    editor.down(event.pointerId,"touch",p,undefined,true);
    updateChrome();invalidate();
  }else if(handle){
    if("rotate" in handle||"textEdge" in handle||"divider" in handle){flow.clearHover();canvas.focus({preventScroll:true});}
    editor.down(event.pointerId,event.pointerType,p,handle.id,false,false,handle);
  }else if(copyTarget&&(!topic||root)){
    editor.down(event.pointerId,event.pointerType,p,copyTarget,false,event.shiftKey,"copy");
  }else if(root){
    // Root tap focuses the topic, but a root drag translates the whole map
    // through the usual editor gesture and its single undo transaction.
    if(!event.shiftKey){
      if(editor.selectedIds.length!==1||editor.selection!==root.mapId)editor.select(root.mapId);
      nodeTap={id:event.pointerId,start:p,finish:()=>{enterMind(root);if(renameOnTap&&sameTopic)requestTopic();}};
    }
    editor.down(event.pointerId,event.pointerType,p,root.mapId,false,event.shiftKey);
  }else if(mindPress&&mind.down(event.pointerId,event.pointerType,p,event.shiftKey)){
    if(renameOnTap&&sameTopic)nodeTap={id:event.pointerId,start:p,finish:()=>requestTopic()};
    invalidate();
  }else if(!mind.armed&&!mind.active&&!editor.busy&&!space&&event.button===0&&(!event.shiftKey||flow.mode)&&editor.tool==="select"&&flow.down(event.pointerId,event.pointerType,p)){
    updateChrome();invalidate();
  }else{
    const hit=targetAt(p,touch),item=hit?editor.doc.objects[hit]:undefined;
    const extendTable=Boolean(item&&item.kind==="table"&&event.shiftKey&&tables.table?.id===item.id&&tables.range);
    if(item&&item.kind==="table"&&mindPress&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&(!event.shiftKey||extendTable)&&
      !editor.isLocked(item.id)&&(editor.selectedIds.length<=1||!editor.selectedIds.includes(item.id))){
      const at=cellAt(item,screenToWorld(p,editor.camera));
      if(at)nodeTap={id:event.pointerId,start:p,finish:()=>{
        if(tables.table?.id===item.id)tables.tap(at,extendTable,!finishedText);
      }};
    }
    if(mindPress&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&isCard(item)&&(item.content.kind==="markdown"||!item.label)&&!editor.isLocked(item.id)&&
      cardOffsetAt(item,worldToLocal(screenToWorld(p,editor.camera),item),true)!==undefined){
      nodeTap={id:event.pointerId,start:p,finish:()=>startCard(item,p)};
    }else if(renameOnTap&&item&&item.id===editor.selection&&editor.selectedIds.length===1&&!editor.isLocked(item.id)){
      if(item.kind==="shape")nodeTap={id:event.pointerId,start:p,finish:()=>startFlowLabel(item,p)};
      if(item.kind==="text")nodeTap={id:event.pointerId,start:p,finish:()=>startText(item)};
    }
    editor.down(event.pointerId,event.pointerType,p,hit,space||event.button===1,event.shiftKey&&!extendTable);
  }
  try {canvas.setPointerCapture(event.pointerId);}catch{
    if(flow.pointer?.id===event.pointerId){flow.cancel();updateChrome();invalidate();}
    if(editor.transforming||editor.draggingObjects)editor.pointerCancelled(event.pointerId);
  }
}
function collectInkMotion(event:PointerEvent,source:"raw"|"move"){
  const batch=event.getCoalescedEvents?.()??[],bounds=canvas.getBoundingClientRect();
  const samples=(batch.length?batch:[event]).filter(sample=>sample.pointerId===event.pointerId&&
    !(event.pointerType==="mouse"&&(sample.buttons&4)!==0))
    .map(sample=>({at:local(sample,bounds),pressure:sample.pressure,timeStamp:sample.timeStamp}));
  applyInkActions(ink.move(event.pointerId,samples,source));
}
function onRawInkMotion(raw:Event){
  const event=raw as PointerEvent;
  if(event.pointerType==="mouse"&&(ink.panning||(event.buttons&4)!==0))return;
  if(ink.ownerId===event.pointerId&&!ink.erasing)collectInkMotion(event,"raw");
}
listen(canvas,"pointerenter",event=>{
  if(event.pointerType==="mouse"&&!event.buttons){hoverPoint=local(event);requestPointerFeedback();}
});
listen(canvas,"pointermove",event=>{
  if(middleInkPan(event,"move"))return;
  if(ink.owns(event.pointerId)){collectInkMotion(event,"move");return;}
  if(inkArmed)return;
  const p=local(event);
  hoverPoint=event.pointerType==="mouse"&&!event.buttons?p:undefined;
  if(paths.mode){paths.move(event.pointerId,p,event.pointerType);invalidate();return;}
  if(textPointer?.id===event.pointerId){
    textPointer.current=p;
    if(placementDragged(textPointer.start,p))textPointer.moved=true;
  }
  if(nodeTap?.id===event.pointerId&&Math.hypot(p.x-nodeTap.start.x,p.y-nodeTap.start.y)>=(event.pointerType==="touch"?8:3))nodeTap=undefined;
  if(mind.move(event.pointerId,p)){invalidate();return;}
  editor.move(event.pointerId,p,event.shiftKey,bypassAlignment(event));
  if(!mind.active&&!mind.armed&&!editor.busy&&!textArmed&&!textOverlay.active&&editor.tool==="select"&&!space){
    const handle=boxHandleAt(p,event.pointerType==="touch",event.shiftKey,!event.altKey&&!event.ctrlKey&&!event.metaKey);
    if(handle&&!flow.pointer)flow.clearHover();else flow.move(event.pointerId,p,event.pointerType==="touch");
    if(!flow.pointer)canvas.style.cursor=handle?handleCursor(handle):flow.mode?"crosshair":"default";
    if(!passiveFlow())invalidate();
  }
  requestPointerFeedback();
});
listen(canvas,"pointerleave",()=>{
  hoverPoint=undefined;paths.leave();flow.clearHover();
  if(paths.mode||!passiveFlow())invalidate();else requestPointerFeedback();
});
listen(canvas,"pointerup",event=>{
  if(event.pointerType==="mouse"&&!event.buttons&&document.elementFromPoint?.(event.clientX,event.clientY)===canvas){
    hoverPoint=local(event);requestPointerFeedback();
  }
  if(middleInkPan(event,"up"))return;
  if(ink.owns(event.pointerId)){applyInkActions(ink.up(event.pointerId,local(event),event.timeStamp));return;}
  if(inkArmed)return;
  const p=local(event);
  if(paths.mode){paths.up(event.pointerId,p);refreshPath();return;}
  if(textArmed){
    if(editor.busy){editor.up(event.pointerId,p);return;}
    const pending=textPointer;
    if(pending?.id!==event.pointerId)return;
    textPointer=undefined;
    if(!pending.moved&&p.x>=0&&p.y>=0&&p.x<width&&p.y<height&&!placementDragged(pending.start,p)){
      if(tableArmed){
        if(reopening)return;
        const table=createTable(placementBox("table",p,editor.camera).at);
        activateSelectionTool();
        editor.commitEdit({label:"插入表格",patches:[{op:"putObject",value:table}]},editor.generation,[table.id]);
        canvas.focus({preventScroll:true});return;
      }
      const kind=cardArmed??"text",box=placementBox(kind,p,editor.camera);
      const draft=kind==="text"?createText(box.at):newCard(kind,box.at,"",kind==="sticky"?placement.color:undefined);
      if(editor.commitEdit({label:"放置"+(kind==="text"?"文字框":cardName(kind)),patches:[{op:"putObject",value:draft}]},editor.generation,[draft.id])){
        const placed=editor.doc.objects[draft.id];
        if(isCard(placed))startCard(placed,undefined,editor.history);
        else if(placed.kind==="text")startText(placed,true,editor.history);
      }
    }
    return;
  }
  const tap=nodeTap?.id===event.pointerId?nodeTap:undefined;
  if(tap)nodeTap=undefined;
  const finishTap=tap&&Math.hypot(p.x-tap.start.x,p.y-tap.start.y)<(event.pointerType==="touch"?8:3)?tap.finish:undefined;
  if(mind.up(event.pointerId,p)){if(mind.active&&flow.mode==="connect")setFlowMode();refreshMind();finishTap?.();return;}
  if(flow.up(event.pointerId,p)){
    const drop=flow.drop;
    if(drop){
      const under=document.elementFromPoint?.(event.clientX,event.clientY);
      if(p.x>=0&&p.x<width&&p.y>=0&&p.y<height&&(!under||under===canvas))openDropMenu(drop);
      else flow.finishDrop(drop);
    }
    updateChrome();invalidate();return;
  }
  editor.up(event.pointerId,p,hitCanvasMarquee,event.shiftKey,bypassAlignment(event));
  finishTap?.();
});
const cancelPointer=(event:PointerEvent)=>{
  if(event.type==="pointercancel"){hoverPoint=undefined;requestPointerFeedback();}
  if(paths.pointer?.id===event.pointerId){paths.cancel();refreshPath();return;}
  if(ink.owns(event.pointerId)){applyInkActions(ink.cancel(event.pointerId));return;}
  if(inkArmed)return;
  if(textPointer?.id===event.pointerId)textPointer=undefined;
  if(nodeTap?.id===event.pointerId)nodeTap=undefined;
  if(mind.pointer?.id===event.pointerId){mind.cancelPointer();refreshMind();}
  if(flow.pointer?.id===event.pointerId){flow.cancel();updateChrome();invalidate();}
  editor.pointerCancelled(event.pointerId);
};
listen(canvas,"pointercancel",cancelPointer);
listen(canvas,"lostpointercapture",cancelPointer);
function suppressMiddleDefault(event:MouseEvent){if(inkArmed&&event.button===1)event.preventDefault();}
listen(canvas,"mousedown",suppressMiddleDefault);
listen(canvas,"auxclick",suppressMiddleDefault);
listen(canvas,"dblclick",event=>{
  if(paths.mode||inkArmed)return;
  if(textOverlay.active||textArmed||mind.armed||(flow.mode&&flow.mode!=="connect")||flow.working||editor.tool==="hand")return;
  const b=canvas.getBoundingClientRect();
  const point={x:event.clientX-b.left,y:event.clientY-b.top};
  if(boxHandleAt(point)){event.preventDefault();return;}
  const topic=mind.at(point);
  if(topic){event.preventDefault();enterMind(topic);requestTopic();return;}
  const item=editor.doc.objects[targetAt(point)??""];
  if(item&&editor.enterGroup(item.id)){event.preventDefault();return;}
  if(item?.kind==="table"){
    const at=cellAt(item,screenToWorld(point,editor.camera));
    if(at&&!editor.isLocked(item.id)){event.preventDefault();editor.select(item.id);tables.startEdit(at);}
  }else if(item?.kind==="text"){event.preventDefault();startText(item);}
  else if(item?.kind==="shape"){event.preventDefault();startFlowLabel(item,point);}
  else if(!flow.working&&flow.addWaypointAt({x:event.clientX-b.left,y:event.clientY-b.top}))event.preventDefault();
});
const arrangeMenu=required("arrange-menu");
const arrangeGroups:readonly (readonly (readonly [ArrangeCommand,string,string])[])[]=[
  [["front","置于顶层","Shift+]"],["forward","上移一层","]"],["backward","下移一层","["],["back","置于底层","Shift+["]],
  [["left","左对齐","Alt+A"],["center","水平居中","Alt+H"],["right","右对齐","Alt+D"],
    ["top","顶对齐","Alt+W"],["middle","垂直居中","Alt+V"],["bottom","底对齐","Alt+S"]],
  [["distribute-x","水平等距分布","Alt+Shift+H"],["distribute-y","垂直等距分布","Alt+Shift+V"]],
];
const arrangeBindings=new Map(arrangeGroups.flat().map(([command,,shortcut])=>[shortcut,command] as const));
let arrangeSource:HTMLElement|undefined;
let arrangePoint:Point|undefined;
let canvasMenuWorld:Point|undefined;
let layoutContext:{history:typeof editor.history;ids:readonly Id[];generation:symbol;locks:number;visibility:number}|undefined;
function dismissArrange(focus=false,preset?:DropNode){
  if(arrangeMenu.hidden)return;
  const drop=menuDrop;menuDrop=undefined;
  present(()=>{ui.patch("arrange-menu",{hidden:true,"data-connection-drop":undefined});ui.menu.set([]);});
  arrangePoint=undefined;canvasMenuWorld=undefined;layoutContext=undefined;
  const source=arrangeSource;arrangeSource=undefined;
  if(drop&&flow.drop===drop){
    if(!flow.finishDrop(drop,preset)){savedHint="无法在此处创建连线。";updateChrome();invalidate();}
  }
  if(focus){
    const id=source?.dataset.id;
    if(id&&!layerRows.has(id)&&withinLayerPage(id))updateLayers();
    (id?layerElement(id)??canvas:canvas).focus({preventScroll:true});
  }
}
function placeArrange(){
  if(arrangeMenu.hidden)return;
  let point=arrangePoint;
  if(menuDrop){
    if(menuDrop!==flow.drop){dismissArrange(arrangeMenu.contains(document.activeElement));return;}
    const screen=worldToScreen(menuDrop.point,editor.camera),canvasRect=canvas.getBoundingClientRect();
    point={x:canvasRect.left+screen.x,y:canvasRect.top+screen.y};
  }
  if(!point)return;
  const visual=window.visualViewport;
  const left=visual?.offsetLeft??0,top=visual?.offsetTop??0;
  const w=visual?.width??window.innerWidth,h=visual?.height??window.innerHeight;
  arrangeMenu.style.maxHeight=Math.max(0,h-16)+"px";
  const rect=arrangeMenu.getBoundingClientRect(),width=Math.min(rect.width,w-16),height=Math.min(rect.height,h-16);
  let {x,y}=point;
  if(menuDrop){
    x+=x+width+16<=left+w?8:-width-8;
    y+=y+height+16<=top+h?8:-height-8;
  }
  arrangeMenu.style.left=Math.max(left+8,Math.min(left+w-width-8,x))+"px";
  arrangeMenu.style.top=Math.max(top+8,Math.min(top+h-height-8,y))+"px";
}
function showArrange(source:HTMLElement,items:MenuEntry[],label:string,client?:Point){
  arrangeSource=source;arrangePoint=client;
  present(()=>{
    ui.menu.set(items);
    ui.patch("arrange-menu",{hidden:false,"aria-label":label,"data-connection-drop":menuDrop?"true":undefined});
  });
  placeArrange();
  const first=enabledMenuItems()[0];
  (first??arrangeMenu).focus({preventScroll:true});first?.scrollIntoView?.({block:"nearest"});
}
function openDropMenu(drop:ConnectionDrop){
  dismissArrange();menuDrop=drop;
  const choices=[["process","流程步骤"],["decision","判断／选择"],["free","仅保留连线"]] as const;
  showArrange(canvas,choices.map(([choice,label])=>({key:choice,label,dropNode:choice,
    run:()=>{if(menuDrop===drop)dismissArrange(true,choice==="free"?undefined:choice);}})),"在连线终点创建节点");
}
function openArrange(id:Id|undefined,client:Point,source:HTMLElement,pinIndex?:number){
  dismissArrange();
  if(lockControlsBusy())return false;
  if(id!==undefined){
    if(!objectById(editor.doc,id))return false;
    showArrange(source,objectMenu(id,pinIndex),"图层、对齐与流程整理",client);
  }else{
    if(source!==canvas)return false;
    const rect=canvas.getBoundingClientRect();
    const point=screenToWorld(clientToScreen(client,{x:rect.left,y:rect.top}),editor.camera);
    canvasMenuWorld=point;
    const item=(key:string,label:string,action:()=>void,disabled=false):MenuEntry=>({key,label,disabled,
      run:()=>{if(canvasMenuWorld!==point)return;dismissArrange(true);if(!lockControlsBusy())action();}});
    showArrange(source,[
      item("node","添加流程节点",()=>{activateSelectionTool();createFlowNode(editor,"process",point);}),
      item("text","添加文字",()=>{activateSelectionTool();startText(createText(point));}),
      item("all","全选可见对象",()=>{activateSelectionTool();editor.selectAll();},!editor.doc.order.some(key=>!editor.isHidden(key))),
      item("fit","查看整板",fit)
    ],"画布操作",client);
  }
  return true;
}
function objectMenu(id:Id,pinIndex?:number):MenuEntry[]{
  activateSelectionTool();
  const hidden=editor.isHidden(id);
  if(!hidden&&!editor.selectedIds.includes(id))editor.select(id);
  const pin=pinIndex!==undefined&&flow.selectWaypoint(id,pinIndex);
  if(pin){updateChrome();invalidate();}
  const available=hidden?[]:availableGroupActions(),end=(action:()=>void)=>()=>{action();dismissArrange(true);};
  const items:MenuEntry[]=[{key:"pin",label:"删除此拐点",hidden:!pin,disabled:!pin,run:end(()=>{if(!lockControlsBusy())flow.removeSelectedWaypoint();})}];
  for(const action of Object.keys(groupLabels) as GroupAction[]){
    const enabled=available.includes(action);
    items.push({key:"group-"+action,group:action,label:groupLabels[action],shortcut:groupKeys[action],hidden:!enabled,disabled:!enabled,
      run:end(()=>invokeGroup(action,action==="enter"?id:undefined))});
  }
  items.push({key:"visibility",label:hidden?restoreCaption(id):"隐藏此层",disabled:lockControlsBusy(),run:end(()=>changeVisibility([id],editor.isHidden(id)))});
  for(const [i,group] of arrangeGroups.entries()){
    if(i)items.push({key:"separator-"+i,separator:true,hidden});
    for(const [command,label,shortcut] of group)items.push({key:command,arrange:command,label,shortcut,hidden,disabled:hidden||!canArrange(editor,command),
      run:end(()=>arrangeSelection(editor,command))});
  }
  layoutContext={history:editor.history,ids:editor.selectedIds,generation:editor.generation,locks:editor.lockRevision,visibility:editor.visibilityRevision};
  items.push({key:"layout",label:"按连接关系整理所选流程",flowLayout:"true",hidden:hidden||!editor.selectedIds.some(key=>editor.doc.objects[key]?.kind==="shape"),run:applyMenuLayout},
    {key:"feedback",status:true,hidden:true});
  return items;
}
function enabledMenuItems(){return Array.from(arrangeMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([hidden])'));}
function applyMenuLayout(){
  const context=layoutContext;
  if(!context||arrangeMenu.hidden)return;
  if(reopening||context.history!==editor.history||context.ids!==editor.selectedIds||context.generation!==editor.generation||
    context.locks!==editor.lockRevision||context.visibility!==editor.visibilityRevision){
    dismissArrange(true);savedHint="选区或画板已变化，请重新打开菜单。";updateStatus();return;
  }
  updateScene();const result=layoutSelectedFlow(editor,projector);
  if(result.state==="refused"){
    present(()=>ui.menu.set(ui.menu.read().map(item=>item.status?{...item,label:result.message,hidden:false}:
      item.flowLayout?{...item,description:"flow-layout-feedback"}:item)));
    placeArrange();required("flow-layout-feedback").scrollIntoView({block:"nearest"});return;
  }
  dismissArrange(true);savedHint=result.message;updateStatus();
}
ui.on("arrange-menu","keydown",event=>{
  const key=event.key;
  if(key==="Tab"){dismissArrange(true);return;}
  if(key==="Escape"){event.preventDefault();event.stopPropagation();dismissArrange(true);return;}
  if(key!=="ArrowDown"&&key!=="ArrowUp"&&key!=="Home"&&key!=="End")return;
  event.preventDefault();event.stopPropagation();
  const items=enabledMenuItems();
  if(!items.length)return;
  const current=items.indexOf(document.activeElement as HTMLButtonElement);
  const i=key==="Home"?0:key==="End"?items.length-1:key==="ArrowDown"?(current+1)%items.length:
    current<0?items.length-1:(current-1+items.length)%items.length;
  items[i].focus({preventScroll:true});items[i].scrollIntoView?.({block:"nearest"});
});
// A committed label can rebuild the inspector during pointerdown. Transfer focus
// to the equivalent live field and preserve a button's normal release-to-activate.
function finishForControl(event:Event){
  if(event.target instanceof Node&&formatBar.root.contains(event.target))return;
  if(!textOverlay.active)return;
  if(event.target instanceof Node&&fitButton.contains(event.target)){
    if(event.type==="pointerdown")event.preventDefault();
    return;
  }
  const control=event.target instanceof Element?event.target.closest<HTMLElement>("input,select,textarea,button"):null;
  const host=control&&(inspector.contains(control)?inspector:required("topic-tree").contains(control)?required("topic-tree"):undefined);
  if(!textOverlay.finishOutside(event.target)||!control||!host||host.contains(control))return;
  const controls=Array.from(host.querySelectorAll<HTMLElement>(control.tagName));
  const next=controls.find(el=>control.dataset.topicId?el.dataset.topicId===control.dataset.topicId:control.id?el.id===control.id:
    control.getAttribute("name")?el.getAttribute("name")===control.getAttribute("name")&&
      (!(control instanceof HTMLInputElement)||control.type!=="radio"||control.value===(el as HTMLInputElement).value):
    control.getAttribute("aria-label")?el.getAttribute("aria-label")===control.getAttribute("aria-label"):el.textContent===control.textContent);
  if(!next)return;
  // The browser's pointer default would focus the detached field after this
  // listener returns and send focus back to body.
  if(event.type==="pointerdown")event.preventDefault();
  next.focus({preventScroll:true});
  if(event.type==="click"){event.preventDefault();event.stopPropagation();next.click();return;}
  if(event.type!=="pointerdown"||(event as PointerEvent).button!==0)return;
  if(next.tagName==="SELECT"||next instanceof HTMLInputElement&&next.type==="color"){
    try{(next as HTMLSelectElement|HTMLInputElement).showPicker();}catch{/* Native activation can still open the picker. */}
  }else if(next.tagName==="BUTTON"||next instanceof HTMLInputElement&&(next.type==="checkbox"||next.type==="radio")){
    const down=event as PointerEvent,watch=new AbortController();
    const options={capture:true,signal:watch.signal};
    listen(next,"click",()=>watch.abort(),options);
    listen(document,"pointercancel",()=>watch.abort(),options);
    listen(document,"pointerdown",()=>watch.abort(),options);
    listen(document,"pointerup",up=>{
      if(up.pointerId!==down.pointerId)return;
      const over=document.elementFromPoint(up.clientX,up.clientY);
      const samePoint=Math.hypot(up.clientX-down.clientX,up.clientY-down.clientY)<5;
      setTimeout(()=>{
        if(!watch.signal.aborted&&next.isConnected&&(samePoint||next.contains(over)))next.click();
        watch.abort();
      },0);
    },options);
  }
}
listen(document,"pointerdown",event=>{
  if(event.target!==canvas)finishForControl(event);
  if(!arrangeMenu.hidden&&event.target instanceof Node&&!arrangeMenu.contains(event.target))dismissArrange();
},true);
listen(document,"focusin",event=>{
  if(menuDrop&&event.target instanceof Node&&!arrangeMenu.contains(event.target))dismissArrange();
  finishForControl(event);
},true);
// Keyboard and accessibility activation can click a control without a pointerdown.
listen(document,"click",event=>{if(event.detail===0)finishForControl(event);},true);
listen(document,"wheel",event=>{
  if(!(event.target instanceof Node&&formatBar.root.contains(event.target)))textOverlay.finishOutside(event.target);
},{capture:true,passive:true});
listen(document,"keydown",event=>{
  if(event.altKey&&!event.ctrlKey&&!event.metaKey&&event.key==="F10"&&!event.isComposing&&!textOverlay.inComposition&&
    (event.target===canvas||event.target===textOverlay.field)&&formatBar.focus()){event.preventDefault();event.stopPropagation();}
},true);
listen(document,"keydown",event=>{
  if(!textOverlay.active||textOverlay.inComposition||event.isComposing||event.keyCode===229||
    !(event.ctrlKey||event.metaKey)||event.shiftKey||event.altKey||event.key.toLowerCase()!=="s")return;
  event.preventDefault();event.stopPropagation();if(event.repeat)return;
  textOverlay.finishOutside(null);canvas.focus({preventScroll:true});void save();
},true);
listen(window,"blur",()=>{hoverPoint=undefined;flow.clearHover();requestPointerFeedback();dismissArrange();});
listen(window,"resize",placeArrange);
listen(window.visualViewport,"resize",placeArrange);
listen(window.visualViewport,"scroll",placeArrange);
listen(canvas,"contextmenu",event=>{
  event.preventDefault();
  const point=local(event),touch=event.pointerType==="touch";
  const pin=editor.tool==="select"&&!space&&!inkArmed&&!textArmed&&!paths.mode&&!mind.active&&!mind.armed&&!flow.working?
    flow.waypointAt(point,touch):undefined;
  openArrange(pin?.id??targetAt(point,touch),{x:event.clientX,y:event.clientY},canvas,pin?.index);
});
ui.on("layers","contextmenu",event=>{
  const row=keyboardLayer(event.target);
  if(!row)return;
  event.preventDefault();openArrange(row.dataset.id,{x:event.clientX,y:event.clientY},row);
});
listen(canvas,"wheel",event=>{
  textOverlay.finishOutside(canvas);
  event.preventDefault();
  if(paths.pointer||ink.drawing||flow.pointer||mind.pointer||textPointer)return;
  const mode=event.deltaMode as 0|1|2;
  let d=normalizeWheel({x:event.deltaX,y:event.deltaY},mode,16,{x:width,y:height});
  if(event.shiftKey&&!d.x&&!event.ctrlKey&&!event.metaKey) d={x:d.y,y:0};
  editor.wheel(local(event),d,event.ctrlKey||event.metaKey);
},{passive:false});
listen(window,"beforeunload",event=>{
  if(menuDrop)dismissArrange();
  if(recovery?.protectExit())return;
  if((editor.dirty&&editor.history.revision>0)||textOverlay.active||recovery?.pending){event.preventDefault();event.returnValue="";}
});
listen(window,"pagehide",()=>{if(menuDrop)dismissArrange();recovery?.protectExit();});
listen(window,"blur",()=>{
  if(!recovery&&!textOverlay.inComposition)textOverlay.finishOutside(null);
  const focused=document.activeElement as HTMLInputElement|null;
  const choosingColor=focused?.type==="color"&&inspector.contains(focused);
  if(!choosingColor)resetInspectorForCanvas();
  paths.cancel();applyInkActions(ink.interrupt(true));space=false;textPointer=undefined;nodeTap=undefined;
  flow.cancel();mind.cancelPointer();editor.resetPointers();updateChrome();invalidate();
});
listen(document,"visibilitychange",()=>{
  frameMeter.setPaused(document.hidden);
  if(!document.hidden)return;
  frameTrace.pause();
  if(menuDrop)dismissArrange();
  if(!recovery)textOverlay.finishOutside(null);
  resetInspectorForCanvas();paths.cancel();applyInkActions(ink.interrupt(true));space=false;textPointer=undefined;nodeTap=undefined;
  flow.cancel();mind.cancelPointer();editor.resetPointers();recovery?.flush(true);updateChrome();invalidate();
});
function ignoreShortcut(target:EventTarget|null){
  return target instanceof Element&&(target===searchClear||Boolean(target.closest("input,textarea,select"))||
    (target as HTMLElement).isContentEditable);
}
function keyboardLayer(target:EventTarget|null):HTMLElement|undefined{
  const row=target instanceof Element?target.closest<HTMLElement>(".layer"):null;
  if(row?.dataset.id&&row.parentElement===layers&&layerRows.has(row.dataset.id))return row;
}
function arrangeCommand(event:KeyboardEvent):ArrangeCommand|undefined{
  if(event.ctrlKey||event.metaKey)return;
  let key=event.key;
  if(event.altKey){
    if(key.length!==1)return;
    // Option can produce a symbol instead of the letter on its key.
    if(/^[a-z]$/i.test(key))key=key.toUpperCase();
    else if(/^Key[A-Z]$/.test(event.code))key=event.code.slice(3);
    else return;
  }else if(event.shiftKey&&key==="{")key="[";
  else if(event.shiftKey&&key==="}")key="]";
  return arrangeBindings.get((event.altKey?"Alt+":"")+(event.shiftKey?"Shift+":"")+key);
}
function typeIntoSelection(first?:string){
  if(reopening||textOverlay.active||!arrangeMenu.hidden||editor.tool!=="select"||editor.busy||space||
    paths.mode||inkArmed||textArmed||mind.armed||mind.pointer||flow.working||flow.mode&&flow.mode!=="connect"||
    editor.selectedIds.length!==1||!editor.selection||editor.selectionLocked||editor.isHidden(editor.selection))return false;
  const item=editor.doc.objects[editor.selection];
  if(item.kind==="table"){if(!tables.startEdit())return false;}
  else if(item.kind==="shape")startFlowLabel(item);
  else if(item.kind==="mindmap"){
    if((editor.selectedTopics.get(item.id)?.size??0)>1)return false;
    if(!mind.selected)enterMind(focusedMapTopic(item)??{mapId:item.id,topicId:item.rootId});
    requestTopic();
  }else if(item.kind==="text")startText(item);
  else return false;
  return textOverlay.beginTyping(first);
}
listen(canvas,"compositionstart",()=>typeIntoSelection());
listen(document,"keydown",event=>{
  if(event.defaultPrevented||textOverlay.active||!arrangeMenu.hidden)return;
  if(event.target===canvas&&(event.key==="Process"||event.key==="Dead"||event.keyCode===229&&(event.key==="Unidentified"||isTextKey(event.key)))){
    // Focus the native field before the IME/dead key delivers the first character.
    // The browser still owns this keystroke and the candidate window.
    typeIntoSelection();return;
  }
  if(event.isComposing||event.keyCode===229||event.getModifierState?.("AltGraph"))return;
  if(event.key==="Escape"&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&event.target instanceof Element&&
    !ignoreShortcut(event.target)&&resetInspectorForCanvas()){event.preventDefault();return;}
  if(ignoreShortcut(event.target))return;
  const onCanvas=event.target===canvas,row=keyboardLayer(event.target);
  if(!onCanvas&&!row)return;
  const cmd=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
  if(row?.dataset.id&&editor.isHidden(row.dataset.id)){
    if(!cmd&&!event.altKey&&(key==="contextmenu"||key==="f10"&&event.shiftKey)){
      const rect=row.getBoundingClientRect();
      if(openArrange(row.dataset.id,{x:rect.left+20,y:rect.top+20},row))event.preventDefault();
    }
    return; // Keep the row's native Enter / Space button activation.
  }
  const plainCommand=cmd&&!event.altKey&&!event.shiftKey;
  const historyKey=dockHistory(event),toolKey=dockTool(key);
  if(paths.mode&&onCanvas){
    if(paths.mode==="anchors"&&historyKey){
      event.preventDefault();if(!event.repeat)changeHistory(historyKey==="redo");return;
    }
    if(paths.mode==="anchors"&&!cmd&&!event.altKey&&!event.shiftKey&&dockContextKey("path-insert",key)){
      event.preventDefault();if(!event.repeat){paths.armInsert();refreshPath();}return;
    }
    if(!cmd&&!event.altKey&&(dockContextKey("path-cancel",key)||dockContextKey("path-finish",key))){
      event.preventDefault();
      if(dockContextKey("path-cancel",key))cancelPathStep();
      else if(!event.repeat){if(paths.inserting){paths.insertMidpoint();refreshPath();}else endPath(false);}
      return;
    }
    if(!cmd&&!event.altKey&&toolKey){
      paths.cancel();refreshPath();
    }else{
      if(historyKey||arrangeCommand(event)||["tab","f2","delete","backspace"," "].includes(key)||key.startsWith("arrow")||
        plainCommand&&["a","c","d","v","x"].includes(key))event.preventDefault();
      if(plainCommand&&key==="s"){event.preventDefault();if(!event.repeat)void save();}
      return;
    }
  }
  if(editor.draggingObjects&&onCanvas){
    if(key==="alt"&&!cmd){editor.setMoveBypass(bypassAlignment(event));event.preventDefault();return;}
    if(key==="escape"&&!cmd){
      nodeTap=undefined;const ids=[...editor.pointers.keys()];
      mind.cancelPointer();editor.cancel();for(const id of ids)releasePathPointer(id);
      event.preventDefault();return;
    }
  }
  if(editor.transforming){
    const canRead=editor.pathTransforming||editor.resizingText;
    if(canRead&&plainCommand&&key==="c")return;
    if(canRead&&plainCommand&&key==="s"){event.preventDefault();if(!event.repeat)void save();return;}
    if(key==="shift")editor.setRotationSnap(true);
    else if(key==="escape"&&!cmd&&!event.altKey){
      const ids=canRead?[...editor.pointers.keys()]:[];
      editor.cancel();for(const id of ids)releasePathPointer(id);
      event.preventDefault();
    }
    else if(historyKey||arrangeCommand(event)||(plainCommand&&["a","c","d","s","v","x"].includes(key))||
      (!cmd&&!event.altKey&&(key.startsWith("arrow")||[" ","tab","enter","f2","delete","backspace","p","t","m","c","r","l","h","v","0"].includes(key))))event.preventDefault();
    return;
  }
  if(ink.drawing){
    if(!cmd&&!event.altKey&&key==="escape"){applyInkActions(ink.interrupt());event.preventDefault();}
    else if(onCanvas&&(historyKey||(plainCommand&&["a","c","d","s","v","x"].includes(key))||
      (!cmd&&!event.altKey&&(event.key===" "||key.startsWith("arrow")))))event.preventDefault();
    return;
  }
  if(key==="escape"&&inkArmed&&!cmd&&!event.altKey){setInkMode(false);event.preventDefault();return;}
  if(onCanvas&&!cmd&&!event.altKey&&!editor.busy&&!reopening&&wholePathMode()&&tables.table&&!editor.selectionLocked){
    const range=tables.range;
    if(range&&key==="escape"){event.preventDefault();tables.select();return;}
    if(range&&(key==="delete"||key==="backspace")){event.preventDefault();tables.clearCells();return;}
    if(range&&(event.key.startsWith("Arrow")||key==="tab")){event.preventDefault();tables.navigate(event.key,event.shiftKey);return;}
    if(key==="f2"||key==="enter"){event.preventDefault();if(!event.repeat)tables.startEdit();return;}
    if(range&&isTextKey(event.key)&&typeIntoSelection(event.key)){event.preventDefault();return;}
  }
  if(toolKey==="tool-ink"&&!cmd&&!event.altKey&&onCanvas){if(!event.repeat)setInkMode(!inkArmed);event.preventDefault();return;}
  if(onCanvas&&!cmd&&!event.altKey&&flow.selectedWaypoint){
    if(key==="escape"){
      const pointerId=flow.pointer?.id;
      flow.cancel();releasePathPointer(pointerId);updateChrome();invalidate();event.preventDefault();return;
    }
    if(key==="delete"||key==="backspace"){
      event.preventDefault();
      if(!event.repeat&&!lockControlsBusy())flow.removeSelectedWaypoint();
      return;
    }
  }
  if(!cmd&&!event.altKey&&(key==="contextmenu"||(key==="f10"&&event.shiftKey))){
    const rect=(row??canvas).getBoundingClientRect();
    const id=row?.dataset.id??editor.selection;
    const point=id?{x:rect.left+20,y:rect.top+20}:{x:rect.left+rect.width/2,y:rect.top+rect.height/2};
    if(openArrange(id,point,row??canvas,onCanvas?flow.selectedWaypoint?.index:undefined))event.preventDefault();
    return;
  }
  if(plainCommand&&key==="a"){
    if(onCanvas&&tables.range&&wholePathMode()&&!editor.busy){event.preventDefault();if(!event.repeat)tables.select();return;}
    // The document guard admitted only the canvas or a current ordinary layer row.
    if(row&&(composingLayerSearch||event.ctrlKey&&event.metaKey))return;
    event.preventDefault();
    if(event.repeat||editor.busy||reopening||row&&(paths.mode||flow.working||mind.pointer||textPointer))return;
    exitMind();setFlowMode();armText(false);editor.setTool("select");editor.selectAll();return;
  }
  const selectionTarget=onCanvas||Boolean(row?.dataset.id&&editor.selectedIds.includes(row.dataset.id));
  if(selectionTarget&&!event.altKey&&cmd&&key==="g"){
    const action=event.shiftKey?"ungroup":"group";
    if(availableGroupActions().includes(action)&&!editor.busy){
      if(event.repeat||invokeGroup(action))event.preventDefault();
    }
    return;
  }
  if(onCanvas&&!cmd&&!event.shiftKey&&!event.altKey&&!editor.busy){
    if(key==="enter"&&editor.selectedGroup&&invokeGroup("enter")){event.preventDefault();return;}
    if(key==="escape"&&editor.editingGroup&&!flow.working&&invokeGroup("leave")){event.preventDefault();return;}
  }
  const arrange=arrangeCommand(event);
  if(arrange){
    if(!selectionTarget||(onCanvas&&mind.active)||reopening||flow.working||mind.pointer||textPointer||!canArrange(editor,arrange))return;
    event.preventDefault();
    if(!event.repeat)arrangeSelection(editor,arrange);
    return;
  }
  if(plainCommand&&key==="s"){event.preventDefault();if(!event.repeat)void save();return;}
  if(plainCommand&&key==="d"&&onCanvas&&editor.selectedIds.length){
    event.preventDefault();
    if(event.repeat||!canvasClipboardReady())return;
    try{if(duplicateClipboardSelection(editor,vault))clipboardStatus("已复制一份所选对象");}
    catch(error){clipboardFailure("无法复制所选对象",error);}
    return;
  }
  if(historyKey){
    event.preventDefault();changeHistory(historyKey==="redo");return;
  }
  if(event.altKey&&!cmd&&!event.shiftKey&&mind.selected&&onCanvas&&(key==="arrowup"||key==="arrowdown")){
    event.preventDefault();reorderTopic(editor,mind.selected,key==="arrowup"?-1:1);return;
  }
  if(cmd||event.altKey)return;
  if(row&&(key==="delete"||key==="backspace")){
    if(selectionTarget&&!reopening&&!flow.working&&!mind.pointer&&!textPointer&&!editor.busy){
      event.preventDefault();if(!event.repeat)deleteBoardSelection(editor);
    }
    return;
  }
  // The layer row is a button first; it keeps its native Space/Enter
  // activation. Only Escape finishes the shared workspace session below.
  if(row&&key!=="escape")return;
  if(onCanvas&&!flow.working){
    if(mind.active){
      if(dockContextKey("mind-child",key)&&!event.shiftKey){event.preventDefault();requestTopic("child");return;}
      if(dockContextKey("mind-sibling",key)){event.preventDefault();requestTopic("sibling",true);return;}
      if(dockContextKey("mind-edit",key)){event.preventDefault();requestTopic();return;}
      if(key==="delete"||key==="backspace"){event.preventDefault();if(!event.repeat)deleteFocusedTopic();return;}
      if(key.startsWith("arrow")&&navigateTopic(key)){event.preventDefault();return;}
    }else if((key==="enter"||key==="f2")&&editor.selectedIds.length===1&&editor.selection&&getMap(editor,editor.selection)){
      const map=getMap(editor,editor.selection)!;
      if((editor.selectedTopics.get(map.id)?.size??0)>1)return;
      event.preventDefault();enterMind(focusedMapTopic(map)??{mapId:map.id,topicId:map.rootId});requestTopic();return;
    }
    if(!reopening&&!inkArmed&&!mind.active&&!mind.armed&&!editor.busy&&(!flow.mode||flow.mode==="connect")&&!textArmed&&!space&&editor.tool==="select"&&editor.selectedIds.length===1&&!event.shiftKey){
      const item=editor.selection?objectById(editor.doc,editor.selection):undefined;
      if(item?.kind==="shape"){
        if(key==="enter"||key==="f2"){event.preventDefault();if(!event.repeat)startFlowLabel(item);return;}
        if(key==="tab"&&!isCard(item)){
          if(event.repeat){event.preventDefault();return;}
          updateScene();
          const pointer=pastePointer?.generation===editor.generation?pastePointer.point:undefined;
          const center=worldToScreen({x:item.at.x+item.width/2,y:item.at.y+item.height/2},editor.camera);
          const cursor=pointer&&Math.hypot(pointer.x-center.x,pointer.y-center.y)>1?screenToWorld(pointer,editor.camera):undefined;
          const line=addDownstream(editor,item,area=>projector.query(area).some(group=>objectById(editor.doc,group.id)?.kind!=="connector"),cursor);
          if(line){
            event.preventDefault();
            const node=editor.selection?objectById(editor.doc,editor.selection):undefined;
            if(node?.kind==="shape")revealFlowNode(node);
            return;
          }
          if(item.shape==="diamond"){event.preventDefault();return;}
        }
      }
    }
  }
  if(event.repeat&&(toolKey||key==="0")){event.preventDefault();return;}
  if(event.key===" "&&onCanvas){space=true;updateChrome();event.preventDefault();}
  else if(key===dockEscapeKey.toLowerCase()){
    event.preventDefault();
    if(nodeTap){nodeTap=undefined;editor.resetPointers();}
    if(textArmed)armText(false);
    else if(mind.pointer){mind.cancelPointer();refreshMind();}
    else if(mind.armed||mind.active)exitMind();
    else if(flow.mode||flow.working||paletteOpen)setFlowMode();
    else if(editor.busy)editor.cancel();else editor.select();
    dismissCanvasPanel();
  }
  else if(key==="delete"||key==="backspace"){
    if(onCanvas&&!flow.working&&(event.repeat||deleteBoardSelection(editor)))event.preventDefault();
  }
  else if(toolKey==="tool-text"){event.preventDefault();armText(true);}
  else if(toolKey==="tool-mind"){event.preventDefault();armMind(!mind.armed);}
  else if(toolKey==="tool-connect"){event.preventDefault();setFlowMode(flow.mode==="connect"?undefined:"connect");}
  else if(toolKey==="shape-process"){event.preventDefault();setFlowMode("process");}
  else if(toolKey==="shape-line"){event.preventDefault();setFlowMode("line");}
  else if(key.startsWith("arrow")&&editor.selectedIds.length&&!flow.working){
    const n=event.shiftKey?10:1;
    const delta:Record<string,Point>={arrowleft:{x:-n,y:0},arrowright:{x:n,y:0},arrowup:{x:0,y:-n},arrowdown:{x:0,y:n}};
    if(!delta[key])return;
    event.preventDefault();editor.moveSelection(delta[key]);
  }
  else if(toolKey==="tool-hand"){event.preventDefault();setInkMode(false);mind.cancelPointer();setFlowMode();armText(false);editor.setTool("hand");}
  else if(toolKey==="tool-select"){event.preventDefault();activateSelectionTool();}
  else if(key==="0"){event.preventDefault();fit();}
  else if(onCanvas&&isTextKey(event.key)&&typeIntoSelection(event.key))event.preventDefault();
});
function releaseSpace(){if(space){space=false;updateChrome();invalidate();}}
listen(document,"keyup",event=>{
  if(event.key===" ")releaseSpace();
  if(event.key==="Alt"&&editor.draggingObjects)editor.setMoveBypass(!snapMoves);
  if(event.key==="Shift"&&editor.transforming)editor.setRotationSnap(false);
});
listen(canvas,"blur",releaseSpace);
function activateSelectionTool(){setInkMode(false);exitMind();setFlowMode();armText(false);editor.setTool("select");}
ui.on("tool-select","click",activateSelectionTool);
ui.on("tool-hand","click",()=>{setInkMode(false);mind.cancelPointer();setFlowMode();armText(false);editor.setTool("hand");});
ui.on("tool-connect","click",()=>setFlowMode(flow.mode==="connect"?undefined:"connect"));
ui.on("tool-shapes","click",()=>{
  setInkMode(false);exitMind();armText(false);const next=!paletteOpen;setFlowMode();paletteOpen=next;updateChrome();invalidate();
});
for(const mode of ["process","decision","triangle","line"] as const)ui.on("shape-"+mode,"click",()=>{
  setFlowMode(mode);canvas.focus({preventScroll:true});
});
function setFlowMode(mode?:FlowMode){
  paths.cancel();
  if(mode){setInkMode(false);exitMind();armText(false);}
  paletteOpen=false;flow.setMode(mode);
  if(mode){editor.cancel();editor.setTool("select");}
  updateChrome();invalidate();
}
ui.on("tool-text","click",()=>{armText(!textArmed||tableArmed||Boolean(cardArmed));canvas.focus({preventScroll:true});});
for(const [id,kind] of [["tool-document","markdown"],["tool-sticky","sticky"]] as const){
  ui.on(id,"click",()=>{armText(cardArmed!==kind,false,kind);canvas.focus({preventScroll:true});});
}
ui.on("tool-table","click",()=>{armText(!tableArmed,true);canvas.focus({preventScroll:true});});
function armText(active:boolean,table=false,card?:CardKind){
  if(active){paths.cancel();setInkMode(false);}
  if(active&&textOverlay.active)textOverlay.close();
  if(active){editor.cancel();flow.cancel(true);mind.reset();paletteOpen=false;}
  tableArmed=active&&table;cardArmed=active?card:undefined;textArmed=active;textPointer=undefined;
  updateChrome();invalidate();
}
function startText(item:TextObject,initial=false,placed?:History){
  if(reopening||editor.busy||textOverlay.active||editor.isLocked(item.id)||editor.isHidden(item.id))return;
  inspectorDraft?.reset();exitMind();setFlowMode();armText(false);editor.setTool("select");dismissCanvasPanel();
  const generation=editor.generation, existing=objectById(editor.doc,item.id);
  if(existing)editor.select(item.id);
  textFormatDraft=item;
  textOverlay.show({...item,...textFrame(item)},(text,_follow,outside)=>{
    const styled=textFormatDraft??item;textFormatDraft=undefined;
    const saved=text!==undefined&&objectById(editor.doc,item.id)===existing&&saveText(editor,generation,styled,text,styled!==item,!existing||initial,placed);
    if(!saved)updateSelectionControls();
    updateChrome();invalidate();
    if(!outside)canvas.focus({preventScroll:true});
  },undefined,false,{kind:"text",id:item.id,...(!existing||initial?{at:item.at}:{})});
  updateSelectionControls();updateChrome();placeOverlay();invalidate();
}

function revealFlowNode(item:ShapeObject){
  const bounds=boxBounds(item),a=worldToScreen(bounds.min,editor.camera),b=worldToScreen(bounds.max,editor.camera);
  const usable=unobstructedWidth(),margin=24,right=usable-margin,bottom=height-86;
  const x=b.x-a.x>right-margin?(usable-a.x-b.x)/2:a.x<margin?margin-a.x:b.x>right?right-b.x:0;
  const y=b.y-a.y>bottom-margin?(height-a.y-b.y)/2:a.y<margin?margin-a.y:b.y>bottom?bottom-b.y:0;
  if(x||y)editor.pan({x,y});
}
function startCard(item:CardObject,screen?:Point,placed?:History){
  if(reopening||editor.busy||textOverlay.active||editor.isLocked(item.id)||editor.isHidden(item.id))return;
  inspectorDraft?.reset();activateSelectionTool();dismissCanvasPanel();
  const generation=editor.generation,existing=objectById(editor.doc,item.id);
  editor.select(existing?item.id:undefined);
  const offset=screen?cardOffsetAt(item,worldToLocal(screenToWorld(screen,editor.camera),item))??0:0;
  textOverlay.showCard(item,(next,outside)=>{
    if(next&&editor.generation===generation&&objectById(editor.doc,item.id)===existing){
      editor.commitEdit({label:(existing?"编辑":"插入")+cardName(item.content.kind),patches:[{op:"putObject",value:next}]},generation,[item.id],placed);
    }
    updateSelectionControls();updateChrome();invalidate();
    if(!outside)canvas.focus({preventScroll:true});
  },offset,!existing);
  updateChrome();placeOverlay();invalidate();
}
function startFlowLabel(item:ShapeObject,screen?:Point){
  if(isCard(item)){startCard(item,screen);return;}
  if(reopening||editor.busy||textOverlay.active||editor.isLocked(item.id)||editor.isHidden(item.id))return;
  inspectorDraft?.reset();dismissCanvasPanel();editor.select(item.id);revealFlowNode(item);
  const generation=editor.generation;
  const label:TextObject={...flowLabelBox(item),kind:"text",id:item.id,text:item.label,
    fontSize:item.labelFontSize??13,color:autoLabelInk("#212735",item.fill),align:"center"};
  textOverlay.show(label,(text,_follow,outside)=>{
    if(text!==undefined&&editor.generation===generation&&objectById(editor.doc,item.id)===item)setFlowNodeLabel(editor,item.id,text);
    updateChrome();invalidate();if(!outside)canvas.focus({preventScroll:true});
  },{kind:"label",fill:item.fill,weight:700,backdrop:()=>view.labelBackdrop(item.id)},true,{kind:"label",id:item.id});
  updateChrome();placeOverlay();invalidate();
}

function changeHistory(redo:boolean){
  if(textOverlay.active||ink.drawing)return;
  const editing=paths.mode==="anchors",id=editing?paths.pointer?.id:undefined;
  flow.cancel();mind.cancelPointer();paths.history(redo);
  releasePathPointer(id);if(editing)canvas.focus({preventScroll:true});refreshPath();
}
ui.on("undo","click",()=>changeHistory(false));
ui.on("redo","click",()=>changeHistory(true));
ui.on("fit","click",fit);
setPressed("drag-snap",snapMoves);
ui.on("drag-snap","click",event=>{
  snapMoves=!snapMoves;setPressed("drag-snap",snapMoves);
  try{window.localStorage?.setItem(snapStorageKey,snapMoves?"on":"off");}catch{/* Session selection still applies. */}
  editor.setMoveBypass(bypassAlignment(event));canvas.focus({preventScroll:true});updateChrome();
});
ui.on("zoom-in","click",()=>{if(!ink.drawing)editor.zoomAt({x:width/2,y:height/2},1.25);});
ui.on("zoom-out","click",()=>{if(!ink.drawing)editor.zoomAt({x:width/2,y:height/2},.8);});
function lockControlsBusy(){
  return reopening||editor.busy||ink.drawing||Boolean(flow.pointer||mind.pointer||paths.pointer||textPointer);
}
function restoreCaption(id:Id):string{
  return editor.hasHiddenEndpoint(id)?"显示连线和端点":"显示此层";
}
function changeVisibility(ids:readonly Id[]|undefined,visible:boolean){
  if(lockControlsBusy())return false;
  inspectorDraft?.reset();flow.cancel();paths.cancel();mind.cancelPointer();nodeTap=undefined;
  const changed=ids?editor.setLayerVisibility(ids,visible):editor.showAllLayers();
  if(changed){
    savedHint=visible?"已显示图层":"已隐藏图层，可在图层面板按名称找回";
    refreshPath();
  }
  return changed;
}
ui.on("layer-hide","click",()=>{
  const id=editor.selection;
  if(id&&changeVisibility(editor.selectedIds,false))(layerElement(id)??searchInput).focus({preventScroll:true});
});
ui.on("layer-show-all","click",()=>{
  if(changeVisibility(undefined,true))searchInput.focus({preventScroll:true});
});
function toggleLayerLocks(on:boolean){
  if(lockControlsBusy()||!editor.selectedIds.length)return;
  inspectorDraft?.reset();flow.cancel();paths.cancel();mind.cancelPointer();nodeTap=undefined;
  if(editor.setLayerLocks(editor.selectedIds,on)){
    savedHint=on?"所选图层已锁定，仅限本次打开":"所选图层已解锁";
    (on?unlockButton:lockButton).focus({preventScroll:true});
  }
  refreshPath();
}
ui.on("layer-lock","click",()=>toggleLayerLocks(true));
ui.on("layer-unlock","click",()=>toggleLayerLocks(false));
ui.on("layer-search-clear","keydown",layerSearchKey);
ui.on("layer-search-clear","click",()=>{
  clearLayerInput();searchInput.focus({preventScroll:true});applyLayerSearch("");
});
ui.on("layer-newer","click",()=>{
  if(layerPage>0){layerPage--;updateLayers();layerPanel.scrollTop=0;}
});
ui.on("layer-older","click",()=>{
  if((layerPage+1)*LAYER_PAGE_SIZE<listedLayers.length){layerPage++;updateLayers();layerPanel.scrollTop=0;}
});
ui.on("layer-locate","click",()=>{
  const id=editor.selection;if(!id)return;
  if(withinLayerPage(id))updateLayers();
  else if(layerTerm){clearLayerInput();applyLayerSearch("",id);}
  showLayer(id,true);
});
function revealLayerObject(id:Id){
  const bounds=projector.selectedBounds([id],displayPatch());if(!bounds)return;
  const a=worldToScreen(bounds.min,editor.camera),b=worldToScreen(bounds.max,editor.camera);
  const right=unobstructedWidth(),bottom=Math.max(1,height-76);
  if(b.x<0||a.x>right||b.y<0||a.y>bottom){
    editor.pan({x:(right-a.x-b.x)/2,y:(bottom-a.y-b.y)/2});
  }
}
ui.on("layers","click",event=>{
  const row=keyboardLayer(event.target);
  if(row?.dataset.id&&!textOverlay.active){
    if(editor.isHidden(row.dataset.id)){changeVisibility([row.dataset.id],true);return;}
    if(paths.mode){paths.cancel();refreshPath();}
    if(mind.active)exitMind();
    editor.select(row.dataset.id,(event as MouseEvent).shiftKey);
    if(panel==="layers"&&editor.selectedIds.length===1)revealLayerObject(row.dataset.id);
    if(tables.table)tables.select();
  }
});

function setPanel(open:WorkspacePanel|undefined) {
  panel=open;
  present(()=>{ui.patch("layers-panel",{hidden:!open});ui.patch("toggle-layers",{"aria-expanded":Boolean(open)});});
  invalidate();
}
function dismissCanvasPanel(){
  if(panel)setPanel(undefined);
}
{
  const toggle=required("toggle-layers"),sheet=layerPanel;
  const close=()=>{setPanel(undefined);toggle.focus({preventScroll:true});};
  ui.on("toggle-layers","click",event=>{
    const open=!panel;
    if(open)formatBar.close();
    setPanel(open?"layers":undefined);
    if(open){
      if(compactProperties.matches)sheet.scrollTop=0;
      if(event.detail===0)searchInput.focus({preventScroll:true});
    }
  });
  ui.on("close-layers","click",close);
  ui.on("layers-panel","keydown",event=>{
    if(event.key==="Escape"&&!event.defaultPrevented&&!event.isComposing&&event.keyCode!==229&&!composingLayerSearch){
      event.preventDefault();close();
    }
  });
}
listen(compactPanels,"change",invalidate);
const historyMenu=required<HTMLDetailsElement>("file-history");
const historyToggle=historyMenu.querySelector("summary")!;
function closeHistory(){
  historyToggle.focus({preventScroll:true});
  historyMenu.open=false;
}
ui.on("file-history","keydown",event=>{
  if(event.key==="Escape"&&historyMenu.open){event.preventDefault();closeHistory();}
});
ui.on("file-history","click",event=>{
  if(event.target instanceof Element&&event.target.closest("button"))closeHistory();
});
ui.on("file-history","focusout",event=>{
  if(event.relatedTarget instanceof Node&&!historyMenu.contains(event.relatedTarget))historyMenu.open=false;
});
listen(document,"pointerdown",event=>{
  if(historyMenu.open&&event.target instanceof Node&&!historyMenu.contains(event.target))historyMenu.open=false;
});
function setCreationTools(open:boolean,restoreFocus=false){
  if(restoreFocus)creationToggle.focus({preventScroll:true});
  present(()=>{
    ui.patch("toggle-creation",{"aria-expanded":open});
    ui.patch("creation-tools",{"data-open":open?"true":undefined});
  });
  invalidate();
}
function creationOpen(){return creationToggle.getAttribute("aria-expanded")==="true";}
ui.on("toggle-creation","click",event=>{
  const open=!creationOpen();
  if(open)formatBar.close();
  setCreationTools(open);
  if(open&&event.detail===0)creationTools.querySelector<HTMLElement>("button:enabled")?.focus({preventScroll:true});
});
ui.on("creation-tools","click",event=>{
  if(creationOpen()&&event.target instanceof Element&&event.target.closest("button")){
    setCreationTools(false,creationTools.contains(document.activeElement));
  }
});
listen(mainDock,"keydown",event=>{
  if(event.key==="Escape"&&creationOpen()){
    event.preventDefault();setCreationTools(false,true);
  }
});
listen(mainDock,"focusout",event=>{
  if(creationOpen()&&event.relatedTarget instanceof Node&&event.relatedTarget!==creationToggle&&!creationTools.contains(event.relatedTarget)){
    setCreationTools(false);
  }
});
listen(document,"pointerdown",event=>{
  if(creationOpen()&&event.target instanceof Node&&!creationTools.contains(event.target)&&!creationToggle.contains(event.target)){
    setCreationTools(false,creationTools.contains(document.activeElement));
  }
});
listen(compactTools,"change",()=>{
  setCreationTools(false,compactTools.matches&&creationTools.contains(document.activeElement));
});

function updateDiagnostics(){
  diagnostics.open=!compactProperties.matches;
  invalidate();
}
updateDiagnostics();
listen(compactProperties,"change",updateDiagnostics);
listen(diagnostics,"toggle",()=>{
  if(compactProperties.matches&&diagnostics.open)formatBar.close();
  invalidate();
});
listen(diagnostics,"keydown",event=>{
  if(event.key==="Escape"&&diagnostics.open&&compactProperties.matches){
    event.preventDefault();diagnosticsToggle.focus({preventScroll:true});diagnostics.open=false;
  }
});
listen(diagnostics,"focusout",event=>{
  if(compactProperties.matches&&event.relatedTarget instanceof Node&&!diagnostics.contains(event.relatedTarget)){
    diagnostics.open=false;
  }
});
listen(document,"pointerdown",event=>{
  if(compactProperties.matches&&event.target instanceof Node&&!diagnostics.contains(event.target)){
    diagnostics.open=false;
  }
});

for(const strip of bottomControls){
  listen(strip,"focusin",event=>{
    const target=event.target;
    if(!(target instanceof HTMLElement)||!target.matches(":focus-visible")||strip.scrollWidth<=strip.clientWidth)return;
    const control=target.closest<HTMLElement>("button,label")??target;
    // Native Tab scrolling can stop as soon as a sliver of a button is visible.
    // Adjust this rail alone, after the browser has placed keyboard focus.
    requestAnimationFrame(()=>{
      if(lifetime.signal.aborted||document.activeElement!==target)return;
      const edge=strip.getBoundingClientRect().left+strip.clientLeft,box=control.getBoundingClientRect();
      const start=box.left-edge-4,end=box.right-edge-strip.clientWidth+4;
      if(start<0)strip.scrollLeft+=start;
      else if(end>0)strip.scrollLeft+=end;
    });
  });
  listen(strip,"wheel",event=>{
    if(event.ctrlKey||event.metaKey||!event.deltaY||Math.abs(event.deltaX)>=Math.abs(event.deltaY)||strip.scrollWidth<=strip.clientWidth)return;
    const pixels=normalizeWheel({x:0,y:event.deltaY},event.deltaMode as 0|1|2,16,{x:strip.clientWidth,y:strip.clientWidth});
    strip.scrollLeft+=pixels.y;event.preventDefault();
  },{passive:false});
}

ui.on("tool-mind","click",()=>armMind(!mind.armed));
ui.on("mind-child","click",()=>requestTopic("child"));
ui.on("mind-sibling","click",()=>requestTopic("sibling"));
ui.on("mind-edit","click",()=>requestTopic());
ui.on("mind-fold","click",()=>{if(mind.selected)foldTopic(editor,mind.selected);});
ui.on("mind-done","click",()=>{exitMind();canvas.focus({preventScroll:true});});
function refreshMind(){
  updateSelectionControls();updateChrome();invalidate();
}
function armMind(active:boolean){
  if(textOverlay.active)return;
  setInkMode(false);
  armText(false);setFlowMode();editor.cancel();editor.setTool("select");
  mind.armCreate(active);dismissCanvasPanel();refreshMind();
}
function exitMind(){
  if(!mind.active&&!mind.armed&&!mind.pointer)return;
  mind.reset();refreshMind();
}
function enterMind(ref:TopicRef){
  setInkMode(false);
  setFlowMode();armText(false);editor.setTool("select");
  if(mind.focus(ref.mapId,ref.topicId)){dismissCanvasPanel();refreshMind();canvas.focus({preventScroll:true});}
}
function chooseTreeTopic(ref:TopicRef):boolean{
  if(lockControlsBusy()||editor.selectedIds.length!==1||editor.selection!==ref.mapId||
    editor.isLocked(ref.mapId)||editor.isHidden(ref.mapId)||!Object.hasOwn(getMap(editor,ref.mapId)?.topics??{},ref.topicId))return false;
  paths.cancel();setInkMode(false);setFlowMode();armText(false);editor.setTool("select");
  if(!mind.focus(ref.mapId,ref.topicId,true))return false;
  const map=getMap(editor,ref.mapId)!;
  const target=topicBox(mind.displayMap(map),ref.topicId);
  if(target)keepTopicVisible(target.box);
  refreshMind();return true;
}
function requestTopic(relation?:TopicRelation,rootRename=false,fromTree=false){
  const focused=mind.selected,map=focused&&getMap(editor,focused.mapId);
  if(!focused||!map||editor.busy||textOverlay.active||mind.pointer)return;
  if(relation==="sibling"&&focused.topicId===map.rootId){
    if(!rootRename)return;
    relation=undefined;
  }
  const draft=topicDraft(editor,focused,relation);
  if(draft)startTopic(draft,fromTree);
}
function startTopic(draft:TopicDraft,fromTree=false){
  if(reopening||textOverlay.active||draft.generation!==editor.generation||editor.isLocked(draft.map.id))return;
  resetInspectorForCanvas();
  const frame=topicBox(mind.displayMap(draft.map,draft.topicId),draft.topicId);
  if(!frame)return;
  keepTopicVisible(frame.box);
  if(draft.before&&draft.newTopic&&motionPreference?.matches&&!document.hidden)
    motion.topics.transition(mind.displayMap(draft.before),mind.displayMap(draft.map,draft.topicId),performance.now());
  mindDraft=draft;
  const returnPanel=fromTree&&panel==="layers";if(returnPanel)dismissCanvasPanel();
  const topic=frame.topic;
  const paint=topicPaint(draft.map,topic,frame,activeTheme);
  const labelBox=topicLabelBox(frame.box,draft.map.scale,frame.depth);
  const item:TextObject={...labelBox,kind:"text",id:topic.id,
    text:topic.text,fontSize:frame.fontSize,color:paint.textColor,align:"center"};
  function layout(value:string):Box{
    const map=withTopicInput(draft.map,draft.topicId,value,draft.newTopic);
    if(mindDraft&&motion.topics.liveRows(map.id))motion.topics.transition(mindDraft.map,mind.displayMap(map,draft.topicId),performance.now());
    mindDraft={...draft,map};
    const row=topicBox(mind.displayMap(map,draft.topicId),draft.topicId);
    invalidate();return row?topicLabelBox(row.box,map.scale,row.depth):labelBox;
  }
  const target:DraftTarget=!draft.before?{kind:"map",id:draft.topicId,mapId:draft.map.id,at:draft.map.origin}:
    draft.addition?{kind:draft.addition.relation,id:draft.topicId,mapId:draft.map.id,relativeTo:draft.addition.relativeTo}:
    {kind:"topic",id:draft.topicId,mapId:draft.map.id};
  textOverlay.show(item,(text,follow,outside)=>{
    const shown=mindDraft?.map;
    mindDraft=undefined;
    if(text===undefined&&shown&&draft.before&&motionPreference?.matches)
      motion.topics.transition(shown,draft.before,performance.now());
    if(!outside&&returnPanel&&draft.generation===editor.generation)setPanel("layers");
    if(text!==undefined){
      let done:boolean;committingTopic=shown;
      try{done=finishTopicDraft(editor,draft,text);}finally{committingTopic=undefined;}
      const map=getMap(editor,draft.map.id);
      if(done||(!draft.newTopic&&map))mind.focus(draft.map.id,draft.topicId);
      if(follow&&map&&(done||!draft.newTopic)&&!(follow==="sibling"&&draft.topicId===map.rootId)){
        refreshMind();requestTopic(follow,false,fromTree);return;
      }
    }
    refreshMind();
    if(!outside){
      if(fromTree&&draft.generation===editor.generation)topicTree.restoreFocus();else canvas.focus({preventScroll:true});
    }
  },{kind:"topic",fill:paint.fill,weight:topicTier(frame.depth).weight,surfaceInk:paint.surfaceInk,autoWidth:topic.appearance?.width===undefined,layout,
    present:()=>{
      const rows=motion.topics.liveRows(draft.map.id),row=rows&&topicBox(draft.map,draft.topicId,rows);
      return row?topicLabelBox(row.box,draft.map.scale,row.depth):undefined;
    }},draft.newTopic,target);
  updateChrome();placeOverlay();invalidate();
}
function keepTopicVisible(box:Box){
  const position=worldToScreen(box.at,editor.camera);
  const zoom=editor.camera.zoom, padding=24, bottom=height-151;
  const right=unobstructedWidth()-padding;
  const x=position.x<padding?padding-position.x:position.x+box.width*zoom>right?right-position.x-box.width*zoom:0;
  const y=position.y<padding?padding-position.y:position.y+box.height*zoom>bottom?bottom-position.y-box.height*zoom:0;
  if(x||y)editor.pan({x,y});
}
function deleteFocusedTopic(current=mind.selected){
  if(!current)return;
  const parent=deleteTopic(editor,current);
  if(parent){mind.focus(current.mapId,parent);refreshMind();}
}
function navigateTopic(key:string):boolean{
  const focused=mind.selected,map=focused&&getMap(editor,focused.mapId);
  if(!focused||!map)return false;
  const target=map.topics[focused.topicId],parent=map.topics[parentIndex(map).get(target.id)??""];
  const i=parent?.childIds.indexOf(target.id)??-1;
  const id=key==="arrowleft"?parent?.id:
    key==="arrowright"?(!mind.displayMap(map).topics[target.id].collapsed?target.childIds[0]:undefined):
    key==="arrowup"?parent?.childIds[i-1]:key==="arrowdown"?parent?.childIds[i+1]:undefined;
  if(id){
    mind.focus(map.id,id);
    const target=topicBox(mind.displayMap(map),id);
    if(target)keepTopicVisible(target.box);
    refreshMind();
  }
  return true;
}

async function save(){
  if(bridgePage){
    if(!liveCommands)return;
    try{await liveCommands.request("save",{baseRevision:liveCommands.status().revision},lifetime.signal);savedHint=editor.dirty?"已保存快照，页面仍有新修改":"已保存到工程文件";}
    catch(error){savedHint=error instanceof Error?error.message:"工程保存失败";}
    if(!lifetime.signal.aborted)updateStatus();
    return;
  }
  // Guard the shortcut as well as the button. A slow or unreadable initial
  // snapshot must never be overwritten with the starter board.
  if(reopening||textOverlay.active||ink.drawing||!canSaveLocally())return;
  const target=writeSlot();if(!target)return;
  const seed=target!=="fallback"&&activeCopy!==target;
  const seedMessage=target==="table"?"另建表格副本？原有画板会保留。":target==="group"?"另建流程组副本？原有画板会保留。":target==="curve"?"另建曲线副本？直线路径、手写和普通画板会保留。":target==="path"?"另建路径副本？旧版画板和手写副本将保留。":target==="ink"?"另建手写副本？旧版画板将保留。":"从旧副本另建当前副本？原来的旧副本会保留。";
  if(seed&&(saving||!window.confirm(seedMessage)))return;
  if(!seed&&unopenedLocalBoard&&(saving||!window.confirm("保存当前画板会覆盖尚未打开的本地画板。仍要覆盖吗？")))return;
  saving++;savedHint=undefined;updateStatus();
  try {
    const snapshot={document:editor.doc,generation:editor.generation,revision:editor.history.revision,names:projectNames};
    const result=await localCopies!.save(target,snapshot,vault);
    if(lifetime.signal.aborted||result.generation!==editor.generation)return;
    importedVersion=undefined;
    if(seed){
      activeCopy=target;
      if(!recoveryChoices.includes(target))recoveryChoices.unshift(target);
    }
    unopenedLocalBoard=false;
    editor.markSaved(result.generation,result.revision);
  } catch(error){
    if(error instanceof SaveConflictError){
      saveConflict=true;
      if(!recoveryChoices.includes(target))recoveryChoices.unshift(target);
    }
    else savedHint="保存失败，画板未丢失";
  } finally{
    saving--;if(!lifetime.signal.aborted)updateStatus();
  }
}
async function reopen(slot=activeCopy??defaultCopy){
  if(reopening||storageRead==="checking"||!slot||!canReplace("放弃当前未保存的修改，打开本地画板？"))return;
  const startRevision=editor.history.revision, startGeneration=editor.generation;
  const priorChoice=requireChoice;
  applyInkActions(ink.interrupt());reopening=true;savedHint=undefined;updateStatus();
  try{
    const copies=await inspectCopies();
    if(lifetime.signal.aborted)return;
    // If a retry found a new divergence while neither copy is chosen, do
    // not infer a choice from the previously generic "reopen" click.
    if(requireChoice&&!priorChoice&&!activeCopy){storageRead="ready";return;}
    const copy=copies[slot];
    if(copy.kind==="failed"||copy.kind==="unavailable"){storageRead="failed";return;}
    const stored=copy.kind==="present"?decodeProject(copy.bytes):undefined;
    storageRead="ready";
    // A successful retry may find a backup that startup couldn't read.
    // If it cannot be adopted without discarding new edits, protect it.
    if(editor.history.revision!==startRevision || editor.generation!==startGeneration){
      if(!activeCopy&&!requireChoice&&!saveConflict){
        activeCopy=slot;
        if(isProtected(slot)&&copy.kind==="present")localCopies!.adoptBaseline(slot,copy.bytes);
      }
      if(activeCopy===slot)unopenedLocalBoard=Boolean(stored);
      savedHint="已有新修改，未切换画板";return;
    }
    if(!stored){
      // Never pin to an empty alternate merely because its former record
      // disappeared, or fall through to an unchosen copy on reopen.
      if(!activeCopy&&!requireChoice&&defaultCopy===slot)activeCopy=slot;
      if(activeCopy===slot)unopenedLocalBoard=false;
      savedHint="此副本没有已保存的画板";return;
    }
    adopt(stored,true);
    activeCopy=slot;
    if(isProtected(slot)&&copy.kind==="present"){localCopies!.adoptBaseline(slot,copy.bytes);saveConflict=false;}
    unopenedLocalBoard=false;
  }catch{
    storageRead="failed";
  }finally{
    reopening=false;if(!lifetime.signal.aborted)updateStatus();
  }
}
ui.on("save","click",()=>void save());
ui.on("open","click",()=>void reopen());
for(const [index,button] of alternateButtons.entries())ui.on(button.id,"click",()=>{
  const slot=alternateCopies(activeCopy??defaultCopy)[index];
  if(slot)void reopen(slot);
});
function restoreTextDraft(draft:TextDraft){
  const t=draft.target;
  if(t.kind==="text"){
    const item=objectById(editor.doc,t.id);
    if(item?.kind==="text")startText(item,Boolean(t.at&&!item.text));
    else if(!item&&t.at)startText({...createText(t.at),id:t.id});
    if(textFormatDraft&&draft.style){
      const s=draft.style;
      const styled=planTextStyle(textFormatDraft,{width:textFormatDraft.width,fontSize:s.fontSize,align:s.align,color:s.color,
        colorMode:s.colorMode,background:s.background??"transparent",fontFamily:s.fontFamily??"system",fontWeight:s.fontWeight??500,italic:s.italic??false});
      if(styled){textFormatDraft=styled;textOverlay.restyle(styled);}
    }
  }else if(t.kind==="card"){
    const existing=objectById(editor.doc,t.id);
    if(!existing||isCard(existing)){
      const base=existing??{...newCard(t.content.kind,t.at),id:t.id};
      startCard({...base,content:t.content,fill:t.fill});
    }
  }else if(t.kind==="cell"){
    if(objectById(editor.doc,t.id)?.kind==="table"){editor.select(t.id);tables.startEdit({row:t.row,col:t.col},t.style);}
  }else if(t.kind==="label"){
    const item=objectById(editor.doc,t.id);if(item?.kind==="shape")startFlowLabel(item);
  }else if(t.kind==="map"){
    if(!objectById(editor.doc,t.mapId))startTopic(newMindDraft(editor,t.at,t.mapId,t.id));
  }else{
    const ref={mapId:t.mapId,topicId:t.kind==="topic"?t.id:t.relativeTo};
    const plan=t.kind==="topic"?topicDraft(editor,ref):topicDraft(editor,ref,t.kind,t.id);
    if(plan)startTopic(plan);
  }
  textOverlay.restoreDraft(draft);
}
async function startBrowserWorkspace(){
  const generation=editor.generation;
  const path=window.location?.pathname;
  let readyRecovery:Promise<WorkspaceData|undefined>|undefined;
  if(path){
    const entry=embeddedProject?path+"#"+editor.doc.id:path;
    const prepared=prepareBrowserRecovery(window,entry,()=>({
      doc:editor.doc,vault,camera:editor.camera,draft:textOverlay.recoverable,names:projectNames,
      lineage:importedVersion??(activeCopy==="table"?6:activeCopy==="group"?5:activeCopy==="curve"?4:activeCopy==="path"?3:activeCopy==="ink"?2:undefined),
    }),updateStatus,()=>ink.drawing||editor.draggingObjects||editor.transforming||Boolean(paths.pointer||flow.pointer||mind.pointer));
    recovery=prepared.recovery;
    textOverlay.onDraftChange=()=>recovery?.changed();
    readyRecovery=prepared.ready.catch(()=>undefined);
  }
  const [copies,stored]=await Promise.all([inspectCopies().catch(()=>undefined),readyRecovery]);
  if(lifetime.signal.aborted)return;
  const edited=editor.generation!==generation||editor.history.revision!==0||Boolean(textOverlay.recoverable);
  const canRestore=!edited&&!textOverlay.active&&(!editor.busy||editor.navigating)&&!reopening&&!paths.mode&&!ink.drawing&&!importing;
  storageRead=copies?"ready":"failed";
  let manual:ProjectPackage|undefined;
  if(copies&&defaultCopy&&!requireChoice){
    const copy=copies[defaultCopy];
    if(copy.kind==="failed")storageRead="failed";
    else try{
      if(copy.kind==="present"){
        manual=decodeProject(copy.bytes);
        if(isProtected(defaultCopy))localCopies!.adoptBaseline(defaultCopy,copy.bytes);
      }
      activeCopy=defaultCopy;
    }catch{storageRead="failed";}
  }
  unopenedLocalBoard=Boolean(manual);
  if(stored){
    if(!canRestore){recovery!.conflict("startup-edited");return;}
    adopt(stored.project,true,stored.head.names,stored.head.draft);
    confirmRecoveredWorkspace=desktop;
    importedVersion=stored.head.lineage??stored.project.document.schemaVersion;
    recovery!.activate(true);return;
  }
  if(manual&&!embeddedProject&&canRestore){adopt(manual,true);unopenedLocalBoard=false;}
  // Manual copies have their own keys and explicit overwrite checks. New edits can be
  // recovered even while the user decides between old copies or retries a manual read.
  recovery?.activate(false,edited);
}

function canReplace(message:string):boolean {
  return (!(editor.dirty&&editor.history.revision>0)&&!textOverlay.active)||window.confirm(message);
}
function adopt(project:ProjectPackage,saved:boolean,names:ProjectNames=project,draft?:TextDraft){
  if(lifetime.signal.aborted)return;
  const staged=new AssetVault(project.assets);
  dismissArrange();
  applyInkActions(ink.interrupt(true));setInkMode(false);
  textOverlay.close();armText(false);setFlowMode();exitMind();imageCache.reset();
  importedVersion=saved?undefined:project.document.schemaVersion;
  vault=staged;editor.open(project.document,saved);
  confirmRecoveredWorkspace=false;
  projectNames=readProjectNames(names);updateProjectHeading();
  if(draft)restoreTextDraft(draft);
  fit();
}
const imagePicker=required<HTMLInputElement>("image-picker");
const projectPicker=required<HTMLInputElement>("project-picker");
const markdownPicker=required<HTMLInputElement>("markdown-picker");
const markdownFile=(file:File)=>/\.(md|markdown)$/i.test(file.name)||file.type==="text/markdown";
ui.on("import-markdown","click",()=>markdownPicker.click());
function markdownOrigin(){return screenToWorld({x:Math.max(20,unobstructedWidth()/2-235*editor.camera.zoom),y:Math.max(20,height/2-130*editor.camera.zoom)},editor.camera);}
ui.on("markdown-picker","change",()=>{
  const file=markdownPicker.files?.[0];markdownPicker.value="";
  if(file)void importMarkdown(file,markdownOrigin());
});
async function importMarkdown(file:File,at:Point){
  if(reopening||textOverlay.active||ink.drawing)return;
  const generation=editor.generation;
  importing++;updateStatus();
  try{
    if(file.size>MAX_CARD_TEXT*4)throw new Error("文件超过文档框可容纳的大小");
    const item=newCard("markdown",at,await file.text());
    if(generation!==editor.generation||reopening||textOverlay.active)return;
    activateSelectionTool();
    if(editor.commitEdit({label:"导入 Markdown 文档",patches:[{op:"putObject",value:item}]},generation,[item.id])){
      savedHint="已导入 "+file.name;canvas.focus({preventScroll:true});
    }
  }catch(error){if(generation===editor.generation)savedHint=error instanceof Error?"导入失败："+error.message:"无法读取 Markdown 文件";}
  finally{importing--;updateStatus();}
}
ui.on("tool-image","click",()=>{setFlowMode();setInkMode(false);armText(false);imagePicker.click();});
ui.on("image-picker","change",()=>{
  const file=imagePicker.files?.[0];imagePicker.value="";
  if(file)void importPicture(file,screenToWorld({x:width/2-62,y:height/2-45},editor.camera));
});
async function importPicture(file:File,at:Point){
  if(reopening||textOverlay.active||ink.drawing)return;
  if(file.size>MAX_IMAGE_BYTES){savedHint="图片过大：单张最多 8 MiB。";updateStatus();return;}
  const generation=editor.generation;
  importing++;savedHint=undefined;updateStatus();
  try{
    const result=await importStandalone({editor,vault,expected:generation,at,read:async()=>new Uint8Array(await file.arrayBuffer()),
      decode:decodeBrowserImage,dispose:releaseBitmap,isCurrent:()=>!reopening&&!textOverlay.active&&!ink.drawing});
    if(result){imageCache.add(result.asset.id,result.handle);savedHint=recovery?"图片已嵌入":"图片已嵌入，画板未保存";recovery?.flush();}
    else if(generation===editor.generation&&!reopening)savedHint="图片导入未完成";
  }catch(error){if(generation===editor.generation)savedHint=error instanceof Error?"导入失败："+error.message:"图片导入失败";}
  finally{importing--;updateStatus();}
}
listen(viewport,"dragover",e=>{
  if(e.dataTransfer?.types.includes("Files")){e.preventDefault();e.dataTransfer.dropEffect="copy";}
});
listen(viewport,"drop",e=>{
  const file=e.dataTransfer?.files[0];
  if(!file)return;
  e.preventDefault();
  const b=canvas.getBoundingClientRect();
  const at=screenToWorld({x:e.clientX-b.left,y:e.clientY-b.top},editor.camera);
  if(markdownFile(file)){textOverlay.finishOutside(null);void importMarkdown(file,at);}
  else void importPicture(file,at);
});
// Clipboard shortcuts belong only to the canvas. Property/text fields keep
// native behavior, and copy/paste use only the trusted event payload.
function canvasClipboardReady(copyOnly=false){
  const preview=editor.preview;
  const groupCopy=copyOnly&&editor.draggingObjects&&editor.doc.flowGroups&&preview&&
    preview.ids.length===editor.selectedIds.length&&preview.ids.every((id,i)=>id===editor.selectedIds[i])&&editor.selectedIds.some(id=>flowGroupOf(editor.doc,id));
  return document.activeElement===canvas&&!reopening&&!textOverlay.active&&!paths.mode&&!ink.drawing&&(!editor.busy||copyOnly&&(editor.pathTransforming||editor.resizingText||groupCopy))&&!textPointer&&!flow.working&&!mind.pointer&&arrangeMenu.hidden;
}
function trustedCanvasClipboard(event:ClipboardEvent,copyOnly=false):boolean{
  return event.isTrusted&&event.cancelable&&!event.defaultPrevented&&event.target===canvas&&canvasClipboardReady(copyOnly);
}
function clipboardStatus(message:string){savedHint=message;updateStatus();}
function clipboardFailure(message:string,error:unknown){
  clipboardStatus(error instanceof Error?message+"："+error.message:message);
}
function registerCanvasCopy(event:ClipboardEvent,report:string){
  if(!event.clipboardData)return false;
  const fragment=captureClipboard(editor.doc,editor.selectedIds,vault,editor.hiddenIds,editor.selectedTopics);
  if(!fragment)return false;
  event.clipboardData.setData("text/plain",encodeClipboard(fragment));
  event.preventDefault();
  clipboardStatus(report);return true;
}
listen(canvas,"copy",event=>{
  if(!trustedCanvasClipboard(event,true)||!editor.selectedIds.length)return;
  if(tables.copy(event))return;
  try{if(!registerCanvasCopy(event,"已向剪贴板提交所选对象"))clipboardStatus("未获得可写的剪贴板");}
  catch(error){clipboardFailure("无法复制所选对象",error);}
});
listen(canvas,"cut",event=>{
  if(!trustedCanvasClipboard(event)||!editor.selectedIds.length)return;
  if(tables.copy(event,true))return;
  // Event data can stage an OS copy, but has no commit acknowledgement.
  // For deletion require the browser's writable Clipboard API promise.
  let cut:ReturnType<typeof prepareClipboardCut>;
  try{cut=prepareClipboardCut(editor,vault);}catch(error){event.preventDefault();clipboardFailure("无法剪切所选对象",error);return;}
  event.preventDefault();
  if(!cut){clipboardStatus("此次剪切涉及锁定或隐藏图层，已保留原对象");return;}
  let clipboard:Clipboard|undefined;
  try{clipboard=window.navigator?.clipboard;}catch{/* unavailable in this origin */}
  if(typeof clipboard?.writeText!=="function"){
    try{
      if(event.clipboardData){event.clipboardData.setData("text/plain",cut.payload);clipboardStatus("当前环境仅提交复制，未剪切");}
      else clipboardStatus("此环境不支持剪切；所选对象未删除");
    }catch(error){clipboardFailure("此环境不支持剪切；所选对象未删除",error);}
    return;
  }
  const prepared=cut;
  void (async()=>{
    try{
      await clipboard.writeText(prepared.payload);
      const applied=!paths.mode&&!ink.drawing&&!reopening&&!textOverlay.active&&prepared.remove();
      clipboardStatus(applied?"已剪切所选对象":"选择、锁定或画板已变化，未删除对象");
    }catch(error){clipboardFailure("剪贴板写入失败，未删除对象",error);}
  })();
});
let pastePointer:{point:Point;generation:symbol}|undefined;
function rememberPastePointer(event:PointerEvent|WheelEvent){
  const point=local(event);
  pastePointer=!("pointerType" in event&&event.pointerType==="touch")&&point.x>=0&&point.y>=0&&point.x<width&&point.y<height?{point,generation:editor.generation}:undefined;
  placement.track(pastePointer?.point);
  if(textArmed||flow.shapeTool)placement.paint(editor.camera,space||editor.busy||reopening,flow.shapePointer);
}
listen(canvas,"pointerenter",rememberPastePointer);
listen(canvas,"pointerdown",rememberPastePointer);
listen(canvas,"pointermove",rememberPastePointer);
listen(canvas,"wheel",rememberPastePointer,{passive:true});
listen(canvas,"pointerleave",e=>{
  pastePointer=undefined;
  if(!(cardArmed==="sticky"&&e.relatedTarget instanceof Node&&stickyPalette.contains(e.relatedTarget)))placement.track();
});
ui.on("sticky-palette","pointerleave",e=>{if(e.relatedTarget!==canvas)placement.track();});
ui.on("sticky-palette","keydown",e=>{
  if(e.key==="Escape"){e.preventDefault();armText(false);canvas.focus({preventScroll:true});}
});
listen(window,"blur",()=>{pastePointer=undefined;placement.track();});
listen(canvas,"blur",()=>{pastePointer=undefined;});
listen(canvas,"paste",event=>{
  const data=event.clipboardData;
  if(!trustedCanvasClipboard(event)||!data)return;
  // Capture the file synchronously from the event. A screenshot may include a
  // parallel text representation: paste only its image, never HTML or image URLs.
  let picture:File|null|undefined;
  for(const item of Array.from(data.items??[])){
    if(item.kind==="file"&&item.type.startsWith("image/")&&(picture=item.getAsFile()))break;
  }
  picture??=Array.from(data.files??[]).find(file=>file.type.startsWith("image/"));
  const plain=data.getData("text/plain");
  // A canvas envelope carries the original objects even if another application supplies a bitmap preview.
  const canvasObject=isCanvasClipboardText(plain);
  if(canvasObject)picture=undefined;
  if(!picture&&tables.paste(plain,data,canvasObject)){
    event.preventDefault();return;
  }
  const markdownSource=!picture&&!canvasObject&&data.types?.includes("text/markdown")?data.getData("text/markdown"):"";
  const value=picture?"":markdownSource||plain;
  if(!picture&&!value.trim())return;
  event.preventDefault();
  let fragment;
  try{if(!picture)fragment=decodeClipboard(value);}
  catch(error){clipboardFailure("剪贴板中的画布对象无法读取",error);return;}
  const normalized=value.replace(/\r\n?/g,"\n"),markdown=!picture&&!fragment&&Boolean(markdownSource||hasMarkdown(normalized));
  if(!picture&&!fragment&&normalized.length>(markdown?MAX_CARD_TEXT:MAX_TEXT_LENGTH)){
    savedHint="文字过长：最多 "+(markdown?MAX_CARD_TEXT:MAX_TEXT_LENGTH)+" 个字符。";updateStatus();return;
  }
  const generation=editor.generation;
  const last=pastePointer?.generation===generation?pastePointer.point:undefined;
  const screen=last&&last.x<width&&last.y<height?last:{x:width/2,y:height/2};
  const at=screenToWorld(screen,editor.camera);
  setInkMode(false);exitMind();setFlowMode();armText(false);editor.setTool("select");
  if(picture)void importPicture(picture,at);
  else if(fragment){
    try{if(pasteClipboard(editor,vault,fragment,{anchor:at,expected:generation}))clipboardStatus("已粘贴画布对象");}
    catch(error){clipboardFailure("无法粘贴画布对象",error);}
  }else if(markdown){
    const card=newCard("markdown",at,normalized);
    if(editor.commitEdit({label:"粘贴 Markdown 文档",patches:[{op:"putObject",value:card}]},generation,[card.id]))clipboardStatus("Markdown 文档已粘贴");
  }else if(saveText(editor,generation,createText(at),value)){
    savedHint=recovery?"文字已粘贴":"文字已粘贴，画板未保存";updateStatus();
  }
});
ui.on("project-open","click",()=>{if(!reopening)projectPicker.click();});
ui.on("project-picker","change",()=>{
  const file=projectPicker.files?.[0];projectPicker.value="";
  if(file){if(markdownFile(file))void importMarkdown(file,markdownOrigin());else void openProjectFile(file);}
});
async function openProjectFile(file:File){
  if(bridgePage||reopening||!canReplace("放弃当前编辑并打开这个项目？"))return;
  if(file.size>MAX_PROJECT_CHARS){savedHint="项目文件过大。";updateStatus();return;}
  await importProject(file.name,()=>file.text());
}
async function openDesktopProject(fileName:string,encoded:string):Promise<CanvasToolPayload>{
  const blockers=canvasBlockers();
  if(blockers.length)return {ok:false,code:"BUSY",message:"请先结束当前编辑或文件操作。",blockingReasons:blockers};
  const message="放弃当前编辑并打开这个项目？";
  if(!(confirmRecoveredWorkspace?window.confirm(message):canReplace(message))){
    return {ok:false,code:"CANCELLED",message:"已取消打开项目。"};
  }
  return importProject(fileName,()=>encoded,true);
}
async function importProject(fileName:string,read:()=>string|Promise<string>,external=false):Promise<CanvasToolPayload>{
  const generation=editor.generation, revision=editor.history.revision;
  applyInkActions(ink.interrupt());reopening=true;savedHint=undefined;updateStatus();
  function stillCurrent(){
    lifetime.signal.throwIfAborted();
    return generation===editor.generation&&revision===editor.history.revision&&
      (!external||!canvasBlockers().some(reason=>reason!=="REOPENING"));
  }
  function changed():CanvasToolPayload{
    savedHint="已有新修改，未切换画板";
    return {ok:false,code:"BUSY",message:savedHint};
  }
  try{
    const bytes=await read();
    if(!stillCurrent())return changed();
    const project=decodeProject(bytes.charCodeAt(0)===0xfeff?bytes.slice(1):bytes);
    for(const {meta,bytes} of project.assets){
      if(!stillCurrent())return changed();
      const decoded=await decodeBrowserImage(bytes,{mime:meta.mime,width:meta.pixelWidth,height:meta.pixelHeight});
      releaseBitmap(decoded.handle);
      if(decoded.width!==meta.pixelWidth||decoded.height!==meta.pixelHeight)throw new Error("项目图片尺寸不一致。");
    }
    if(!stillCurrent())return changed();
    adopt(project,false,{title:project.title,fileName});
    if((activeCopy==="table"&&importedVersion===6||activeCopy==="group"&&importedVersion===5||activeCopy==="path"&&importedVersion===3||activeCopy==="curve"&&importedVersion===4)&&
      localCopies!.baseline(activeCopy)!==undefined&&localCopies!.baseline(activeCopy)!==bytes)unopenedLocalBoard=true;
    if(external)canvas.focus({preventScroll:true});
    savedHint="项目已打开";recovery?.flush();
    return {ok:true,revision:currentLocalCommands().status().revision,fileName};
  }catch(error){
    if(external)lifetime.signal.throwIfAborted();
    savedHint=error instanceof Error?"打开失败："+error.message:"无法打开项目。";
    return {ok:false,code:"INVALID",message:savedHint};
  }
  finally{reopening=false;updateStatus();}
}
ui.on("project-export","click",()=>{
  if(reopening||textOverlay.active)return;
  try{
    const encoded=encodeProject(editor.doc,vault,{title:projectNames.title});
    const url=URL.createObjectURL(new Blob([encoded],{type:"application/json"}));
    const link=node("a");
    link.href=url;link.download=editor.doc.id+".mgcanvas";
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30_000);
    savedHint="已生成项目下载";
  }catch(error){savedHint=error instanceof Error?error.message:"无法导出项目。";}
  updateStatus();
});

const inspectorBlocker=watchInspector(inspector,lifetime.signal);
function canvasBlockers(){
  const reasons:BlockReason[]=[];
  if(reopening)reasons.push("REOPENING");
  if(saving)reasons.push("SAVING");
  if(importing)reasons.push("IMPORTING");
  if(editor.busy||flow.pointer||mind.pointer||paths.pointer||textPointer)reasons.push("POINTER_GESTURE");
  if(ink.drawing)reasons.push("INK_STROKE");
  if(flow.working)reasons.push("FLOW_EDIT");
  if(paths.mode)reasons.push(paths.points.length||paths.preview?"PATH_DRAFT":"PATH_TOOL");
  if(textOverlay.active)reasons.push("TEXT_EDITOR");
  if(mindDraft)reasons.push("MIND_TOPIC_DRAFT");
  if(editor.preview)reasons.push("PROPERTY_PREVIEW");
  const inspectorReason=inspectorBlocker();
  if(inspectorReason)reasons.push(inspectorReason);
  return reasons;
}
let localCommands:ReturnType<typeof createLiveCommands>|undefined,commandGeneration:symbol|undefined;
function currentLocalCommands(){
  if(!localCommands||commandGeneration!==editor.generation){
    commandGeneration=editor.generation;
    localCommands=createLiveCommands({editor,vault,names:projectNames,epoch:allocateId("page"),busy:canvasBlockers,focusedTopic:()=>mind.selected});
  }
  return localCommands;
}
const canvasTools=createCanvasTools({editor,vault:()=>vault,scene:projector,focusedTopic:()=>mind.selected,
  boardTitle:()=>ui.control("project-title").read().caption||editor.doc.id,
  size:action=>{
    // A tool can navigate immediately after a CSS resize, before ResizeObserver runs.
    if(action||fitPending)size();
    return canvasViewport(action==="view");
  },
  live:()=>{
    if(bridgePage)return liveCommands??reject("BUSY","The authorized page has not finished opening");
    return currentLocalCommands();
  }});
if(embeddedProject)adopt(decodeProject(embeddedProject),false);
if(!bridgePage){
  const ready=startBrowserWorkspace().finally(()=>{if(lifetime.signal.aborted)return;updateStatus();void exposeCanvasTools(window,document,canvasTools,lifetime.signal);});
  if(desktop)attachDesktopBridge({signal:lifetime.signal,ready,tools:canvasTools,open:openDesktopProject,snapshot:()=>{
    const {project,revision}=currentLocalCommands().snapshot();
    return {ok:true,encoded:project,revision,...(projectNames.fileName?{fileName:projectNames.fileName}:{})};
  }});
}
if(bridgePage){
  document.body.inert=true;
  cleanups.push(()=>{document.body.inert=false;});
  void attachBridge({
    editor,tools:canvasTools,signal:lifetime.signal,vault:()=>vault,open:(project,saved)=>adopt(project,saved),focusedTopic:()=>mind.selected,busy:canvasBlockers,
    hint:value=>{savedHint=value;updateStatus();},
  }).then(connected=>{
    if(lifetime.signal.aborted)return;
    liveCommands=connected;document.body.inert=false;updateStatus();void exposeCanvasTools(window,document,canvasTools,lifetime.signal);
  }).catch(error=>{if(lifetime.signal.aborted)return;savedHint="桥接连接失败："+error.message;updateStatus();});
}
mounted=true;
return ()=>{
  recovery?.dispose();
  lifetime.abort();
  for(const dispose of cleanups.reverse())dispose();
  mounted=false;
  clearTimeout(cameraSettle);frameMeter.dispose();
  imageCache.reset();cameraRaster.clear();motion.clear();
  releaseProperties();
  ui.reset();
};
}
