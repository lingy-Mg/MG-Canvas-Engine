import type {Point,Rect} from "../core/geometry.ts";
import type {DrawGroup,Primitive} from "./board.ts";

const shift=(p:Point,o:Point):Point=>({x:p.x+o.x,y:p.y+o.y});
export const localPoint=(p:Point,o:Point):Point=>({x:p.x-o.x,y:p.y-o.y});
export const localRect=(r:Rect,o:Point):Rect=>({min:localPoint(r.min,o),max:localPoint(r.max,o)});
type Placement={local:DrawGroup;origin:Point;worldItem:(item:Primitive)=>Primitive};
const placements=new WeakMap<DrawGroup,Placement>();
export const topicPlacement=(group:DrawGroup)=>placements.get(group);

/** A map's layout and paint index live in local coordinates. Only requested primitives need world coordinates. */
export function placeTopics(local:DrawGroup,origin:Point):DrawGroup{
  if(!origin.x&&!origin.y)return local;
  const translated=new WeakMap<Primitive,Primitive>();
  function worldItem(item:Primitive):Primitive{
    const prior=translated.get(item);if(prior)return prior;
    let next:Primitive;
    switch(item.kind){
      case "box":case "nodeLabel":next={...item,box:{...item.box,at:shift(item.box.at,origin)}};break;
      case "text":next={...item,at:shift(item.at,origin)};break;
      case "path":next={...item,points:item.points.map(p=>shift(p,origin))};break;
      default:throw new Error("Unexpected mind map primitive");
    }
    translated.set(item,next);return next;
  }
  let items:DrawGroup["items"]|undefined,picks:DrawGroup["picks"]|undefined;
  const group:DrawGroup={id:local.id,topicCount:local.topicCount,
    bounds:{min:shift(local.bounds.min,origin),max:shift(local.bounds.max,origin)},
    get items(){return items??=local.items.map(worldItem);},
    get picks(){return picks??=local.picks.map(p=>{
      if(!("box" in p))throw new Error("Unexpected mind map pick");
      return {...p,box:{...p.box,at:shift(p.box.at,origin)}};
    });}
  };
  placements.set(group,{local,origin,worldItem});return group;
}
