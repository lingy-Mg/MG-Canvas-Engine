import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "./project.ts";
import {checkedHead,checkedProject} from "./workspace-store.ts";
import type {WorkspaceChanges,WorkspaceData,WorkspaceFrame,WorkspaceHead,WorkspaceStore} from "./workspace-store.ts";

const delay=280,maxDelay=1400;
const unique=()=>Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,"0")).join("");
type State="starting"|"ready"|"pending"|"saved"|"failed"|"conflict"|"startup-edited"|"unavailable";
function changes(frame:WorkspaceFrame,prior?:WorkspaceFrame):WorkspaceChanges {
  return {document:frame.doc!==prior?.doc,assets:frame.vault!==prior?.vault||frame.doc.assets!==prior?.doc.assets};
}
function sameFrame(a:WorkspaceFrame,b:WorkspaceFrame|undefined):boolean {
  if(!b||a.doc!==b.doc||a.vault!==b.vault||a.lineage!==b.lineage||a.names?.title!==b.names?.title||a.names?.fileName!==b.names?.fileName||a.camera.zoom!==b.camera.zoom||
    a.camera.offset.x!==b.camera.offset.x||a.camera.offset.y!==b.camera.offset.y)return false;
  const d=a.draft,p=b.draft;
  return d===p||Boolean(d&&p&&d.value===p.value&&d.start===p.start&&d.end===p.end&&
    JSON.stringify(d.target)===JSON.stringify(p.target)&&JSON.stringify(d.style)===JSON.stringify(p.style));
}

/** One writer per page. The IndexedDB head is the authority across page and process lifetimes. */
export class WorkspaceRecovery {
  state:State="starting";
  private store?:WorkspaceStore;
  private base:string|null=null;
  private last?:WorkspaceFrame;
  private writing?:{frame:WorkspaceFrame;head:WorkspaceHead};
  private serial=0;
  private durable=0;
  private journal?:{serial:number;parents:(string|null)[]};
  private armed=false;
  private disposed=false;
  private retryJournal=false;
  private timer?:ReturnType<typeof setTimeout>;
  private first=0;
  private prefix:string;
  private ownKey:string;
  private storage?:Storage;
  private capture:()=>WorkspaceFrame;
  private notify:()=>void;
  private inGesture:()=>boolean;
  constructor(entry:string,storage:Storage|undefined,capture:()=>WorkspaceFrame,notify:()=>void,inGesture:()=>boolean){
    this.prefix="mg-canvas:workspace-exit:"+encodeURIComponent(entry)+":";
    this.ownKey=this.prefix+unique();this.storage=storage;this.capture=capture;this.notify=notify;this.inGesture=inGesture;
  }
  private status(value:State){if(value!==this.state){this.state=value;if(!this.disposed)this.notify();}}
  get pending(){return this.serial!==this.durable;}
  /** A closing page leaves a synchronous, parent-tagged record until the browser finishes its transaction. */
  private journals(saved:WorkspaceData|undefined){
    const found:{key:string;time:number;data:WorkspaceData;changes:WorkspaceChanges}[]=[],s=this.storage;
    if(!s)return found;
    let keys:string[];
    try{keys=Array.from({length:s.length},(_,i)=>s.key(i)).filter((k):k is string=>!!k&&k.startsWith(this.prefix));}catch{return found;}
    for(const key of keys){try{
      const row=JSON.parse(s.getItem(key)??"null"),head=checkedHead(row.head);
      if(head.token===saved?.head.token){s.removeItem(key);continue;}
      if(!Array.isArray(row.parents)||!row.parents.includes(saved?.head.token??null)){
        if(Date.now()-row.time>7*86400000)s.removeItem(key);
        continue;
      }
      const project=typeof row.project==="string"?decodeProject(row.project):row.document&&saved?
        checkedProject(row.document,saved.project.assets):saved?.project;
      if(project&&Number.isFinite(row.time))found.push({key,time:row.time,data:{head,project},
        changes:{document:typeof row.project==="string"||row.document!==undefined,assets:typeof row.project==="string"}});
    }catch{/* A torn or unavailable exit record cannot displace a verified checkpoint. */}}
    return found.sort((a,b)=>b.time-a.time||b.key.localeCompare(a.key));
  }
  async prepare(backend:Promise<WorkspaceStore>):Promise<WorkspaceData|undefined>{
    try{
      const store=await backend;
      if(this.disposed){store.close?.();return;}
      this.store=store;
      while(!this.disposed){
        const saved=await store.read();
        if(this.disposed)return;
        this.base=saved?.head.token??null;
        const journal=this.journals(saved)[0];if(!journal)return saved;
        const {project,head}=journal.data;
        const frame={doc:project.document,vault:new AssetVault(project.assets),camera:head.camera};
        try{
          if(!await store.write(this.base,head,frame,journal.changes))continue;
          this.base=head.token;
          try{this.storage?.removeItem(journal.key);}catch{}
        }catch{this.retryJournal=true;}
        return this.disposed?undefined:journal.data;
      }
    }catch(error){if(this.disposed)return;this.status("unavailable");throw error;}
  }
  activate(restored:boolean,edited=false){
    if(this.disposed||!this.store||this.state==="unavailable")return;
    this.armed=true;
    if(restored&&!this.retryJournal)this.last=this.capture();
    this.status(restored?"saved":"ready");
    if(edited||this.retryJournal)this.changed();
  }
  conflict(reason:"conflict"|"startup-edited"="conflict"){this.armed=false;clearTimeout(this.timer);this.status(reason);}
  /** Only document and draft edits start the timer. Capture samples the live camera when that edit is saved. */
  changed(){
    if(this.disposed||!this.armed)return;
    this.serial++;this.status("pending");
    this.first||=Date.now();
    if(!this.writing)this.schedule(Math.max(0,Math.min(delay,this.first+maxDelay-Date.now())));
  }
  private schedule(ms:number){clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush(),ms);}
  private head(frame:WorkspaceFrame):WorkspaceHead {
    return {version:1,token:unique(),camera:frame.camera,draft:frame.draft,lineage:frame.lineage,...(frame.names?{names:frame.names}:{})};
  }
  flush(force=false){
    clearTimeout(this.timer);
    if(!this.armed||!this.store||!this.pending||this.writing)return;
    if(!force&&this.inGesture()){this.schedule(delay);return;}
    const frame=this.capture(),serial=this.serial;
    if(sameFrame(frame,this.last)){
      this.durable=serial;this.first=0;this.clearJournal();this.status("saved");return;
    }
    const head=this.head(frame);
    this.writing={frame,head};this.first=0;
    void this.store.write(this.base,head,frame,changes(frame,this.last)).then(matched=>{
      if(!matched){this.conflict();return;}
      this.base=head.token;this.last=frame;this.durable=serial;this.retryJournal=false;
      if(!this.pending){
        this.clearJournal();
        this.status("saved");
      }
    },()=>this.status("failed")).finally(()=>{
      this.writing=undefined;
      if(this.disposed){
        // A previous write may have been holding the final edit behind it when the viewport left.
        if(this.armed&&serial!==this.serial&&this.pending)this.flush(true);
        if(!this.writing)this.closeStore();
      }else if(this.armed&&this.pending)this.schedule(this.state==="failed"?5000:delay);
    });
  }
  private closeStore(){
    this.armed=false;this.store?.close?.();this.store=undefined;
  }
  /** Capture a pending draft while its editor is still mounted, then release this writer. */
  dispose(){
    if(this.disposed)return;
    this.disposed=true;clearTimeout(this.timer);
    if(this.armed&&this.pending){
      const final=this.capture();
      this.capture=()=>final;
      this.protectExit();
    }
    if(!this.writing)this.closeStore();
  }
  private clearJournal(){
    if(!this.journal)return;
    try{this.storage?.removeItem(this.ownKey);this.journal=undefined;}catch{}
  }
  protectExit():boolean {
    if(!this.armed)return false;
    if(!this.pending)return true;
    if(this.journal?.serial===this.serial&&this.journal.parents.includes(this.base)){this.flush(true);return true;}
    const frame=this.capture(),head=this.head(frame),parents=[this.base];
    let written=false;
    try{
      if(this.storage){
        const base=changes(frame,this.last),active=this.writing;
        const flight=active?changes(frame,active.frame):undefined;
        if(active)parents.push(active.head.token);
        const data=base.assets||flight?.assets?{project:encodeProject(frame.doc,frame.vault)}:
          base.document||flight?.document?{document:frame.doc}:{};
        this.storage.setItem(this.ownKey,JSON.stringify({parents,head,time:Date.now(),...data}));
        this.journal={serial:this.serial,parents};written=true;
      }
    }catch{this.status("failed");}
    this.flush(true);return written;
  }
}
