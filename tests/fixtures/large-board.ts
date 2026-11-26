import type { BoardDocument,BoardObject,ShapeObject } from "../../core/document.ts";
import type { Point } from "../../core/geometry.ts";

export type LargeFixture=Readonly<{document:BoardDocument;probe:Point;dragId:string}>;
/** Deterministic mixed document with no external/real image data. */
export function largeBoard(count:number):LargeFixture{
  if(!Number.isSafeInteger(count)||count<0)throw new RangeError("invalid object count");
  const objects: Record<string,BoardObject>=Object.create(null),order:string[]=[];
  const cols=Math.max(1,Math.ceil(Math.sqrt(count/10)));
  const put=(item:BoardObject)=>{objects[item.id]=item;order.push(item.id);};
  const shape=(i:number,x:number,y:number):ShapeObject=>({
    kind:"shape",id:"s-"+i,shape:i%10===2?"diamond":"rect",at:{x,y},width:110,height:52,rotation:0,
    cornerRadius:6,fill:"#eaf2ff",stroke:"#668cdd",label:"会议步骤 "+i,
  });
  for(let i=0;i<count;i++){
    const group=Math.floor(i/10),row=Math.floor(group/cols),col=group%cols;
    const x=col*710,y=row*440,k=i%10;
    if(k<6)put(shape(i,x+(k%3)*150,y+Math.floor(k/3)*67));
    else if(k<8)put({kind:"connector",id:"l-"+i,from:{kind:"anchor",objectId:"s-"+(i-k+(k===6?0:3)),portId:"east"},
      to:{kind:"anchor",objectId:"s-"+(i-k+(k===6?1:4)),portId:"west"},routing:"orthogonal",label:"提交",arrow:"end",stroke:"#334870",
      waypoints:[{x:x+130,y:y+(k===6?26:93)}]});
    else if(k===8)put({kind:"text",id:"t-"+i,at:{x,y:y+209},width:246,height:25,rotation:0,text:"协同预约 · "+i,fontSize:16,color:"#64748b",align:"left"});
    else {
      const root="r-"+i,child="c-"+i,sibling="b-"+i,deep="d-"+i;
      put({kind:"mindmap",id:"m-"+i,origin:{x:x+164,y:y+314},rootId:root,layout:"right",theme:"indigo",topics:{
        [root]:{id:root,text:"会议管理",childIds:[child,sibling],collapsed:false},
        [child]:{id:child,text:"预约设置",childIds:[deep],collapsed:false},
        [sibling]:{id:sibling,text:"门禁授权",childIds:[],collapsed:false},
        [deep]:{id:deep,text:"控制器",childIds:[],collapsed:false},
      }});
    }
  }
  return {document:{schemaVersion:1,id:"bench-"+count,theme:"paper",objects,assets:{},order},probe:{x:12,y:10},dragId:"s-0"};
}
