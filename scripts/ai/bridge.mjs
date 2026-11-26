import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { MAX_PROJECT_CHARS } from "../../platform/project.ts";
import { CommandError, reject } from "../../features/board-commands.ts";
import { inputMarker, openProject, removeDescriptor, saveProject, template, writeDescriptor } from "./files.mjs";

const verbs=new Set(["status","inspect","snapshot","apply","save","undo","redo","receipt","edit-state","set-layer","tools/list","tools/call"]);
const token=()=>randomBytes(32).toString("base64url");
const authorized=(header,secret)=>{
  const actual=Buffer.from(String(header??"")),expected=Buffer.from("Bearer "+secret);
  return actual.length===expected.length && timingSafeEqual(actual,expected);
};
function reply(res,status,body) {
  if(res.destroyed || res.writableEnded)return;
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(body));
}
async function body(req, limit) {
  if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"]??""))reject("INVALID","Expected application/json");
  if(Number(req.headers["content-length"])>limit)reject("TOO_LARGE","Request is too large");
  let size=0;const parts=[];
  for await(const part of req){size+=part.length;if(size>limit)reject("TOO_LARGE","Request is too large");parts.push(part);}
  const value=JSON.parse(Buffer.concat(parts).toString("utf8"));
  if(!value || typeof value!=="object" || Array.isArray(value))reject("INVALID","Expected a JSON object");
  return value;
}
const httpCode=code=>({FORBIDDEN:403,NOT_FOUND:404,STALE:409,ID_CONFLICT:409,CONFLICT:409,BUSY:409,OFFLINE:503,UNKNOWN_OUTCOME:504,TOO_LARGE:413}[code]??400);
const cap=MAX_PROJECT_CHARS*4+1024*1024;
export async function startBridge(projectPath,descriptorPath,port=0) {
  if(!Number.isInteger(port)||port<0||port>65535)reject("INVALID","Expected a port from 0 to 65535");
  const project=await realpath(projectPath);
  await openProject(project);
  const html=(await template()).replace(inputMarker,'<meta id="mgcanvas-bridge" name="mgcanvas-bridge" content="1">');
  const pageKey=token(), cliKey=token(), epoch=randomUUID();
  let claimed=false, diskRevision, poll, pending, host, origin, descriptor, closing;
  function deliver() {
    if(!poll || !pending || pending.delivered)return;
    const active=poll;poll=undefined;pending.delivered=true;
    reply(active,200,{id:pending.id,command:pending.command,args:pending.args});
  }
  function dispatch(command,args,res) {
    if(!verbs.has(command))reject("INVALID","Unknown bridge command");
    if(!claimed)reject("OFFLINE","Open the authorized page before using session commands");
    if(pending)reject("BUSY","A session request is in progress");
    const job={id:randomUUID(),command,args,res,delivered:false};
    pending=job;
    job.timer=setTimeout(()=>{
      if(pending!==job)return;
      pending=undefined;
      const code=job.delivered?"UNKNOWN_OUTCOME":"OFFLINE";
      reply(res,httpCode(code),{ok:false,code,message:job.delivered?"Response missing. Inspect session and receipt before retrying.":"Page has not received this command."});
    },12000);
    // A disconnected caller cannot cancel or cause redelivery of an already-issued command.
    res.on("close",()=>{if(pending===job&&!job.delivered){clearTimeout(job.timer);pending=undefined;}});
    deliver();
  }
  const server=createServer(async(req,res)=>{
    res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Referrer-Policy","no-referrer");res.setHeader("X-Frame-Options","DENY");
    try {
      if(req.headers.host!==host || req.headers.origin!==undefined && req.headers.origin!==origin)
        reject("FORBIDDEN","Host or Origin rejected");
      if(req.method==="GET"&&req.url==="/"){
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
        res.end(html);return;
      }
      const path=req.url;
      if(req.method!=="POST" || !["/cli","/page/open","/page/next","/page/result","/page/save"].includes(path))reject("NOT_FOUND","Unknown route");
      if(req.headers.origin!==origin || !authorized(req.headers.authorization,path==="/cli"?cliKey:pageKey))
        reject("FORBIDDEN","Session authorization required");
      const data=await body(req,path==="/page/next"||path==="/page/open"?4096:cap);
      if(path==="/cli"){dispatch(data.command,data.args??{},res);return;}
      if(path==="/page/open"){
        if(claimed)reject("CONFLICT","This session already has an editor. Start a new bridge to open another.");
        claimed=true;
        try{const disk=await openProject(project);diskRevision=disk.revision;reply(res,200,{epoch,project:disk.text,diskRevision});}
        catch(error){claimed=false;throw error;}
        return;
      }
      if(!claimed)reject("OFFLINE","No editor has claimed this session");
      if(path==="/page/save"){
        if(typeof data.revision!=="string"||!data.revision.startsWith(epoch+".")||data.diskRevision!==diskRevision)
          reject("STALE","Save snapshot belongs to an old session or disk revision");
        if(typeof data.project!=="string")reject("INVALID","Expected encoded project");
        diskRevision=await saveProject(project,data.diskRevision,data.project);
        reply(res,200,{diskRevision});return;
      }
      if(data.epoch!==epoch)reject("STALE","Session has changed");
      if(path==="/page/next"){
        if(poll)reject("BUSY","A page is already waiting");
        poll=res;
        const timer=setTimeout(()=>{if(poll===res){poll=undefined;reply(res,200,{});}},9000);
        res.on("close",()=>{clearTimeout(timer);if(poll===res)poll=undefined;});
        deliver();return;
      }
      if(pending && pending.delivered && pending.id===data.id){
        const job=pending;pending=undefined;clearTimeout(job.timer);
        if(!data.result || typeof data.result.ok!=="boolean"){reply(job.res,504,{ok:false,code:"UNKNOWN_OUTCOME",message:"Invalid page receipt; inspect before retrying"});}
        else reply(job.res,data.result.ok?200:httpCode(data.result.code),data.result);
      }
      reply(res,200,{ok:true});
    } catch(error) {
      const code=error instanceof CommandError?error.code:"INVALID";
      reply(res,httpCode(code),{ok:false,code,message:error.message});
    }
  });
  await new Promise((done,fail)=>{server.once("error",fail);server.listen(port,"127.0.0.1",done);});
  host="127.0.0.1:"+server.address().port;origin="http://"+host;
  descriptor={format:"mgcanvas-session/1",port:server.address().port,token:cliKey};
  try{await writeDescriptor(descriptorPath,descriptor);}catch(error){server.close();throw error;}
  function close() {
    return closing??=(async()=>{
      if(pending)clearTimeout(pending.timer);
      const closed=new Promise(done=>server.close(done));server.closeAllConnections();await closed;
      await removeDescriptor(descriptorPath,descriptor);
    })();
  }
  return {url:origin+"/#mgcanvas="+pageKey,session:resolve(descriptorPath),close};
}
export async function bindSession(path) {
  const descriptor=JSON.parse(await readFile(path,"utf8"));
  if(descriptor?.format!=="mgcanvas-session/1"||!Number.isInteger(descriptor.port)||descriptor.port<1||descriptor.port>65535||
    typeof descriptor.token!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(descriptor.token))reject("INVALID","Invalid session descriptor");
  return (command,args)=>callBoundSession(descriptor,command,args);
}

export async function sessionCall(path,command,args){
  const call=await bindSession(path);
  return call(command,args);
}

async function callBoundSession(descriptor,command,args){
  const origin="http://127.0.0.1:"+descriptor.port;
  let result;
  try {
    const response=await fetch(origin+"/cli",{method:"POST",redirect:"error",signal:AbortSignal.timeout(18000),
      headers:{Origin:origin,Authorization:"Bearer "+descriptor.token,"Content-Type":"application/json"},body:JSON.stringify({command,args})});
    result=await response.json();
  } catch { reject("UNKNOWN_OUTCOME","Connection ended. Check session status, disk or operation receipt before another write."); }
  if(!result.ok){const error=new CommandError(result.code,result.message);error.revision=result.revision;throw error;}
  return result.data;
}
