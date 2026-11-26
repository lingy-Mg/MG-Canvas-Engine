import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AssetVault } from "../features/image-assets.ts";
import { arrangeSchema, executeBatch, CommandError, operationFields, readBoard, reject } from "../features/board-commands.ts";
import { encodeProject } from "../platform/project.ts";
import { EditorSession } from "../session/editor.ts";
import { startBridge, sessionCall } from "./ai/bridge.mjs";
import { newOutput, openProject, preview, saveProject } from "./ai/files.mjs";
import { pack, verifyArchive } from "./ai/archive.mjs";
import { renderPng } from "./ai/png.mjs";

const flags={
  help:[], capabilities:[], new:["out","id"], serve:["file","session","port"],
  inspect:["file","session","id","map","kind"], status:["file","session"],
  "edit-state":["session","id"], "set-layer":["session","id","rev","locked","visible"],
  apply:["file","session","batch"], save:["session","rev"], undo:["session","rev"], redo:["session","rev"],
  receipt:["session","id"], export:["file","session","out"], preview:["file","session","out"],
  png:["file","session","out","id","scale"], pack:["file","session","out"], verify:["file"],
};
const exits={USAGE:2,INVALID:2,NOT_FOUND:2,TOO_LARGE:2,STALE:3,CONFLICT:3,ID_CONFLICT:3,BUSY:3,EXISTS:3,
  IO:4,OFFLINE:4,FORBIDDEN:4,RENDER_DEPENDENCY:4,BROWSER_UNAVAILABLE:4,RENDER_FAILED:4,UNKNOWN_OUTCOME:5};
const help={protocol:"mgcanvas-cli/1",usage:"node scripts/mgcanvas.mjs COMMAND --file PATH | --session DESCRIPTOR [options]",
  commands:flags,operations:operationFields,objectKinds:["shape","connector","mindmap","text","image","ink","path"],
  operationDetails:{
    arrange:{inputSchema:arrangeSchema,
      align:"left/center/right/top/middle/bottom: align the selection bounds along one axis. Requires two movable units.",
      distribute:"distribute-x/distribute-y: at least three units. Keep the spatial extremes fixed; equalize edge gaps with the page's integer rounding.",
      layers:"front/back/forward/backward: preserve selected layers' internal order; locked and hidden layers form barriers. A legal no-op adds no undo step.",
      selection:"Explicit distinct board object IDs. A normal group pick expands its visible members; optional group scopes all IDs to members of that group. Does not change the page selection. Direct hidden IDs and locked selections are refused.",
      connectors:"Only two free ends count as a geometric unit. Bound endpoints follow shapes; visible manual pins move only when both bound ends move by the same delta. A locked pin change refuses the batch.",
      result:"selectedIds is the resolved selection; changedIds lists translated objects (including changed connector pins) or selected objects whose stack index changed."},
    layoutFlow:{required:["ids"],optional:["group"],ids:"Distinct object IDs. After group expansion, select at least two shape nodes with a visible bound connection. Internal connectors are optional.",
      group:"An ordinary selection includes whole flow groups. An explicit group ID scopes all input IDs to that group.",
      limits:"Uses UI direction, collision, visibility and lock rules. Only node positions change. Manual waypoints, endpoint bindings and layer order survive."},
    moveTopic:{required:["id","topicId","targetId","place"],optional:["side"],id:"The mind map containing both topics.",
      topicId:"Root topic of the branch to move, including its descendants.",targetId:"Destination topic in the same map.",
      place:{child:"Append to target children and expand target",before:"Insert before target sibling",after:"Insert after target sibling"},
      side:"Optional left or right for a root-level branch. Balanced layout uses this to choose its side.",
      limits:"Moves the entire subtree within one map. Root moves, sibling placement at the root, self and descendant drops are invalid."},
    addTopic:{required:["id","topicId","relation"],optional:["newId","text"],relation:["child","sibling"],
      limits:"Parent or preceding sibling is topicId in map id. A root has no sibling. Expands the parent, uses the UI text limit/default and root branch side rules.",
      result:"topicId (created), parentId, zero-based position, actual text and displayed side"},
    deleteTopic:{required:["id","topicId"],limits:"Explicit non-root branch only, including all collapsed descendants. Protected targets are refused.",
      result:"parentId and removedIds in tree order"},
    setMapLayout:{required:["id","layout"],layout:["left","right","balanced"],result:"layout and changed; stored branch side preferences are retained"},
    setBranchSide:{required:["id","topicId","side"],side:["left","right"],limits:"Direct child of the root only. Switching sides enables balanced layout and preserves the displayed sides of other branches. Same side is a no-op.",result:"layout, side and changed"},
    addDownstream:{required:["id"],optional:["nodeId","connectorId","group"],limits:"One visible, unlocked source shape. Supply its current group ID for a member. Uses Tab placement around visible non-connectors, process preset and facing port. New node is ungrouped; no free slot rejects the batch.",
      result:"nodeId, connectorId, node at and bound from/to endpoints"},
    ids:"New topics accept map-local newId. New downstream objects accept board-level nodeId and connectorId. Omit to allocate; supplied IDs must be valid and unused.",
    batching:"Operations use preceding staged edits. A successful batch is one session undo step. results entries for arrange and the structural commands carry their zero-based operation index; a live replay/receipt returns the original results.",
  },
  editState:{read:"edit-state --session DESCRIPTOR [--id ID] returns selectedIds, focusedTopic, selectedTopics, busy, activeDraft, blockingReasons, locked/hidden layers, hiddenBy endpoint IDs and stateRevision. No field values or draft text.",
    write:"set-layer --session DESCRIPTOR --id ID --rev STATE_REVISION --locked true|false OR --visible true|false. One explicit layer, no document write or undo step. Returns affectedIds. Showing a bound line can show its endpoints, matching the UI; visibility never changes locks. Read state after a lost reply.",
    blockers:["INSPECTOR_DRAFT","INSPECTOR_FOCUS","TEXT_EDITOR","MIND_TOPIC_DRAFT","PROPERTY_PREVIEW","POINTER_GESTURE","INK_STROKE","FLOW_EDIT","PATH_DRAFT","PATH_TOOL","IMPORTING","REOPENING","SAVING","EDITOR_BUSY"]},
  geometry:"Integer world coordinates and sizes; rotations in radians. Nested fields replace one whole field.",
  targets:{disk:"apply checks the file revision and saves atomically",session:"apply is one undo step in the open page; save writes the attached file"},
  png:{scope:"Whole committed board by default; --id renders that object alone, resolving bound endpoints against the board. Includes locally hidden layers. Drafts and selection overlays are excluded.",
    scale:"auto (default) fits in 1600x1200 at up to 1 px/world unit; explicit 0.05–8. Light grid #f3f5f9, DPR 1, 24px padding, max 4096px/side and 8388608 pixels. Empty board 256x192.",
    output:"PNG plus width, height, scale, world bounds, offset, revision and SHA-256. Requires a new --out path."},
  outputs:"new, export, preview, png and pack require a new --out path. Batch accepts a UTF-8 JSON file or - for stdin.",
  batchExample:{operationId:"edit-001",baseRevision:"<revision from inspect>",operations:[{op:"update",id:"flow-submit",fields:{label:"已确认"}}]},
  revisions:"Session operationId is bound to full batch content. receipt returns appliedRevision and current revision. Inspect after a missing reply.",
  requirements:{runtime:"Node >=24.3",preview:"npm run build",png:"npm run build, Python 3, Python playwright and an installed local Chrome/Edge/Chromium (optional absolute MGCANVAS_BROWSER). Offline render; no installation or server.",zip:"python 3 on PATH"},exitCodes:{success:0,...exits}};
// Native Windows PowerShell pipelines may decode stdout with an OEM code page.
function jsonLine(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, ch=>"\\u"+ch.charCodeAt(0).toString(16).padStart(4,"0"));
}
const print=data=>console.log(jsonLine({ok:true,...data}));
function parse(argv) {
  const [name="help",...tail]=argv, command=name==="--help"||name==="-h"?"help":name;
  if(!Object.hasOwn(flags,command))reject("USAGE","Unknown command. Run help.");
  const opts=Object.create(null);
  for(let i=0;i<tail.length;i+=2){
    const flag=tail[i],value=tail[i+1],key=flag.slice(2);
    if(!flag.startsWith("--")||!flags[command].includes(key)||!value||value.startsWith("--")||Object.hasOwn(opts,key))
      reject("USAGE","Unexpected, missing or duplicate option: "+flag);
    opts[key]=value;
  }
  return {command,opts};
}
function required(opts,key){return opts[key]??reject("USAGE","Missing --"+key);}
async function batchData(path) {
  let raw;
  if(path==="-"){const chunks=[];for await(const c of process.stdin)chunks.push(c);raw=Buffer.concat(chunks).toString("utf8");}
  else raw=await readFile(path,"utf8");
  const b=JSON.parse(raw.replace(/^\uFEFF/,""));
  if(!b || typeof b!=="object" || Array.isArray(b) || typeof b.baseRevision!=="string" ||
    typeof b.operationId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(b.operationId)||
    !Array.isArray(b.operations)||b.label!==undefined&&typeof b.label!=="string"||
    Object.keys(b).some(k=>!["baseRevision","operationId","operations","label"].includes(k)))
    reject("INVALID","Expected operationId, baseRevision, operations and optional label");
  return b;
}
async function main() {
  const {command,opts}=parse(process.argv.slice(2));
  if(command==="help"||command==="capabilities"){print(help);return;}
  if(command==="new"){
    const document={schemaVersion:1,id:opts.id??"board-"+randomUUID(),theme:"paper",order:[],objects:{},assets:{}};
    const path=required(opts,"out");
    const output=await newOutput(path,encodeProject(document,new AssetVault()));
    print({source:"disk",...output,revision:(await openProject(path)).revision});return;
  }
  if(command==="serve"){
    const bridge=await startBridge(required(opts,"file"),required(opts,"session"),Number(opts.port??0));
    const stop=()=>void bridge.close().then(()=>{process.exitCode=0;});
    process.once("SIGINT",stop);process.once("SIGTERM",stop);
    print({source:"session",url:bridge.url,session:bridge.session});return;
  }
  if(command==="verify"){
    const file=required(opts,"file");
    if(file.toLowerCase().endsWith(".zip"))print({verified:true,...verifyArchive(file)});
    else {const {project,revision}=await openProject(file);print({verified:true,revision,schemaVersion:project.document.schemaVersion,documentId:project.document.id,assets:project.assets.length});}
    return;
  }
  if(Boolean(opts.file)===Boolean(opts.session))reject("USAGE","Choose exactly one of --file and --session");
  const disk=opts.file?await openProject(opts.file):undefined, project=disk?.project;
  const source=disk?"disk":"session", revision=disk?.revision;
  const call=(name,args={})=>sessionCall(required(opts,"session"),name,args);
  if(command==="status"){
    print(disk?{source,revision,documentId:project.document.id,schemaVersion:project.document.schemaVersion,objectCount:project.document.order.length,assetCount:project.assets.length}:await call("status"));return;
  }
  if(command==="edit-state"){print(await call(command,opts.id===undefined?{}:{id:opts.id}));return;}
  if(command==="set-layer"){
    const fields=["locked","visible"].filter(name=>opts[name]!==undefined);
    if(fields.length!==1||!["true","false"].includes(opts[fields[0]]))reject("USAGE","Choose exactly one: --locked true|false or --visible true|false");
    print(await call(command,{id:required(opts,"id"),stateRevision:required(opts,"rev"),[fields[0]]:opts[fields[0]]==="true"}));return;
  }
  if(command==="inspect"){
    const {id,map,kind}=opts, query=Object.fromEntries(Object.entries({id,map,kind}).filter(([,v])=>v!==undefined));
    print(disk?{source,revision,data:readBoard(project.document,query)}:await call("inspect",query));return;
  }
  if(command==="apply"){
    const batch=await batchData(required(opts,"batch"));
    if(!disk){print(await call("apply",batch));return;}
    if(batch.baseRevision!==revision)reject("STALE","Disk revision has changed");
    const editor=new EditorSession(project.document,{offset:{x:0,y:0},zoom:1}),vault=new AssetVault(project.assets);
    const {changed,results}=executeBatch(editor,vault,batch.operations,batch.label);
    const next=await saveProject(disk.path,revision,changed?encodeProject(editor.doc,vault,project):disk.text);
    print({source,revision:next,appliedRevision:next,operationId:batch.operationId,changed,results});return;
  }
  if(command==="receipt"){print(await call("receipt",{operationId:required(opts,"id")}));return;}
  if(["undo","redo","save"].includes(command)){print(await call(command,{baseRevision:required(opts,"rev")}));return;}
  const path=required(opts,"out");
  const snap=disk?{revision,project:encodeProject(project.document,new AssetVault(project.assets),project)}:await call("snapshot");
  let artifact;
  if(command==="png")artifact=await renderPng(path,snap.project,opts);
  else if(command==="pack")artifact=await pack(path,snap.project);
  else artifact=await newOutput(path,command==="preview"?await preview(snap.project):snap.project);
  print({source,revision:snap.revision,...artifact});
}
main().catch(error=>{
  let code=error instanceof CommandError?error.code:"IO";
  if(error.name==="DocumentValidationError"||error instanceof SyntaxError||error instanceof TypeError||
    error.name==="InvalidCharacterError"||!error.code && code==="IO")code="INVALID";
  if(error.code==="EEXIST")code="EXISTS";
  console.log(jsonLine({ok:false,code,message:error.stderr?.toString().trim()||error.message,revision:error.revision,issues:error.issues}));
  process.exitCode=exits[code]??4;
});
