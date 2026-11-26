// Run with extracted release roots, for example: node scripts/check-previous.mjs /tmp/M5N
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve,basename} from "node:path";
import {pathToFileURL} from "node:url";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {captureClipboard,encodeClipboard,decodeClipboard} from "../features/clipboard.ts";
import {AssetVault} from "../features/image-assets.ts";
import {SelectionProperties} from "../features/selection-appearance.ts";
import {EditorSession} from "../session/editor.ts";
import {rotationHandle} from "../session/resize.ts";

const roots=process.argv.slice(2);assert(roots.length,"provide at least one extracted historical source directory");
const initial=decodeProject(readFileSync(new URL("../docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas",import.meta.url),"utf8"));
const editor=new EditorSession(initial.document,{offset:{x:0,y:0},zoom:1});
editor.select("flow-submit");editor.select("flow-first",true);
assert(new SelectionProperties(editor).apply(new Map([["lineColor","#198275"]]),{x:-2,y:1.5}));
const v1=editor.doc;
const stroke={kind:"ink",id:"compat-ink",brushVersion:1,at:{x:4,y:9},baseWidth:5,color:"#215b9d",samples:[[0,0,.13],[8,4,.82],[14,10,.46]]};
assert(editor.commitEdit({label:"fixture",patches:[{op:"putObject",value:stroke}]},editor.generation));
editor.select(stroke.id,true);
assert(new SelectionProperties(editor).apply(new Map([["lineWidth",8],["lineColor","#733b91"]]),{x:5}));
assert.deepEqual(editor.doc.objects[stroke.id].samples,stroke.samples);
const pair=decodeProject(readFileSync(new URL("../docs/fixtures/M5P-Selection-Translation.mgcanvas",import.meta.url),"utf8"));
const manual=new EditorSession(pair.document,editor.camera);
manual.select("a");manual.select("b",true);assert(new SelectionProperties(manual).apply(new Map(),{x:5}));
function rotateQuarter(session,id){
  session.select(id);
  const item=session.doc.objects[id],{knob}=rotationHandle(item,session.camera);
  const x=item.at.x+item.width/2,y=item.at.y+item.height/2;
  session.down(1,"mouse",knob,id,false,false,{id,rotate:true});
  session.up(1,{x:x-(knob.y-y),y:y+(knob.x-x)},undefined,true);
  assert.equal(session.doc.objects[id].rotation,item.rotation+Math.PI/2);
}
const rotatedPair=new EditorSession(manual.doc,editor.camera),rotatedImage=new EditorSession(editor.doc,editor.camera);
rotateQuarter(rotatedPair,"b");rotateQuarter(rotatedImage,"qa-picture");
for(const root of roots){
  const load=relative=>import(pathToFileURL(resolve(root,relative)).href);
  const project=await load("platform/project.ts"),clipboard=await load("features/clipboard.ts"),assets=await load("features/image-assets.ts");
  for(const [doc,sourceAssets,fixture] of [[v1,initial.assets,"v1 translated PNG"],[editor.doc,initial.assets,"v2 translated PNG and ink"],[manual.doc,pair.assets,"v1 translated manual routes"],
    [rotatedPair.doc,pair.assets,"v1 rotated node and two manual routes"],[rotatedImage.doc,initial.assets,"v2 rotated PNG and pressure ink"]]){
    const sourceVault=new AssetVault(sourceAssets);
    const encoded=encodeProject(doc,sourceVault),old=project.decodeProject(encoded);
    assert.deepEqual(old,decodeProject(encoded));assert.deepEqual(old.assets,sourceAssets);
    assert.equal(project.encodeProject(old.document,new assets.AssetVault(old.assets)),encoded);
    const wire=encodeClipboard(captureClipboard(doc,doc.order,sourceVault)),fragment=clipboard.decodeClipboard(wire);
    assert.deepEqual(fragment,decodeClipboard(wire));assert.equal(clipboard.encodeClipboard(fragment),wire);
    console.log(basename(root)+" original codecs verified "+fixture+": exact project and clipboard bytes.");
  }
}
