import type {BoardDocument,BoardObject,MindMap,Topic} from "../../core/document.ts";

export function mindViewportBoard(count:number,shape:"chain"|"tree"|"fan"="chain",mixed=false):BoardDocument{
  const topics:Record<string,Topic>={};
  for(let i=0;i<count;i++){
    const childIds=shape==="chain"?(i+1<count?["t"+(i+1)]:[]):shape==="fan"?(i?[]:Array.from({length:count-1},(_,j)=>"t"+(j+1))):
      [2*i+1,2*i+2].filter(j=>j<count).map(j=>"t"+j);
    const id="t"+i;topics[id]={id,text:"预约 "+i,childIds,collapsed:false};
  }
  const map:MindMap={kind:"mindmap",id:"map",rootId:"t0",origin:{x:0,y:0},layout:shape==="tree"?"balanced":"right",topics};
  const objects:Record<string,BoardObject>={map},order=["map"];
  if(mixed){
    objects.under={kind:"shape",id:"under",at:{x:-110,y:-17},width:295,height:50,rotation:0,shape:"rect",cornerRadius:4,fill:"#ffecba",stroke:"#c85d12",label:""};
    objects.over={...objects.under,id:"over",at:{x:10,y:-29},width:42,height:78,shape:"diamond",cornerRadius:0,fill:"rgba(90,80,205,0.55)",stroke:"#382f9b"};
    order.unshift("under");order.push("over");
  }
  return {schemaVersion:1,id:"mind-viewport-"+shape,theme:"light",objects,order,assets:{}};
}
