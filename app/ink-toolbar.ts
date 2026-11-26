import type {WorkspaceUI} from "./react/workspace-ui.ts";
import {HIGHLIGHTER_BRUSH_VERSION} from "../features/ink.ts";
import type {InkBrush} from "../features/ink.ts";
import {dockTitle} from "./dock-shortcuts.ts";

type Tool="pen"|"highlighter"|"eraser";
const tools={pen:{name:"普通笔",icon:"glyph-ink-pen",weights:[4,8]},highlighter:{name:"荧光笔",icon:"glyph-marker",weights:[8,16]},
  eraser:{name:"笔迹橡皮",icon:"glyph-ink-eraser",weights:[8,18]}} as const;
export const inkColors=[["墨黑","#223344"],["朱红","#e34935"],["橙色","#ec9639"],["黄色","#f2cf42"],
  ["绿色","#60ca78"],["天蓝","#38aee0"],["紫色","#8955de"],["白色","#ffffff"]] as const;

export function inkToolbar(ui:WorkspaceUI,onToolChange:(focusCanvas:boolean)=>void){
  const settings={pen:{color:"#223344",width:4},highlighter:{color:"#f2cf42",width:16},eraser:{color:"",width:18}};
  let selected:Tool="pen",shown:Tool="pen",previousDisplay="",cursor="crosshair";
  for(const tool of Object.keys(tools) as Tool[])ui.on("ink-"+tool,"click",event=>{selected=tool;onToolChange(event.detail>0);});
  for(const [index,id] of ["ink-thin","ink-thick"].entries())ui.on(id,"click",event=>{
    settings[shown].width=tools[shown].weights[index];onToolChange(event.detail>0);
  });
  for(const [,hex] of inkColors)ui.on("ink-swatch-"+hex.slice(1),"click",event=>{
    settings[shown].color=hex;onToolChange(event.detail>0);
  });
  for(const event of ["input","change"] as const){
    ui.on("ink-color",event,e=>{settings[shown].color=(e.target as HTMLInputElement).value;onToolChange(false);});
    ui.on("ink-width",event,e=>{settings[shown].width=Number((e.target as HTMLInputElement).value);onToolChange(false);});
  }
  function sync(temporaryEraser=false){
    shown=temporaryEraser?"eraser":selected;
    const erasing=shown==="eraser",diameter=settings[shown].width,hex=(erasing?settings.pen:settings[shown]).color;
    const display=[shown,diameter,hex].join("/");if(display===previousDisplay)return;previousDisplay=display;
    const config=tools[shown];
    for(const tool of Object.keys(tools) as Tool[])ui.patch("ink-"+tool,{"aria-pressed":tool===shown});
    config.weights.forEach((size,i)=>ui.patch(i?"ink-thick":"ink-thin",{"aria-pressed":size===diameter,title:(i?"粗":"细")+" · "+size}));
    ui.patch("ink-main-icon",{href:"#"+config.icon});
    ui.patch("ink-main-label",{caption:shown==="pen"?"手写":config.name});
    ui.patch("tool-ink",{title:dockTitle("tool-ink",config.name)});
    ui.patch("ink-main-color",{hidden:erasing,style:{backgroundColor:hex}});
    ui.patch("ink-width-value",{caption:String(diameter)});
    ui.patch("ink-width",{"aria-label":erasing?"橡皮直径":"笔触粗细",value:String(diameter)});
    ui.patch("ink-color",{disabled:erasing,value:hex});
    for(const [,swatch] of inkColors)ui.patch("ink-swatch-"+swatch.slice(1),{disabled:erasing,"aria-pressed":!erasing&&swatch===hex});
    const custom=!erasing&&!inkColors.some(([,c])=>c===hex);
    ui.patch("ink-custom",{"data-selected":String(custom)});
    ui.patch("ink-custom-chip",{style:{background:custom?hex:""}});
    if(erasing){
      const size=diameter+4,center=size/2;
      const circle='<circle cx="'+center+'" cy="'+center+'" r="'+diameter/2+'" fill="none"';
      const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+size+'" height="'+size+'">'+circle+' stroke="white" stroke-width="3"/>'+circle+' stroke="#475569"/></svg>';
      cursor='url("data:image/svg+xml,'+encodeURIComponent(svg)+'") '+Math.floor(center)+' '+Math.floor(center)+', crosshair';
    }else cursor="crosshair";
  }
  sync();
  return {get eraser(){return selected==="eraser";},get cursor(){return cursor;},
    get eraserDiameter(){return settings.eraser.width;},
    brush():InkBrush{return {color:settings[selected].color,baseWidth:settings[selected].width,...(selected==="highlighter"?{brushVersion:HIGHLIGHTER_BRUSH_VERSION}:{})};},sync};
}
