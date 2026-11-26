import {CommandError} from "../features/board-commands.ts";
import {decodeProject} from "../platform/project.ts";
import type {ProjectPackage} from "../platform/project.ts";

type Job={id?:string;command:string;args?:Record<string,unknown>};
type Replies={
  "/page/open":{epoch:string;diskRevision:string;project:string};
  "/page/next":Job;
  "/page/result":{ok:boolean};
  "/page/save":{diskRevision:string};
};
type Connection={
  post:<K extends keyof Replies>(path:K,body:unknown)=>Promise<Replies[K]>;
  ready:Promise<{epoch:string;diskRevision:string;project:ProjectPackage;saved:boolean}>;
  mounts:number;
  receiver?:{dispatch:(job:Job)=>Promise<unknown>;disconnected:()=>void};
  polling:boolean;
  saving?:Promise<unknown>;
};
// The bridge grants its page token once. Keep the claim in this document's module, across React mounts.
let page:Connection|undefined;
export function authorizedBridgePage():Connection{
  if(location.protocol!=="http:"||location.hostname!=="127.0.0.1")throw Error("请使用当前 CLI 打印的授权地址打开本页");
  if(page&&!location.hash)return page;
  const match=/^#mgcanvas=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if(!match||page)throw Error("请使用当前 CLI 打印的授权地址打开本页");
  const token=match[1];
  history.replaceState(null,"","/");
  async function post<K extends keyof Replies>(path:K,body:unknown):Promise<Replies[K]>{
    const reply=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},
      credentials:"omit",redirect:"error",cache:"no-store",body:JSON.stringify(body)});
    const data=await reply.json();
    if(!reply.ok)throw new CommandError(data.code??"IO",data.message??"桥接通信失败");
    return data;
  }
  // A transient mount cannot tell whether the server already accepted an interrupted claim.
  const ready=post("/page/open",{}).then(({epoch,diskRevision,project})=>({epoch,diskRevision,project:decodeProject(project),saved:true}));
  return page={post,ready,mounts:0,polling:false};
}

export function pollBridgePage(page:Connection,epoch:string){
  if(page.polling)return;
  page.polling=true;
  async function run(){
    try{
      while(page.receiver){
        // The server permits exactly one outstanding long poll. It expires in 9s or delivers once.
        // A remount can consume that same reply with its current receiver.
        const job=await page.post("/page/next",{epoch});
        if(!job.id)continue;
        const result=page.receiver?await page.receiver.dispatch(job):
          {ok:false,code:"OFFLINE",message:"当前页面已卸载画板。"};
        await page.post("/page/result",{epoch,id:job.id,result});
      }
    }catch{page.receiver?.disconnected();}
    finally{page.polling=false;}
  }
  void run();
}
