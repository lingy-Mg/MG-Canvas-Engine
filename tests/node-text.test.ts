import { test } from "node:test";
import assert from "node:assert/strict";
import { demo } from "../app/demo.ts";
import { buildScene,flowLabelBox,hitTest } from "../scene/board.ts";
import {localToWorld} from "../core/geometry.ts";
import { centeredNodeRuns,nodeTextRows } from "../renderers/canvas2d/node-text.ts";
import { layoutMap } from "../features/mindmap-layout.ts";

const fake=(text:string)=>{
  const cjk=/\p{Script=Han}/u.test(text);
  const width=Array.from(new Intl.Segmenter("zh",{granularity:"grapheme"}).segment(text)).length*10;
  return {width,
    actualBoundingBoxAscent:cjk?12:7,actualBoundingBoxDescent:cjk?1:4,actualBoundingBoxLeft:width/2+(width?1:0),actualBoundingBoxRight:width/2-(width?1:0)};
};

test("Chinese & mixed Latin ink is centered, not its em box",()=>{
  const runs=centeredNodeRuns(["审批","Desk 2g"],13,17,fake);
  const top=Math.min(...runs.map(r=>r.baseline-fake(r.text).actualBoundingBoxAscent));
  const bottom=Math.max(...runs.map(r=>r.baseline+fake(r.text).actualBoundingBoxDescent));
  assert.equal(top,-bottom);
  for(const {x,text} of runs)assert.equal(x-fake(text).actualBoundingBoxLeft,-(x+fake(text).actualBoundingBoxRight));
  const [single]=centeredNodeRuns(["需要审批?"],13,17,fake);
  assert.equal(single.baseline,5.5); // A fixed middle baseline would retain the 11-unit ascent/descent asymmetry.
});

test("node wrapping has strict measured width, line cap, ellipsis, and intact graphemes",()=>{
  assert.deepEqual(nodeTextRows("审批确认\nEnglish",30,2,fake),["审批确","认…"]);
  assert.deepEqual(nodeTextRows("审🔐批",10,3,fake),["审","🔐","批"]);
  assert.deepEqual(nodeTextRows("é中文",10,3,fake),["é","中","文"]);
  assert.deepEqual(nodeTextRows("任务A\n完成",35,2,fake),["任务A","完成"]);
  assert.deepEqual(nodeTextRows("审批",1,1,fake),[]);
});

test("node projection uses the actual shape center and one-line diamond safe band, keeps pick boxes",()=>{
  const scene=buildScene(demo);
  const decision=scene.find(group=>group.id==="flow-decision")!;
  const box=decision.items.find(item=>item.kind==="box")!;
  const label=decision.items.find(item=>item.kind==="nodeLabel")!;
  assert(box.kind==="box"&&label.kind==="nodeLabel");
  const mid=(b:typeof box.box)=>({x:b.at.x+b.width/2,y:b.at.y+b.height/2});
  assert(Math.abs(mid(box.box).x-mid(label.box).x)<1e-9);
  assert(Math.abs(mid(box.box).y-mid(label.box).y)<1e-9);
  assert.equal(label.maxLines,1);
  assert(label.box.width<box.box.width&&label.box.height<box.box.height);
  assert.equal(hitTest([decision],mid(box.box),0),"flow-decision");
  const group=scene.find(item=>item.id==="mind-room")!;
  const labels=group.items.filter(item=>item.kind==="nodeLabel");
  assert(labels.length>1);
  assert(labels[0].fontSize>labels[1].fontSize&&labels[0].weight>labels[1].weight);
  const docMap=demo.objects["mind-room"];assert(docMap.kind==="mindmap");
  assert.equal(layoutMap(docMap)[0].topic.text,labels[0].text);
  assert.equal(hitTest([group],mid(labels[1].box),0),"mind-room");
});

test("flow label safe areas rotate around the owning shape center at right and oblique angles",()=>{
  const seed=demo.objects["flow-source"];assert(seed.kind==="shape");
  for(const shape of ["rect","diamond","triangle"] as const){
    const source={...seed,shape,rotation:0},flat=flowLabelBox(source);
    for(const rotation of [Math.PI/2,-.57]){
      const owner={...source,rotation},label=flowLabelBox(owner);
      assert.equal(label.rotation,rotation);assert.equal(label.width,flat.width);assert.equal(label.height,flat.height);
      for(const p of [{x:0,y:0},{x:label.width,y:label.height}]){
        const expected=localToWorld({x:flat.at.x-source.at.x+p.x,y:flat.at.y-source.at.y+p.y},owner),actual=localToWorld(p,label);
        assert(Math.hypot(actual.x-expected.x,actual.y-expected.y)<1e-9);
      }
    }
  }
});
