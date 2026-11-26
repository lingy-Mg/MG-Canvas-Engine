import {gridSize} from "../core/geometry.ts";
import type {Point} from "../core/geometry.ts";
import type {TableObject} from "../core/table.ts";

export type TableAxis="row"|"col";
export type TableDivider=Readonly<{axis:TableAxis;index:number}>;
type Grid=Readonly<{rowEdges:readonly number[];columnEdges:readonly number[]}>;
const layouts=new WeakMap<TableObject,Grid>();

function offsets(count:number,extent:number,weights?:readonly number[]):number[]{
  if(!weights)return Array.from({length:count+1},(_,i)=>extent*(i/count));
  const total=weights.reduce((sum,n)=>sum+n,0),scale=extent/total,edges=[0];
  let prefix=0;
  for(const weight of weights){
    prefix+=weight;
    edges.push(Number.isFinite(scale)?prefix*scale:extent*(prefix/total));
  }
  edges[count]=extent;
  return edges;
}
/** Local world coordinates, shared by paint, hit testing and the cell editor. */
export function tableGrid(table:TableObject):Grid{
  let grid=layouts.get(table);
  if(!grid){
    grid={rowEdges:offsets(table.cells.length,table.height,table.rowWeights),
      columnEdges:offsets(table.cells[0].length,table.width,table.columnWeights)};
    layouts.set(table,grid);
  }
  return grid;
}
function lengths(table:TableObject,axis:TableAxis):number[]{
  const grid=tableGrid(table),edges=axis==="row"?grid.rowEdges:grid.columnEdges;
  return edges.slice(1).map((edge,i)=>edge-edges[i]);
}
export function bandAt(edges:readonly number[],value:number):number{
  // Interior boundaries belong to the following cell. The outside edge belongs to the last.
  let lo=0,hi=edges.length-2;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(value<edges[mid+1])hi=mid;else lo=mid+1;}
  return lo;
}
export function hitTableDivider(table:TableObject,point:Point,tolerance:number):TableDivider|undefined{
  const x=point.x-table.at.x,y=point.y-table.at.y,{rowEdges,columnEdges}=tableGrid(table);
  let nearest:TableDivider|undefined,distance=Infinity;
  function scan(axis:TableAxis,edges:readonly number[],value:number){
    for(let i=1;i<edges.length;i++){
      const d=Math.abs(value-edges[i]);
      const band=Math.min(edges[i]-edges[i-1],i+1<edges.length?edges[i+1]-edges[i]:Infinity);
      if(d<distance&&d<=Math.min(tolerance,band/4)){nearest={axis,index:i-1};distance=d;}
    }
  }
  if(x>=0&&x<=table.width)scan("row",rowEdges,y);
  if(y>=0&&y<=table.height)scan("col",columnEdges,x);
  return nearest;
}
function dimension(axis:TableAxis,sizes:number[]){
  const extent=gridSize(sizes.reduce((sum,n)=>sum+n,0));
  return axis==="row"?{height:extent,rowWeights:sizes}:{width:extent,columnWeights:sizes};
}
export function resizeTableBand(table:TableObject,{axis,index}:TableDivider,delta:number):TableObject{
  const sizes=lengths(table,axis),old=sizes[index];
  if(!old||!Number.isFinite(delta))return table;
  const min=Math.min(old,axis==="row"?24:32);
  const change=Math.max(Math.ceil(min-old),Math.round(delta));
  if(!change)return table;
  sizes[index]=old+change;
  return {...table,...dimension(axis,sizes)};
}
/** Insert neighbours of the same size, or remove just the specified bands. */
export function spliceBandSizes(table:TableObject,axis:TableAxis,index:number,removed:number,added:number){
  if(!removed&&!added)return {};
  const row=axis==="row",count=row?table.cells.length:table.cells[0].length;
  if(!(row?table.rowWeights:table.columnWeights)){
    const factor=(count-removed+added)/count;
    return row?{height:gridSize(table.height*factor)}:{width:gridSize(table.width*factor)};
  }
  const sizes=lengths(table,axis),size=gridSize(sizes[Math.min(index,count-1)]);
  sizes.splice(index,removed,...Array<number>(added).fill(size));
  return dimension(axis,sizes);
}
