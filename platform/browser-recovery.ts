import {WorkspaceRecovery} from "./workspace-recovery.ts";
import {workspaceBackend} from "./workspace-store.ts";
import type {WorkspaceFrame} from "./workspace-store.ts";

export function prepareBrowserRecovery(host:Window,entry:string,capture:()=>WorkspaceFrame,notify:()=>void,held:()=>boolean){
  let journal:Storage|undefined;
  try{journal=host.localStorage;}catch{/* Recovery can still use IndexedDB. */}
  const recovery=new WorkspaceRecovery(entry,journal,capture,notify,held);
  return {recovery,ready:recovery.prepare(workspaceBackend(host,entry))};
}
