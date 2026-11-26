import { createHash, randomUUID } from "node:crypto";
import { open, link, realpath, rename, unlink, lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { decodeProject, MAX_PROJECT_CHARS } from "../../platform/project.ts";
import { reject } from "../../features/board-commands.ts";
import { previewFile } from "../release.mjs";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const privateTemp = path => join(dirname(resolve(path)), "."+basename(path)+"."+randomUUID()+".tmp");
async function snapshot(path) {
  const handle=await open(path,"r");
  try {
    const before=await handle.stat({bigint:true});
    if (!before.isFile() || before.size>BigInt(MAX_PROJECT_CHARS*4)) reject("INVALID","Expected a supported project file");
    const bytes=await handle.readFile(), after=await handle.stat({bigint:true});
    if (before.mtimeNs!==after.mtimeNs || before.size!==after.size) reject("STALE","File changed while reading");
    return {text:bytes.toString("utf8").replace(/^\uFEFF/,""),revision:"disk."+after.ino+"."+after.mtimeNs+"."+sha256(bytes)};
  } finally { await handle.close(); }
}
export async function openProject(path) {
  const file=await realpath(path), snap=await snapshot(file);
  return {...snap,path:file,project:decodeProject(snap.text)};
}
async function stage(path, bytes) {
  const handle=await open(path,"wx",0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}
export async function newOutput(path, bytes) {
  const tmp=privateTemp(path);
  try {
    await stage(tmp,bytes);
    await link(tmp,path); // Atomic no-clobber publication on the destination volume.
  } finally { await unlink(tmp).catch(()=>{}); }
  return {path:resolve(path),bytes:Buffer.byteLength(bytes),sha256:sha256(bytes)};
}
export async function saveProject(path, expected, encoded) {
  decodeProject(encoded);
  const file=await realpath(path), lock=file+".mgcanvas.lock", tmp=privateTemp(file);
  let owner;
  try { owner=await open(lock,"wx",0o600); }
  catch(error) { if(error.code==="EEXIST")reject("BUSY","Project lock exists: "+lock); throw error; }
  try {
    await owner.writeFile(JSON.stringify({pid:process.pid,time:new Date().toISOString()}));
    const first=await snapshot(file);
    if(first.revision!==expected)reject("STALE","Disk project changed. Inspect disk before saving.");
    if(first.text===encoded)return first.revision;
    await stage(tmp,encoded);
    if((await snapshot(file)).revision!==expected)reject("STALE","Disk project changed before publication");
    await rename(tmp,file);
    return (await snapshot(file)).revision;
  } finally {
    await unlink(tmp).catch(()=>{}); await owner.close(); await unlink(lock);
  }
}
export async function template() {
  const html=await readFile(new URL("../../dist/"+previewFile,import.meta.url),"utf8");
  if(!html.includes(inputMarker)||!html.includes('<script type="module" data-mgcanvas-editor>'))reject("INVALID","Build the current editor with npm run build");
  return html;
}
export const inputMarker="<!-- mgcanvas-input -->";
export async function preview(project) {
  const safe=project.replaceAll("<","\\u003c");
  return (await template()).replace(inputMarker,()=>'<script id="mgcanvas-project" type="application/json">'+safe+'</script>');
}
export async function writeDescriptor(path, data) { return newOutput(path,JSON.stringify(data)); }
export async function removeDescriptor(path, expected) {
  try { if((await lstat(path)).isFile() && (await readFile(path,"utf8"))===JSON.stringify(expected))await unlink(path); } catch{}
}
