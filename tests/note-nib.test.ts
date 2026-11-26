import {test} from "node:test";
import assert from "node:assert/strict";
import {handwriting,sampleTrace} from "./fixtures/handwriting.ts";
import {eraserHitsInk,hitInk,inkPoints,InkAccumulator,inkRadius,transformCompletedInk,validInkGeometry} from "../features/ink.ts";
import {InkInput} from "../features/ink-input.ts";
import type {InkDevice,InkPoint} from "../features/ink.ts";
import {demo} from "../app/demo.ts";
import {encodeProject,decodeProject} from "../platform/project.ts";
import {AssetVault} from "../features/image-assets.ts";
import {captureClipboard} from "../features/clipboard.ts";

const brush={color:"#223344",baseWidth:8},pt=(x:number,y=0)=>({x,y});
function replay(i:number,hz:number,device:InkDevice="mouse",zoom=1) {
  const [first,...rest]=sampleTrace(handwriting[i],hz),world=({x,y}:typeof first.at)=>pt(x/zoom,y/zoom);
  const path=new InkAccumulator(device,world(first.at),brush,.5,2048,{zoom,timeStamp:first.timeStamp});
  for(const sample of rest){
    const contact=world(sample.at);path.append(contact,.5,sample.timeStamp);
    const [x,y,p]=path.draft.samples.at(-1)!;
    assert(Math.hypot(x+path.draft.at.x-contact.x,y+path.draft.at.y-contact.y)<1e-12);
    assert.equal(p,.5);
  }
  const last=rest[rest.length-1],preview=structuredClone(path.draft);
  const finished=path.finish(world(last.at),last.timeStamp)!;
  assert.deepEqual(finished,preview);
  return finished;
}

test("Chinese note strokes keep their pen footprint at 30 and 240 Hz, including a paused corner",()=>{
  for(const [i,trace] of handwriting.entries()){
    const slow=inkPoints(replay(i,30)),dense=inkPoints(replay(i,240));
    let both=0,one=0;
    for(let y=4;y<79;y++)for(let x=2;x<106;x++){
      const a=hitInk(slow,pt(x,y)),b=hitInk(dense,pt(x,y));
      if(a||b)one++;if(a&&b)both++;
    }
    assert(both/one>(i===4?.70:.83),trace.name+" mask overlap "+both/one);
    assert([...slow,...dense].every(p=>p.radius===4),trace.name);
    for(const device of ["mouse","touch","pen"] as const)for(const zoom of [.5,2]){
      assert(inkPoints(replay(i,60,device,zoom)).every(p=>p.radius===4));
    }
  }
  const corner=inkPoints(replay(1,240)),atCorner=corner.find(p=>p.x===66&&p.y===21);
  assert(atCorner&&atCorner.radius===4,"stationary turn must keep its width and vertex");
});

test("a sparse mouse flick keeps both caps full size and a pressure pen follows the hardware readings",()=>{
  const path=new InkAccumulator("mouse",pt(0),brush,.5,20,{timeStamp:0});
  path.append(pt(80),.5,20);const stroke=path.finish(pt(80),21)!;
  assert.equal(stroke.brushVersion,1);
  const points=inkPoints(stroke);
  assert.deepEqual(points,[{x:0,y:0,radius:4},{x:80,y:0,radius:4}]);
  const hardware=new InkAccumulator("pen",pt(0),brush,.5,20,{timeStamp:0});
  hardware.append(pt(12),.5,16);hardware.append(pt(24),.13,32);hardware.append(pt(36),.88,48);
  const native=hardware.finish(pt(36))!;
  assert.equal(native.brushVersion,1);
  assert.deepEqual(inkPoints(native).map(p=>p.radius),[.5,.5,.13,.88].map(p=>inkRadius(8,p)));
  const legacy={...native,samples:[[0,0,.5],[12,0,.5]] as const};
  assert.deepEqual(inkPoints(legacy),[{x:0,y:0,radius:4},{x:12,y:0,radius:4}]);
  const tap=new InkAccumulator("touch",pt(3,8),brush,.5).finish(pt(3,8))!;
  assert.deepEqual(inkPoints(tap),[{x:3,y:8,radius:4}]);
});

test("saved simulated ink keeps its tapered outline across reopening and copying alongside new fixed and pressure ink",()=>{
  const note={kind:"ink",id:"note",at:pt(8),brushVersion:3,...brush,samples:[[0,0,.5],[8,0,.62],[32,2,.47],[44,19,.39]]} as const;
  const fixed={kind:"ink",id:"fixed",...replay(2,60)} as const;
  const old=inkPoints(note);
  assert.equal(old[0].radius,2.8);assert(Math.abs(old.at(-1)!.radius-.4944)<1e-10);
  assert(old.length>note.samples.length,"legacy renderer should retain its derived contour");
  const restyled=new InkAccumulator("mouse",pt(0),note,.5);
  assert.equal(restyled.finish(pt(9))!.brushVersion,1);
  const input=new InkAccumulator("pen",pt(8),{...brush,brushVersion:2},.1);
  input.append(pt(32),.9);
  const marker={kind:"ink",id:"mark",...input.finish(pt(32))!} as const;
  assert(validInkGeometry(marker));
  assert.deepEqual(marker.samples.map(s=>s[2]),[.1,.9]);
  const [light,heavy]=inkPoints(marker);
  assert(light.radius>3&&heavy.radius<5&&heavy.radius>light.radius);
  const vault=new AssetVault(),bytes=encodeProject({...demo,schemaVersion:2,objects:{...demo.objects,note,fixed,mark:marker},order:[...demo.order,"note","fixed","mark"]},vault);
  const doc=decodeProject(bytes).document;
  assert.equal(encodeProject(doc,vault),bytes);
  const copied=captureClipboard(doc,["note","fixed","mark"],vault)!.document;
  for(const stroke of [note,fixed,marker]){
    const restored=copied.objects[stroke.id];assert(restored.kind==="ink");assert.deepEqual(restored,stroke);
    assert.deepEqual(inkPoints(restored),inkPoints(stroke));
  }
});

test("precise strokes keep their integer object anchor, first contact and pressure through transforms, save and copy",()=>{
  const input=new InkAccumulator("pen",pt(-2.25,7.375),brush,.2);
  input.append(pt(3.125,9.5),.8);
  const a={id:"fractional",kind:"ink",...input.finish(pt(3.125,9.5))!} as const;
  assert.deepEqual(a.at,pt(-2,7));assert.deepEqual(a.samples,[[-.25,.375,.2],[5.125,2.5,.8]]);
  assert(!validInkGeometry({...a,subpixel:false}));
  assert(!validInkGeometry({...a,samples:[[.74,0,.5]]}));
  assert(!validInkGeometry({...a,subpixel:undefined}));
  const moved=transformCompletedInk(a,a,90,2,pt(10,20))!;
  assert.deepEqual(moved.samples,[[-.25,.375,.2],[-4.5,11.125,.8]]);
  const vault=new AssetVault(),bytes=encodeProject({...demo,schemaVersion:2,objects:{[moved.id]:moved},order:[moved.id]},vault);
  const reopened=decodeProject(bytes).document;
  assert.equal(encodeProject(reopened,vault),bytes);
  assert.deepEqual(captureClipboard(reopened,[moved.id],vault)!.document.objects[moved.id],moved);
});

test("eraser hit follows the complete variable-width sweep between contacts",()=>{
  const line:InkPoint[]=[{x:-20,y:0,radius:1},{x:20,y:0,radius:6}];
  assert(eraserHitsInk(line,pt(0,-20),pt(0,20),1));
  assert(eraserHitsInk(line,pt(-26,7.9),pt(26,7.9),2));
  assert(!eraserHitsInk(line,pt(26,8.1),pt(-26,8.1),2));
  assert(eraserHitsInk(line,pt(20,7),pt(20,7),1));
  assert(!eraserHitsInk(line,pt(-20,4),pt(-20,4),1));
  const input=new InkInput(),camera={offset:pt(10,20),zoom:2};
  assert.deepEqual(input.down({device:"pen",id:2,at:pt(18,28),primaryTip:true},
    {brush,camera,eraserDiameterCss:12,fingerInk:false}),[{kind:"stroke-start"},{kind:"erase-sweep",points:[pt(4,4)],radius:3}]);
  assert(input.erasing&&!input.draft);
  assert.deepEqual(input.up(2,pt(38,28)),[{kind:"erase-sweep",points:[pt(4,4),pt(14,4)],radius:3},{kind:"erase-commit"}]);
  assert(!input.erasing&&!input.drawing);
});
