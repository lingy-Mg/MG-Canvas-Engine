import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIXED_INK_PRESSURE,InkAccumulator,inkBounds,inkPoints,inkRadius,inkSegmentHull,hitInk,
  normalizeInkPressure,validInkGeometry,
} from "../features/ink.ts";
import type { InkDevice } from "../features/ink.ts";
import { InkInput } from "../features/ink-input.ts";
import type { InkAction,InkPointer } from "../features/ink-input.ts";
const pt=(x:number,y=0)=>({x,y});
const opts={brush:{color:"#223344",baseWidth:10},camera:{offset:pt(0),zoom:1},fingerInk:false};
const finger={...opts,fingerInk:true};
const pointer=(id:number,device:InkDevice,x:number,y=0,pressure=0.5,primaryTip=true):InkPointer=>({id,device,at:pt(x,y),pressure,primaryTip});
const kinds=(actions:readonly InkAction[])=>actions.map(a=>a.kind);
const settled=(actions:readonly InkAction[])=>{
  const action=actions[0];
  assert.equal(action?.kind,"stroke-commit");
  if(action?.kind!=="stroke-commit")assert.fail();
  return action.stroke;
};

test("pen and touch use normalized pressure and mice always use the chosen base width",()=>{
  for(const device of ["pen","touch"] as const){
    for(const pressure of [0,0.1,0.5,0.9,1])assert.equal(normalizeInkPressure(device,pressure),pressure);
    assert.equal(normalizeInkPressure(device,undefined),FIXED_INK_PRESSURE);
  }
  for(const p of [0,.1,.5,.9,1,NaN,undefined])assert.equal(normalizeInkPressure("mouse",p,.8),.5);
  assert.equal(normalizeInkPressure("pen",-.3),0);
  assert.equal(normalizeInkPressure("pen",1.3),1);
  assert.equal(normalizeInkPressure("pen",undefined,.2),.2);
  assert.equal(normalizeInkPressure("pen",NaN,NaN),.5);
  assert.equal(inkRadius(10,.5),5);
  assert(inkRadius(10,.05)>0);
  assert(inkRadius(10,.05)<inkRadius(10,.9));
});

test("ordered batches preserve pressure-only moves, ignore duplicate points, and never use zero release pressure",()=>{
  const tool=new InkInput();
  assert.deepEqual(kinds(tool.down(pointer(1,"pen",20,20,.3),{...opts,camera:{zoom:2,offset:pt(10,10)}})),["stroke-start"]);
  assert.deepEqual(kinds(tool.move(1,[{at:pt(20,20),pressure:.3},{at:pt(20,20),pressure:.5},
    {at:pt(24,26),pressure:.8},{at:pt(30,30),pressure:NaN}])),["stroke-update"]);
  const ink=settled(tool.up(1,pt(34,34)));
  assert.deepEqual(ink.at,pt(5,5));
  assert.deepEqual(ink.samples.map(s=>s[2]),[.3,.5,.8,.8,.8]);
  assert.deepEqual(ink.samples.slice(0,2),[[0,0,.3],[0,0,.5]]);
  assert(Math.hypot(ink.samples[2][0]-2,ink.samples[2][1]-3)<.3);
  assert(Math.hypot(ink.samples[3][0]-5,ink.samples[3][1]-5)<.3);
  assert.deepEqual(ink.samples.at(-1),[7,7,.8]);
  assert(validInkGeometry(JSON.parse(JSON.stringify(ink))));
  assert(Object.isFrozen(ink)&&Object.isFrozen(ink.samples)&&Object.isFrozen(ink.samples[0]));
  assert.deepEqual(tool.cancel(1),[],"late normal lost capture must not cancel committed data");
  assert.equal(tool.drawing,false);
});

test("tap is one selectable pressure-weighted dot; tapered strokes have width-aware geometry",()=>{
  const dot=new InkAccumulator("pen",pt(10,20),opts.brush,.9);
  const dotStroke=dot.finish(pt(10,20));assert(dotStroke);
  const points=inkPoints(dotStroke);
  assert.equal(points.length,1);
  const radius=inkRadius(10,.9);
  assert.deepEqual(inkBounds(points),{min:pt(10-radius,20-radius),max:pt(10+radius,20+radius)});
  assert(hitInk(points,pt(10+radius-.1,20)));
  assert(!hitInk(points,pt(10+radius+.1,20)));
  assert(hitInk(points,pt(10+radius+.1,20),.2));
  const a={...pt(0),radius:1},b={...pt(10),radius:5};
  assert(inkSegmentHull(a,b));
  assert(!inkSegmentHull(a,{...b,x:2}));
  assert(hitInk([a,b],pt(5,3.2)),"edge lies in variable-radius sweep");
  assert(!hitInk([a,b],pt(5,4)));
});

test("validate portable stroke limits and mark capacity exhaustion instead of committing a clipped stroke",()=>{
  const b=new InkAccumulator("pen",pt(0),opts.brush,.5,2);
  assert.equal(b.append(pt(1),.6),"added");assert.equal(b.append(pt(1),.6),"ignored");
  assert.equal(b.append(pt(2),.5),"overflow");
  assert.equal(b.finish(pt(2)),undefined);
  assert.equal(b.finish(pt(1)),undefined);
  const good=new InkAccumulator("pen",pt(1),opts.brush).finish(pt(1));assert(good&&validInkGeometry(good));
  for(const bad of [
    {...good,brushVersion:999},{...good,color:["#223344"]},{...good,baseWidth:0},
    {...good,samples:[]},{...good,samples:[[1,0,.5]]},{...good,samples:[[0,0,1.001]]},
    {...good,samples:[[0,0,.5],[0,Infinity,.5]]},{...good,samples:[[0,0,.5],[1_000_000_001,0,.5]]},
    {...good,samples:[[0,,.5]]},{...good,at:null},
  ])assert.equal(validInkGeometry(bad),false);
  const tool=new InkInput(1);
  tool.down(pointer(4,"pen",0),opts);
  assert.deepEqual(tool.move(4,[{at:pt(1),pressure:.8}]),[{kind:"stroke-cancel",reason:"sample-limit"}]);
  assert(tool.owns(4));
  assert.deepEqual(tool.up(4,pt(1)),[]);
  assert(!tool.owns(4));
});

test("a reported pressure signal restores ambiguous contact readings and stays authoritative for that stroke",()=>{
  const tool=new InkInput();
  assert.deepEqual(tool.down(pointer(9,"pen",0,0,0,false),opts),[]);
  for(const device of ["pen","touch"] as const){
    tool.down({...pointer(3,device,0,0,0),timeStamp:0},finger);
    tool.move(3,[{at:pt(1),pressure:.5,timeStamp:16},{at:pt(2),pressure:.5,timeStamp:32}]);
    assert(tool.draft!.samples.every(sample=>sample[2]===.5));
    tool.move(3,[{at:pt(3),pressure:.25},{at:pt(3),pressure:.5},{at:pt(4),pressure:0},
      {at:pt(5),pressure:NaN},{at:pt(6),pressure:1},{at:pt(7)}]);
    assert.deepEqual(settled(tool.up(3,pt(8))).samples,
      [[0,0,0],[1,0,.5],[2,0,.5],[3,0,.25],[3,0,.5],[4,0,0],[5,0,0],[6,0,1],[7,0,1],[8,0,1]]);
  }
});

test("ordinary input keeps the selected diameter across speed, zoom, device and batching",()=>{
  const draw=(device:InkDevice,pressure:number|undefined,zoom:number,batch:boolean)=>{
    const tool=new InkInput(),camera={offset:pt(30,-12),zoom};
    tool.down({...pointer(1,device,30),pressure,timeStamp:0},{...finger,camera});
    const samples=[1,2,3,35,67,104].map((x,i)=>({at:pt(30+x),pressure,timeStamp:(i+1)*16}));
    if(batch)tool.move(1,samples);
    else for(const sample of samples)tool.move(1,[sample]);
    const preview=structuredClone(tool.draft);
    const stroke=settled(tool.up(1,samples.at(-1)!.at,120));
    assert(validInkGeometry(stroke));
    assert.deepEqual(stroke,preview);
    assert.equal(stroke.brushVersion,1);
    assert(stroke.samples.every(s=>s[2]===.5));
    assert(inkPoints(stroke).every(p=>p.radius===opts.brush.baseWidth/2));
    assert.equal(stroke.samples.at(-1)![0]*zoom,104);
  };
  for(const device of ["pen","touch","mouse"] as const)
    for(const pressure of [.5,0,undefined,NaN,-1,Infinity,2])
      for(const zoom of [.25,1,8])draw(device,pressure,zoom,zoom!==1);
  for(const pressure of [.03,.8,1])draw("mouse",pressure,1,false);
});

test("an ambiguous stationary press stays a single dot unless the device confirms the pressure change",()=>{
  const tool=new InkInput();
  for(const confirmed of [false,true]){
    tool.down(pointer(2,"pen",12,7,0),opts);
    tool.move(2,[{at:pt(12,7),pressure:.5}]);
    if(confirmed)tool.move(2,[{at:pt(12,7),pressure:.8}]);
    const stroke=settled(tool.up(2));
    assert.deepEqual(stroke.samples,confirmed?[[0,0,0],[0,0,.5],[0,0,.8]]:[[0,0,.5]]);
  }
});

test("ordinary input ignores event timing, pauses and lift pressure",()=>{
  const endPressure=(step:number,speed:number)=>{
    const path=new InkAccumulator("pen",pt(0),opts.brush,.5,128,{timeStamp:0});
    for(let ms=step;ms<=96;ms+=step)path.append(pt(ms*speed),.5,ms);
    return path.finish(pt(96*speed),96)!.samples.at(-1)![2];
  };
  for(const speed of [.125,2.5])
    for(const step of [4,8,16])assert.equal(endPressure(step,speed),.5);
  const path=new InkAccumulator("touch",pt(0),opts.brush,0,16,{timeStamp:100});
  for(const [i,timeStamp] of [100,99,NaN,undefined,104,104,10_000].entries()){
    path.append(pt(i+1),0,timeStamp);
    assert.equal(path.append(pt(i+1),0,timeStamp),"ignored","resting contact must not accumulate width");
  }
  const last=path.draft.samples.at(-1)!;
  const stroke=path.finish(pt(last[0]+.1),12_000)!;
  assert(validInkGeometry(stroke)&&stroke.samples.every(s=>s[2]===.5));
  const dot=new InkAccumulator("mouse",pt(4,3),opts.brush,.5);
  assert.deepEqual(dot.finish(pt(4,3),900)!.samples,[[0,0,.5]]);
});

test("handwriting stabilization softens small lateral jitter while retaining the live tip, corners and pressure-only marks",()=>{
  const path=new InkAccumulator("pen",pt(0),opts.brush,.1);
  const raw=[[2,.56,.2],[4,-.56,.3],[6,.56,.4],[8,0,.5],[8,4,.6],[5,4,.7],[5,4,.9]];
  for(const [x,y,p] of raw){
    path.append(pt(x,y),p);
    assert.deepEqual(path.draft.samples.at(-1),[x,y,p]);
  }
  for(const index of [1,2,3])assert(Math.abs(path.draft.samples[index][1])<.4);
  const stroke=path.finish(pt(5,3))!;
  assert.deepEqual(stroke.samples[0],[0,0,.1]);
  assert(stroke.samples.slice(1,4).every(s=>Math.abs(s[1])<.4));
  assert.deepEqual(stroke.samples.slice(4),[[8,0,.5],[8,4,.6],[5,4,.7],[5,4,.9],[5,3,.9]]);
  assert.deepEqual(stroke.samples.map(s=>s[2]),[.1,.2,.3,.4,.5,.6,.7,.9,.9]);
});

test("subpixel movement is visible immediately and an identical lift keeps the last preview",()=>{
  for(const device of ["mouse","pen","touch"] as const){
    const path=new InkAccumulator(device,pt(-8.31,7.2),opts.brush,.5,16);
    const pressure=device==="pen"?.7:.5;
    path.append(pt(-3.27,2.18),pressure);
    for(const dx of [.1,-.2,.23,-.37]){
      const at=pt(-3+dx,2.1);assert.equal(path.append(at,pressure),"added");
      const tip=inkPoints(path.draft).at(-1)!;assert(Math.hypot(tip.x-at.x,tip.y-at.y)<1e-12);
    }
    const preview=structuredClone(path.draft);
    assert.deepEqual(path.finish(pt(-3.37,2.1)),preview);
  }
});

test("raw and regular movement update the tip once and carry no state into the next contact",()=>{
  const tool=new InkInput(),start={...pointer(8,"pen",0,0,.18),timeStamp:100};
  const moves=[{at:pt(10,2),pressure:.25,timeStamp:108},{at:pt(18,4),pressure:.8,timeStamp:116}];
  tool.down(start,opts);
  assert.deepEqual(kinds(tool.move(8,moves,"raw")),["stroke-update"]);
  assert.deepEqual(tool.draft!.samples.at(-1),[18,4,.8]);
  assert.deepEqual(tool.move(8,moves,"move"),[]);
  const turn={at:pt(18,12),pressure:.4,timeStamp:120};
  tool.move(8,[...moves,turn]);assert.deepEqual(tool.move(8,[turn],"raw"),[]);
  const last=structuredClone(tool.draft);assert.deepEqual(settled(tool.up(8,turn.at)),last);
  tool.down({...start,at:pt(40),pressure:.5,timeStamp:200},opts);
  assert.deepEqual(tool.move(8,moves,"raw"),[]);
  tool.move(8,[{at:pt(54),pressure:.5,timeStamp:217}]);
  assert.deepEqual(settled(tool.up(8,pt(54))).samples,[[0,0,.5],[14,0,.5]]);
});

test("overlapping streams preserve same-tick turns and pressure-only contacts in order",()=>{
  const sample=(x:number,p:number,timeStamp:number)=>({at:pt(x),pressure:p,timeStamp});
  const a=sample(12,.3,12),b=sample(15,.6,12),c=sample(15,.9,12),d=sample(20,.4,16);
  for(const [early,late] of [["raw","move"],["move","raw"]] as const){
    const tool=new InkInput();
    tool.down({...pointer(1,"pen",0,0,.2),timeStamp:9},opts);
    tool.move(1,[a,b],early);
    tool.move(1,[a,b,c,a],late); // A genuine return to a within the same clock tick.
    assert.deepEqual(tool.move(1,[c,a],early),[]);
    tool.move(1,[d],early);
    assert.deepEqual(tool.move(1,[sample(7,.1,14)],early),[]);
    assert.deepEqual(settled(tool.up(1)).samples,[[0,0,.2],[12,0,.3],[15,0,.6],[15,0,.9],[12,0,.3],[20,0,.4]]);
  }
});

test("middle pan starts on the first pixel and a held mouse resumes the same translucent stroke under the cursor",()=>{
  const input=new InkInput(),mouse=(x:number,down:boolean)=>pointer(1,"mouse",x,0,.5,down);
  assert.deepEqual(kinds(input.beginPan(mouse(0,false))),["pan-start"]);
  assert.deepEqual(input.panTo(mouse(.4,false)),[{kind:"pan",delta:pt(.4)}]);
  assert.equal(input.draft,undefined);
  assert.deepEqual(kinds(input.endPan(mouse(.4,false),opts)),["pan-end"]);
  input.down(mouse(0,true),{...opts,brush:{...opts.brush,brushVersion:2}});input.move(1,[{at:pt(12)}]);
  const prefix=structuredClone(input.draft);
  input.beginPan(mouse(12,true));input.panTo(mouse(92,true));
  input.move(1,[{at:pt(145)}],"raw");assert.deepEqual(input.preview,prefix);
  const camera={zoom:1,offset:pt(80)};
  assert.deepEqual(kinds(input.endPan(mouse(92,true),{...opts,camera})),["pan-end"]);
  input.move(1,[{at:pt(102)}]);
  const [commit]=input.up(1,pt(102));assert(commit.kind==="stroke-commit");
  assert.equal(commit.preceding,undefined);assert.equal(commit.stroke.brushVersion,2);
  assert.deepEqual(inkPoints(commit.stroke).map(p=>p.x),[0,12,22]);
  assert.equal(input.preview,undefined);
});

test("a second-device pan lets the pen move freely or lift, including implicit capture loss",()=>{
  for(const lifted of [false,true]){
    const input=new InkInput(),mouse=pointer(3,"mouse",100,0,.5,false);
    input.down(pointer(5,"pen",10,0,.2),opts);input.move(5,[{at:pt(40),pressure:.8}]);
    input.beginPan(mouse);input.panTo({...mouse,at:pt(150)});
    input.move(5,[{at:pt(300),pressure:.5}]);
    if(lifted){assert.deepEqual(input.up(5),[]);assert.deepEqual(input.cancel(5),[]);}
    const actions=input.endPan({...mouse,at:pt(150)},{...opts,camera:{zoom:1,offset:pt(50)}});
    if(lifted){
      assert.deepEqual(kinds(actions),["pan-end","stroke-commit"]);assert(!input.drawing);
    }else{
      const [commit]=input.up(5,pt(310));assert(commit.kind==="stroke-commit");
      assert.deepEqual(inkPoints(commit.preceding![0]).map(p=>p.x),[10,40]);
      assert.deepEqual(inkPoints(commit.stroke).map(p=>p.x),[250,260]);
    }
  }
});

test("a split contact shares its original sample limit across pieces",()=>{
  const input=new InkInput(3),mouse=pointer(3,"mouse",20,0,.5,false);
  input.down(pointer(8,"pen",0,0,.1),opts);input.move(8,[{at:pt(8),pressure:.7}]);
  input.beginPan(mouse);input.panTo({...mouse,at:pt(52)});
  input.move(8,[{at:pt(90),pressure:.2}]);
  input.endPan(mouse,{...opts,camera:{zoom:1,offset:pt(32)}});
  assert.deepEqual(input.move(8,[{at:pt(92),pressure:.8}]),[{kind:"stroke-cancel",reason:"sample-limit"}]);
  assert.equal(input.preview,undefined);assert.deepEqual(input.up(8),[]);
});

test("default finger navigation passes original IDs and pen preempts it with no held-palm resurrection",()=>{
  const tool=new InkInput();
  assert.deepEqual(tool.down(pointer(11,"touch",0),opts),[{kind:"nav",phase:"down",pointer:pointer(11,"touch",0)}]);
  assert.deepEqual(kinds(tool.move(11,[{at:pt(5)}])),["nav"]);
  tool.down(pointer(12,"touch",25),opts);
  assert.deepEqual(kinds(tool.down(pointer(9,"pen",25),opts)),["nav-reset","stroke-start"]);
  assert.deepEqual(tool.move(11,[{at:pt(1)}]),[]);
  assert.deepEqual(tool.down(pointer(13,"touch",20),opts),[]);
  assert.deepEqual(tool.down(pointer(14,"pen",20),opts),[],"do not replace one pen with another");
  assert.equal(tool.ownerId,9);
  settled(tool.up(9,pt(26)));
  assert.deepEqual(tool.move(12,[{at:pt(14)}]),[]);
  assert.deepEqual(tool.down(pointer(15,"touch",20),opts),[],"wait for quarantined touch release");
  for(const id of [11,12,13,14,15])assert.deepEqual(tool.up(id),[]);
  assert.deepEqual(kinds(tool.down(pointer(16,"touch",20),opts)),["nav"]);
});

test("second finger cancels provisional finger stroke and enters two-contact pinch at latest locations",()=>{
  const tool=new InkInput();
  tool.down(pointer(1,"touch",0),finger);
  tool.move(1,[{at:pt(20,40)}]);
  const p2=pointer(2,"touch",70,40);
  const actions=tool.down(p2,finger);
  assert.deepEqual(actions,[
    {kind:"stroke-cancel",reason:"pinch"},
    {kind:"nav",phase:"down",pointer:{...pointer(1,"touch",0),at:pt(20,40)}},
    {kind:"nav",phase:"down",pointer:p2},
  ]);
  assert.equal(tool.draft,undefined); // former finger drawing never reappears
  assert.deepEqual(kinds(tool.up(2,pt(71,40))),["nav"]);
  assert.deepEqual(kinds(tool.move(1,[{at:pt(21,40)}])),["nav"]);
  assert.deepEqual(kinds(tool.up(1)),["nav"]);
  assert.deepEqual(kinds(tool.down(pointer(3,"touch",90),finger)),["stroke-start"]);
});

test("pen cancels finger draft; cancellation/escape/blur discard without accepting late releases",()=>{
  const tool=new InkInput();
  tool.down(pointer(1,"touch",0),finger);
  assert.deepEqual(tool.down(pointer(2,"pen",0),finger),[{kind:"stroke-cancel",reason:"pen-priority"},{kind:"stroke-start"}]);
  assert.deepEqual(tool.cancel(2),[{kind:"stroke-cancel",reason:"contact-cancelled"}]);
  assert.equal(tool.draft,undefined);
  assert.deepEqual(tool.up(2),[]);
  assert.deepEqual(tool.up(1),[]);
  tool.down(pointer(3,"pen",0),opts);
  assert.deepEqual(tool.interrupt(),[{kind:"stroke-cancel",reason:"interrupted"}]);
  assert(tool.owns(3));assert.deepEqual(tool.move(3,[{at:pt(90)}]),[]);
  assert.deepEqual(tool.up(3),[]);
  tool.down(pointer(4,"touch",0),opts);
  assert.deepEqual(tool.interrupt(true),[{kind:"nav-reset"}]);
  assert(!tool.owns(4));assert.deepEqual(tool.up(4),[]);
  assert.deepEqual(kinds(tool.down(pointer(4,"touch",0),opts)),["nav"]);
});

test("pointer cancel routes only the owning navigation contact once",()=>{
  const tool=new InkInput(),contact=pointer(1,"touch",0);
  tool.down(contact,opts);
  assert.deepEqual(tool.cancel(1),[{kind:"nav",phase:"cancel",pointer:contact}]);
  assert.deepEqual(tool.cancel(1),[]);
});

test("a saved v2 fixed-width stroke reopens and copies with its recorded pressures",async()=>{
  const {demo}=await import("../app/demo.ts");
  const {AssetVault}=await import("../features/image-assets.ts");
  const {captureClipboard}=await import("../features/clipboard.ts");
  const {decodeProject,encodeProject}=await import("../platform/project.ts");
  const legacy={id:"legacy-mouse",kind:"ink",at:pt(10,20),brushVersion:1,...opts.brush,
    samples:[[0,0,.5],[1,0,.5],[55,0,.5]]} as const;
  const vault=new AssetVault();
  const bytes=encodeProject({...demo,schemaVersion:2,objects:{...demo.objects,[legacy.id]:legacy},order:[...demo.order,legacy.id]},vault);
  const doc=decodeProject(bytes).document,stroke=doc.objects[legacy.id];
  assert(stroke.kind==="ink");
  assert.deepEqual(inkPoints(stroke).map(p=>p.radius),[5,5,5]);
  assert.deepEqual(captureClipboard(doc,[legacy.id],vault)!.document.objects[legacy.id],legacy);
  assert.equal(encodeProject(doc,vault),bytes);
});

test("ink creation upgrades v1 atomically; v2 export round-trips pressure and undo/redo while v1 source stays intact",async()=>{
  const { demo }=await import("../app/demo.ts");
  const { EditorSession }=await import("../session/editor.ts");
  const { validateDocument }=await import("../core/document.ts");
  const { encodeProject,decodeProject }=await import("../platform/project.ts");
  const { AssetVault }=await import("../features/image-assets.ts");
  const { buildScene,hitTest,marqueeHit }=await import("../scene/board.ts");
  const { duplicateStandalone,deleteStandalone }=await import("../features/standalone.ts");
  const original=encodeProject(demo,new AssetVault());
  const editor=new EditorSession(decodeProject(original).document,{offset:pt(0),zoom:1});
  const tool=new InkInput();
  tool.down(pointer(1,"pen",4000,4000,.05),opts);
  tool.move(1,[{at:pt(4050,4000),pressure:.95}]);
  const stroke={kind:"ink" as const,id:"ink-test",...settled(tool.up(1))};
  assert(editor.commitEdit({label:"ink",patches:[{op:"putObject",value:stroke}]},editor.generation,[stroke.id]));
  assert.equal(editor.doc.schemaVersion,2);
  assert.equal(editor.history.past.length,1);
  assert.equal(validateDocument({...editor.doc,schemaVersion:1}).length,1);
  assert.equal(decodeProject(original).document.schemaVersion,1);
  const reloaded=decodeProject(encodeProject(editor.doc,new AssetVault())).document;
  assert.deepEqual(reloaded,JSON.parse(JSON.stringify(editor.doc)));
  // Ink is selected by its tapered edge rather than its full bounding box.
  const scene=buildScene(reloaded);
  assert.equal(hitTest(scene,pt(4050,4006),0),stroke.id);
  assert.equal(hitTest(scene,pt(4000,4006),0),undefined);
  assert(marqueeHit(scene,{min:pt(4049,4005),max:pt(4051,4006)}).includes(stroke.id));
  assert(!marqueeHit(scene,{min:pt(3999,4005),max:pt(4001,4006)}).includes(stroke.id));
  editor.undo();assert.equal(editor.doc.schemaVersion,1);assert.equal(editor.doc.objects[stroke.id],undefined);
  editor.redo();assert.equal(editor.doc.schemaVersion,2);editor.select(stroke.id);
  const before=editor.doc.objects[stroke.id];assert(before.kind==="ink");
  assert(editor.moveSelection(pt(10,20)));
  const after=editor.doc.objects[stroke.id];assert(after.kind==="ink");
  assert.deepEqual(after.at,pt(4010,4020));
  assert.strictEqual(after.samples,before.samples);
  assert(duplicateStandalone(editor));assert(deleteStandalone(editor));
  assert(editor.doc.objects[stroke.id]);
  assert.equal(encodeProject(demo,new AssetVault()),original);
});
