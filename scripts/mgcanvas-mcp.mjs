import {createInterface} from "node:readline";
import {bindSession} from "./ai/bridge.mjs";

const usage="Usage: node scripts/mgcanvas-mcp.mjs --session <descriptor.json>";
const versions=["2025-11-25","2025-06-18","2025-03-26","2024-11-05"];
const limit=32;
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const write=message=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",...message})+"\n");
const result=(id,value)=>write({id,result:value});
const error=(id,code,message,data)=>write({id,error:{code,message,data}});
const idOf=value=>typeof value==="string"||Number.isSafeInteger(value);

function serve(call){
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  let state="new",active,closed=false;
  const waiting=[];
  function pump(){
    if(active||closed||!waiting.length)return;
    const job=active=waiting.shift();
    void (async()=>{
      try{
        const value=await call(job.method,job.params);
        const valid=object(value)&&(job.method==="tools/list"?Array.isArray(value.tools):Array.isArray(value.content));
        if(job.cancelled||closed)return;
        if(valid)result(job.id,value);
        else error(job.id,-32603,"The page returned an invalid MCP result");
      }catch(failure){
        if(job.cancelled||closed)return;
        const {code,revision,message}=failure;
        error(job.id,code==="UNKNOWN_TOOL"?-32602:-32000,message,{code:code??"IO",revision});
      }finally{active=undefined;pump();}
    })();
  }
  input.on("line",line=>{
    if(!line.trim())return;
    let message;
    try{message=JSON.parse(line);}
    catch{error(null,-32700,"Invalid JSON");return;}
    const id=message?.id,hasId=object(message)&&Object.hasOwn(message,"id");
    if(!object(message)||message.jsonrpc!=="2.0"||typeof message.method!=="string"||hasId&&!idOf(id)){
      error(idOf(id)?id:null,-32600,"Invalid request");return;
    }
    const {method}=message,params=Object.hasOwn(message,"params")?message.params:{};
    if(!hasId){
      if(method==="notifications/initialized"&&state==="initializing")state="ready";
      if(method==="notifications/cancelled"&&object(params)&&idOf(params.requestId)){
        const index=waiting.findIndex(job=>job.id===params.requestId);
        if(index>=0)waiting.splice(index,1);
        // The existing bridge owns dispatched work. Never retry or replay to cancel.
        if(active?.id===params.requestId)active.cancelled=true;
      }
      return;
    }
    if(!object(params)){error(id,-32602,"Expected an object for params");return;}
    if(method==="initialize"){
      if(state!=="new"){error(id,-32600,"The server has already initialized");return;}
      if(typeof params.protocolVersion!=="string"||!object(params.capabilities)||!object(params.clientInfo)||
        typeof params.clientInfo.name!=="string"||typeof params.clientInfo.version!=="string"){
        error(id,-32602,"Expected protocolVersion, capabilities and clientInfo");return;
      }
      state="initializing";
      result(id,{protocolVersion:versions.includes(params.protocolVersion)?params.protocolVersion:versions[0],
        capabilities:{tools:{}},serverInfo:{name:"mgcanvas",version:"1.0.0"}});
      return;
    }
    if(method==="ping"){result(id,{});return;}
    if(state!=="ready"){error(id,-32000,"Complete MCP initialization first");return;}
    if(method!=="tools/list"&&method!=="tools/call"){error(id,-32601,"Method not found");return;}
    if(method==="tools/list"&&params.cursor!==undefined&&typeof params.cursor!=="string"||
      method==="tools/call"&&(typeof params.name!=="string"||!params.name||params.arguments!==undefined&&!object(params.arguments))){
      error(id,-32602,"Invalid tool request parameters");return;
    }
    if(active?.id===id||waiting.some(job=>job.id===id)){error(id,-32600,"Request ID is already in use");return;}
    if(waiting.length>=limit){error(id,-32000,"Too many pending requests",{code:"BUSY"});return;}
    waiting.push({id,method,params});pump();
  });
  input.on("close",()=>{closed=true;waiting.length=0;});
}

const args=process.argv.slice(2);
try{
  if(args.length!==2||args[0]!=="--session"||!args[1])throw Error(usage);
  serve(await bindSession(args[1]));
}catch(failure){
  console.error(failure.message);process.exitCode=2;
}
