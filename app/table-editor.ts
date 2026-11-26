import {objectEditingView} from "./object-editing-view.ts";
import type {ObjectEditingView,TableAction} from "./object-editing-view.ts";
import type { TextObject } from "../core/document.ts";
import { worldToScreen } from "../core/geometry.ts";
import { fitsTable } from "../core/table.ts";
import type { CellStyle, TableObject } from "../core/table.ts";
import { cellAppearance, cellRange, changeCells, copyCells, editTableAxis, firstCell, formatCells, pasteCells,
  rangeAppearance, rangeBox, rangeEdges, tableLimits, withinTable, CELL_CLIPBOARD } from "../features/table.ts";
import type { CellAddress, CellRange, TableAxis } from "../features/table.ts";
import { standaloneInk } from "../platform/theme.ts";
import type { WorkspaceTheme } from "../platform/theme.ts";
import type { EditorSession } from "../session/editor.ts";
import type { TextOverlay } from "./text-editor.ts";
import { formatSeries } from "./text-format-bar.ts";
import type { FormatCapability, FormatChange, FormatGesture, FormatTarget, ScreenArea } from "./text-format-bar.ts";

function styleChange(change:FormatChange):CellStyle{
  const {colorMode,...patch}=change;
  return colorMode==="auto"?{...patch,color:"auto"}:patch;
}
const same=(a:CellAddress,b:CellAddress)=>a.row===b.row&&a.col===b.col;
const tableCapabilities:readonly FormatCapability[]=["ink","family","size","bold","italic","underline","strike","align"];

// The asynchronous Clipboard API acknowledges a cut. A standard HTML table also carries
// the cell styles through browsers that expose only standard formats on the next paste.
function clipboardTable(selection:ReturnType<typeof copyCells>){
  const table=document.createElement("table");
  table.dataset.mgcanvasCells=encodeURIComponent(selection.formatted);
  for(const row of selection.cells){
    const tr=table.insertRow();
    for(const cell of row)tr.insertCell().textContent=cell.text;
  }
  return new ClipboardItem({
    "text/plain":new Blob([selection.plain],{type:"text/plain"}),
    "text/html":new Blob([table.outerHTML],{type:"text/html"}),
  });
}

export class CanvasTables{
  private editor:EditorSession;
  private overlay:TextOverlay;
  private canvas:HTMLCanvasElement;
  private refresh:()=>void;
  private report:(message:string)=>void;
  private selection?:{id:string;generation:symbol;range:CellRange};
  private edit?:{id:string;at:CellAddress;patch:CellStyle};
  private formatSnapshot?:{cells:TableObject["cells"];style?:CellStyle;range?:CellRange;appearance:ReturnType<typeof rangeAppearance>};
  private view:ObjectEditingView;
  private root:HTMLElement;
  private highlight:HTMLElement;
  private menu:HTMLElement;
  private controls:Record<TableAction,HTMLButtonElement>;
  private menuAxis?:TableAxis;

  constructor(editor:EditorSession,overlay:TextOverlay,canvas:HTMLCanvasElement,mount:HTMLElement,refresh:()=>void,report:(message:string)=>void){
    this.editor=editor;this.overlay=overlay;this.canvas=canvas;this.refresh=refresh;this.report=report;
    const view=this.view=objectEditingView(mount);
    this.root=view.layer.querySelector<HTMLElement>(".table-controls")!;
    this.highlight=this.root.querySelector<HTMLElement>(".table-selection")!;this.menu=this.root.querySelector<HTMLElement>(".table-axis-menu")!;
    this.controls=Object.fromEntries(Array.from(this.root.querySelectorAll<HTMLButtonElement>("[data-table-action]"),b=>[b.dataset.tableAction,b])) as Record<TableAction,HTMLButtonElement>;
    view.tableActions(action=>{
      if(action==="addRow"||action==="addCol")this.append(action==="addRow"?"row":"col");
      else if(action==="whole"){this.select();this.focusCanvas();}
      else this.toggleMenu(action);
    });
    document.addEventListener("pointerdown",e=>{if(this.menuAxis&&!this.root.contains(e.target as Node))this.closeMenu();},{capture:true,signal:view.signal});
    this.root.addEventListener("keydown",e=>{
      if(e.key==="Escape"){e.preventDefault();e.stopPropagation();this.closeMenu();this.focusCanvas();}
    },{signal:view.signal});
  }
  get table():TableObject|undefined{
    const e=this.editor,item=e.selection&&e.selectedIds.length===1?e.doc.objects[e.selection]:undefined;
    return item?.kind==="table"&&!e.isHidden(item.id)?item:undefined;
  }
  get range():CellRange|undefined{
    const s=this.selection,table=this.table;
    if(s&&table?.id===s.id&&s.generation===this.editor.generation&&withinTable(table,s.range.anchor)&&withinTable(table,s.range.focus))return s.range;
  }
  appearance(table:TableObject,range=this.range){
    const last=this.formatSnapshot;
    if(last&&last.cells===table.cells&&last.style===table.style&&last.range===range)return last.appearance;
    const appearance=rangeAppearance(table,range);
    this.formatSnapshot={cells:table.cells,style:table.style,range,appearance};
    return appearance;
  }
  get editing(){return this.edit?.at;}
  sync(){
    if(this.selection&&!this.range){this.selection=undefined;this.closeMenu();}
  }
  private focusCanvas(){this.canvas.focus({preventScroll:true});}
  private closeMenu(){
    if(this.menuAxis)this.controls[this.menuAxis].setAttribute("aria-expanded","false");
    this.menuAxis=undefined;this.menu.hidden=true;
  }
  select(range?:CellRange){
    const table=this.table;
    this.selection=table&&range?{id:table.id,range,generation:this.editor.generation}:undefined;
    this.closeMenu();this.refresh();
  }
  tap(at:CellAddress,extend:boolean,canEdit:boolean){
    const previous=this.range;
    if(!extend&&canEdit&&previous&&same(previous.anchor,at)&&same(previous.focus,at)){this.startEdit(at);return;}
    this.select(cellRange(at,extend?previous?.anchor:at));
  }
  private commit(next:TableObject,label:string,gesture?:FormatGesture){
    if(this.table===next)return false;
    return this.editor.commitEdit({label,patches:[{op:"putObject",value:next}]},this.editor.generation,undefined,undefined,formatSeries(gesture,this.editor.history));
  }
  private changeAxis(axis:TableAxis,index:number,remove=false){
    const table=this.table;if(!table||this.editor.isLocked(table.id))return;
    const next=editTableAxis(table,axis,index,remove);if(!next)return;
    const focused=this.range;
    if(!this.commit(next,(remove?"删除":"插入")+"表格"+(axis==="row"?"行":"列")))return;
    if(focused){
      const last=(axis==="row"?next.cells.length:next.cells[0].length)-1;
      const shift=(p:CellAddress)=>({...p,[axis]:Math.min(last,p[axis]+(p[axis]<index?0:remove?p[axis]>index?-1:0:1))});
      this.select(cellRange(shift(focused.focus),shift(focused.anchor)));
    }
    this.closeMenu();this.focusCanvas();
  }
  private append(axis:TableAxis){
    const t=this.table;if(t)this.changeAxis(axis,axis==="row"?t.cells.length:t.cells[0].length);
  }
  private toggleMenu(axis:TableAxis){
    const table=this.table;if(!table)return;
    if(this.menuAxis===axis){this.closeMenu();return;}
    this.closeMenu();this.menuAxis=axis;this.controls[axis].setAttribute("aria-expanded","true");
    const at=this.range?.focus??firstCell,{rows,cols}=tableLimits(table),row=axis==="row",name=row?"行":"列";
    const index=at[axis],length=row?rows:cols;
    const choose=()=>{
      this.select(row?cellRange({row:index,col:cols-1},{row:index,col:0}):cellRange({row:rows-1,col:index},{row:0,col:index}));
      this.focusCanvas();
    };
    const insert=(after:boolean)=>({label:(row?(after?"在下方":"在上方"):(after?"在右侧":"在左侧"))+"插入"+name,
      disabled:!fitsTable(rows+Number(row),cols+Number(!row)),run:()=>this.changeAxis(axis,index+Number(after))});
    this.view.tableMenu([{label:"选择整"+name,run:choose},insert(false),insert(true),
      {label:"删除此"+name,disabled:length<=1,run:()=>this.changeAxis(axis,index,true)}]);
    this.menu.hidden=false;this.refresh();this.menu.querySelector("button")?.focus({preventScroll:true});
  }
  private textFor(table:TableObject,at:CellAddress,patch:CellStyle={}):TextObject & CellStyle{
    const cell=table.cells[at.row][at.col],style=cellAppearance(table,{...cell,style:{...cell.style,...patch}});
    return {...rangeBox(table,cellRange(at)),...style,kind:"text",id:table.id,text:cell.text,heightMode:"fixed"};
  }
  startEdit(at=this.range?.focus??firstCell,style?:CellStyle):boolean{
    const table=this.table,e=this.editor;
    if(!table||this.overlay.active||e.busy||e.isLocked(table.id)||!withinTable(table,at))return false;
    this.select(cellRange(at));
    const generation=e.generation,source=table.cells[at.row][at.col],draft={id:table.id,at,patch:style??{}};
    this.edit=draft;
    const field=this.textFor(table,at,style);
    this.overlay.show(field,(text,_follow,outside)=>{
      this.edit=undefined;
      const current=this.table;
      if(text!==undefined&&generation===e.generation&&current?.id===table.id&&!e.isLocked(table.id)&&
        current.cells.length===table.cells.length&&current.cells[0].length===table.cells[0].length&&current.cells[at.row][at.col].text===source.text){
        const range=cellRange(at);
        let next=Object.keys(draft.patch).length?formatCells(current,range,draft.patch):current;
        if(text!==source.text)next=changeCells(next,range,cell=>({...cell,text}));
        this.commit(next,"编辑表格单元格");
      }
      this.refresh();if(!outside)this.focusCanvas();
    },{kind:"cell",next:step=>this.navigate("Tab",step<0)},false,{kind:"cell",id:table.id,...at,style});
    this.decorateField(field);this.refresh();return true;
  }
  private decorateField(style:CellStyle){
    if(this.overlay.field)this.overlay.field.style.textDecorationLine=[style.underline?"underline":"",style.strike?"line-through":""].filter(Boolean).join(" ")||"none";
  }
  navigate(key:string,shift=false){
    const table=this.table;if(!table)return;
    const range=this.range,at=range?.focus??firstCell,{rows,cols}=tableLimits(table);
    let {row,col}=at;
    if(key==="Tab"){
      const index=Math.max(0,Math.min(rows*cols-1,row*cols+col+(shift?-1:1)));
      row=Math.floor(index/cols);col=index%cols;
    }else{
      if(key==="ArrowUp")row--;if(key==="ArrowDown")row++;if(key==="ArrowLeft")col--;if(key==="ArrowRight")col++;
      row=Math.max(0,Math.min(rows-1,row));col=Math.max(0,Math.min(cols-1,col));
    }
    this.select(cellRange({row,col},shift&&key!=="Tab"?range?.anchor:undefined));
  }
  clearCells(){
    const table=this.table,range=this.range;
    if(table&&range&&!this.editor.isLocked(table.id))this.commit(changeCells(table,range,cell=>cell.text?{...cell,text:""}:cell),"清空单元格");
  }
  copy(event:ClipboardEvent,cut=false):boolean{
    const table=this.table,range=this.range,data=event.clipboardData;
    if(!table||!range)return false;
    event.preventDefault();
    if(!data){this.report("未获得可写的剪贴板");return true;}
    const selection=copyCells(table,range);
    try{data.setData("text/plain",selection.plain);}catch{this.report("无法复制所选单元格");return true;}
    try{data.setData(CELL_CLIPBOARD,selection.formatted);}catch{/* Plain TSV also works in spreadsheets. */}
    if(cut&&!this.editor.isLocked(table.id)){
      const history=this.editor.history;
      void (async()=>{
        try{
          const clipboard=window.navigator?.clipboard;
          if(!clipboard?.write||typeof ClipboardItem==="undefined"){this.report("已复制单元格，此环境无法确认剪切");return;}
          await clipboard.write([clipboardTable(selection)]);
          if(this.editor.history===history&&this.table===table&&this.range===range&&!this.overlay.active&&
            !this.editor.busy&&!this.editor.isLocked(table.id)){
            this.clearCells();this.report("已剪切单元格");
          }else this.report("画布状态已变化，已保留原单元格");
        }catch{this.report("剪贴板写入失败，单元格内容已保留");}
      })();
    }
    return true;
  }
  paste(plain:string,data:DataTransfer,canvasObject:boolean):boolean{
    const table=this.table,range=this.range;if(!table||!range)return false;
    const formats=Array.from(data.types??[]);
    let formatted=formats.includes(CELL_CLIPBOARD)?data.getData(CELL_CLIPBOARD):"";
    if(!formatted&&formats.includes("text/html")){
      const match=/<table\b[^>]*?\sdata-mgcanvas-cells="([^"]+)"/i.exec(data.getData("text/html"));
      if(match)try{formatted=decodeURIComponent(match[1]);}catch{/* Use the plain cell contents. */}
    }
    if(!formatted&&(canvasObject||!plain&&!formats.includes("text/plain")))return false;
    if(this.editor.isLocked(table.id))return true;
    const {top,left}=rangeEdges(table,range);
    const next=pasteCells(table,{row:top,col:left},plain,formatted);
    if(next)this.commit(next,"粘贴表格单元格");else this.report("粘贴的内容超出表格容量");
    return true;
  }
  hide(){if(!this.root.hidden){this.root.hidden=true;this.closeMenu();this.formatSnapshot=undefined;}}
  place(table:TableObject,area:ScreenArea,theme:WorkspaceTheme){
    const camera=this.editor.camera,z=camera.zoom,at=worldToScreen(table.at,camera);
    const w=table.width*z,h=table.height*z,{rows,cols}=tableLimits(table),range=this.range;
    const focus=range?.focus??firstCell;
    if(at.x+w<area.left||at.y+h<area.top||at.x>area.right||at.y>area.bottom){this.hide();return;}
    this.root.hidden=false;
    let scope="整表";
    if(range){
      const {top,bottom,left,right}=rangeEdges(table,range);
      scope=top===bottom&&left===right?`单元格，第 ${top+1} 行第 ${left+1} 列`:
        `单元格区域，第 ${top+1} 行第 ${left+1} 列至第 ${bottom+1} 行第 ${right+1} 列`;
    }
    const label="表格操作，"+scope;
    if(this.root.getAttribute("aria-label")!==label){
      this.root.setAttribute("aria-label",label);
      this.controls.whole.setAttribute("aria-pressed",String(!range));
    }
    Object.assign(this.root.style,{left:at.x+"px",top:at.y+"px",width:w+"px",height:h+"px"});
    const cell=rangeBox(table,cellRange(focus)),point=worldToScreen(cell.at,camera);
    const colX=point.x-at.x+cell.width*z/2,rowY=point.y-at.y+cell.height*z/2;
    this.controls.col.style.left=colX+"px";this.controls.row.style.top=rowY+"px";
    this.controls.addRow.disabled=!fitsTable(rows+1,cols);this.controls.addCol.disabled=!fitsTable(rows,cols+1);
    if(this.menuAxis){
      const left=this.menuAxis==="row"?at.x-24:at.x+colX,top=this.menuAxis==="row"?at.y+rowY:at.y;
      const x=Math.max(area.left+4,Math.min(left,area.right-this.menu.offsetWidth-4));
      const y=Math.max(area.top+4,Math.min(top,area.bottom-this.menu.offsetHeight-4));
      Object.assign(this.menu.style,{left:x-at.x+"px",top:y-at.y+"px"});
    }
    this.highlight.hidden=!range||Boolean(this.edit);
    if(range){
      const rect=rangeBox(table,range);
      Object.assign(this.highlight.style,{left:(rect.at.x-table.at.x)*z+"px",top:(rect.at.y-table.at.y)*z+"px",
        width:rect.width*z+"px",height:rect.height*z+"px"});
    }
    const item=this.edit?this.textFor(table,focus,this.edit.patch):this.appearance(table,range),overlay=this.overlay;
    const target:FormatTarget={layout:"table",id:[table.id,range?.anchor.row,range?.anchor.col,range?.focus.row,range?.focus.col].join("/"),
      capabilities:tableCapabilities,values:{color:standaloneInk(item,theme),autoInk:!item.colorMode,background:item.background,
        fontFamily:item.fontFamily??"system",fontSize:item.fontSize,fontWeight:item.fontWeight??400,italic:Boolean(item.italic),
        strike:Boolean(item.strike),underline:Boolean(item.underline),align:item.align},
      get composing(){return overlay.inComposition;},focus:()=>{const field=this.overlay.field??this.canvas;if(document.activeElement!==field)field.focus({preventScroll:true});},
      apply:(change,gesture)=>{
        const current=this.table;
        if(!current||current.id!==table.id||this.range!==range||this.editor.busy||this.editor.isLocked(current.id))return;
        const patch=styleChange(change);
        if(this.edit){
          this.edit.patch={...this.edit.patch,...patch};
          const field=this.textFor(current,focus,this.edit.patch);this.decorateField(field);
          this.overlay.restyle(field,{kind:"cell",id:table.id,...focus,style:this.edit.patch});
        }else this.commit(formatCells(current,range,patch),"修改表格文字格式",gesture);
        this.refresh();
      },
    };
    const anchor={left:Math.max(area.left,at.x),right:Math.min(area.right,at.x+w),top:at.y-20,bottom:at.y+h+25};
    return {target,anchor};
  }
}
