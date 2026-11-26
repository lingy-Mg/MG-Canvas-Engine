import { execFile } from "node:child_process";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isId } from "../../core/document.ts";
import { reject } from "../../features/board-commands.ts";
import { inputMarker, newOutput } from "./files.mjs";

const run=promisify(execFile);
const worker=fileURLToPath(new URL("./render_png.py",import.meta.url));
const pngSignature=Buffer.from("89504e470d0a1a0a","hex");
export async function renderPng(path,project,{id,scale:rawScale}){
  if(id!==undefined&&!isId(id))reject("INVALID","Expected a valid board object ID");
  const scale=rawScale===undefined||rawScale==="auto"?undefined:Number(rawScale);
  if(scale!==undefined&&(!Number.isFinite(scale)||scale<0.05||scale>8))
    reject("INVALID","--scale accepts auto or 0.05–8 pixels per world unit");
  let template;
  try{template=await readFile(new URL("../../dist/ai-render.html",import.meta.url),"utf8");}
  catch(error){if(error.code==="ENOENT")reject("RENDER_DEPENDENCY","Build the PNG renderer with npm run build");throw error;}
  if(!template.includes(inputMarker)||!template.includes('"app/png-render.js"'))reject("RENDER_DEPENDENCY","Rebuild the PNG renderer with npm run build");
  const tag=(key,json)=>'<script type="application/json" id="'+key+'">'+json.replaceAll("<","\\u003c")+'</script>';
  const html=template.replace(inputMarker,()=>tag("mgcanvas-project",project)+tag("png-options",JSON.stringify({id,scale})));
  const dir=await mkdtemp(join(tmpdir(),"mgcanvas-png-")),page=join(dir,"render.html"),file=join(dir,"image.png");
  try{
    await writeFile(page,html,{mode:0o600});
    let stdout;
    try{
      ({stdout}=await run(process.platform==="win32"?"python":"python3",[worker,page,file],
        {encoding:"utf8",windowsHide:true,timeout:90000,maxBuffer:256*1024}));
    }catch(error){
      if(error.code==="ENOENT")reject("RENDER_DEPENDENCY","Python 3 was not found on PATH");
      reject("RENDER_FAILED","The local PNG worker did not finish: "+error.message);
    }
    let result;
    try{result=JSON.parse(stdout);}catch{reject("RENDER_FAILED","The local PNG worker returned an unreadable status");}
    if(!result.ok)reject(result.code,result.message);
    const bytes=await readFile(file);
    if(bytes.length<33||!bytes.subarray(0,8).equals(pngSignature)||bytes.readUInt32BE(16)!==result.width||bytes.readUInt32BE(20)!==result.height)
      reject("RENDER_FAILED","The browser returned an invalid PNG or unexpected dimensions");
    const {ok,...metadata}=result;
    return {format:"png",...metadata,...await newOutput(path,bytes)};
  }finally{
    for(const p of [page,file])await unlink(p).catch(error=>{if(error.code!=="ENOENT")throw error;});
    await rmdir(dir);
  }
}
