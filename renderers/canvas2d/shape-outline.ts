import type {ShapeKind} from "../../core/geometry.ts";

/** Append one local shape to the current path. */
export function traceShape(c:CanvasRenderingContext2D,shape:ShapeKind,w:number,h:number,radius:number){
  if(shape==="rect"){c.roundRect(0,0,w,h,Math.min(radius,w/2,h/2));return;}
  c.moveTo(w/2,0);
  if(shape==="diamond"){c.lineTo(w,h/2);c.lineTo(w/2,h);c.lineTo(0,h/2);}
  else{c.lineTo(w,h);c.lineTo(0,h);}
  c.closePath();
}
