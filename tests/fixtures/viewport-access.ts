import type {BoardDocument,BoardObject,Connector,ShapeObject,VectorPath} from "../../core/document.ts";
import type {Camera,Rect} from "../../core/geometry.ts";

import type {DrawGroup,Scene} from "../../scene/board.ts";
import type {SceneProjection} from "../../scene/projector.ts";
import type {GridQueryWork} from "../../scene/spatial-grid.ts";

export const viewportSize={width:1920,height:1080}, zoom=.05, padding=32;
export const camera:Camera={zoom,offset:{x:0,y:0}};
export function viewportRect(offset={x:0,y:0}):Rect{
  return {min:{x:(-padding-offset.x)/zoom,y:(-padding-offset.y)/zoom},
    max:{x:(viewportSize.width+padding-offset.x)/zoom,y:(viewportSize.height+padding-offset.y)/zoom}};
}
export const views=Array.from({length:24},(_,i)=>viewportRect({x:i*3%49,y:i*7%37}));
export function box(id:string,x:number,y:number,width=76,height=43,fill="#6386a9"):ShapeObject{
  return {kind:"shape",id,shape:"rect",at:{x,y},width,height,rotation:0,cornerRadius:9,fill,stroke:"#263e55",label:""};
}
export function viewportBoard(farCount:number,nearBoundary=false):BoardDocument{
  const glass=box("glass",6650,5550,3200,1900,"rgba(255,120,65,0.55)");
  const target=box("review",21700,9550,2700,1450,"#bcd9cd");
  const edge:Connector={kind:"connector",id:"edge",from:{kind:"anchor",objectId:glass.id,portId:"east"},
    to:{kind:"anchor",objectId:target.id,portId:"west"},routing:"orthogonal",waypoints:[{x:12600,y:6500},{x:12600,y:9100},{x:18200,y:9100},{x:18200,y:10275}],
    stroke:"#365b85",strokeWidth:32,arrow:"end",label:""};
  const span:Connector={...edge,id:"span",from:{kind:"free",point:{x:-28500,y:14600}},to:{kind:"free",point:{x:67200,y:14600}},
    waypoints:[],routing:"straight",arrow:"none",stroke:"#9b6e7b",strokeWidth:30};
  const curve:VectorPath={kind:"path",id:"curve",at:{x:24500,y:3200},vertices:[{x:0,y:0},{x:5500,y:900}],
    curves:{"0":{out:{x:600,y:3100},in:{x:-800,y:-2800}}},closed:false,stroke:"#8a587a",strokeWidth:48};
  const label:BoardObject={kind:"text",id:"note",at:{x:11200,y:16100},width:3300,height:420,rotation:0,
    text:"审批记录",color:"#3d586d",fontSize:140,align:"left",heightMode:"fixed"};
  const rows:BoardObject[]=[span,edge,box("back",5400,5000,3400,1900,"#5788b2"),glass,target,curve,label,box("outside",40700,17300)];
  for(let i=0;i<farCount;i++){
    const x=nearBoundary?40100+i%9:120000+i%200*235,y=nearBoundary?13000+i%11:100000+Math.floor(i/200)*167;
    rows.push(box("far-"+i,x,y));
  }
  return {schemaVersion:4,id:"viewport-access",theme:"paper",order:rows.map(o=>o.id),objects:Object.fromEntries(rows.map(o=>[o.id,o])),assets:{}};
}

export function denseBoard(count:number):BoardDocument{
  const rows=Array.from({length:count},(_,i)=>box("dense-"+i,6500+(i%8)*385,6500+(Math.floor(i/8)%7)*385,
    395,395,["#5487a4","rgba(239,120,86,0.45)","#b6d0bb"][i%3]));
  return {schemaVersion:1,id:"dense-viewport",theme:"paper",objects:Object.fromEntries(rows.map(o=>[o.id,o])),order:rows.map(o=>o.id),assets:{}};
}
const intersects=(a:Rect,b:Rect)=>a.min.x<=b.max.x&&a.max.x>=b.min.x&&a.min.y<=b.max.y&&a.max.y>=b.min.y;
export function bruteScene(scene:Scene,rect:Rect,patch:ReadonlyMap<string,DrawGroup>=new Map(),include:readonly string[]=[]):Scene{
  const known=new Set(scene.map(g=>g.id)),forced=new Set(include);
  return [...scene.map(g=>patch.get(g.id)??g),...[...patch].filter(([id])=>!known.has(id)).map(([,group])=>group)]
    .filter(g=>forced.has(g.id)||intersects(g.bounds,rect));
}

/** Observe the actual bounds reads in either release without modifying the projector code.
 * Never use this instrumented pass for timings. Restore every descriptor afterwards. */
export function observeViewport(index:Pick<SceneProjection,"query"|"all">,requests:readonly Rect[]){
  const descriptors=new Map<DrawGroup,PropertyDescriptor>();
  let boundsReads=0,offscreenReads=0;
  try{
    for(const group of index.all()){
      const saved=Object.getOwnPropertyDescriptor(group,"bounds")!;
      descriptors.set(group,saved);
      Object.defineProperty(group,"bounds",{enumerable:true,configurable:true,get(){
        boundsReads++;
        if(group.id.startsWith("far-"))offscreenReads++;
        return saved.value;
      }});
    }
    return requests.map(rect=>{
      boundsReads=0;offscreenReads=0;
      let grid:GridQueryWork|undefined;
      const ids=index.query(rect,undefined,undefined,w=>{grid=w;}).map(group=>group.id);
      return {boundsReads,offscreenReads,grid,ids};
    });
  }finally{
    for(const [group,descriptor] of descriptors)Object.defineProperty(group,"bounds",descriptor);
  }
}
