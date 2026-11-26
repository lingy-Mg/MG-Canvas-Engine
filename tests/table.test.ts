import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {assertDocument,contentVersion} from "../core/document.ts";
import type {BoardDocument} from "../core/document.ts";
import {MAX_CELL_TEXT} from "../core/table.ts";
import type {TableObject} from "../core/table.ts";
import {cellAppearance,cellAt,cellRange,changeCells,copyCells,createTable,editTableAxis,formatCells,pasteCells,rangeAppearance,rangeBox} from "../features/table.ts";
import {hitTableDivider,resizeTableBand,tableGrid} from "../features/table-geometry.ts";
import {captureClipboard,decodeClipboard,encodeClipboard,pasteClipboard} from "../features/clipboard.ts";
import {AssetVault} from "../features/image-assets.ts";
import {decodeProject,encodeProject} from "../platform/project.ts";
import {contrastRatio,standaloneInk,canvasThemes} from "../platform/theme.ts";
import {buildScene,hitTest} from "../scene/board.ts";
import {tablePrimitives} from "../scene/table-layout.ts";
import {EditorSession} from "../session/editor.ts";

const empty:BoardDocument={id:"table-test",schemaVersion:1,objects:{},order:[],assets:{},theme:"light"};
const camera={zoom:1,offset:{x:0,y:0}},a={row:0,col:0},b={row:1,col:1};
const fresh=()=>createTable({x:10.2,y:20.8});
const native=(table:TableObject):BoardDocument=>({...empty,schemaVersion:6,objects:{[table.id]:table},order:[table.id]});
const asTable=(e:EditorSession,id:string)=>e.doc.objects[id] as TableObject;
const put=(e:EditorSession,t:TableObject)=>e.commitEdit({label:"表格",patches:[{op:"putObject",value:t}]},e.generation,[t.id]);

function exampleGrid(){
  const texts=[["123","123","123"],["123","123",""],["","","651321"],["","","123123123"]];
  const table={...fresh(),width:324,height:184,cells:texts.map(row=>row.map(text=>({text})))};
  return formatCells(table,cellRange(b),{background:"#cbe2f7"});
}

test("middle and outside dividers share geometry with text, grid strokes, selection, clipboard and saved v6 boards",()=>{
  const old=exampleGrid(),table=([
    {axis:"row",index:1,delta:23},{axis:"col",index:1,delta:42},
    {axis:"row",index:3,delta:17},{axis:"col",index:2,delta:-19},
  ] as const).reduce((t,step)=>resizeTableBand(t,step,step.delta),old);
  assert.deepEqual(tableGrid(old),{rowEdges:[0,46,92,138,184],columnEdges:[0,108,216,324]});
  const edges={rowEdges:[0,46,115,161,224],columnEdges:[0,108,258,347]};
  assert.deepEqual(tableGrid(table),edges);assert.equal(table.cells,old.cells);
  assert.equal(table.at,old.at);
  const {rowEdges,columnEdges}=edges;
  for(let r=0;r<4;r++)for(let c=0;c<3;c++){
    const x=table.at.x+columnEdges[c],y=table.at.y+rowEdges[r],at={row:r,col:c};
    const width=columnEdges[c+1]-columnEdges[c],height=rowEdges[r+1]-rowEdges[r];
    assert.deepEqual(rangeBox(table,cellRange(at)),{at:{x,y},width,height,rotation:0});
    assert.deepEqual(cellAt(table,{x,y}),at);
    assert.deepEqual(hitTableDivider(table,{x:x+width/2,y:y+height},5),{axis:"row",index:r});
    assert.deepEqual(hitTableDivider(table,{x:x+width,y:y+height/2},5),{axis:"col",index:c});
    assert.equal(hitTableDivider(table,{x:x+width/2,y:y+height/2},9),undefined);
  }
  const [grid,...labels]=tablePrimitives(table);
  assert.ok(grid.kind==="tableGrid");assert.deepEqual(grid.rowEdges,rowEdges);assert.deepEqual(grid.columnEdges,columnEdges);
  assert.deepEqual(grid.backgrounds,[{box:rangeBox(table,cellRange(b)),color:"#cbe2f7"}]);
  for(const label of labels){
    assert.ok(label.kind==="textBlock"&&label.cell);
    const box=rangeBox(table,cellRange(label.cell));
    assert.equal(label.lines.join(""),table.cells[label.cell.row][label.cell.col].text);
    assert.ok(label.box.at.x>=box.at.x&&label.box.at.x+label.box.width<=box.at.x+box.width);
    assert.ok(label.box.at.y>=box.at.y&&label.box.at.y+label.box.height<=box.at.y+box.height);
  }
  const plus=editTableAxis(editTableAxis(table,"col",1)!,"row",4)!;
  assert.deepEqual(plus.columnWeights,[108,150,150,89]);assert.deepEqual(plus.rowWeights,[46,69,46,63,63]);
  assert.deepEqual(editTableAxis(editTableAxis(plus,"row",4,true)!,"col",1,true),table);
  const pasted=pasteCells(table,{row:3,col:2},"甲\t乙\n丙\t丁")!;
  assert.deepEqual(pasted.rowWeights,[46,69,46,63,63]);assert.deepEqual(pasted.columnWeights,[108,150,89,89]);
  assert.equal(pasted.cells[2][2],table.cells[2][2]);
  const vault=new AssetVault(),project=decodeProject(encodeProject(native(table),vault));
  assert.deepEqual(project.document,native(table));
  const fragment=captureClipboard(project.document,[table.id],vault)!,target=new EditorSession(empty,camera);
  assert.ok(pasteClipboard(target,vault,decodeClipboard(encodeClipboard(fragment))!));
  assert.deepEqual(tableGrid(asTable(target,target.selection!)),edges);
  for(const bad of [{rowWeights:[1,2]},{columnWeights:[0,1,2]},{columnWeights:[1,Infinity,2]},{rowWeights:[1,2,3,-1]}])
    assert.throws(()=>assertDocument(native({...old,...bad})));
  const clamped=resizeTableBand(table,{axis:"col",index:1},-999);
  assert.deepEqual(clamped.columnWeights,[108,32,89]);
  assert.equal(resizeTableBand(clamped,{axis:"col",index:1},-1),clamped);
});

test("divider previews use screen travel at the current zoom and commit once on release",()=>{
  for(const zoom of [.5,1,2]){
    const original=exampleGrid(),e=new EditorSession(native(original),{offset:{x:133,y:-92},zoom});
    const t=asTable(e,original.id),start={x:100,y:200};
    const handle={id:t.id,divider:{axis:"row",index:1}} as const;
    const middle={...start,y:start.y+12*zoom},end={...start,y:start.y+31*zoom};
    e.down(1,"mouse",start,t.id,false,false,handle);e.move(1,middle);e.move(1,end);
    assert.equal(e.selection,t.id);assert.equal(e.resizingTableAxis,"row");assert.equal(asTable(e,t.id),t);
    assert.equal(e.history.past.length,0);assert.deepEqual((e.preview!.objects.get(t.id) as TableObject).rowWeights,[46,77,46,46]);
    e.move(1,start);assert.equal(e.preview,undefined);e.up(1,start);assert.equal(e.history.past.length,0);
    e.down(1,"mouse",start,t.id,false,false,handle);e.move(1,end);e.pointerCancelled(1);
    assert.equal(e.history.past.length,0);assert.equal(asTable(e,t.id),t);
    e.down(1,"mouse",start,t.id,false,false,handle);e.move(1,middle);e.up(1,end);
    assert.equal(e.history.past.length,1);const changed=asTable(e,t.id);assert.equal(changed.height,t.height+31);
    e.undo();assert.equal(asTable(e,t.id),t);e.redo();assert.equal(asTable(e,t.id),changed);
    const corner={id:t.id,corner:"se",lockRatio:false} as const;
    const x2={x:start.x+changed.width*zoom,y:start.y+changed.height*zoom};
    e.down(1,"mouse",start,t.id,false,false,corner);e.up(1,x2);
    assert.deepEqual(tableGrid(asTable(e,t.id)).rowEdges,tableGrid(changed).rowEdges.map(n=>2*n));
    e.undo();assert.equal(asTable(e,t.id),changed);
    e.down(1,"touch",start,t.id,false,false,handle);e.move(1,end);e.down(2,"touch",middle,undefined,true);
    assert.equal(e.preview,undefined);e.up(2,middle);e.up(1,end);assert.equal(asTable(e,t.id),changed);
  }
});

test("inserting and deleting grid bands preserves cell contents, styling and physical cell dimensions",()=>{
  const base=pasteCells(fresh(),a,'项目\t日期\n"复核\n意见"\t完成')!;
  const table=formatCells(base,cellRange(b),{italic:true,fontSize:22,align:"right"});
  const rows=editTableAxis(table,"row",0)!,cols=editTableAxis(rows,"col",1)!;
  assert.deepEqual(cols.cells.map(row=>row.map(c=>c.text)),[["","",""],["项目","","日期"],["复核\n意见","","完成"]]);
  assert.equal(cols.cells[2][2],table.cells[1][1]);assert.deepEqual([cols.width,cols.height],[432,144]);
  const restored=editTableAxis(editTableAxis(cols,"row",0,true)!,"col",1,true);
  assert.deepEqual(restored,table);
  const single=editTableAxis(editTableAxis(table,"row",1,true)!,"col",1,true)!;
  assert.equal(editTableAxis(single,"row",0,true),undefined);assert.equal(editTableAxis(single,"col",0,true),undefined);
  assert.deepEqual(table.at,{x:10,y:21});assert.deepEqual(cellAt(table,{x:200,y:90}),b);
  assert.deepEqual(rangeBox(table,cellRange(b)).at,{x:154,y:69});
  const scene=buildScene(native(table));assert.equal(hitTest(scene,{x:299,y:100},0),undefined);
  assert.equal(hitTest(scene,{x:200,y:90},0),table.id);
});

test("whole table and rectangular formatting, automatic theme ink and portable TSV/format clipboard",()=>{
  const table=formatCells(fresh(),undefined,{fontFamily:"simsun",fontWeight:700,align:"center"});
  assert.equal(formatCells(table,cellRange(a),{fontWeight:700}),table);
  assert.equal(formatCells(table,undefined,{fontSize:16}),table);
  const column=cellRange({row:1,col:0},a);
  const styled=formatCells(table,column,{background:"#edf2ff",italic:true,strike:true,fontSize:22});
  const filled=changeCells(styled,cellRange(a),c=>({...c,text:'一\t二\n"三"'}));
  assert.equal(rangeAppearance(filled).italic,false);assert.equal(rangeAppearance(filled,column).italic,true);
  assert.equal(rangeAppearance(filled).fontWeight,700);
  assert.deepEqual(filled.cells[0][1].style,undefined);
  assert.equal(cellAppearance(filled,filled.cells[1][0]).fontFamily,"simsun");
  const whole=formatCells(filled,undefined,{fontSize:14});
  assert.equal(cellAppearance(whole,whole.cells[1][0]).fontSize,14);
  const {plain,formatted}=copyCells(filled,column);
  const dest=pasteCells(fresh(),b,plain,formatted)!;
  assert.equal(dest.cells.length,3);assert.deepEqual(cellAppearance(dest,dest.cells[1][1]),cellAppearance(filled,filled.cells[0][0]));
  assert.equal(dest.cells[1][1].text,filled.cells[0][0].text);
  assert.equal(pasteCells(fresh(),a,plain)!.cells[0][0].text,filled.cells[0][0].text);
  assert.equal(pasteCells(fresh(),a,'"原样粘贴')!.cells[0][0].text,'"原样粘贴');
  for(const theme of ["light","dark"] as const){
    const ink=standaloneInk(cellAppearance(table,table.cells[0][0]),theme);
    assert.ok(contrastRatio(ink,canvasThemes[theme].handle)!>=4.5);
  }
  assert.equal(pasteCells(table,a,"x".repeat(MAX_CELL_TEXT+1)),undefined);
  assert.equal(pasteCells(table,a,"x\t".repeat(256)+"x"),undefined);
});

test("legacy and grouped boards round trip with and without tables, including complete-object clipboard and undo",()=>{
  for(const fixture of ["M5V-Drag-Alignment","M5X-Flow-Groups"]){
    const old=decodeProject(readFileSync(new URL("../docs/fixtures/"+fixture+".mgcanvas",import.meta.url),"utf8"));
    const vault=new AssetVault(old.assets),e=new EditorSession(old.document,camera);
    assert.deepEqual(decodeProject(encodeProject(e.doc,vault)).document,old.document);
    const t=pasteCells(fresh(),a,"保留中文")!;
    assert.ok(put(e,t));assert.equal(e.doc.schemaVersion,6);
    assert.deepEqual(e.doc.flowGroups?.members,old.document.flowGroups?.members);
    const copied=captureClipboard(e.doc,e.doc.order,vault)!;
    const target=new EditorSession(empty,camera);
    assert.ok(pasteClipboard(target,new AssetVault(),decodeClipboard(encodeClipboard(copied))!));
    const copy=Object.values(target.doc.objects).find(i=>i.kind==="table")!;
    assert.notEqual(copy.id,t.id);assert.deepEqual(copy.cells,t.cells);
    assert.deepEqual(decodeProject(encodeProject(e.doc,vault)).document,structuredClone(e.doc));
    e.undo();assert.deepEqual(e.doc,old.document);e.redo();assert.deepEqual(asTable(e,t.id).cells,t.cells);
    assert.ok(e.commitEdit({label:"删除",patches:[{op:"removeObject",id:t.id}]},e.generation));
    assert.deepEqual(structuredClone(e.doc),structuredClone(old.document));
  }
});

test("table drags, opposite-corner resize, cancellation, locking and validation use normal editor transactions",()=>{
  const t=fresh(),e=new EditorSession(native(t),camera);
  e.select(t.id);e.down(1,"mouse",{x:80,y:50},t.id,false);e.move(1,{x:100,y:75});e.up(1,{x:100,y:75});
  const moved=asTable(e,t.id);assert.deepEqual(moved.at,{x:30,y:46});assert.deepEqual(moved.cells,t.cells);
  const se={x:moved.at.x+moved.width,y:moved.at.y+moved.height},to={x:se.x+64,y:se.y+24};
  const handle={id:t.id,corner:"se" as const,lockRatio:false};
  e.down(2,"mouse",se,t.id,false,false,handle);e.move(2,to);e.pointerCancelled(2);
  assert.equal(asTable(e,t.id),moved);
  e.down(3,"mouse",se,t.id,false,false,handle);e.move(3,to);e.up(3,to);
  assert.equal(asTable(e,t.id).width,352);e.undo();assert.equal(asTable(e,t.id),moved);e.redo();
  e.setLayerLocks([t.id],true);assert.equal(put(e,formatCells(t,undefined,{fontSize:28})),false);e.setLayerLocks([t.id],false);
  const current=asTable(e,t.id);assert.equal(put(e,{...current,rotation:1}),false);assert.equal(asTable(e,t.id),current);
  for(const cells of [[],[[]],[[{text:"好"}],[]],[[{text:"",style:{bogus:1}}]],[[{text:"",style:{fontSize:Infinity}}]]]){
    assert.throws(()=>assertDocument({...native(t),objects:{[t.id]:{...t,cells}}}));
  }
  assert.throws(()=>assertDocument({...native(t),schemaVersion:1}));assert.equal(contentVersion([t]),6);
});
