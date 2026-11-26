import { renderPng, renderPngFailure } from "./png-render.ts";

async function render() {
  const result=document.getElementById("status")!;
  try{
    const canvas=document.getElementById("png-canvas") as HTMLCanvasElement;
    const project=document.getElementById("mgcanvas-project")!.textContent!;
    const options=JSON.parse(document.getElementById("png-options")!.textContent!);
    const {png,metadata}=await renderPng(canvas,project,options);
    (document.getElementById("png-download") as HTMLAnchorElement).href=URL.createObjectURL(png);
    result.textContent=JSON.stringify({ok:true,...metadata});
  }catch(error){
    result.textContent=JSON.stringify(renderPngFailure(error));
  }
}
void render();
