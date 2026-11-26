import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";
import {test} from "node:test";

const script=fileURLToPath(new URL("../scripts/mgcanvas-mcp.mjs",import.meta.url));
const fixtures=[{name:"canvas_read",description:"读取所选画板",inputSchema:{type:"object",properties:{id:{type:"string"}}}}];

test("MCP lifecycle, forwarding and descriptor pinning across concurrent requests",{timeout:15000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),"mgcanvas-stdio-"));
  const path=join(directory,"session.json");
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const requests:string[]=[];
  async function broker(label:string,token:string){
    const server=createServer(async(req,res)=>{
      if(req.headers.authorization!=="Bearer "+token||req.url!=="/cli"||req.method!=="POST"){
        res.writeHead(403).end(JSON.stringify({ok:false,code:"FORBIDDEN",message:"Invalid session"}));
        return;
      }
      const chunks=[];
      for await(const chunk of req)chunks.push(chunk);
      const {command,args}=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(label+"/"+command);
      if(command==="tools/call"&&args.name==="missing"){
        res.writeHead(400).end(JSON.stringify({ok:false,code:"UNKNOWN_TOOL",message:"Unknown tool"}));return;
      }
      const data=command==="tools/list"?{tools:fixtures}:{content:[{type:"text",text:"同一张画板"}],structuredContent:{label,args}};
      res.end(JSON.stringify({ok:true,data}));
    });
    server.listen(0,"127.0.0.1");
    await once(server,"listening");
    t.after(()=>{server.close();server.closeAllConnections();});
    const address=server.address();assert(address&&typeof address!=="string");
    return {format:"mgcanvas-session/1",port:address.port,token};
  }
  const first=await broker("first","a".repeat(43)),second=await broker("second","b".repeat(43));
  await writeFile(path,JSON.stringify(first));
  const child=spawn(process.execPath,[script,"--session",path],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  t.after(()=>child.kill());
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const send=(method:string,id?:number,params?:object)=>child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");
  async function receive(){
    const next=await lines.next();assert(!next.done);
    return JSON.parse(next.value);
  }
  send("initialize",1,{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"test",version:"1"}});
  const initial=await receive();
  assert.equal(initial.result.protocolVersion,"2025-06-18");assert.deepEqual(initial.result.capabilities,{tools:{}});
  send("tools/list",2);
  assert.equal((await receive()).error.code,-32000);
  send("notifications/initialized");
  // A freshly rotated descriptor only applies to a newly launched client.
  await writeFile(path,JSON.stringify(second));
  send("tools/list",3);send("tools/call",4,{name:"canvas_read",arguments:{id:"中文图层"}});
  assert.deepEqual(await receive(),{jsonrpc:"2.0",id:3,result:{tools:fixtures}});
  assert.deepEqual((await receive()).result.structuredContent,{label:"first",args:{name:"canvas_read",arguments:{id:"中文图层"}}});
  send("tools/call",5,{name:"missing"});
  assert.equal((await receive()).error.code,-32602);
  assert.deepEqual(requests,["first/tools/list","first/tools/call","first/tools/call"]);
  child.stdin.end();
  assert.deepEqual(await once(child,"close"),[0,null]);

  const restarted=spawn(process.execPath,[script,"--session",path],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  t.after(()=>restarted.kill());
  const replies=createInterface({input:restarted.stdout})[Symbol.asyncIterator]();
  const initialize={id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"test",version:"1"}}};
  const call={id:2,method:"tools/call",params:{name:"canvas_read",arguments:{}}};
  const messages=[initialize,{method:"notifications/initialized"},call];
  restarted.stdin.write(messages.map(message=>JSON.stringify({jsonrpc:"2.0",...message})).join("\n")+"\n");
  assert.equal(JSON.parse((await replies.next()).value).id,1);
  assert.equal(JSON.parse((await replies.next()).value).result.structuredContent.label,"second");
  restarted.stdin.end();
  assert.deepEqual(await once(restarted,"close"),[0,null]);
});
