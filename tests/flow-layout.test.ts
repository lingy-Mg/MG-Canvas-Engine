import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import type {BoardDocument,BoardObject,Connector,ShapeObject} from "../core/document.ts";
import {resolveEndpoint} from "../core/document.ts";
import {boxBounds} from "../core/geometry.ts";
import {layoutSelectedFlow} from "../features/flow-layout.ts";
import {applyDownstreamLayout,planDownstreamLayout} from "../features/downstream-layout.ts";
import {anchoredFlowPath,setConnectorEnd} from "../features/flow.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {SceneProjection} from "../scene/projector.ts";
import {EditorSession} from "../session/editor.ts";

const p=(x:number,y:number)=>({x,y});
const shape=(id:string,x:number,y:number,fields:Partial<ShapeObject>={}):ShapeObject=>({
  kind:"shape",shape:"rect",id,at:p(x,y),width:40,height:24,rotation:0,cornerRadius:3,
  fill:"#cdebee",stroke:"rebeccapurple",label:id,...fields});
const line=(id:string,from:string,to:string,fields:Partial<Connector>={}):Connector=>({
  id,kind:"connector",from:{kind:"anchor",objectId:from,portId:"east"},to:{kind:"anchor",objectId:to,portId:"west"},
  routing:"orthogonal",waypoints:[],arrow:"end",label:"",stroke:"#697384",...fields});
const board=(rows:BoardObject[]):BoardDocument=>({schemaVersion:1,id:"arrange-flow",theme:"paper",
  objects:Object.fromEntries(rows.map(row=>[row.id,row])),order:rows.map(row=>row.id),assets:{}});
const session=(doc:BoardDocument)=>new EditorSession(doc,{zoom:1,offset:p(0,0)});
function select(e:EditorSession,ids:string[]){ids.forEach((id,i)=>e.select(id,i>0));}
function arrange(e:EditorSession){const scene=new SceneProjection(e.doc);scene.setHidden(e.hiddenIds);return layoutSelectedFlow(e,scene);}
const locate=(e:EditorSession,id:string)=>(e.doc.objects[id] as ShapeObject).at;
const mixed=JSON.parse(readFileSync(new URL("../docs/fixtures/M5AG-Layer-Locks.mgcanvas",import.meta.url),"utf8")).document as BoardDocument;

test("branches and merges use longest directed distance; stable layer order and repeated commands are independent of selection order",()=>{
  const ids=["a","b","c","d"],doc=board([shape("a",10,20),shape("c",190,115),shape("b",44,200),shape("d",260,55),
    line("ab","a","b"),line("ac","a","c"),line("bd","b","d"),line("cd","c","d"),line("ad","a","d"),line("parallel","a","b")]);
  for(const order of [ids,[...ids].reverse()]){
    const e=session(doc);select(e,order);const before=e.doc,picked=e.selectedIds;
    assert.equal(arrange(e).state,"applied");assert.deepEqual(ids.map(id=>locate(e,id)),[p(10,20),p(90,72),p(90,20),p(170,20)]);
    assert.deepEqual(e.selectedIds,picked);assert.equal(e.doc.order,before.order);const state=e.history;
    assert.equal(arrange(e).state,"unchanged");assert.equal(e.history,state);e.undo();assert.equal(e.doc,before);e.redo();assert.equal(e.doc,state.doc);
  }
});
test("loops and bidirectional links share a column; reversed arrows, plain direction and isolated components have stable lanes",()=>{
  const nodes=["a","b","c","d","e","f","solo"].map((id,i)=>shape(id,20+i*100,35+i*47));
  const rows=[...nodes,line("ac","a","b"),line("bc","b","c"),line("cb","c","b"),line("cd","c","d",{arrow:"none"}),
    line("ed","e","d",{arrow:"start"}),line("fe","f","e",{arrow:"both"}),line("self","b","b",{waypoints:[p(1,7)]})];
  const e=session(board(rows));select(e,nodes.map(n=>n.id));assert.equal(arrange(e).state,"applied");
  assert.equal(locate(e,"b").x,locate(e,"c").x);assert(locate(e,"b").y<locate(e,"c").y);
  assert(locate(e,"a").x<locate(e,"b").x&&locate(e,"c").x<locate(e,"d").x&&locate(e,"d").x<locate(e,"e").x);
  assert.equal(locate(e,"e").x,locate(e,"f").x);assert(locate(e,"solo").y>locate(e,"f").y);
  const history=e.history;assert.equal(arrange(e).state,"unchanged");assert.equal(e.history,history);
  const noEdge=session(board([shape("a",3,4),shape("b",60,90),line("loop","a","a")]));select(noEdge,["a","b"]);
  assert.match(arrange(noEdge).message,/两个不同节点/);assert.equal(noEdge.history.revision,0);
});
test("multiple connected components and rotated, unequal sizes fit without losing style or stacking",()=>{
  const rows=[shape("z",20,40,{width:148,height:44,rotation:.6,strokeWidth:12}),shape("y",340,290,{shape:"triangle"}),
    shape("a",80,270,{shape:"diamond",rotation:-.22}),shape("b",400,250),line("ab","a","b"),line("zy","z","y")];
  const e=session(board(rows));select(e,["a","z","y","b"]);const initial=e.doc;
  assert.equal(arrange(e).state,"applied");const boxes=["z","y","a","b"].map(id=>boxBounds(e.doc.objects[id] as ShapeObject));
  assert(boxes[1].min.x-boxes[0].max.x>=45.99999);assert(boxes[2].min.y-boxes[0].max.y>=69.99999);assert(boxes[3].min.x>boxes[2].max.x);
  for(const n of rows)if(n.kind==="shape")assert.deepEqual(e.doc.objects[n.id],{...initial.objects[n.id],at:locate(e,n.id)});
  const state=e.history;assert.equal(arrange(e).state,"unchanged");assert.equal(e.history,state);
});
test("complete selected group or explicit subgroup selection changes only its eligible nodes and never edits connector records",()=>{
  const e=session(mixed);e.select("a");const before=e.doc,inside=before.objects.internal as Connector,cross=before.objects.cross as Connector;
  const pins=structuredClone([inside.waypoints,cross.waypoints]),from=resolveEndpoint(before,cross.from);
  assert.equal(arrange(e).state,"applied");assert.equal(e.doc.flowGroups,before.flowGroups);
  for(const id of before.order)if(!["a","b","target"].includes(id))assert.equal(e.doc.objects[id],before.objects[id]);
  assert.deepEqual([inside.waypoints,cross.waypoints],pins);assert.notDeepEqual(resolveEndpoint(e.doc,cross.from),from);
  assert.deepEqual(resolveEndpoint(e.doc,cross.to),resolveEndpoint(before,cross.to));e.undo();assert.equal(e.doc,before);
  assert(e.enterGroup("b"));e.select("a",true);e.setLayerLocks(["internal"],true);
  assert.equal(arrange(e).state,"applied");assert.equal(e.doc.objects.internal,inside);assert.equal(e.doc.objects.target,before.objects.target);
  assert.equal(e.editingGroup,"group-intake");e.undo();assert.equal(e.doc,before);
});
test("partly hidden or locked groups, mixed selections and explicitly selected external lines refuse the entire action",()=>{
  for(const protectedBy of ["lock","hide"]){
    const e=session(mixed);if(protectedBy==="lock")e.setLayerLocks(["target"],true);else e.setLayerVisibility(["target"],false);
    e.select("a");const before=e.history;assert.match(arrange(e).message,/锁定|隐藏/);assert.equal(e.history,before);
  }
  for(const peer of ["qa-picture","sample-ink","mind-booking","qa-label","open-path","cross"]){
    const e=session(mixed);e.select("a");e.select(peer,true);const before=e.history;
    assert.equal(arrange(e).state,"refused");assert.equal(e.history,before);
  }
});
test("hidden and crossing lines cannot create graph edges; ordinary pins and free endpoints stay in world space",()=>{
  const a=shape("a",0,0),b=shape("b",210,85),c=shape("c",400,150);
  const ab=line("ab","a","b",{waypoints:[p(111,82)]}),bc=line("bc","b","c",{waypoints:[p(260,90),p(275,110)]}),
    free=line("free","b","c",{to:{kind:"free",point:p(510,200)}});
  const e=session(board([a,b,c,ab,bc,free]));select(e,["a","b"]);e.setLayerVisibility(["ab"],false);const before=e.history;
  assert.match(arrange(e).message,/没有连接/);assert.equal(e.history,before);
  e.showAllLayers();e.select("free",true);assert.match(arrange(e).message,/自由端/);assert.equal(e.history,before);e.select("free",true);
  e.setLayerLocks(["bc"],true);assert.equal(arrange(e).state,"applied");
  for(const n of [ab,bc,free,c])assert.equal(e.doc.objects[n.id],before.doc.objects[n.id]);
  assert.deepEqual(resolveEndpoint(e.doc,ab.to),p(80,12));assert.deepEqual(resolveEndpoint(e.doc,bc.from),p(120,12));
});
test("occupied destinations and invalid final cross-boundary bindings reject every node atomically",()=>{
  const a=shape("a",0,0),b=shape("b",200,150),c=shape("c",300,310);
  for(const extra of [shape("obstacle",165,1),line("external","c","a",{to:{kind:"free",point:p(200,12)},routing:"straight"})]){
    const e=session(board([a,b,c,line("ab","a","b"),line("bc","b","c"),extra]));
    select(e,["a","b","c"]);const state=e.history;assert.equal(arrange(e).state,"refused");assert.equal(e.history,state);
    assert.deepEqual(locate(e,"b"),b.at);
    if(extra.kind==="shape"){e.setLayerVisibility(["obstacle"],false);assert.equal(arrange(e).state,"applied");assert.equal(e.doc.objects.obstacle,state.doc.objects.obstacle);}
  }
});
test("two complete groups may be laid out together while their cross-group pins and all membership references stay fixed",()=>{
  const e=session(mixed);e.setLayerVisibility(["standalone"],false);select(e,["a","outside"]);
  const before=e.doc,groups=before.flowGroups,cross=before.objects.cross as Connector;
  assert.equal(arrange(e).state,"applied");assert.equal(e.doc.flowGroups,groups);assert.equal(e.doc.objects.cross,cross);
  assert.deepEqual(["a","b","outside","review","target"].map(id=>locate(e,id)),[p(25,48),p(143,48),p(261,48),p(379,48),p(25,150)]);
  for(const id of ["internal","review-link","qa-picture","sample-ink","mind-booking","standalone"])assert.equal(e.doc.objects[id],before.objects[id]);
  assert.equal(arrange(e).state,"unchanged");e.undo();assert.equal(e.doc,before);
});
test("unrepresentable column spacing at an extreme finite coordinate leaves the original snapshot intact",()=>{
  const x=2**60,a=shape("a",x,0,{width:512,height:128}),b=shape("b",x+2048,150,{width:512,height:128});
  const e=session(board([a,b,line("ab","a","b")]));select(e,["a","b"]);const state=e.history;
  assert.match(arrange(e).message,/坐标/);assert.equal(e.history,state);
});
test("long cyclic selection collapses iteratively without a recursive graph walk",()=>{
  const n=1600,nodes=Array.from({length:n},(_,i)=>shape("s"+i,110*i,0));
  const doc=board([...nodes,...nodes.map((v,i)=>line("l"+i,v.id,nodes[(i+1)%n].id))]),e=session(doc);e.selectAll();
  assert.equal(arrange(e).state,"applied");assert.deepEqual(locate(e,"s0"),p(0,0));assert.deepEqual(locate(e,"s1599"),p(0,1599*52));
  assert.equal(e.history.revision,1);assert.equal(arrange(e).state,"unchanged");
});

const preview=(e:EditorSession)=>planDownstreamLayout(e,new SceneProjection(e.doc));
test("legacy and explicitly bound fork ports get enough clearance for a monotone route without changing either binding",()=>{
  for(const routing of ["orthogonal","curve"] as const){
    const link=line("fork","b","d",{from:{kind:"anchor",objectId:"b",portId:"south"},to:{kind:"anchor",objectId:"d",portId:"north"},
      routing,...(routing==="curve"?{portCurve:true as const}:{})});
    const e=session(board([shape("a",0,0),shape("b",180,0),shape("c",356,-45),shape("d",356,45),line("ab","a","b"),line("bc","b","c"),link]));
    e.select("a");const original=e.doc.objects.fork;fromRoot(e);assert.equal(e.doc.objects.fork,original);
    const start=resolveEndpoint(e.doc,link.from)!,end=resolveEndpoint(e.doc,link.to)!;
    const path=anchoredFlowPath(start,end,routing,[],link.from,link.to,id=>e.doc.objects[id],{portCurve:link.portCurve});
    assert(path.length>2);assert(path.every((p,i)=>!i||(p.x>=path[i-1].x&&p.y>=path[i-1].y)));
  }
});
test("successive forks retain a straight main route; preview, applied ports and persisted geometry agree",()=>{
  const rows=[["a",0,0],["b",176,0],["c",352,-45],["d",352,45],["e",528,0],["f",528,90],["g",704,90]] as const;
  const edges=[["ab","a","b"],["bc","b","c"],["bd","b","d"],["de","d","e"],["df","d","f"],["fg","f","g"]] as const;
  for(const routing of ["orthogonal","curve"] as const){
    const doc=board([...rows.map(([id,x,y])=>shape(id,x,y,{width:136,height:62})),...edges.map(([id,a,b])=>{
      const turn=id==="bd"||id==="df";
      return line(id,a,b,{from:{kind:"anchor",objectId:a,portId:turn?"south":"east"},to:{kind:"anchor",objectId:b,portId:turn?"north":"west"},
        routing,autoPorts:"both",unedited:true,...(routing==="curve"?{portCurve:true as const}:{})});
    })]);
    const e=session(doc);e.select("a");const before=e.doc,scene=new SceneProjection(before),plan=planDownstreamLayout(e,scene);
    assert(plan.state==="planned");assert.deepEqual(plan.lines.map(l=>l.id),["bd","df"]);
    const overlay=scene.overlay({objects:new Map<string,BoardObject>([...plan.nodes,...plan.lines].map(v=>[v.id,v]))});
    assert.equal(e.doc,before);assert.equal(applyDownstreamLayout(e,plan).state,"applied");scene.update(e.doc);
    for(const id of ["b","d","f","g"])assert.equal(locate(e,id).y,locate(e,"a").y);
    assert.equal(locate(e,"c").y,locate(e,"e").y);assert(locate(e,"c").y+62<locate(e,"d").y);
    for(const [id] of edges){
      const l=e.doc.objects[id];assert(l.kind==="connector"&&l.from.kind==="anchor"&&l.to.kind==="anchor");
      assert.equal(l.from.portId,"east");assert.equal(l.to.portId,"west");assert(l.unedited);
      assert.deepEqual(scene.group(id),overlay.get(id));
    }
    const arranged=e.doc;assert.equal(preview(e).state,"unchanged");assert.equal(e.history.past.length,1);
    const saved=encodeProject(arranged,new AssetVault());assert.deepEqual(decodeProject(saved).document,{...arranged,objects:{...arranged.objects}});
    e.undo();assert.equal(e.doc,before);e.redo();assert.equal(e.doc,arranged);
    const l=arranged.objects.bd as Connector;assert(setConnectorEnd(e,l.id,"from",l.from));
    assert.equal((e.doc.objects.bd as Connector).autoPorts,"to");
  }
});
function fromRoot(e:EditorSession){
  const plan=preview(e);assert.equal(plan.state,"planned");
  const before=e.history;assert.equal(applyDownstreamLayout(e,plan).state,"applied");
  assert.equal(e.history.past.length,before.past.length+1);
  assert.equal(preview(e).state,"unchanged");
  return plan.scope;
}
test("successors align in all four outlet directions, with a fixed start, equal gaps and one undo",()=>{
  for(const [port,opposite,dx,dy] of [["east","west",80,0],["west","east",-80,0],["south","north",0,64],["north","south",0,-64]] as const){
    const edge=(id:string,a:string,b:string)=>line(id,a,b,{from:{kind:"anchor",objectId:a,portId:port},to:{kind:"anchor",objectId:b,portId:opposite}});
    const doc=board([shape("start",210,190),shape("one",89,85),shape("two",510,460),shape("else",770,780),shape("upstream",620,520),
      edge("in","upstream","start"),edge("out","start","one"),edge("next","one","two")]);
    const e=session(doc);e.select("start");const original=e.doc,history=e.history;
    const plan=preview(e);assert.equal(plan.state,"planned");assert.deepEqual(plan.scope,["one","two"]);
    assert.equal(e.doc,original);assert.equal(e.history,history);assert.deepEqual(e.selectedIds,["start"]);
    assert.deepEqual(fromRoot(e),plan.scope);
    assert.deepEqual(locate(e,"one"),p(210+dx,190+dy));assert.deepEqual(locate(e,"two"),p(210+2*dx,190+2*dy));
    for(const id of ["start","upstream","else","in","out","next"])assert.equal(e.doc.objects[id],original.objects[id]);
    const arranged=e.doc;e.undo();assert.equal(e.doc,original);e.redo();assert.equal(e.doc,arranged);
  }
});
test("downstream layout previews and commits clean links between even and odd sized nodes",()=>{
  for(const [side,opposite,across] of [["east","west","y"],["south","north","x"]] as const){
    const bind=(id:string,a:string,b:string)=>line(id,a,b,{from:{kind:"anchor",objectId:a,portId:side},
      to:{kind:"anchor",objectId:b,portId:opposite}});
    const ab=bind("ab","a","b"),bc=bind("bc","b","c");
    const e=session(board([shape("a",20,30),shape("b",230,170,{shape:"diamond",width:73,height:55}),
      shape("c",400,300),ab,bc]));
    e.select("a");const original=e.doc,scene=new SceneProjection(original),plan=planDownstreamLayout(e,scene);
    assert(plan.state==="planned");
    const drafts=scene.overlay({objects:new Map(plan.nodes.map(n=>[n.id,n]))});
    assert.equal(applyDownstreamLayout(e,plan).state,"applied");scene.update(e.doc);
    const arranged=e.doc;
    for(const edge of [ab,bc]){
      const ends=[resolveEndpoint(arranged,edge.from)!,resolveEndpoint(arranged,edge.to)!];
      assert.equal(Math.abs(ends[0][across]-ends[1][across]),.5);
      assert.deepEqual(drafts.get(edge.id)?.items.find(q=>q.kind==="path")?.points,ends);
      assert.deepEqual(scene.all().find(g=>g.id===edge.id)?.items.find(q=>q.kind==="path")?.points,ends);
      assert.strictEqual(arranged.objects[edge.id],original.objects[edge.id]);
    }
    assert.equal(e.history.past.length,1);e.undo();assert.strictEqual(e.doc,original);e.redo();assert.strictEqual(e.doc,arranged);
  }
});
test("opposite decision exits determine sibling order; a join follows the longest branch and all route data survives reopening",()=>{
  for(const vertical of [false,true]){
    const source=shape("decision",220,200,{shape:"diamond"}),yes=vertical?"north":"west",no=vertical?"south":"east";
    const branch=(id:string,port:"north"|"south"|"east"|"west")=>line(id,"decision",id.toLowerCase(),{label:id,
      from:{kind:"anchor",objectId:"decision",portId:port},waypoints:[p(150,137),p(147,182)]});
    const rows=[source,shape("yes",490,440),shape("no",25,6),shape("extra",324,399),shape("join",540,400),
      branch("No",no),branch("Yes",yes),line("long","yes","extra"),line("merge-a","extra","join"),line("merge-b","no","join")];
    const e=session(board(rows));e.select(source.id);const before=e.doc;
    assert.deepEqual(new Set(fromRoot(e)),new Set(["no","yes","extra","join"]));
    const across=vertical?"y":"x",along=vertical?"x":"y";
    assert(locate(e,"yes")[across]<source.at[across]&&locate(e,"no")[across]>source.at[across]);
    assert.equal(locate(e,"yes")[along],locate(e,"no")[along]);
    assert(locate(e,"extra")[along]>locate(e,"yes")[along]);assert(locate(e,"join")[along]>locate(e,"extra")[along]);
    for(const item of rows.filter(v=>v.kind==="connector"))assert.equal(e.doc.objects[item.id],before.objects[item.id]);
    const opened=decodeProject(encodeProject(e.doc,new AssetVault())).document;
    assert.deepEqual(opened,structuredClone(e.doc));assert.deepEqual(resolveEndpoint(opened,(opened.objects.Yes as Connector).from),resolveEndpoint(before,(before.objects.Yes as Connector).from));
  }
});
test("a nested decision may turn the following layers, while the straight entry retains its direction",()=>{
  const rows=[shape("a",80,100),shape("d",360,195,{shape:"diamond"}),shape("left",350,300),shape("right",100,560),shape("merge",550,550),
    line("entry","a","d"),line("no","d","left",{label:"No",from:{kind:"anchor",objectId:"d",portId:"west"}}),
    line("yes","d","right",{label:"Yes"}),line("l","left","merge"),line("r","right","merge")];
  const e=session(board(rows));e.select("a");fromRoot(e);
  const d=locate(e,"d");
  assert(d.x>locate(e,"a").x&&d.y===locate(e,"a").y);
  assert(locate(e,"left").x<d.x&&locate(e,"right").x>d.x);
  assert(locate(e,"left").y>d.y&&locate(e,"merge").y>locate(e,"right").y);
});
test("a retry from a join to one of its entering branches cannot reverse the decision's forward path",()=>{
  const d=shape("d",130,220,{shape:"diamond"}),left=shape("l",20,60),right=shape("r",250,95),m=shape("m",160,-110);
  const rows=[d,left,right,m,line("yes","d","l",{label:"Yes",from:{kind:"anchor",objectId:"d",portId:"west"}}),
    line("no","d","r",{label:"No"}),line("lm","l","m"),line("rm","r","m"),line("retry","m","r")];
  const e=session(board(rows));e.select("d");fromRoot(e);
  assert.equal(locate(e,"l").y,locate(e,"r").y);assert(locate(e,"l").x<d.at.x&&d.at.x<locate(e,"r").x);
  assert(locate(e,"m").y<locate(e,"l").y&&locate(e,"l").y<d.at.y);
});
test("parallel joins shared by two branches keep the same lanes when arranged again",()=>{
  const nodes=[["a",200,564,80,40],["b",473,327,100,40],["c",454,47,80,50],["step",90,259,60,40],
    ["d",98,276,80,60],["m",380,525,60,60],["n",477,362,60,40]] as const;
  const links=[["a","north","b"],["a","north","c"],["b","west","step"],["a","south","d"],
    ["c","south","m"],["d","east","m"],["d","south","n"],["c","south","n"]] as const;
  const e=session(board([...nodes.map(([id,x,y,width,height])=>shape(id,x,y,{width,height})),
    ...links.map(([from,portId,to],i)=>line("e"+i,from,to,{from:{kind:"anchor",objectId:from,portId}}))]));
  e.select("a");fromRoot(e);assert(locate(e,"m").y<locate(e,"n").y);
});
test("back edges and self loops stay bound; a return through an incoming predecessor cannot move the preceding chain or its other branch",()=>{
  const rows=[shape("up",-180,100),shape("a",0,100),shape("b",180,210),shape("c",290,220),shape("d",320,90),shape("other",-140,210),
    line("in","up","a"),line("unrelated","up","other"),line("ab","a","b"),line("bc","b","c"),line("cd","c","d"),
    line("back","c","b",{label:"重试",waypoints:[p(175,330)]}),line("feedback","d","up"),line("return","c","a"),
    line("self","d","d",{waypoints:[p(500,20)]})];
  const e=session(board(rows));e.select("a");const before=e.doc;assert.deepEqual(fromRoot(e),["b","c","d"]);
  assert.deepEqual(["a","b","c","d"].map(id=>locate(e,id)),[p(0,100),p(80,100),p(160,100),p(240,100)]);
  for(const id of ["up","other","feedback","back","return","self"])assert.equal(e.doc.objects[id],before.objects[id]);
});
test("downstream layout bypasses stationary obstacles and respects project visibility, flow group and lock boundaries",()=>{
  const obstacle=shape("fixed",80,0,{width:93});
  const rows=[shape("root",0,0),shape("b",410,70,{rotation:.25}),shape("c",440,120),obstacle,
    line("ab","b","root",{arrow:"start",to:{kind:"anchor",objectId:"root",portId:"east"}}),line("bc","b","c",{arrow:"both"})];
  const e=session(board(rows));e.select("root");const orig=e.doc;
  const stale=preview(e);e.setLayerLocks(["b"],true);assert.equal(applyDownstreamLayout(e,stale).state,"refused");
  const locked=preview(e);assert.equal(locked.state,"refused");assert.match(locked.message,/锁定/);
  e.setLayerLocks(["b"],false);e.setLayerVisibility(["ab"],false);const hidden=preview(e);assert.equal(hidden.state,"unchanged");assert.match(hidden.message,/没有/);e.showAllLayers();
  assert.deepEqual(fromRoot(e),["b","c"]);assert(boxBounds(e.doc.objects.b as ShapeObject).min.x>=173);
  assert.equal(e.doc.objects.fixed,orig.objects.fixed);
  const grouped=session({...board(rows),schemaVersion:5,flowGroups:{baseVersion:1,members:{pair:["b","fixed"]}}});grouped.select("root");
  assert.equal(preview(grouped).state,"refused");assert.equal(grouped.history.revision,0);
});
test("a terminal, a lone self-loop, card or free endpoint produces no history; a changed selection invalidates its pending plan",()=>{
  const a=shape("a",0,0),b=shape("b",150,100),card=shape("memo",200,160,{content:{kind:"sticky",fontSize:16}});
  const doc=board([a,b,card,line("ab","a","b",{arrow:"none"}),line("loop","b","b",{waypoints:[p(300,180)]}),
    line("memo-link","b","memo"),line("loose","b","a",{to:{kind:"free",point:p(300,20)}})]);
  const e=session(doc),before=e.doc;e.select("a");const plan=preview(e);e.select("b");
  assert.equal(applyDownstreamLayout(e,plan).state,"refused");
  assert.match(applyDownstreamLayout(e,preview(e)).message,/没有.*后续/);
  assert.equal(e.history.revision,0);assert.equal(e.doc,before);
});
test("a closed ring starting at the anchor retains a tail initially drawn behind it",()=>{
  const e=session(board([shape("a",200,50),shape("b",350,150),shape("c",40,270),
    line("ab","a","b"),line("bc","b","c"),line("ca","c","a")]));
  e.select("a");assert.deepEqual(fromRoot(e),["b","c"]);
  assert.deepEqual(locate(e,"c"),p(360,50));
});
test("a fixed free endpoint that coincides with a proposed port preserves its position and a valid preview",()=>{
  const e=session(board([shape("a",0,0),shape("b",60,100),line("ab","a","b"),
    line("pin","b","a",{routing:"straight",to:{kind:"free",point:p(120,12)}})]));
  e.select("a");const fixed=e.doc.objects.pin;fromRoot(e);
  assert.deepEqual(locate(e,"b"),p(81,0));assert.equal(e.doc.objects.pin,fixed);
});
