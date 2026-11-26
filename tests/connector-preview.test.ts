import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DEFAULT_CONNECTOR_STROKE,resolveEndpoint} from "../core/document.ts";
import type {BoardDocument,Connector} from "../core/document.ts";
import {bindPropertyColor} from "../app/property-color.ts";
import {EditorSession} from "../session/editor.ts";
import {SceneProjection} from "../scene/projector.ts";
import {FlowInput} from "../features/flow-input.ts";
import {flowHandles,planConnectorStyle,styleConnector} from "../features/flow.ts";
import {AssetVault} from "../features/image-assets.ts";
import {captureClipboard,encodeClipboard} from "../features/clipboard.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";

const board=decodeProject(readFileSync(new URL("../docs/fixtures/M5AA-Connector-Colors.mgcanvas",import.meta.url),"utf8")).document;
const vault=new AssetVault(),camera={zoom:1,offset:{x:0,y:0}};
const asLine=(doc:BoardDocument)=>{const line=doc.objects.route;assert(line.kind==="connector");return line;};
const initial=asLine(board);
const appearance=({label,arrow,routing}:Connector)=>({label,arrow,routing});
const withLine=(line:Connector):BoardDocument=>({...board,objects:{...board.objects,route:line}});

test("connector width alone preserves named stroke, bindings and pins; absent and explicit default widths remain distinct",()=>{
  const {strokeWidth,...old}=initial,doc=withLine(old);
  assert.equal(planConnectorStyle(doc,old,{...appearance(old),strokeWidth:DEFAULT_CONNECTOR_STROKE}),old);
  for(const width of [.25,3,64]){
    const next=planConnectorStyle(doc,old,{...appearance(old),strokeWidth:width});assert(next);
    assert.deepEqual(next,{...old,strokeWidth:width});assert.equal(next.waypoints,old.waypoints);assert.equal(next.from,old.from);assert.equal(next.to,old.to);
  }
  const explicit={...old,strokeWidth:DEFAULT_CONNECTOR_STROKE};assert.equal(planConnectorStyle(withLine(explicit),explicit,appearance(explicit)),explicit);
  assert.equal(planConnectorStyle(board,{...initial},appearance(initial)),undefined);
});

test("invalid color, width or enum rejects other valid fields without history or projected changes",()=>{
  const editor=new EditorSession(board,camera),line=asLine(editor.doc),valid={...appearance(line),label:"待发送",stroke:"#000000"};
  for(const delta of [{strokeWidth:0},{strokeWidth:.249},{strokeWidth:64.01},{strokeWidth:NaN},{strokeWidth:Infinity},
    {stroke:"#abc"},{stroke:""},{stroke:"navy"},{routing:"bogus" as Connector["routing"]},{arrow:"bogus" as Connector["arrow"]}]){
    assert.equal(planConnectorStyle(editor.doc,line,{...valid,...delta}),undefined);
    assert.equal(styleConnector(editor,line.id,{...valid,...delta}),false);
  }
  assert.equal(editor.history.past.length,0);assert.equal(asLine(editor.doc),line);
});

test("twelve arrow and route combinations share projected endpoints and paint, while straight hides but retains manual points",()=>{
  const editor=new EditorSession(board,camera),line=asLine(editor.doc),projection=new SceneProjection(editor.doc),flow=new FlowInput(editor,()=>undefined);
  const bytes=encodeProject(editor.doc,vault),clip=encodeClipboard(captureClipboard(editor.doc,editor.doc.order,vault));
  editor.select(line.id);
  const from=resolveEndpoint(board,line.from),to=resolveEndpoint(board,line.to);
  for(const routing of ["straight","orthogonal","curve"] as const)for(const arrow of ["none","start","end","both"] as const){
    const next=planConnectorStyle(editor.doc,line,{...appearance(line),routing,arrow,stroke:"#000000",strokeWidth:7});assert(next);
    const override=projection.overlay({objects:new Map([[line.id,next]])});
    assert.deepEqual([...override.keys()],[line.id]);
    const path=override.get(line.id)?.items.find(i=>i.kind==="path");assert(path?.kind==="path");
    assert.deepEqual([path.points[0],path.points.at(-1),path.color,path.width,path.arrow],[from,to,"#000000",7,arrow]);
    if(routing==="straight")assert.deepEqual(path.points,[from,to]);
    else for(const p of line.waypoints)assert(path.points.some(q=>q.x===p.x&&q.y===p.y));
    assert.equal(next.waypoints,line.waypoints);assert.equal(next.from,line.from);assert.equal(next.to,line.to);
    const marks=flow.decor(undefined,next).markers;
    assert.deepEqual(marks.filter(m=>m.kind==="endpoint").map(m=>m.point),[from,to]);
    assert.deepEqual(marks.filter(m=>m.kind==="waypoint").map(m=>m.point),routing==="straight"?[]:line.waypoints);
    assert.equal(flowHandles(editor.doc,line.id).length,6);
  }
  assert.equal(encodeProject(editor.doc,vault),bytes);assert.equal(encodeClipboard(captureClipboard(editor.doc,editor.doc.order,vault)),clip);
  assert.equal(editor.history.past.length,0);
});

test("combined connector property edits commit once, restore exact source with undo, and reopen with manual bends on switching back",()=>{
  const editor=new EditorSession(board,camera),line=asLine(editor.doc),before=encodeProject(editor.doc,vault);
  const style={label:"审批",stroke:"#000000",strokeWidth:6,arrow:"both",routing:"straight"} as const;
  const candidate=planConnectorStyle(editor.doc,line,style);assert(candidate);assert(styleConnector(editor,line.id,style));
  assert.equal(editor.history.past.length,1);assert.deepEqual(asLine(editor.doc),candidate);
  for(const id of board.order.filter(id=>id!==line.id))assert.deepEqual(editor.doc.objects[id],board.objects[id]);
  const after=encodeProject(editor.doc,vault),reopen=new EditorSession(decodeProject(after).document,camera);
  assert.deepEqual(asLine(reopen.doc),candidate);assert(styleConnector(reopen,line.id,{...style,routing:"orthogonal"}));
  assert.deepEqual(flowHandles(reopen.doc,line.id).filter(h=>h.kind==="waypoint").map(h=>h.point),line.waypoints);
  assert(!styleConnector(editor,line.id,style));editor.undo();assert.equal(encodeProject(editor.doc,vault),before);assert.equal(editor.history.past.length,0);
  editor.redo();assert.equal(encodeProject(editor.doc,vault),after);
});

test("a bound loop with a real bend rejects zero-length straight routing and preserves the edited style in other routing modes",()=>{
  const loop={...initial,to:initial.from},editor=new EditorSession(withLine(loop),camera),line=asLine(editor.doc),style={...appearance(line),stroke:"#000000"};
  assert(!planConnectorStyle(editor.doc,line,{...style,routing:"straight"}));assert(!styleConnector(editor,line.id,{...style,routing:"straight"}));
  assert.equal(editor.history.past.length,0);assert(styleConnector(editor,line.id,{...style,routing:"curve"}));
  assert.deepEqual(asLine(editor.doc).waypoints,line.waypoints);assert.deepEqual(asLine(editor.doc).from,asLine(editor.doc).to);
});

test("style-only change keeps untouched legacy multiline/over-limit label bytes and its color token",()=>{
  const label="原文\r\n"+"甲".repeat(420),line={...initial,label},doc=withLine(line);
  assert.deepEqual(planConnectorStyle(doc,line,{...appearance(line),arrow:"both"}),{...line,arrow:"both"});
  const next=planConnectorStyle(doc,line,{...appearance(line),label:"验收\n归档"});assert(next);
  assert(!next.label.includes("\n"));assert.equal(next.stroke,"rebeccapurple");
});

class Field extends EventTarget{
  value="";style:Record<string,string>={};attrs:Record<string,string>={};children:Field[]=[];validationMessage="";
  append(...items:Field[]){this.children.push(...items);}
  setAttribute(key:string,value:string){this.attrs[key]=value;}
  setCustomValidity(value:string){this.validationMessage=value;}
  getContext(){return null;}
}
function colorControl(stored:string|undefined,effective?:string){
  const values:(string|undefined)[]=[];
  const old=Object.getOwnPropertyDescriptor(globalThis,"document");
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>new Field()}});
  try{
    const field=()=>new Field() as unknown as HTMLInputElement;
    return {...bindPropertyColor(field(),field(),field(),stored,{effective,onInput:v=>values.push(v)}),values};
  }
  finally{if(old)Object.defineProperty(globalThis,"document",old);else Reflect.deleteProperty(globalThis,"document");}
}

test("the original CSS token is visible and an unresolved opaque-picker seed never turns activation, cancel or repeated events into edits",()=>{
  for(const original of ["transparent","rebeccapurple","black","#000"]){
    const {input,picker,read,reset,values}=colorControl(original);assert.equal(input.value,original);assert.equal(picker.value,"#000000");
    for(const name of ["click","focus","blur","input","change"])picker.dispatchEvent(new Event(name));
    assert.deepEqual(values,[]);assert.equal(read(),undefined);
    input.value="#000000";input.dispatchEvent(new Event("input"));assert.deepEqual(values,["#000000"]);assert.equal(read(),"#000000");
    assert.equal(picker.value,"#000000");picker.dispatchEvent(new Event("change"));assert.equal(values.length,1);
    reset();assert.equal(input.value,original);assert.equal(read(),undefined);
  }
});

test("picker reports a changed opaque value once, recognizes an actual transition to black, and invalid partial text stays invalid",()=>{
  const {input,picker,read,values}=colorControl("transparent");
  for(const hex of ["#ab4312","#000000"]){picker.value=hex;picker.dispatchEvent(new Event("input"));picker.dispatchEvent(new Event("change"));}
  assert.deepEqual(values,["#ab4312","#000000"]);assert.equal(read(),"#000000");
  input.value="#00";input.dispatchEvent(new Event("input"));assert.equal(read(),"#00");assert(input.validationMessage);
  input.value="";input.dispatchEvent(new Event("input"));assert.equal(read(),"");assert(input.validationMessage);
});

test("inherited paints remain unset on passive/native round trips and can be explicitly set to the inherited six digits",()=>{
  const {input,picker,read,values}=colorControl(undefined,"#000000");assert.equal(input.value,"");assert.equal(read(),undefined);
  for(const next of ["#345678","#000000"]){picker.value=next;picker.dispatchEvent(new Event("change"));}
  assert.deepEqual(values,["#345678",undefined]);assert.equal(read(),undefined);
  input.value="#000000";input.dispatchEvent(new Event("input"));assert.equal(read(),"#000000");
});
