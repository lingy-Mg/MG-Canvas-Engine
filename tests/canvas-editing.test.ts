import {test} from "node:test";
import assert from "node:assert/strict";
import {demo} from "../app/demo.ts";
import type {Connector,BoardDocument} from "../core/document.ts";
import {resolveEndpoint} from "../core/document.ts";
import {PORT_IDS} from "../core/geometry.ts";
import type {Point} from "../core/geometry.ts";
import {buildScene,fitScene,hitTest,marqueeHit} from "../scene/board.ts";
import {connectorArrows} from "../scene/connector-arrows.ts";
import {canvasStroke,canvasThemes,contrastRatio} from "../platform/theme.ts";
import type {Scene} from "../scene/board.ts";
import {CanvasView} from "../renderers/canvas2d/canvas.ts";
import {cardDisplayLayout,cardLayout,cardOffsetAt,cardPlaceholders,newCard} from "../features/card-content.ts";
import {placementBox} from "../app/text-placement.ts";
import {topicBox,topicTier} from "../features/mindmap-layout.ts";

function recorded(scene:Scene,editing?:{objectId:string;topicId?:string},theme:"light"|"dark"="light",cardPlaceholders=false,overviewZoom?:number){
  const texts=new Set<string>(),textColors=new Map<string,string>(),fills=new Set<string>(),triangles:Point[][]=[];
  const strokes:{color:string;cap:string;points:Point[]}[]=[];
  let path:Point[]=[];
  const arcs=new Map<string,number>();
  const methods={beginPath:()=>{path=[];},moveTo:(x:number,y:number)=>path.push({x,y}),lineTo:(x:number,y:number)=>path.push({x,y}),
    strokeStyle:"",lineCap:"",stroke(){strokes.push({color:this.strokeStyle,cap:this.lineCap,points:path});},
    fillStyle:"",fill(){fills.add(this.fillStyle);if(path.length===3)triangles.push(path);},
    arc(){arcs.set(this.fillStyle,(arcs.get(this.fillStyle)??0)+1);},
    fillText(text:string){texts.add(text);textColors.set(text,this.fillStyle);},measureText:(text:string)=>({width:Array.from(text).length*8})};
  const context=new Proxy(methods,{get:(target,key)=>Reflect.get(target,key)??(()=>{})});
  const view=new CanvasView({getContext:()=>context} as unknown as HTMLCanvasElement,{cardPlaceholders,overviewDetail:overviewZoom!==undefined});
  const camera=overviewZoom===undefined?fitScene(scene,800,550):{zoom:overviewZoom,offset:{x:40,y:40}};
  view.setTheme(theme);view.size(800,550,1);view.draw(scene,camera,[],undefined,undefined,editing);
  return {texts,textColors,fills,triangles,strokes,arcs};
}
test("overview rendering drops unreadable labels while keeping their shape, selection and full-detail rendering",()=>{
  const original=demo.objects["flow-source"];assert(original.kind==="shape");
  const shape={...original,at:{x:0,y:0},label:"节点文字"};
  const scene=buildScene({...demo,order:[shape.id],objects:{[shape.id]:shape}});
  const overview=recorded(scene,undefined,"light",false,.05);
  assert(overview.fills.has(shape.fill));assert.equal(overview.texts.size,0);
  assert.equal(hitTest(scene,{x:shape.width/2,y:shape.height/2},0),shape.id);
  assert(recorded(scene,undefined,"light",false,1).texts.has(shape.label));
});
test("overview ink reuses a reduced centerline and leaves full-resolution paths and hits intact",()=>{
  const ink={kind:"ink",id:"overview-ink",at:{x:0,y:0},baseWidth:4,color:"#263655",brushVersion:1,
    samples:Array.from({length:300},(_,i)=>[i,Math.round(5*Math.sin(i/17)),.5+.25*Math.sin(i/13)] as const)} as const;
  const scene=buildScene({...demo,schemaVersion:2,order:[ink.id],objects:{[ink.id]:ink}});
  const tiny=recorded(scene,undefined,"light",false,.05);
  assert(!tiny.arcs.has(ink.color));assert.equal(tiny.strokes.length,1);
  assert(tiny.strokes[0].points.length<ink.samples.length/4);
  const last=ink.samples.at(-1)!;
  assert.deepEqual(tiny.strokes[0].points.at(-1),{x:last[0],y:last[1]});
  assert.equal(hitTest(scene,{x:last[0],y:last[1]},0),ink.id);
  const quarter=recorded(scene,undefined,"light",false,.25);
  assert(!quarter.arcs.has(ink.color));assert.equal(quarter.strokes.length,1);
  const enlarged=recorded(scene,undefined,"light",false,.6);
  assert((enlarged.arcs.get(ink.color)??0)>0,"visible pressure differences retain the variable-width outline");
  assert.equal(recorded(scene,undefined,"light",false,1).arcs.get(ink.color),ink.samples.length);
  assert.equal(recorded(scene).arcs.get(ink.color),ink.samples.length);
});
test("committed subpixel ink keeps its exact centerline and small pressure changes at overview zoom",()=>{
  for(const fixed of [false,true]){
    const samples=Array.from({length:73},(_,i)=>[i*.75,Math.sin(i/4)*1.3,fixed?.5:.47+.1*Math.sin(i/9)] as const);
    const ink={kind:"ink",id:"live-ink",at:{x:0,y:0},baseWidth:6,color:"#116677",brushVersion:1,subpixel:true,samples} as const;
    const scene=buildScene({...demo,schemaVersion:2,order:[ink.id],objects:{[ink.id]:ink}});
    const overview=recorded(scene,undefined,"light",false,.05);
    if(fixed)assert.equal(overview.strokes.find(s=>s.color===ink.color)?.points.length,samples.length);
    else assert.equal(overview.arcs.get(ink.color),samples.length);
  }
});
test("empty cards show editable hints on the canvas only, with their real authoring dimensions and contrast",()=>{
  for(const kind of ["markdown","sticky"] as const){
    const preview=placementBox(kind,{x:285,y:122},{zoom:.65,offset:{x:-85,y:185}});
    const card=newCard(kind,preview.at,"","transparent");
    assert.deepEqual([card.width,card.height],[preview.width,preview.height]);
    assert.equal(cardLayout(card).glyphs.length,0);
    const glyphs=cardDisplayLayout(card).glyphs;
    assert.equal(glyphs.map(g=>g.text).join(""),cardPlaceholders[kind]);
    const end=glyphs.at(-1)!;
    assert.equal(cardOffsetAt(card,{x:end.x+end.width-1,y:end.baseline-end.size*.2},true),0);
    const scene=buildScene({...demo,order:[card.id],objects:{[card.id]:card}});
    for(const theme of ["light","dark"] as const){
      const {texts,textColors}=recorded(scene,undefined,theme,true);
      for(const g of glyphs){assert(texts.has(g.text));assert(contrastRatio(textColors.get(g.text)!,canvasThemes[theme].bg)!>=4.5);}
      assert.equal(recorded(scene,undefined,theme).texts.size,0);
      assert.equal(recorded(scene,{objectId:card.id},theme,true).texts.size,0);
    }
    assert.equal(card.label,"");
  }
});
test("inline edit suppresses exactly one label while its shape, siblings and unrelated equal IDs keep painting",()=>{
  const shape=demo.objects["flow-source"],map=demo.objects["mind-room"];
  assert(shape.kind==="shape"&&map.kind==="mindmap");
  const collision={...shape,id:"child-a",fill:"#daaf63",label:"保留节点"};
  const doc={...demo,order:[...demo.order,collision.id],objects:{...demo.objects,[collision.id]:collision}};
  const scene=buildScene(doc);
  const editShape=recorded(scene,{objectId:collision.id});
  assert(editShape.fills.has(collision.fill));assert(!editShape.texts.has(collision.label));
  assert(editShape.texts.has("预约管理"));
  const editTopic=recorded(scene,{objectId:map.id,topicId:"child-a"});
  assert(!editTopic.texts.has("预约管理"));assert(editTopic.texts.has("门禁控制"));
  assert(editTopic.texts.has(collision.label));assert(editTopic.fills.has(collision.fill));
  const restored=recorded(scene);assert(restored.texts.has("预约管理")&&restored.texts.has(collision.label));
});
test("third-level topics paint one branch-colored underline, use canvas contrast and remain fully hittable",()=>{
  const original=demo.objects["mind-room"];assert(original.kind==="mindmap");
  const map={...original,topics:{...original.topics,"child-a":{...original.topics["child-a"],childIds:["secondary"]},
    secondary:{id:"secondary",text:"第二级",childIds:["leaf"],collapsed:false},leaf:{id:"leaf",text:"第三级",childIds:[],collapsed:false,
      appearance:{fill:"#010203",stroke:"#c74450",strokeWidth:2}}}};
  const scene=buildScene({...demo,order:[map.id],objects:{[map.id]:map}});
  const ids=[map.rootId,"child-a","secondary","leaf"],rows=ids.map(id=>topicBox(map,id)!);
  for(let i=1;i<rows.length;i++){
    assert(rows[i].fontSize<rows[i-1].fontSize);assert(topicTier(i).weight<topicTier(i-1).weight);
    assert(rows[i].box.height<rows[i-1].box.height);
  }
  assert(topicTier(3).gap<topicTier(2).gap&&topicTier(2).gap<topicTier(1).gap);
  const leaf=rows[3].box,cap=scene[0].items.find(p=>p.kind==="box"&&p.underline);assert(cap?.kind==="box");
  assert.deepEqual(cap.box,leaf);
  const p={x:leaf.at.x+leaf.width/2,y:leaf.at.y+2};assert.equal(hitTest(scene,p,0),map.id);
  for(const theme of ["light","dark"] as const){
    const drawn=recorded(scene,undefined,theme);
    assert(!drawn.fills.has("transparent")&&!drawn.fills.has("#010203"));
    assert.equal(drawn.textColors.get("预约管理"),"#fff");assert.equal(drawn.textColors.get("第二级"),"#000");
    assert.equal(drawn.textColors.get("第三级"),theme==="light"?"#000":"#fff");
    const cam=fitScene(scene,800,550);
    const snapped=(x:number)=>(Math.round(x*cam.zoom+cam.offset.x)-cam.offset.x)/cam.zoom;
    assert(drawn.strokes.some(s=>s.color===cap.stroke&&s.cap==="butt"&&s.points.length===2&&s.points[0].x===snapped(leaf.at.x)&&
      s.points[1].x===snapped(leaf.at.x+leaf.width)&&s.points.every(p=>p.y===leaf.at.y+leaf.height)));
  }
  const link=scene[0].items.find(p=>p.kind==="path"&&p.points.at(-1)?.x===leaf.at.x);assert(link?.kind==="path");
  assert.equal(link.points.at(-1)?.y,leaf.at.y+leaf.height);
});

test("all four ports on orthogonal links point outwards and both painted arrowheads terminate on the ports",()=>{
  const a=demo.objects["flow-source"],b=demo.objects["flow-decision"],line=demo.objects["flow-arrow"];
  assert(a.kind==="shape"&&b.kind==="shape"&&line.kind==="connector");
  const angles={east:0,south:Math.PI/2,west:Math.PI,north:-Math.PI/2};
  for(const rotation of [0,Math.PI/2,-Math.PI/6])for(const start of PORT_IDS)for(const end of PORT_IDS){
    const edge:Connector={...line,label:"",arrow:"both",waypoints:[],
      from:{kind:"anchor",objectId:a.id,portId:start},to:{kind:"anchor",objectId:b.id,portId:end}};
    const doc:BoardDocument={...demo,objects:{...demo.objects,[a.id]:{...a,rotation},[b.id]:{...b,rotation:-rotation},[edge.id]:edge}};
    const scene=buildScene(doc,undefined,[edge.id]),route=scene[0].items.find(p=>p.kind==="path");assert(route);
    const {triangles}=recorded(scene);assert.equal(triangles.length,2);
    const ends=[[edge.from,angles[start]+rotation,route.points[1]],[edge.to,angles[end]-rotation,route.points.at(-2)!]] as const;
    for(const [i,[binding,angle,neighbor]] of ends.entries()){
      const point=resolveEndpoint(doc,binding)!;
      const outward=(p:Point)=>(p.x-point.x)*Math.cos(angle)+(p.y-point.y)*Math.sin(angle);
      assert(outward(neighbor)>0);assert.deepEqual(triangles[i][0],point);
      const [,left,right]=triangles[i];assert(outward({x:(left.x+right.x)/2,y:(left.y+right.y)/2})>0);
    }
  }
});

test("a connector paints one contrasting shaft behind both tips, with pickable wings inside its bounds",()=>{
  const sample=demo.objects["flow-arrow"];assert(sample.kind==="connector");
  for(const width of [1.65,8,64]){
    const line:Connector={...sample,from:{kind:"free",point:{x:0,y:0}},to:{kind:"free",point:{x:400,y:0}},
      routing:"straight",arrow:"both",stroke:"#475a75",strokeWidth:width,label:"",waypoints:[]};
    const scene=buildScene({...demo,objects:{...demo.objects,[line.id]:line}},undefined,[line.id]);
    for(const theme of ["light","dark"] as const){
      const {strokes,triangles,fills}=recorded(scene,undefined,theme),color=canvasStroke(line.stroke,theme).connector;
      assert.equal(strokes.length,1);assert.equal(strokes[0].cap,"butt");
      assert.equal(strokes[0].color,color);assert(fills.has(color));assert.equal(triangles.length,2);
      assert((contrastRatio(color,canvasThemes[theme].bg)??0)>=3);
      const [start,end]=triangles,[a,b]=strokes[0].points;
      assert(0<a.x&&a.x<start[1].x&&end[1].x<b.x&&b.x<400);
      assert.deepEqual(start[0],{x:0,y:0});assert.deepEqual(end[0],{x:400,y:0});
      const wing={x:end[1].x+.1,y:end[1].y*.9};
      assert(Math.abs(wing.y)>width/2);
      assert.equal(hitTest(scene,wing,0),line.id);assert.deepEqual(marqueeHit(scene,{min:wing,max:wing}),[line.id]);
    }
  }
});

test("short double arrows share the available length; sampled curves span samples and orthogonal tips stop at the bend",()=>{
  const p=(x:number,y=0)=>({x,y});
  const short=connectorArrows([p(0),p(0),p(4),p(4)],2,"both")!;
  assert(short.heads[0][1].x<short.heads[1][1].x);
  assert(short.shaft[0].x<short.shaft.at(-1)!.x);
  const curve=connectorArrows([p(0,1),p(12,.2),p(18),p(19),p(20),p(20)],2,"end")!;
  assert(curve.heads[0][1].x<18);assert.deepEqual(curve.heads[0][0],p(20));
  const elbow=connectorArrows([p(0),p(12),p(12,2)],2,"end")!;
  assert.deepEqual(elbow.shaft.slice(0,2),[p(0),p(12)]);
  assert.equal(elbow.heads[0][1].y,0);assert.equal(elbow.heads[0][2].y,0);
  assert.equal(connectorArrows([p(0),p(20)],2,"none"),undefined);
});
