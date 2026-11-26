import type { Box } from "../core/geometry.ts";
import type { TableObject } from "../core/table.ts";
import { cellAppearance, cellRange, rangeBox } from "../features/table.ts";
import {tableGrid} from "../features/table-geometry.ts";
import { wrapPlainText } from "../features/plain-text.ts";
import type { Primitive } from "./board.ts";

export function cellTextBox(cell:Box,fontSize:number,lines:number):Box {
  const padX=Math.min(8,cell.width/6),padY=Math.min(4,cell.height/6);
  const top=Math.max(padY,(cell.height-lines*fontSize*1.4)/2);
  return {at:{x:cell.at.x+padX,y:cell.at.y+top},width:cell.width-2*padX,height:cell.height-top-padY,rotation:0};
}
export function tablePrimitives(table:TableObject):Primitive[]{
  const backgrounds:{box:Box;color:string}[]=[],text:Primitive[]=[];
  table.cells.forEach((row,r)=>row.forEach((cell,c)=>{
    if(!cell.text&&!cell.style?.background&&!table.style?.background)return;
    const style=cellAppearance(table,cell),address={row:r,col:c},box=rangeBox(table,cellRange(address));
    if(style.background)backgrounds.push({box,color:style.background});
    if(!cell.text)return;
    const inner=cellTextBox(box,style.fontSize,1);
    const lines=wrapPlainText(cell.text,inner.width,style.fontSize,style);
    text.push({...style,kind:"textBlock",box:cellTextBox(box,style.fontSize,lines.length),lines,textAlign:style.align,
      clip:true,cell:address});
  }));
  return [{kind:"tableGrid",box:table,...tableGrid(table),backgrounds},...text];
}
