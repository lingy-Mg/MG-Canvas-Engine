import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { previewFile,previewVersion } from "./release.mjs";
import { textFallback } from "../platform/text-metrics.ts";
const root=fileURLToPath(new URL("../",import.meta.url));
process.chdir(root);
// Standalone engine modules are shared by the PNG worker and engine diagnostics.
const sources=[
  "app/png-download.ts","app/demo.ts","app/property-color.ts","features/clipboard.ts",
  "features/flow-input.ts","features/ink-input.ts","platform/store.ts","scene/projector.ts",
  "session/resize.ts","session/shape-properties.ts","session/text-width.ts",
];
const units=[],built=new Set(),visiting=new Set();
async function compile(path){
  if(built.has(path))return;
  if(visiting.has(path))throw new Error("cyclic standalone module dependency: "+path);
  visiting.add(path);
  const js=path.replace(/\.ts$/,".js");
  const code=stripTypeScriptTypes(await readFile(path,"utf8")).replace(/(from\s+["'][^"'\n]+)\.ts(["'])/g,"$1.js$2");
  const deps={};
  for(const [,target] of code.matchAll(/from\s+["']([^"'\n]+)["']/g)){
    const resolve=posix.normalize(posix.join(posix.dirname(js),target));
    if(!target.startsWith(".")||resolve.startsWith("../")||!resolve.endsWith(".js"))throw new Error("unsupported standalone import: "+path+" → "+target);
    await compile(resolve.slice(0,-3)+".ts");
    deps[target]=resolve;
  }
  units.push({path:js,code,deps});
  await mkdir(dirname("dist/"+js),{recursive:true});
  await writeFile("dist/"+js,code);
  visiting.delete(path);built.add(path);
}
for(const path of sources)await compile(path);
const template=await readFile("app/index.html","utf8");
const entryScript='<script type="module" src="./main.js"></script>';
const cssLink='<link rel="stylesheet" href="./style.css">';
if(template.split(entryScript).length!==2||!template.includes(cssLink)||!template.includes("<!-- mgcanvas-input -->")||
  !template.includes('id="root"')||template.split("__PREVIEW_VERSION__").length!==2){
  throw new Error("Expected the React mount, version, editor module, stylesheet and project input marker in app/index.html");
}
const index=template.replace("__PREVIEW_VERSION__",previewVersion);
const editor=await build({
  entryPoints:["app/main.tsx"],outfile:"dist/app/main.js",write:false,
  bundle:true,platform:"browser",format:"esm",target:"es2022",jsx:"automatic",minify:true,metafile:true,
  supported:{"inline-script":true},legalComments:"eof",charset:"utf8",
  define:{"process.env.NODE_ENV":'"production"'},
});
const [output]=editor.outputFiles;
const editorInputs=Object.keys(editor.metafile.inputs);
const testInput = [...built, ...editorInputs].find(path => path.startsWith("tests/"));
if (testInput) throw new Error("Production entry imports a test file: " + testInput);
if(editor.outputFiles.length!==1||Object.values(editor.metafile.outputs).some(file=>file.imports.length)||
  !["react","react-dom"].every(name=>editorInputs.some(path=>path.startsWith(`node_modules/${name}/`)))){
  throw new Error("The editor must bundle React and React DOM into one self-contained module");
}
if(/<\/script/i.test(output.text))throw new Error("The inline editor bundle contains an HTML script end tag");
await writeFile(output.path,output.text);
await writeFile("dist/app/index.html",index);
const inlineCss=":root{--workspace-font:"+textFallback+"}\n"+await readFile("app/style.css","utf8");
await writeFile("dist/app/style.css",inlineCss);
const pngEntry="app/png-download.js";
function bootFor(units,entry){return `
const units=${JSON.stringify(units).replaceAll("<","\\u003c")};
const urls=new Map();
for(const {path,code,deps} of units){
  const source=code.replace(/(from\\s+["'])([^"'\\n]+)(["'])/g,(_,before,name,after)=>before+urls.get(deps[name])+after);
  urls.set(path,URL.createObjectURL(new Blob([source],{type:"text/javascript"})));
}
try { await import(urls.get(${JSON.stringify(entry)})); }
catch (error) { document.getElementById("status").textContent="预览启动失败"; console.error(error); }
finally { for(const url of urls.values()) URL.revokeObjectURL(url); }
`;}
const html=index
  .replace(cssLink,()=>"<style>\n"+inlineCss+"\n</style>")
  .replace(entryScript,()=>'<script type="module" data-mgcanvas-editor>\n'+output.text+'</script>');
await writeFile("dist/"+previewFile,html);
// Only the compiled renderer and its local dependencies are available to the temporary PNG worker.
const needed=new Set([pngEntry]);
for(const unit of [...units].reverse())if(needed.has(unit.path))for(const dep of Object.values(unit.deps))needed.add(dep);
const pngBoot=bootFor(units.filter(unit=>needed.has(unit.path)),pngEntry);
const pngPage=`<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; img-src blob: data:; connect-src 'none'; base-uri 'none'">
</head><body><!-- mgcanvas-input --><canvas id="png-canvas"></canvas><a id="png-download" download="canvas.png">PNG</a><output id="status"></output>
<script type="module">${pngBoot}</script></body></html>`;
await writeFile("dist/ai-render.html",pngPage);
console.log("Built dist/app/index.html, dist/"+previewFile+" and dist/ai-render.html");


// Keep the native package surface smaller than dist/ (no old previews or unrelated files).
if(process.argv.includes("--desktop")){
  const target="dist/desktop";
  await rm(target,{recursive:true,force:true});
  await mkdir(target,{recursive:true});
  const entry=index
    .replace('href="./style.css"','href="./app/style.css"')
    .replace('src="./main.js"','src="./app/main.js"');
  await writeFile(target+"/index.html",entry);
  await mkdir(target+"/app",{recursive:true});
  await copyFile("dist/app/style.css",target+"/app/style.css");
  await copyFile(output.path,target+"/app/main.js");
  await copyFile("app/png-render.html",target+"/png-render.html");
  const png=await build({
    entryPoints:["app/desktop-png.ts"],outfile:target+"/app/desktop-png.js",write:false,
    bundle:true,platform:"browser",format:"esm",target:"es2022",minify:true,metafile:true,
    legalComments:"eof",charset:"utf8",
  });
  if(png.outputFiles.length!==1||Object.keys(png.metafile.inputs).some(path=>path.startsWith("tests/"))||
    Object.values(png.metafile.outputs).some(file=>file.imports.length)){
    throw new Error("The desktop PNG renderer must be one self-contained production module");
  }
  await writeFile(png.outputFiles[0].path,png.outputFiles[0].text);
  console.log("Staged desktop frontend in dist/desktop");
}
