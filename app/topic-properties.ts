import {propertyWidget} from "./property-view.ts";
import {MAX_TOPIC_STROKE,MAX_TOPIC_WIDTH,MIN_TOPIC_WIDTH} from "../core/document.ts";
import type {BoardDocument,MindMap,TopicAppearance} from "../core/document.ts";
import {foldTopic,MIND_THEMES,parentIndex,reorderTopic,withMindStyle,withTopicAppearance} from "../features/mindmap.ts";
import type {TopicRef} from "../features/mindmap.ts";
import {DEFAULT_TOPIC_GAP} from "../features/mindmap-layout.ts";
import type {LocalTopic} from "../features/mindmap-layout.ts";
import type {WorkspaceTheme} from "../platform/theme.ts";
import {topicPaint} from "../scene/board.ts";
import {planMapOrigin} from "../session/transform.ts";
import type {EditorSession} from "../session/editor.ts";
import {draftNumber,integerFields,liveProperties,numericInput} from "./property-draft.ts";
import type {LiveProperties} from "./property-draft.ts";
import {liveColor} from "./property-color.ts";
import type {ObjectSection} from "./text-format-bar.ts";

function mapStyleControls(editor:EditorSession,map:MindMap,live:LiveProperties,section:(key:string,title:string)=>HTMLElement){
  const layout=section("layout","整图布局"),theme=section("theme","主题与配色");
  const grid=document.createElement("div");grid.className="mind-numbers";layout.append(grid);
  const get=(d:BoardDocument)=>d.objects[map.id] as MindMap;
  function number(key:"spacing"|"scale",name:string,title:string,min:number,max:number,increment:number){
    const row=propertyWidget(grid,{kind:"stepper",name,caption:title,min,max});
    const input=row.querySelector("input")!;
    const read=(d:BoardDocument)=>key==="spacing"?get(d).spacing??DEFAULT_TOPIC_GAP:Math.round((get(d).scale??1)*100);
    function plan(d:BoardDocument,v:number|undefined){
      if(v===undefined||!Number.isInteger(v)||v<min||v>max)return;
      const m=get(d);return v===read(d)?m:withMindStyle(m,m.layout,m.theme,{[key]:key==="spacing"?v:v/100});
    }
    live.input(input,"修改"+title,read,d=>plan(d,numericInput(input)));
    const buttons=row.querySelectorAll("button");
    for(const [i,sign] of [-1,1].entries()){
      const b=buttons[i];
      live.watch(()=>{const v=read(editor.doc);b.disabled=sign<0?v<=min:v>=max;});
      b.addEventListener("click",()=>live.write(b,"修改"+title,d=>plan(d,Math.max(min,Math.min(max,read(d)+sign*increment))),false));
    }
    if(key==="scale"){
      const slider=propertyWidget(grid,{kind:"input",type:"range",name:"mindScaleSlider",className:"mind-scale-slider",min,max,label:"整图大小滑块"}) as HTMLInputElement;
      live.input(slider,"修改整图大小",read,d=>plan(d,numericInput(slider)));
    }
  }
  number("spacing","mindSpacing","节点间距",4,80,1);number("scale","mindScale","整图大小（%）",50,200,5);
  function choice(key:"layout"|"skin"|"theme",name:string,caption:string,options:Record<string,string>){
    const group=propertyWidget(key==="layout"?layout:theme,{kind:"mind-choice",setting:key,name,caption,values:options});
    for(const input of group.querySelectorAll("input")){
      const value=input.value;
      live.watch(()=>{const m=get(editor.doc);input.checked=value===(key==="layout"?m.layout:key==="skin"?m.skin??"rounded":MIND_THEMES.find(t=>t===m.theme)??"indigo");});
      input.addEventListener("change",()=>{if(input.checked)live.write(input,"修改"+caption,d=>{
        const m=get(d);return withMindStyle(m,key==="layout"?value as MindMap["layout"]:m.layout,key==="theme"?value:m.theme,key==="skin"?{skin:value as MindMap["skin"]}:undefined);
      },false);});
    }
  }
  choice("layout","mindLayout","排列方式",{left:"向左",balanced:"双向",right:"向右"});
  choice("skin","mindSkin","主题皮肤",{rounded:"圆角",square:"方角",capsule:"胶囊"});
  choice("theme","mindPalette","分支色板",{spectrum:"缤纷",indigo:"靛蓝",mint:"薄荷",warm:"暖橙"});
  const origin=document.createElement("fieldset"),legend=document.createElement("legend"),position=document.createElement("div");
  origin.className="mind-choice";legend.textContent="整图原点";position.className="transform-fields";
  for(const key of ["x","y"] as const)live.number(position,key,key.toUpperCase(),d=>get(d).origin[key],(d,n)=>{
    const m=get(d),at={...m.origin,[key]:n};return planMapOrigin(m,at.x,at.y);
  },undefined,undefined,true);
  origin.append(legend,position);layout.append(origin);
}

type TopicActions=Readonly<{focus:(ref:TopicRef)=>void;rename:(ref:TopicRef)=>void;remove:(ref:TopicRef)=>void}>;

export function mindProperties(editor:EditorSession,map:MindMap,ref:TopicRef|undefined,row:LocalTopic|undefined,workspace:WorkspaceTheme,enabled:()=>boolean,actions:TopicActions){
  const form=document.createElement("form");form.className="transform mind-style";
  const live=liveProperties(editor,form,enabled);
  const sections:ObjectSection[]=[];
  function section(key:string,title:string){
    const part=document.createElement("section"),body=document.createElement("div");
    part.className="property-section";part.dataset.topicGroup=key;part.setAttribute("aria-label",title);
    body.className="topic-section-body";part.append(body);form.append(part);
    sections.push({key,label:title,parts:[part]});return body;
  }
  const root=!ref||ref.topicId===map.rootId;
  if(root)mapStyleControls(editor,map,live,section);
  if(ref){
    const appearance=section("appearance",root?"根节点外观":"节点外观");
    topicAppearanceControls(editor,map,ref,row,()=>workspace,live,appearance);
  }
  const structure=section("structure",root?"脑图操作":"分支操作");
  const target=ref??{mapId:map.id,topicId:map.rootId},topic=map.topics[target.topicId];
  if(root){
    const count=document.createElement("span");count.className="topic-count";
    count.textContent=Object.keys(map.topics).length+" 个主题";structure.append(count);
  }
  function command(label:string,fn:()=>void,disabled=false){
    return propertyWidget(structure,{kind:"action",label,disabled,run:()=>{if(live.current())fn();}});
  }
  if(!ref)command("编辑脑图",()=>actions.focus(target));
  else command("编辑节点文字",()=>actions.rename(target));
  const name=root?"脑图":"分支";
  const fold=command((topic.collapsed?"展开":"折叠")+name,()=>foldTopic(editor,target),!topic.childIds.length);
  if(root)fold.id="fold";
  if(!root){
    const parent=map.topics[parentIndex(map).get(topic.id)??""],index=parent?.childIds.indexOf(topic.id)??-1;
    command("上移",()=>reorderTopic(editor,target,-1),index<=0);
    command("下移",()=>reorderTopic(editor,target,1),!parent||index<0||index>=parent.childIds.length-1);
    command("删除此分支",()=>actions.remove(target));
  }
  return {...live,sections,syncTheme(theme:WorkspaceTheme){workspace=theme;live.sync();}};
}

function topicAppearanceControls(editor:EditorSession,map:MindMap,ref:TopicRef,row:LocalTopic|undefined,theme:()=>WorkspaceTheme,live:LiveProperties,section:HTMLElement){
  const get=(d:BoardDocument)=>d.objects[map.id] as MindMap,topic=(d:BoardDocument)=>get(d).topics[ref.topicId];
  const grid=document.createElement("div");grid.className="transform-fields";section.append(grid);
  const effective=(d:BoardDocument)=>topicPaint(get(d),topic(d),row??"right",theme());
  const appearance=(d:BoardDocument,key:keyof TopicAppearance,v:string|number|undefined)=>{
    const style={...topic(d).appearance,[key]:v};if(v===undefined)delete style[key];
    return withTopicAppearance(get(d),ref.topicId,style);
  };
  function fieldRow(key:keyof TopicAppearance,title:string,caption:string){
    const row=document.createElement("div"),control=document.createElement("div");
    row.className="topic-field-row";control.className="topic-field-control";
    row.append(control);grid.append(row);
    const reset=propertyWidget(row,{kind:"action",className:"topic-field-reset",label:caption,title,
      run:()=>live.write(reset,title,d=>appearance(d,key,undefined),false)}) as HTMLButtonElement;
    live.watch(()=>{reset.disabled=topic(editor.doc).appearance?.[key]===undefined;});
    return control;
  }
  const underline=effective(editor.doc).underline;
  for(const [key,name,title] of [["fill","topicFill","填充"],["textColor","topicInk","文字"],["stroke","topicStroke",underline?"下划线颜色":"描边颜色"]] as const){
    if(key==="fill"&&underline)continue;
    const field=fieldRow(key,key==="textColor"?"恢复自动字色":"恢复继承的"+title,key==="textColor"?"自动":"继承");
    liveColor(live,()=>editor.doc,field,name,title,d=>topic(d).appearance?.[key],(d,v)=>appearance(d,key,v||undefined),
      {placeholder:key==="textColor"?"自动":"继承"},d=>effective(d)[key]);
  }
  for(const [key,name,title,min,max] of [["width","topicWidth","节点宽度",MIN_TOPIC_WIDTH,MAX_TOPIC_WIDTH],["strokeWidth","topicStrokeWidth",underline?"下划线粗细":"描边粗细",0,MAX_TOPIC_STROKE]] as const){
    const control=fieldRow(key,key==="width"?"恢复自动宽度":"恢复继承的"+title,key==="width"?"自动":"继承");
    const field=draftNumber(control,name,title,topic(editor.doc).appearance?.[key],min,max);
    if(key==="width")integerFields(field);
    field.required=false;field.placeholder="自动";
    live.input(field,"修改"+title,d=>topic(d).appearance?.[key],d=>{
      const n=numericInput(field);if(n===undefined||!Number.isFinite(n)||n<min||n>max)return;
      return appearance(d,key,n);
    },d=>appearance(d,key,undefined));
  }
  const inherit=propertyWidget(section,{kind:"action",className:"button topic-inherit",label:"继承脑图样式",
    run:()=>live.write(inherit,"继承脑图样式",d=>withTopicAppearance(get(d),ref.topicId),false)}) as HTMLButtonElement;
  live.watch(()=>{inherit.disabled=!topic(editor.doc).appearance;});
}
