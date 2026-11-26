import test from "node:test";
import assert from "node:assert/strict";
import {compileFlowDrawing,FlowDrawingError,parseMermaidFlow} from "../features/flow-drawing.ts";
import type {FlowDrawingInput} from "../features/flow-drawing.ts";
import {executeBatch} from "../features/board-commands.ts";
import {AssetVault} from "../features/image-assets.ts";
import {EditorSession} from "../session/editor.ts";
import {buildScene,fitScene} from "../scene/board.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {encodeClipboard,decodeClipboard} from "../features/clipboard.ts";
import {boxBounds} from "../core/geometry.ts";
import {isId,validateDocument} from "../core/document.ts";
import type {BoardDocument,Connector,ShapeObject} from "../core/document.ts";
import {drawCanvasFlow} from "../features/canvas-tool-drawing.ts";
import {SceneProjection} from "../scene/projector.ts";

const empty:BoardDocument={id:"editable-flow",schemaVersion:1,theme:"paper",objects:{},order:[],assets:{}};
const example=[
  "%% 一次拖动的两个结果",
  "flowchart TD",
  '  start(["拖动节点"]) --> session[暂存位移]',
  "  session -->|移动| scene[预览画面]",
  "  session commit@-->|松手| gate{提交变更？}",
  "  gate yes@-- 是 --> save[保存快照]",
  "  gate no@-->|否| keep[保留文档]",
  "  save & keep --> done([结束])",
].join("\n");
function document(input:Parameters<typeof compileFlowDrawing>[0]){
  const plan=compileFlowDrawing(input),objects=Object.fromEntries(plan.operations.map(op=>[op.value.id,op.value]));
  const doc={...empty,objects,order:plan.operations.map(op=>op.value.id)};
  assert.deepEqual(validateDocument(doc),[]);return {doc,plan};
}
function clearRoutes(doc:BoardDocument){
  const shapes=Object.values(doc.objects).filter((item):item is ShapeObject=>item.kind==="shape");
  for(const [i,a] of shapes.entries()){
    const b=boxBounds(a);
    for(const s of shapes.slice(i+1)){
      const t=boxBounds(s);
      assert.ok(b.max.x<=t.min.x||t.max.x<=b.min.x||b.max.y<=t.min.y||t.max.y<=b.min.y,"overlapping "+a.id+" and "+s.id);
    }
  }
  for(const group of buildScene(doc)){
    const line=doc.objects[group.id];if(line.kind!=="connector")continue;
    assert.ok(line.from.kind==="anchor"&&line.to.kind==="anchor");
    const path=group.items.find(item=>item.kind==="path")!;assert.ok(path.kind==="path"&&path.points.length>=2);
    for(const shape of shapes){
      if(shape.id===line.from.objectId||shape.id===line.to.objectId)continue;
      const b=boxBounds(shape);
      for(let i=1;i<path.points.length;i++){
        const p=path.points[i-1],q=path.points[i];
        const hit=p.x===q.x?p.x>b.min.x&&p.x<b.max.x&&Math.min(p.y,q.y)<b.max.y&&Math.max(p.y,q.y)>b.min.y:
          p.y===q.y&&p.y>b.min.y&&p.y<b.max.y&&Math.min(p.x,q.x)<b.max.x&&Math.max(p.x,q.x)>b.min.x;
        assert.ok(!hit,line.id+" crosses "+shape.id);
      }
    }
  }
}
const node=(d:BoardDocument,id:string)=>d.objects[id] as ShapeObject;
const edge=(d:BoardDocument,id:string)=>d.objects[id] as Connector;
const center=(s:ShapeObject)=>({x:s.at.x+s.width/2,y:s.at.y+s.height/2});
test("quoted labels, comments, native shapes, chained edges, named links and Cartesian forks survive compilation",()=>{
  const source='graph LR; A["输入; [草稿]"] e1@-->|"含|号"| B(校验) --> C((完成)); A & B --- D([归档]); D <--> C; A["已定;稿"]; %% 注释';
  const {doc,plan}=document({mermaid:source});
  assert.deepEqual(plan.nodeIds,["A","B","C","D"]);assert.equal(plan.edgeIds.length,5);
  assert.equal(node(doc,"A").label,"已定;稿");assert.equal(edge(doc,"e1").label,"含|号");
  assert.equal(node(doc,"B").cornerRadius,10);assert.equal(node(doc,"C").width,node(doc,"C").height);
  assert.equal(node(doc,"D").cornerRadius,node(doc,"D").height/2);
  assert.deepEqual(plan.edgeIds.map(id=>edge(doc,id).arrow),["end","end","none","none","both"]);
  assert.deepEqual(compileFlowDrawing({graph:parseMermaidFlow(source)}),plan);
  const fenced="\x60\x60\x60mermaid\nflowchart TD\nA[中文<br/>第二行] --> B\n\x60\x60\x60";
  assert.equal(node(document({mermaid:fenced}).doc,"A").label,"中文\n第二行");
});
test("ranked flow respects all four axes, keeps fork ports opposite, and fits the narrow editing viewport",()=>{
  for(const dir of ["TD","TB","BT","LR","RL"]){
    const {doc,plan}=document({mermaid:example.replace("TD",dir),origin:{x:-147,y:53}});
    const along=dir==="LR"||dir==="RL"?"x":"y",sign=dir==="BT"||dir==="RL"?-1:1;
    for(const [a,b] of [["start","session"],["session","gate"],["gate","save"],["save","done"],["keep","done"]]){
      assert.ok(sign*(center(node(doc,b))[along]-center(node(doc,a))[along])>0);
    }
    const yes=edge(doc,"yes").from,no=edge(doc,"no").from;
    assert.ok(yes.kind==="anchor"&&no.kind==="anchor");
    assert.deepEqual([yes.portId,no.portId],along==="x"?["north","south"]:["west","east"]);
    for(const op of plan.operations){
      const v=op.value,pts=v.kind==="shape"?[v.at]:v.waypoints;
      assert.ok(pts.every(p=>Number.isSafeInteger(p.x)&&Number.isSafeInteger(p.y)));
    }
    clearRoutes(doc);
    if(dir==="TD")assert.ok(fitScene(buildScene(doc),650,831).zoom>=1);
  }
});
test("back edges, parallel edges, self loops, long edges, and disconnected components stay editable and clear",()=>{
  const {doc,plan}=document({mermaid:"flowchart LR; A --> B --> C --> D; A skip@--> D; D back@--> B; C self@--> C; A copy@-->|另一路| B; X[独立节点]; Y --> Z;"});
  assert.ok(plan.edgeIds.every(isId));clearRoutes(doc);
  for(const id of ["skip","back","self","copy"])assert.ok(edge(doc,id).waypoints.length>0,id);
  const graph={nodes:[{id:"root"},{id:"edge.4.root.leaf"},{id:"leaf"},{id:"A".repeat(128)}],edges:[
    {from:"root",to:"leaf"},{from:"root",to:"leaf"},{from:"A".repeat(128),to:"leaf"},
  ]};
  const first=compileFlowDrawing({graph});assert.deepEqual(first,compileFlowDrawing({graph}));
  assert.ok(first.edgeIds.every(isId));assert.equal(new Set([...first.nodeIds,...first.edgeIds]).size,7);
  assert.deepEqual(compileFlowDrawing({graph:{...graph,nodes:graph.nodes.map(n=>({...n,label:"新名称"}))}}).edgeIds,first.edgeIds);
});
test("reject unsupported syntax and malformed declarations at the responsible location, even after a valid prefix",()=>{
  for(const [line,column,source] of [
    [3,3,"flowchart TD\nA --> B\n  subgraph bad"],[2,3,"graph LR\nA -.-> B"],[2,2,"graph TD\nA[[子程序]]"],
    [2,2,"graph LR\nA---oB"],[2,2,"graph LR\nA---xB-->C"],
    [2,2,"graph LR\nA@{shape:database}"],[2,4,"graph TD\nA[x<b>强调</b>]"],
    [2,1,"graph LR\n%%{init: {}}%%"],[4,3,"graph TD\nA --> B\nB --> C\nA B@--> C"],
    [3,5,"graph TD\n  A e@--> B\n  B e@--> C"],[2,10,"graph LR\nA --> B; style B fill:red"],
  ] as const){
    assert.throws(()=>compileFlowDrawing({mermaid:source}),(e:unknown)=>e instanceof FlowDrawingError&&
      e.code==="INVALID"&&e.path==="mermaid"&&e.line===line&&e.column===column,"wrong diagnostic: "+source);
  }
  for(const [input,path] of [
    [{graph:{nodes:[{id:"A"}],edges:[{from:"A",to:"missing"}]}},"graph.edges[0].to"],
    [{graph:{nodes:[{id:"A"},{id:"A"}],edges:[]}},"graph.nodes[1].id"],
    [{graph:{nodes:[{id:"A",shape:"database"}],edges:[]}},"graph.nodes[0].shape"],
    [{graph:{nodes:[{id:"A",shape:"diamond",label:"双\n行"}],edges:[]}},"graph.nodes[0].label"],
    [{graph:{nodes:[{id:"A"}],edges:[{id:"A",from:"A",to:"A"}]}},"graph.edges[0].id"],
    [{graph:{nodes:[{id:"A",color:"red"}],edges:[]}},"graph.nodes[0].color"],
    [{graph:{nodes:[],edges:[]}},"graph.nodes"],[{graph:{},mermaid:"graph LR\nA"},"drawing"],
    [{graph:{nodes:[{id:"A"}],edges:[]},origin:{x:Infinity,y:0}},"origin"],
  ] as const)assert.throws(()=>compileFlowDrawing(input as unknown as FlowDrawingInput),(e:unknown)=>e instanceof FlowDrawingError&&e.path===path);
});
test("one native batch draws the graph; ID updates, undo, redo and project round trip preserve every binding",()=>{
  const editor=new EditorSession(empty,{zoom:1,offset:{x:0,y:0}}),vault=new AssetVault();
  const plan=compileFlowDrawing({mermaid:example});
  executeBatch(editor,vault,plan.operations,"一次起图");
  assert.equal(editor.history.past.length,1);
  const drawn=editor.doc,ports=edge(drawn,"commit");
  assert.throws(()=>executeBatch(editor,vault,plan.operations));assert.equal(editor.doc,drawn);
  executeBatch(editor,vault,[{op:"update",id:"gate",fields:{label:"确定保存？"}},{op:"update",id:"commit",fields:{label:"松开指针"}}]);
  const {unedited,...edited}=ports;
  assert.equal(unedited,true);assert.deepEqual(edge(editor.doc,"commit"),{...edited,label:"松开指针"});
  assert.deepEqual(decodeProject(encodeProject(editor.doc,vault)).document,structuredClone(editor.doc));
  editor.undo();assert.equal(editor.doc,drawn);editor.undo();assert.deepEqual(editor.doc.order,[]);editor.redo();assert.equal(editor.doc,drawn);
});
test("generated type sizes stay with native nodes and edges through projects and clipboard; existing labels retain their original sizes",()=>{
  const {doc}=document({mermaid:"flowchart TB; A[编辑请求] --> B{校验通过？}; B ok@-->|通过| C[提交更改]; B no@-->|拒绝| D[记录原因]; C & D --> E[结束复核]"});
  const font=(d:BoardDocument,id:string)=>{
    const item=buildScene(d).find(g=>g.id===id)!.items[1];
    return item.kind==="nodeLabel"?item.fontSize:item.kind==="text"?item.size:0;
  };
  assert.equal(font(doc,"ok"),16);assert.equal(font(doc,"A"),17);
  const vault=new AssetVault(),encoded=JSON.parse(encodeProject(doc,vault));
  assert.equal(encoded.flowLabelSizes.ok,16);assert.equal(encoded.document.objects.ok.labelFontSize,undefined);
  assert.deepEqual(validateDocument(encoded.document),[]);
  const {flowLabelSizes,...legacy}=encoded;
  const old=decodeProject(JSON.stringify(legacy)).document;
  assert.equal(font(old,"ok"),10);assert.equal(font(old,"A"),13);
  assert.equal(JSON.parse(encodeProject(old,vault)).flowLabelSizes,undefined);
  const clipboard=decodeClipboard(encodeClipboard({document:doc,assets:[]}))!;
  assert.equal(font(clipboard.document,"A"),17);assert.equal(font(clipboard.document,"no"),16);
  for(const bad of [{unknown:16},{A:0},{A:17.5},[],null]){
    assert.throws(()=>decodeProject(JSON.stringify({...encoded,flowLabelSizes:bad})),/字号/);
  }
  assert.equal(flowLabelSizes.B,node(doc,"B").labelFontSize);
});
test("two generated diagrams and an existing note retain readable type at 650 × 760 whole-board fit",()=>{
  const note:ShapeObject={id:"existing-note",kind:"shape",shape:"rect",at:{x:0,y:0},width:188,height:72,
    rotation:0,cornerRadius:8,fill:"#FFF4BA",stroke:"#9B824B",label:"原有便签｜保留编辑约定",content:{kind:"sticky",fontSize:18}};
  const seed={...empty,order:[note.id],objects:{[note.id]:note}},vault=new AssetVault();
  const editor=new EditorSession(seed,fitScene(buildScene(seed),1280,776)),scene=new SceneProjection(editor.doc);
  editor.listen(change=>scene.update(editor.doc,change));
  const draw=(mermaid:string)=>drawCanvasFlow(editor,vault,{mermaid},{scene,camera:editor.camera,width:1280,height:776});
  const flow=draw("flowchart TB; A[编辑请求] --> B{校验通过？}; B -->|通过| C[提交更改]; B -->|拒绝| D[记录原因]; C --> E[结束复核]; D --> E");
  const architecture=draw("flowchart TB; A[编辑界面] --> B[规则校验模块]; B --> C[版本存储]; A --> D[变更日志]");
  const ids=architecture.nodeIdMap;
  executeBatch(editor,vault,[{op:"update",id:ids.B,fields:{label:"变更校验模块"}},{op:"update",id:architecture.edgeIds[1],fields:{
    from:{kind:"anchor",objectId:ids.B,portId:"east"},to:{kind:"anchor",objectId:ids.D,portId:"west"}}}]);
  const zoom=fitScene(scene.all(),650,641).zoom;
  for(const id of flow.edgeIds){
    const e=edge(editor.doc,id);if(!e.label)continue;
    const mark=scene.group(id)!.items.find(p=>p.kind==="text")!;assert.ok(mark.kind==="text"&&mark.size*zoom>=12);
  }
  for(const id of [...flow.nodeIds,...architecture.nodeIds]){
    const mark=scene.group(id)!.items.find(p=>p.kind==="nodeLabel")!;assert.ok(mark.kind==="nodeLabel"&&mark.fontSize*zoom>=13);
  }
  assert.deepEqual(editor.doc.objects[note.id],note);
});

const grouped=[
  "flowchart TD","A --> B","  subgraph app[应用输入]","    A[命中节点]","    B[暂存位移] --> C","  end",
  '  subgraph core["事务与历史"]',"    C{确认提交？} yes@-->|是| D[保留快照]","  end",
  "  subgraph platform[浏览器保存]","    E[写入工作区]","  end","  C write@-->|安排保存| E","  D --> E",
].join("\n");
test("one-level Mermaid groups retain visible titles, single-member groups and concrete cross-group ports",()=>{
  for(const direction of ["TD","LR","RL","BT"]){
    const plan=compileFlowDrawing({mermaid:grouped.replace("TD",direction)});
    assert.deepEqual(plan.groups.map(g=>[g.id,g.nodeIds]),[["app",["A","B"]],["core",["C","D"]],["platform",["E"]]]);
    const editor=new EditorSession(empty,{zoom:1,offset:{x:0,y:0}}),vault=new AssetVault();
    const members=Object.fromEntries(plan.groups.map(g=>[g.id,[g.titleId,...g.nodeIds]]));
    executeBatch(editor,vault,[...plan.operations,{op:"groups",members}]);
    const initial=editor.doc;
    assert.equal(initial.schemaVersion,5);assert.deepEqual(initial.flowGroups?.members,members);
    assert.deepEqual(plan.groups.map(g=>node(initial,g.titleId).label),["应用输入","事务与历史","浏览器保存"]);
    for(const id of plan.edgeIds){
      const e=edge(initial,id);assert.ok(e.from.kind==="anchor"&&e.to.kind==="anchor");
      assert.ok(plan.nodeIds.includes(e.from.objectId)&&plan.nodeIds.includes(e.to.objectId));
    }
    clearRoutes(initial);assert.ok(fitScene(buildScene(initial),650,831).zoom>(direction==="TD"?.95:.4));
    const g=plan.groups[1];
    executeBatch(editor,vault,[{op:"update",group:g.id,id:g.titleId,fields:{label:"事务记录"}},{op:"update",id:"write",fields:{label:"延迟写入"}}]);
    assert.equal(node(editor.doc,g.titleId).label,"事务记录");assert.deepEqual(decodeProject(encodeProject(editor.doc,vault)).document,structuredClone(editor.doc));
    editor.undo();assert.equal(editor.doc,initial);editor.undo();assert.deepEqual(editor.doc.order,[]);editor.redo();assert.equal(editor.doc,initial);
  }
});
test("closing the former incomplete subgraph imports it; nested, empty, misplaced and ambiguous members are diagnosed",()=>{
  const start="graph TD\nA --> B\n  subgraph test";
  assert.throws(()=>compileFlowDrawing({mermaid:start}),{line:3,column:3,message:/缺少 end/});
  const ok=compileFlowDrawing({mermaid:start+"\n    C[处理]\n  end\n B --> C"});assert.deepEqual(ok.groups[0].nodeIds,["C"]);
  for(const [text,line,col] of [
    ["graph TD\n  subgraph a\n    subgraph b\n      X\n    end\n  end",3,5],
    ["graph TD\n  subgraph a\n  end\n X",2,3],["graph TD\nA\n  end",3,3],
    ["graph TD\nsubgraph a\n A[输入]\nend\nsubgraph b\n  A[重复]\nend",6,3],
    ["graph TD\nsubgraph a\n direction LR\n A\nend",3,2],
  ] as const)assert.throws(()=>compileFlowDrawing({mermaid:text}),{path:"mermaid",line,column:col});
  const withClash=compileFlowDrawing({graph:{nodes:[{id:"A"},{id:"title.app"}],edges:[],groups:[{id:"app",nodeIds:["A"]}]}});
  assert.notEqual(withClash.groups[0].titleId,"title.app");
  assert.throws(()=>compileFlowDrawing({graph:{nodes:[{id:"A"}],edges:[],groups:[{id:"g",nodeIds:["A"]},{id:"h",nodeIds:["A"]}]}}),
    {path:"graph.groups[1].nodeIds[0]"});
});
