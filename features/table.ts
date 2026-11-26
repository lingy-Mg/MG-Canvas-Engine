import { gridPoint } from "../core/geometry.ts";
import type { Box, Point } from "../core/geometry.ts";
import { allocateId } from "../core/id.ts";
import { fitsTable, MAX_CELL_TEXT, validCellStyle, validTableCells } from "../core/table.ts";
import type { CellStyle, TableCell, TableObject } from "../core/table.ts";
import { DEFAULT_TEXT_COLOR } from "../core/text-style.ts";
import {bandAt,spliceBandSizes,tableGrid} from "./table-geometry.ts";
import type {TableAxis} from "./table-geometry.ts";

export type CellAddress=Readonly<{row:number; col:number}>;
export type CellRange=Readonly<{anchor:CellAddress; focus:CellAddress}>;
export type {TableAxis} from "./table-geometry.ts";
export const firstCell:CellAddress={row:0,col:0};
export const cellRange=(focus:CellAddress,anchor=focus):CellRange=>({anchor,focus});
const blank=():TableCell=>({text:""});
const defaults:Required<CellStyle>={fontFamily:"system",fontSize:16,fontWeight:400,italic:false,strike:false,underline:false,
  align:"left",color:"auto",background:"transparent"};
export const initialTableBox=Object.freeze({width:288,height:96});
export function createTable(at:Point):TableObject{
  return {kind:"table",id:allocateId("table"),at:gridPoint(at),rotation:0,...initialTableBox,
    cells:[[blank(),blank()],[blank(),blank()]]};
}
export function tableLimits(table:TableObject){
  return {rows:table.cells.length,cols:table.cells[0].length};
}
export function withinTable(table:TableObject,p:CellAddress):boolean{
  return Number.isInteger(p.row)&&Number.isInteger(p.col)&&Boolean(table.cells[p.row]?.[p.col]);
}
export function rangeEdges(table:TableObject,range?:CellRange){
  const {rows,cols}=tableLimits(table);
  if(!range)return {top:0,bottom:rows-1,left:0,right:cols-1};
  const {anchor:a,focus:b}=range;
  return {top:Math.min(a.row,b.row),bottom:Math.max(a.row,b.row),left:Math.min(a.col,b.col),right:Math.max(a.col,b.col)};
}
export function rangeBox(table:TableObject,range?:CellRange):Box{
  const {top,bottom,left,right}=rangeEdges(table,range),{rowEdges,columnEdges}=tableGrid(table);
  return {at:{x:table.at.x+columnEdges[left],y:table.at.y+rowEdges[top]},width:columnEdges[right+1]-columnEdges[left],
    height:rowEdges[bottom+1]-rowEdges[top],rotation:0};
}
export function cellAt(table:TableObject,point:Point):CellAddress|undefined{
  const x=point.x-table.at.x,y=point.y-table.at.y;
  if(x<0||x>table.width||y<0||y>table.height)return;
  const {rowEdges,columnEdges}=tableGrid(table);
  return {row:bandAt(rowEdges,y),col:bandAt(columnEdges,x)};
}
export function cellAppearance(table:TableObject,cell:TableCell){
  const style={...defaults,...table.style,...cell.style};
  const explicit=style.color!=="auto";
  return {...style,color:explicit?style.color:DEFAULT_TEXT_COLOR,
    colorMode:explicit?"custom" as const:undefined,background:style.background==="transparent"?undefined:style.background};
}
export function rangeAppearance(table:TableObject,range?:CellRange){
  const {top,bottom,left,right}=rangeEdges(table,range),first=table.cells[top][left];
  if(top===bottom&&left===right)return cellAppearance(table,first);
  const inherited={...defaults,...table.style};
  const shared:Partial<typeof inherited>={...inherited,...first.style};
  for(let r=top;r<=bottom;r++)for(let c=left;c<=right;c++){
    const style=table.cells[r][c].style;
    for(const key of Object.keys(shared) as (keyof CellStyle)[]){
      const value=style?.[key]??inherited[key];
      if(key==="fontWeight"&&(Number(value)>=600)===(shared.fontWeight!>=600))continue;
      if(shared[key]!==value)delete shared[key];
    }
  }
  // A toggle on a mixed selection turns that property on for every selected cell.
  return cellAppearance(table,{text:"",style:{...shared,fontWeight:shared.fontWeight??400,italic:shared.italic??false,
    underline:shared.underline??false,strike:shared.strike??false}});
}
export function editTableAxis(table:TableObject,axis:TableAxis,index:number,remove=false):TableObject|undefined{
  const {rows,cols}=tableLimits(table),length=axis==="row"?rows:cols,delta=remove?-1:1;
  if(!Number.isInteger(index)||index<0||index>length-(remove?1:0)||
    !fitsTable(rows+(axis==="row"?delta:0),cols+(axis==="col"?delta:0)))return;
  const geometry=spliceBandSizes(table,axis,index,Number(remove),Number(!remove));
  if(axis==="row"){
    const cells=table.cells.slice();
    cells.splice(index,remove?1:0,...(remove?[]:[Array.from({length:cols},blank)]));
    return {...table,cells,...geometry};
  }
  const cells=table.cells.map(row=>{
    const next=row.slice();next.splice(index,remove?1:0,...(remove?[]:[blank()]));return next;
  });
  return {...table,cells,...geometry};
}
export function changeCells(table:TableObject,range:CellRange|undefined,change:(cell:TableCell)=>TableCell):TableObject{
  const {top,bottom,left,right}=rangeEdges(table,range);
  let changed=false;
  const cells=table.cells.map((row,r)=>{
    if(r<top||r>bottom)return row;
    const next=row.map((cell,c)=>c<left||c>right?cell:change(cell));
    if(next.every((cell,c)=>cell===row[c]))return row;
    changed=true;return next;
  });
  return changed?{...table,cells}:table;
}
export function formatCells(table:TableObject,range:CellRange|undefined,patch:CellStyle):TableObject{
  if(!validCellStyle(patch))return table;
  const keys=Object.keys(patch) as (keyof CellStyle)[];
  const inherited={...defaults,...table.style};
  if(range)return changeCells(table,range,cell=>keys.every(k=>(cell.style?.[k]??inherited[k])===patch[k])?
    cell:{...cell,style:{...cell.style,...patch}});
  // A whole-table setting becomes the default for new cells and supersedes that property on existing cells.
  const updated=changeCells(table,undefined,cell=>{
    if(!cell.style||!keys.some(k=>Object.hasOwn(cell.style!,k)))return cell;
    const style=Object.fromEntries(Object.entries(cell.style).filter(([key])=>!Object.hasOwn(patch,key)));
    return Object.keys(style).length?{text:cell.text,style}:{text:cell.text};
  });
  return keys.every(k=>inherited[k]===patch[k])?updated:{...updated,style:{...table.style,...patch}};
}
export const CELL_CLIPBOARD="application/x-mgcanvas-cells+json";
export function copyCells(table:TableObject,range:CellRange){
  const {top,bottom,left,right}=rangeEdges(table,range);
  const cells=table.cells.slice(top,bottom+1).map(row=>row.slice(left,right+1).map(cell=>({
    text:cell.text,style:{...defaults,...table.style,...cell.style},
  } as TableCell)));
  const quote=(s:string)=>/[\t\r\n"]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;
  const plain=cells.map((row,i)=>row.length===1&&row[0].text===""&&i>0&&i===cells.length-1?'""':
    row.map(cell=>quote(cell.text)).join("\t")).join("\n");
  return {plain,formatted:JSON.stringify(cells),cells};
}
// Accept spreadsheet TSV quoting, including tabs, newlines and doubled quotes inside a cell.
function readTsv(raw:string):TableCell[][]|undefined{
  const text=raw.replace(/\r\n?/g,"\n"),rows:TableCell[][]=[[]];
  if(!/[\t\n]/.test(text)&&!/^"(?:[^"]|"")*"$/.test(text))return text.length<=MAX_CELL_TEXT?[[{text}]]:undefined;
  let field="",quoted=false,atStart=true,columns=0;
  const finish=()=>{
    if(field.length>MAX_CELL_TEXT)return false;
    const row=rows[rows.length-1];
    row.push({text:field});columns=Math.max(columns,row.length);field="";atStart=true;
    return fitsTable(rows.length,columns);
  };
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'&&(quoted||atStart)){
      if(quoted&&text[i+1]==='"'){field+='"';i++;}
      else quoted=!quoted;
    }else if(!quoted&&(ch==="\t"||ch==="\n")){
      if(!finish())return;
      if(ch==="\n"){if(i===text.length-1)return rows;rows.push([]);}
      continue;
    }else field+=ch;
    atStart=false;
    if(field.length>MAX_CELL_TEXT)return;
  }
  return finish()?rows:undefined;
}
export function pasteCells(table:TableObject,at:CellAddress,plain:string,formatted?:string):TableObject|undefined{
  if(!withinTable(table,at))return;
  let input:TableObject["cells"]|undefined;
  if(formatted){
    try{const parsed:unknown=JSON.parse(formatted);if(validTableCells(parsed))input=parsed;}catch{/* Use its plain-text representation. */}
  }
  input??=readTsv(plain);
  if(!input)return;
  const source=input,{rows,cols}=tableLimits(table);
  const height=Math.max(rows,at.row+source.length),width=Math.max(cols,at.col+Math.max(...source.map(row=>row.length)));
  if(!fitsTable(height,width))return;
  const cells=Array.from({length:height},(_,r)=>Array.from({length:width},(_,c)=>{
    const before=table.cells[r]?.[c]??blank(),next=source[r-at.row]?.[c-at.col];
    return next?next.style?next:{...before,text:next.text}:before;
  }));
  return {...table,cells,...spliceBandSizes(table,"row",rows,0,height-rows),...spliceBandSizes(table,"col",cols,0,width-cols)};
}
