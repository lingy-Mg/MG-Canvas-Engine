import type {CanvasTools} from "../platform/canvas-tools.ts";

type ModelContext={registerTool:(definition:Record<string,unknown>,options:{signal:AbortSignal})=>Promise<void>|void};
type WithContext={modelContext?:ModelContext};
export async function exposeCanvasTools(host:Window,doc:Document,tools:CanvasTools,lifetime?:AbortSignal){
  if(lifetime?.aborted)return;
  const controller=new AbortController();
  const facade:CanvasTools=lifetime?{
    listTools:()=>tools.listTools(),
    callTool:(name,args,signal)=>tools.callTool(name,args,signal?AbortSignal.any([lifetime,signal]):lifetime),
  }:tools;
  Object.defineProperty(host,"mgCanvasTools",{value:Object.freeze(facade),configurable:true});
  const hide=(event:PageTransitionEvent)=>{if(!event.persisted)dispose();};
  function dispose(){
    controller.abort();
    host.removeEventListener("pagehide",hide);
    lifetime?.removeEventListener("abort",dispose);
    if(Object.getOwnPropertyDescriptor(host,"mgCanvasTools")?.value===facade)Reflect.deleteProperty(host,"mgCanvasTools");
  }
  lifetime?.addEventListener("abort",dispose,{once:true});
  host.addEventListener("pagehide",hide);
  try{
    // Current Chrome exposes document.modelContext. Early implementations used navigator.
    const current=(doc as Document&WithContext).modelContext;
    const context=typeof current?.registerTool==="function"?current:(host.navigator as Navigator&WithContext|undefined)?.modelContext;
    if(typeof context?.registerTool!=="function")return;
    for(const tool of tools.listTools()){
      if(controller.signal.aborted)return;
      await context.registerTool({...tool,annotations:{...tool.annotations,untrustedContentHint:tool.name==="canvas_read"},
        execute:async(args:unknown,client?:{signal?:AbortSignal})=>{
          const reply=await facade.callTool(tool.name,args,client?.signal);
          // Chrome hides thrown error details behind OperationError. Keep repairable failures readable.
          return reply.structuredContent;
        }},{signal:controller.signal});
    }
  }catch(error){
    if(controller.signal.aborted)return;
    controller.abort();
    console.warn("Canvas WebMCP registration is unavailable",error);
  }
}
