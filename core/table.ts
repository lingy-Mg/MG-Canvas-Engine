import type { Box } from "./geometry.ts";
import { textFamilies } from "./text-style.ts";
import type { TextFace } from "./text-style.ts";

export type CellStyle = TextFace & Readonly<{
  fontSize?:number; align?:"left"|"center"|"right"; color?:string; background?:string;
  strike?:boolean; underline?:boolean;
}>;
export type TableCell = Readonly<{text:string; style?:CellStyle}>;
export type TableObject = Box & Readonly<{
  kind:"table"; id:string; cells:readonly (readonly TableCell[])[]; style?:CellStyle;
  /** Proportions within the frame. Omitted axes divide the full extent equally. */
  rowWeights?:readonly number[]; columnWeights?:readonly number[];
}>;
export function validTableWeights(value:unknown,count:number):boolean{
  if(!Array.isArray(value)||value.length!==count)return false;
  let sum=0;
  for(const weight of value){
    if(typeof weight!=="number"||!Number.isFinite(weight)||weight<=0||!Number.isFinite(sum+weight)||sum+weight===sum)return false;
    sum+=weight;
  }
  return true;
}
export const MAX_TABLE_AXIS=256, MAX_TABLE_CELLS=10_000, MAX_CELL_TEXT=12_000;
export function fitsTable(rows:number,cols:number):boolean{
  return Number.isInteger(rows)&&Number.isInteger(cols)&&rows>0&&cols>0&&rows<=MAX_TABLE_AXIS&&
    cols<=MAX_TABLE_AXIS&&rows*cols<=MAX_TABLE_CELLS;
}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&
  (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const hex=(value:unknown)=>typeof value==="string"&&/^#[a-f0-9]{6}$/i.test(value);
export function validCellStyle(style:unknown):style is CellStyle{
  return record(style)&&Object.entries(style).every(([key,value])=>{
    switch(key){
      case "fontFamily": return textFamilies.some(f=>f===value);
      case "fontSize": return typeof value==="number"&&Number.isFinite(value)&&value>=6&&value<=160;
      case "fontWeight": return [400,500,600,700].some(w=>w===value);
      case "italic": case "strike": case "underline": return typeof value==="boolean";
      case "align": return value==="left"||value==="center"||value==="right";
      case "color": return value==="auto"||hex(value);
      case "background": return value==="transparent"||hex(value);
      default: return false;
    }
  });
}
export function validTableCells(cells:unknown):cells is TableObject["cells"]{
  if(!Array.isArray(cells)||!Array.isArray(cells[0])||!fitsTable(cells.length,cells[0].length))return false;
  const columns=cells[0].length;
  for(const row of cells){
    if(!Array.isArray(row)||row.length!==columns)return false;
    for(const cell of row){
      if(!record(cell)||typeof cell.text!=="string"||cell.text.length>MAX_CELL_TEXT||
        !Object.keys(cell).every(k=>k==="text"||k==="style")||("style" in cell&&!validCellStyle(cell.style)))return false;
    }
  }
  return true;
}
