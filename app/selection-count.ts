import type {Rect} from "../core/geometry.ts";
import type {ScreenArea} from "./text-format-bar.ts";

/** Use the painted frame in CSS pixels, including its screen-space padding. */
export function placeSelectionCount(label:HTMLElement,frame:Rect,count:number,viewport:ScreenArea,origin:DOMRect,controls:readonly (HTMLElement|null)[]){
  if(count<2||frame.max.x<viewport.left||frame.min.x>viewport.right||frame.max.y<viewport.top||frame.min.y>viewport.bottom){
    label.hidden=true;return;
  }
  const text=`已选 ${count} 个元素`;
  if(label.textContent!==text)label.textContent=text;
  label.hidden=false;
  const w=label.offsetWidth,h=label.offsetHeight,gap=3;
  const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(value,max));
  const fitX=(x:number)=>clamp(x,viewport.left+gap,viewport.right-w-gap);
  const fitY=(y:number)=>clamp(y,viewport.top+gap,viewport.bottom-h-gap);
  const left=fitX(frame.min.x),above=fitY(frame.min.y-h-gap);
  const obstacles:ScreenArea[]=[];
  for(const el of controls){
    if(!el||el.hidden)continue;
    const box=el.getBoundingClientRect();
    if(box.width&&box.height)obstacles.push({left:box.left-origin.left,top:box.top-origin.top,right:box.right-origin.left,bottom:box.bottom-origin.top});
  }
  const clear=(x:number,y:number)=>obstacles.every(o=>x+w+gap<=o.left||x>=o.right+gap||y+h+gap<=o.top||y>=o.bottom+gap);
  let x=left,y=above;
  if(!clear(x,y)){
    // Keep the label on the same corner when the floating toolbar occupies the space above it.
    const beside=fitX(frame.min.x-w-gap),inside=fitY(frame.min.y+gap);
    if(beside+w<=frame.min.x-gap&&clear(beside,inside)){x=beside;y=inside;}
    else if(clear(x,inside))y=inside;
    else{
      const xs=[left,...obstacles.flatMap(o=>[fitX(o.left-w-gap),fitX(o.right+gap)])];
      const ys=[above,inside,...obstacles.flatMap(o=>[fitY(o.top-h-gap),fitY(o.bottom+gap)])];
      let nearest=Infinity;
      for(const px of xs)for(const py of ys){
        const distance=(px-left)**2+(py-above)**2;
        if(distance<nearest&&clear(px,py)){nearest=distance;x=px;y=py;}
      }
    }
  }
  label.style.left=Math.round(x)+"px";label.style.top=Math.round(y)+"px";
}
