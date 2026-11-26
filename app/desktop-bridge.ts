import {invoke,isTauri} from "@tauri-apps/api/core";
import {isRecord} from "../core/document.ts";
import {CommandError} from "../features/board-commands.ts";
import type {CanvasToolPayload,CanvasTools} from "../platform/canvas-tools.ts";
import {readProjectNames} from "../platform/project.ts";

type Job={id:string;action:string;args:unknown};
type Invoke=typeof invoke;
type Hooks={
  signal:AbortSignal;
  ready:Promise<void>;
  tools:CanvasTools;
  open:(fileName:string,encoded:string)=>Promise<CanvasToolPayload>;
  snapshot:()=>CanvasToolPayload;
};

async function dispatch(job:Job,hooks:Hooks):Promise<CanvasToolPayload>{
  const args=job.args;
  try{
    if(!isRecord(args))return {ok:false,code:"INVALID",message:"桌面请求必须提供参数对象。"};
    switch(job.action){
      case "tools":return {ok:true,tools:hooks.tools.listTools()};
      case "call":
        if(typeof args.name!=="string")return {ok:false,code:"INVALID",message:"桌面请求缺少工具名称。"};
        return (await hooks.tools.callTool(args.name,args.arguments,hooks.signal)).structuredContent;
      case "open":{
        const {fileName}=readProjectNames(args);
        if(!fileName||typeof args.encoded!=="string")return {ok:false,code:"INVALID",message:"桌面打开请求缺少项目名称或内容。"};
        return await hooks.open(fileName,args.encoded);
      }
      case "snapshot":return hooks.snapshot();
      default:return {ok:false,code:"INVALID",message:"未知的桌面操作。"};
    }
  }catch(error){
    if(hooks.signal.aborted&&error===hooks.signal.reason)throw error;
    return {ok:false,code:error instanceof CommandError?error.code:"INVALID",message:error instanceof Error?error.message:String(error)};
  }
}

// A document owns one poll, including across editor mounts. Keep any delivered job
// until a ready editor can receive it, and retry an interrupted acknowledgement by ID.
export function createDesktopBridge(transport:Invoke){
  let receiver:{hooks:Hooks;ready:boolean}|undefined;
  let polling=false;
  let pending:{job:Job;result?:CanvasToolPayload}|undefined;
  const runnable=()=>receiver?.ready||Boolean(receiver&&pending?.result);
  async function poll(){
    if(polling||!runnable())return;
    polling=true;
    try{
      while(runnable()){
        const hooks=receiver!.hooks;
        try{
          if(!pending){
            const job=await transport<Job|null>("desktop_next");
            if(job)pending={job};
            else{
              await pause(125,hooks.signal);
              continue;
            }
          }
          // The next reply may have arrived during an unmount or while recovery is pending.
          if(!pending.result){
            if(!receiver?.ready)break;
            const current=receiver.hooks;
            try{pending.result=await dispatch(pending.job,current);}
            catch(error){
              if(current.signal.aborted&&error===current.signal.reason)continue;
              throw error;
            }
          }
          await transport("desktop_complete",{id:pending.job.id,result:pending.result});
          pending=undefined;
        }catch{
          await pause(750,hooks.signal);
        }
      }
    }finally{polling=false;}
  }
  return (hooks:Hooks)=>{
    if(hooks.signal.aborted)return;
    const mounted={hooks,ready:false};
    receiver=mounted;
    hooks.signal.addEventListener("abort",()=>{if(receiver===mounted)receiver=undefined;},{once:true});
    void hooks.ready.then(()=>{
      if(receiver!==mounted)return;
      mounted.ready=true;
      void poll();
    },()=>{if(receiver===mounted)receiver=undefined;});
  };
}

function pause(ms:number,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{
    const timer=setTimeout(done,ms);
    function done(){
      clearTimeout(timer);
      signal.removeEventListener("abort",done);
      resolve();
    }
    signal.addEventListener("abort",done,{once:true});
  });
}

export const isDesktopWorkbench=isTauri;
export const attachDesktopBridge=createDesktopBridge(invoke);
