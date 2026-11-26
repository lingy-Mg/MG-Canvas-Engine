import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeProject, MAX_PROJECT_CHARS } from "../../platform/project.ts";
import { newOutput, preview } from "./files.mjs";

function zip(...args) {
  return execFileSync("python",[fileURLToPath(new URL("./archive.py",import.meta.url)),...args],{
    maxBuffer:MAX_PROJECT_CHARS*4+4096, windowsHide:true, stdio:["ignore","pipe","pipe"],
  });
}
export function verifyArchive(path) {
  const {document,assets}=decodeProject(zip("verify",path).toString("utf8"));
  return {format:"mgcanvas-offline/1",entries:["board.mgcanvas","index.html","manifest.json"],documentId:document.id,assets:assets.length,objects:document.order.length};
}
export async function pack(path, project) {
  const dir=await mkdtemp(join(tmpdir(),"mgcanvas-pack-"));
  const names=["board.mgcanvas","index.html","offline.zip"], [board,html,archive]=names.map(name=>join(dir,name));
  try {
    await writeFile(board,project); await writeFile(html,await preview(project));
    zip("create",archive,dir);
    const verified=verifyArchive(archive);
    return {...await newOutput(path,await readFile(archive)),...verified};
  } finally {
    for(const name of names)await unlink(join(dir,name)).catch(()=>{});
    await rmdir(dir);
  }
}
