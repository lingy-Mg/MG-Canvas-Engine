import { renderPng, renderPngFailure } from "./png-render.ts";

async function readInput(path:string) {
  const response=await fetch(path,{cache:"no-store"});
  if(!response.ok)throw new Error("Unable to read the PNG render input");
  return response.text();
}

async function render() {
  let body:Blob;
  try{
    const [project,options]=await Promise.all([readInput("/project"),readInput("/options")]);
    const canvas=document.getElementById("png-canvas") as HTMLCanvasElement;
    const {png,metadata}=await renderPng(canvas,project,JSON.parse(options));
    body=new Blob([JSON.stringify({ok:true,...metadata,networkRequests:0}),"\n",png],{type:"application/octet-stream"});
  }catch(error){
    body=new Blob([JSON.stringify(renderPngFailure(error)),"\n"],{type:"application/octet-stream"});
  }
  await fetch("/result",{method:"POST",body});
}
void render();
