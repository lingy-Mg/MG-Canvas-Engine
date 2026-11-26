import type {BoardDocument,BoardObject,Id} from "../core/document.ts";
import type {ChangeSet} from "../core/history.ts";
import {graphemePrefix} from "../features/text-layout.ts";
import {isCard} from "../core/document.ts";
import {cardTitle} from "../features/card-content.ts";

export const kindNames:Record<BoardObject["kind"],string>={shape:"流程节点",connector:"连接线",mindmap:"标准脑图",text:"独立文字",image:"独立图片",ink:"手写笔迹",path:"矢量路径",table:"表格"};
export const LAYER_PAGE_SIZE=180;

/** The first line is a text layer's name. Search the full line even when its caption is shortened. */
export function layerName(item:BoardObject):string{
  if(isCard(item))return cardTitle(item);
  if(item.kind==="table")return "表格 · "+item.cells.length+" 行 × "+item.cells[0].length+" 列";
  if(item.kind==="shape"||item.kind==="connector")return item.label||kindNames[item.kind];
  if(item.kind==="mindmap")return item.topics[item.rootId].text||kindNames.mindmap;
  if(item.kind==="text")return item.text.split("\n",1)[0]||"空文字";
  return kindNames[item.kind];
}
export function layerTitle(item:BoardObject):string{
  const name=layerName(item);return item.kind==="text"||isCard(item)?(graphemePrefix(name,100)||"空文字"):name;
}
export function layerQuery(raw:string):string{return raw.trim().normalize("NFC").toLowerCase();}

export class LayerSearch {
  private names=new WeakMap<BoardObject,string>();
  private previous?:BoardDocument;
  private query="";
  private ids:readonly Id[]=[];
  private matches(item:BoardObject,query:string):boolean{
    let name=this.names.get(item);
    if(name===undefined){name=layerQuery(layerName(item));this.names.set(item,name);}
    return name.includes(query);
  }
  /** Keep document stacking order. Only the visible page is reversed for the sidebar. */
  list(doc:BoardDocument,query:string,change?:ChangeSet):readonly Id[]{
    const before=this.previous,sameQuery=query===this.query;
    if(before===doc&&sameQuery)return this.ids;
    if(!query)this.ids=doc.order;
    else if(!sameQuery||!before||before.order!==doc.order||!change||
      change.updated.some(id=>this.matches(before.objects[id],query)!==this.matches(doc.objects[id],query))){
      this.ids=doc.order.filter(id=>this.matches(doc.objects[id],query));
    }
    this.previous=doc;this.query=query;return this.ids;
  }
}
export function pageOfLayer(ids:readonly Id[],id:Id):number{
  const i=ids.indexOf(id);return i<0?-1:Math.floor((ids.length-1-i)/LAYER_PAGE_SIZE);
}
export function layerPageIds(ids:readonly Id[],page:number):Id[]{
  const end=Math.max(0,ids.length-page*LAYER_PAGE_SIZE);
  return ids.slice(Math.max(0,end-LAYER_PAGE_SIZE),end).reverse();
}
