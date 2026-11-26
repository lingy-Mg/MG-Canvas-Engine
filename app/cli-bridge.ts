import { createLiveCommands } from "../platform/live-commands.ts";
import type { BlockReason } from "../platform/live-commands.ts";
import { CommandError } from "../features/board-commands.ts";
import type { AssetVault } from "../features/image-assets.ts";
import type { EditorSession } from "../session/editor.ts";
import type { ProjectPackage } from "../platform/project.ts";
import type {CanvasTools} from "../platform/canvas-tools.ts";
import {propertyInputSelector,propertyInputValue,synchronizedPropertyValue} from "./property-draft.ts";
import {authorizedBridgePage,pollBridgePage} from "./bridge-page.ts";

/** Keep unfinished inspector values protected even after keyboard focus leaves that field. */
export function watchInspector(inspector:HTMLElement,signal:AbortSignal) {
  const initial = new WeakMap<Element,string>();
  inspector.addEventListener("focusin", event=>{
    const el = event.target;
    if (el instanceof Element && el.matches(propertyInputSelector) && !initial.has(el)) initial.set(el,propertyInputValue(el));
  },{signal});
  return () => {
    if (Array.from(inspector.querySelectorAll(propertyInputSelector)).some(el=>initial.has(el) &&
      (synchronizedPropertyValue(el)??initial.get(el))!==propertyInputValue(el))) return "INSPECTOR_DRAFT" as const;
    const focused=inspector.ownerDocument.activeElement;
    if (focused?.matches(propertyInputSelector) && inspector.contains(focused)) return "INSPECTOR_FOCUS" as const;
  };
}

type Hooks = {signal?:AbortSignal;editor:EditorSession; tools:CanvasTools; vault:()=>AssetVault; busy:()=>readonly BlockReason[]; focusedTopic:()=>{mapId:string;topicId:string}|undefined; open:(project:ProjectPackage,saved:boolean)=>void; hint:(value:string)=>void};
export async function attachBridge(hooks:Hooks) {
  await Promise.resolve();
  hooks.signal?.throwIfAborted();
  const page=authorizedBridgePage(),initial=await page.ready;
  await page.saving?.catch(()=>{});
  hooks.signal?.throwIfAborted();
  if(page.receiver)throw new CommandError("CONFLICT","已有编辑器绑定此页面");
  const project=initial.project;
  hooks.open(project,initial.saved);
  // The new editor has a new local history. Reject retries against a previous mount's revision.
  page.mounts++;
  const epoch=page.mounts===1?initial.epoch:initial.epoch+".mount"+page.mounts;
  const live=createLiveCommands({editor:hooks.editor,vault:hooks.vault(),names:{title:project.title,fileName:project.fileName},epoch,busy:hooks.busy,focusedTopic:hooks.focusedTopic,
    save:async(encoded,revision)=>{
      hooks.signal?.throwIfAborted();
      const document=hooks.editor.doc;
      const saving=page.post("/page/save",{project:encoded,revision,diskRevision:initial.diskRevision}).then(({diskRevision})=>{
        initial.diskRevision=diskRevision;
        if(!page.receiver&&initial.project.document===document)initial.saved=true;
        return {diskRevision};
      });
      page.saving=saving;
      try{return await saving;}finally{page.saving=undefined;}
    }});
  hooks.signal?.addEventListener("abort",()=>{
    const document=hooks.editor.doc,vault=hooks.vault();
    // Only immutable project data is retained between mounts, including unsaved edits and their images.
    if(document!==project.document)initial.project={title:project.title,fileName:project.fileName,document,
      assets:Object.keys(document.assets).map(id=>vault.get(id)!)};
    initial.saved=!hooks.editor.dirty;
    page.receiver=undefined;
  },{once:true});
  page.receiver={
    async dispatch(job){
      try {
        let data;
        if(job.command==="tools/list")data={tools:hooks.tools.listTools()};
        else if(job.command==="tools/call")data=await hooks.tools.callTool(String(job.args?.name??""),job.args?.arguments,hooks.signal);
        else data=await live.request(job.command,job.args,hooks.signal);
        return {ok:true,data};
      }
      catch(error) { return {ok:false,code:error instanceof CommandError?error.code:"INVALID",message:error instanceof Error?error.message:String(error),revision:live.status().revision}; }
    },
    disconnected:()=>hooks.hint("桥接已断开。可导出当前页面的工程以保留修改。"),
  };
  pollBridgePage(page,initial.epoch);
  return live;
}
