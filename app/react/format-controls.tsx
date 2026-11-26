import React,{useLayoutEffect,useRef} from "react";
import type {ButtonHTMLAttributes,CSSProperties,HTMLAttributes,ReactNode} from "react";
import {textFamilies} from "../../core/text-style.ts";
import type {TextFamily} from "../../core/text-style.ts";
import {isHexPaint} from "../../core/document.ts";
import {defaultStickyFill} from "../../features/card-content.ts";
import type {MarkdownBlock} from "../../features/markdown-format.ts";
import {fontChoices} from "../../platform/text-metrics.ts";
import {quickPaperColors} from "../text-placement.ts";
import type {FormatGesture} from "../text-format-bar.ts";
import type {ToolbarModel} from "../object-editing-view.ts";

type ModelProps={model:ToolbarModel};
const quickSizes={sticky:[16,20,24],text:[16,24,32],markdown:[14,16,20],table:[14,18,24]};
const allSizes=[10,12,14,16,18,20,24,28,32,36,48,64];
const colors=["#243854","#ffffff","#64748b","#be384c","#b7601b","#967316","#14785a","#3567bd","#8054b4"];
const fills=[["无填充","transparent"],["白色","#ffffff"],["浅蓝","#dbeafe"],["薄荷绿","#cceee1"],["浅黄","#ffedb8"],["淡紫","#e6dcff"],["浅红","#ffd8d8"]] as const;
const strokes=[["墨灰","#35445c"],["蓝色","#457ada"],["绿色","#23836c"],["橙色","#b96826"],["红色","#bd4054"],["紫色","#8158ad"]] as const;
const inkPresets=[["自动","auto"],["蓝色","#3567bd"],["红色","#be384c"]] as const;
const faceNames={bold:"粗体",italic:"斜体",underline:"下划线",strike:"删除线"};
const faceText={bold:"B",italic:"I",underline:"U",strike:"S"};
const faces=Object.keys(faceNames) as (keyof typeof faceNames)[];
const blocks:Record<MarkdownBlock,string>={paragraph:"正文",h1:"一级标题",h2:"二级标题",h3:"三级标题",h4:"四级标题",h5:"五级标题",h6:"六级标题",quote:"引用",bullet:"项目符号",number:"编号列表"};
const swatch=(paint:string)=>({"--swatch":paint} as CSSProperties);

function Group({name,label,caption,children,...props}:HTMLAttributes<HTMLDivElement>&{name:string;label:string;caption?:string}){
  return <div className="format-group" data-format-group={name} role="group" aria-label={label} {...props}>
    {caption&&<span className="format-caption" title={props["aria-description"]}>{caption}</span>}{children}
  </div>;
}
function Choice({label,pressed,children,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{label:string;pressed?:boolean}){
  return <button type="button" title={label} aria-label={label} aria-pressed={pressed} {...props}>{children}</button>;
}
function Menu({model,name,label,fields=false,...props}:ModelProps&ButtonHTMLAttributes<HTMLButtonElement>&{name:string;label:string;fields?:boolean}){
  return <Choice label={label} className="format-opener" data-menu={name} aria-controls={fields?"inspector":"format-options"}
    aria-expanded={model.open===name&&model.fieldsOpen===fields} {...props}
    onClick={e=>model.menu(e.currentTarget,name,fields,e.detail===0)}/>;
}
function LiveValue({model,value,label,numeric,write,current}:ModelProps&{value:string;label:string;numeric?:boolean;
  write:(value:string,gesture:FormatGesture)=>boolean;current?:boolean}){
  const ref=useRef<HTMLInputElement>(null),gesture=useRef<FormatGesture>({}),composing=useRef(false),latest=useRef(value);
  latest.current=value;
  useLayoutEffect(()=>{const el=ref.current;if(el&&document.activeElement!==el&&el.value!==value)el.value=value;},[value]);
  const input=(el:HTMLInputElement)=>{
    if(composing.current||model.target?.composing)return;
    const text=el.value.trim();el.setAttribute("aria-invalid",String(Boolean(text)&&!write(text,gesture.current)));
  };
  return <input ref={ref} type={numeric?"number":"text"} title={label} aria-label={label} defaultValue={value} data-current={current}
    min={numeric?6:undefined} max={numeric?160:undefined} step={numeric?"any":undefined} spellCheck={false}
    placeholder={numeric?undefined:"#RRGGBB"} onFocus={()=>{gesture.current={};}}
    onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={e=>{composing.current=false;input(e.currentTarget);}}
    onInput={e=>{if(!(e.nativeEvent as InputEvent).isComposing)input(e.currentTarget);}}
    onBlur={e=>{const el=e.currentTarget;queueMicrotask(()=>{if(el.isConnected&&document.activeElement!==el){el.value=latest.current;el.removeAttribute("aria-invalid");}});}}
    onKeyDown={e=>{if(composing.current||e.nativeEvent.isComposing||model.target?.composing||e.altKey||!(e.ctrlKey||e.metaKey))return;
      const key=e.key.toLowerCase();if((key==="z"||key==="y")&&model.history(key==="y"||e.shiftKey)){
        e.preventDefault();e.stopPropagation();gesture.current={};e.currentTarget.value=latest.current;
      }} }/>;
}
function ExactSize({model,current}:ModelProps&{current?:boolean}){
  return <LiveValue model={model} numeric label="自定义字号" value={String(model.target!.values.fontSize)} current={current}
    write={(value,g)=>{const size=Number(value);if(!Number.isFinite(size)||size<6||size>160)return false;model.apply({fontSize:size},g);return true;}}/>;
}
function Sizes({model}:ModelProps){
  const {layout,values}=model.target!,sizes=layout?quickSizes[layout]:allSizes,size=values.fontSize;
  return <Group name="size" label={layout==="markdown"?"整篇文档字号":"字号"} caption={layout?undefined:"字号"}>
    {!layout&&<ExactSize model={model} current={!sizes.includes(size)}/>}
    {sizes.map(n=><Choice key={n} label={n+" 像素"} pressed={n===size} onClick={()=>model.apply({fontSize:n})}>{n}</Choice>)}
    {layout==="table"?<Menu model={model} name="size" label="更多字号" title={"更多字号（当前 "+size+" 像素）"}>⋯</Menu>:
      layout&&<ExactSize model={model} current={!sizes.includes(size)}/>}
  </Group>;
}
function Faces({model,keys}:ModelProps&{keys:readonly (keyof typeof faceNames)[]}){
  const t=model.target!;
  return <Group name="face" label="字形">{keys.map(key=>{
    const on=key==="bold"?t.values.fontWeight>=600:Boolean(t.values[key]);
    return <Choice key={key} label={faceNames[key]} pressed={on} data-format={key}
      onClick={()=>model.apply(key==="bold"?{fontWeight:on?(!t.layout||t.layout==="text"?500:400):700}:{[key]:!on})}>{faceText[key]}</Choice>;
  })}</Group>;
}
function Align({model}:ModelProps){
  return <Group name="align" label="对齐">{([["left","居左"],["center","居中"],["right","居右"]] as const).map(([value,label])=>
    <Choice key={value} label={label} pressed={model.target!.values.align===value} data-align={value} onClick={()=>model.apply({align:value})}/>)}</Group>;
}
function paint(model:ToolbarModel,ink:boolean,value:string,gesture?:FormatGesture){
  model.apply(ink?(value==="auto"?{colorMode:"auto"}:{colorMode:"custom",color:value}):{background:value},gesture);
}
function PaintOptions({model,ink}:ModelProps&{ink:boolean}){
  const {values,backgroundColors}=model.target!,color=ink?values.color:values.background??"transparent";
  const selected=ink&&values.autoInk?"auto":color.toLowerCase(),mode=ink?"auto":"transparent",label=ink?"自动字色":"透明背景";
  const gesture=useRef<FormatGesture>({});
  return <><Choice label={label} pressed={selected===mode} onClick={()=>paint(model,ink,mode)}>{label}</Choice>
    {(ink?colors:backgroundColors??colors).map(value=><Choice label={value} key={value} className="format-swatch" style={swatch(value)}
      pressed={selected===value} onClick={()=>paint(model,ink,value)}/>)}
    <input type="color" aria-label={ink?"选择自定义字色":"选择自定义背景色"} value={isHexPaint(color)?color:"#ffffff"} readOnly
      onPointerDown={()=>{gesture.current={};}} onInput={e=>{if(!model.target?.composing)paint(model,ink,e.currentTarget.value,gesture.current);}}/>
    <LiveValue model={model} label={ink?"自定义字色":"自定义背景色"} value={color}
      write={(v,g)=>{if(!isHexPaint(v))return false;paint(model,ink,v,g);return true;}}/></>;
}
function QuickPaint({model,ink,children}:ModelProps&{ink:boolean;children?:ReactNode}){
  const {layout,values}=model.target!,sticky=layout==="sticky",doc=layout==="markdown";
  const caption=ink?"字色":sticky?"纸色":"底色",scope=ink?(doc?"整篇字色":"字色"):sticky?"便签纸色":doc?"页面背景":"文字背景";
  const presets=ink?inkPresets:sticky?quickPaperColors:[[doc?"纸白":"透明",doc?"#ffffff":"transparent"],["浅黄",defaultStickyFill]];
  const value=ink?values.color:values.background??"transparent",selected=ink&&values.autoInk?"auto":value.toLowerCase();
  const preset=presets.find(([,v])=>v===selected),description=scope+" · "+(preset?.[0]??(selected==="transparent"?"透明":value));
  return <Group name={ink?"ink":"background"} label={scope} caption={caption} data-quick-paint={ink?"ink":"background"}
    data-current-paint={value} data-custom={String(!preset)} aria-description={description} style={{"--current-paint":value} as CSSProperties}>
    {presets.map(([name,v])=><Choice key={v} className="quick-swatch" style={swatch(v)} label={v==="auto"?"自动字色":scope+" · "+name}
      pressed={selected===v} data-paint-value={v} onClick={()=>paint(model,ink,v)}>{v==="auto"?"A":""}</Choice>)}{children}
  </Group>;
}
function Fonts({model}:ModelProps){
  return <>{[false,true].map(serif=><Group key={String(serif)} name={serif?"serif":"sans"} label={serif?"衬线":"无衬线"} caption={serif?"衬线":"无衬线"}>
    {textFamilies.filter(f=>fontChoices[f].serif===serif).map(f=>{
      const face=fontChoices[f];return <Choice key={f} label={face.label} style={{fontFamily:face.stack}}
        pressed={model.target!.values.fontFamily===f} onClick={()=>model.apply({fontFamily:f})}>{face.label}<small>中文 Ag 09</small></Choice>;})}</Group>)}
    <Group name="weights" label="字重" caption="字重">{([[400,"常规"],[500,"中等"],[600,"半粗"],[700,"粗体"]] as const).map(([w,label])=>
      <Choice key={w} label={label+"字重"} pressed={model.target!.values.fontWeight===w} onClick={()=>model.apply({fontWeight:w})}>{label}</Choice>)}</Group></>;
}
function LinkForm({model}:ModelProps){
  const md=model.target!.markdown;
  return <form onSubmit={e=>{e.preventDefault();const field=e.currentTarget.elements.namedItem("url") as HTMLInputElement,value=field.value.trim();
    if(/^(https?:\/\/|mailto:)[^\s()]+$/i.test(value)){if(md)model.markdown({link:value});else model.apply({link:value});field.value="";}
    else{field.setCustomValidity("请输入网页或邮件地址");field.reportValidity();}}}>
    <input type="url" name="url" required aria-label="链接地址" placeholder="https://" defaultValue={md?.link??""} onInput={e=>e.currentTarget.setCustomValidity("")}/>
    <Choice type="submit" label={md?"应用链接":"插入链接"}>插入</Choice></form>;
}
function MarkdownControls({model}:ModelProps){
  const md=model.target!.markdown!,label=md.block==="mixed"?"混合段落":md.block==="code"?"代码块":blocks[md.block];
  return <><Group name="block" label="段落"><Menu model={model} name="block" label="段落样式" disabled={!md.canBlock}>{label}</Menu>
    {(["h1","h2"] as const).map(k=><Choice key={k} label={"当前段落设为"+blocks[k]} disabled={!md.canBlock} pressed={md.block===k}
      onClick={()=>model.markdown({block:md.block===k?"paragraph":k})}>{k.toUpperCase()}</Choice>)}</Group>
    <Group name="inline" label="所选文字">{(["bold","italic","strike"] as const).map(mark=><Choice key={mark} label={"所选文字"+faceNames[mark]}
      data-format={mark} disabled={!md.canMark} pressed={md[mark]} onClick={()=>model.markdown({mark})}>{faceText[mark]}</Choice>)}</Group>
    <Group name="list" label="段落列表">{(["bullet","number"] as const).map(k=><Choice key={k} label={blocks[k]} data-list={k} pressed={md.block===k}
      disabled={!md.canBlock} onClick={()=>model.markdown({block:md.block===k?"paragraph":k})}>{k==="bullet"?"•":"1."}</Choice>)}</Group>
    <Group name="link" label="链接"><Menu model={model} name="link" label="插入或编辑链接" disabled={!md.canLink}>链接</Menu></Group>
    <Sizes model={model}/><QuickPaint model={model} ink/><QuickPaint model={model} ink={false}/>
    <Group name="paper" label="整篇外观"><Menu model={model} name="paper" label="整篇文档外观">外观</Menu></Group></>;
}
function ShapeChoices({model,stroke=false}:ModelProps&{stroke?:boolean}){
  const key=stroke?"stroke":"fill";
  return <>{(stroke?strokes:fills).map(([name,color])=><Choice key={color} label={stroke?"边框"+name:name} pressed={model.shape![key].toLowerCase()===color}
    data-shape-fill={stroke?undefined:color} data-shape-stroke={stroke?color:undefined} className="format-swatch" style={swatch(color)}
    onClick={()=>model.paintShape(key,color)}>{color==="transparent"?name:""}</Choice>)}</>;
}
export function FormatControls({model}:ModelProps){
  if(model.shape)return <><Group name="fill" label="填充" caption="填充"><ShapeChoices model={model}/></Group>
    <Group name="stroke" label="边框"><Menu model={model} name="stroke" label="边框颜色" style={swatch(model.shape.stroke)}>边框</Menu></Group></>;
  const t=model.target;if(!t)return null;
  const {layout,capabilities:caps}=t;
  if(layout==="markdown")return <MarkdownControls model={model}/>;
  if(!layout)return <>{caps.includes("size")&&<Sizes model={model}/>}<Faces model={model} keys={faces.filter(f=>caps.includes(f))}/>
    {caps.includes("align")&&<Align model={model}/>}
    {(["background","ink"] as const).filter(k=>caps.includes(k)).map(k=><Group name={k} label={k==="ink"?"字色":"背景"} key={k} caption={k==="ink"?"字色":"背景"}><PaintOptions model={model} ink={k==="ink"}/></Group>)}
    {caps.includes("family")&&<Group name="family" label="字体" caption="字体"><Fonts model={model}/></Group>}
    {caps.includes("list")&&<Group name="list" label="列表" caption="列表">{([["bullet","项目符号"],["number","编号列表"],["plain","普通段落"]] as const).map(([list,label])=>
      <Choice key={list} label={label} onClick={()=>model.apply({list})}>{label}</Choice>)}</Group>}{caps.includes("link")&&<Group name="link" label="链接"><LinkForm model={model}/></Group>}</>;
  const font=fontChoices[t.values.fontFamily],sticky=layout==="sticky",table=layout==="table";
  return <>{sticky?<QuickPaint model={model} ink={false}><Menu model={model} name="background" label="更多纸色">⋯</Menu></QuickPaint>:
    <Group name="family" label="字体"><Menu model={model} name="family" label="选择字体" style={{fontFamily:font.stack}}>{font.label}</Menu></Group>}
    <Sizes model={model}/><Faces model={model} keys={sticky?["bold"]:table?faces:["bold","italic"]}/>
    {!sticky&&<QuickPaint model={model} ink>{table&&<Menu model={model} name="ink" label="更多字色">⋯</Menu>}</QuickPaint>}
    {!sticky&&!table&&<QuickPaint model={model} ink={false}><Menu model={model} name="colors" label="更多颜色">⋯</Menu></QuickPaint>}
    <Align model={model}/></>;
}
export function FormatOptions({model}:ModelProps){
  switch(model.open){
    case "size":return <ExactSize model={model}/>;
    case "family":return <Fonts model={model}/>;
    case "ink":case "background":return <PaintOptions model={model} ink={model.open==="ink"}/>;
    case "stroke":return <><ShapeChoices model={model} stroke/><LiveValue model={model} label="自定义边框色" value={model.shape!.stroke}
      write={(color,g)=>{if(!isHexPaint(color))return false;model.paintShape("stroke",color,g);return true;}}/></>;
    case "block":return <>{Object.entries(blocks).map(([key,label])=><Choice key={key} label={label} pressed={model.target!.markdown!.block===key}
      onClick={()=>model.markdown({block:key as MarkdownBlock})}>{label}</Choice>)}</>;
    case "link":return <LinkForm model={model}/>;
    case "paper":case "colors":{
      const doc=model.open==="paper";return <>{doc&&<><Faces model={model} keys={faces}/><Align model={model}/>
        <Group name="family" label="字体" caption="字体"><select aria-label="整篇字体" value={model.target!.values.fontFamily}
          onChange={e=>model.apply({fontFamily:e.target.value as TextFamily})}>{textFamilies.map(f=><option key={f} value={f} style={{fontFamily:fontChoices[f].stack}}>{fontChoices[f].label}</option>)}</select></Group></>}
        {[true,false].map(ink=>{const label=ink?(doc?"整篇字色":"文字颜色"):doc?"页面背景":"文字背景";return <Group key={label} name={ink?"ink":"background"} label={label} caption={label}><PaintOptions model={model} ink={ink}/></Group>;})}</>;
    }
    default:return null;
  }
}
// Object property forms own these groups of portalled React controls.
function NativeAction({action}:{action:HTMLElement}){
  const host=useRef<HTMLSpanElement>(null);
  useLayoutEffect(()=>{host.current!.append(action);return ()=>{action.remove();};},[action]);
  return <span ref={host} style={{display:"contents"}}/>;
}
export function PropertySections({model}:ModelProps){
  return <>{model.actions.filter(a=>a.id!=="downstream-control").map((a,index)=><NativeAction key={index} action={a}/>)}
    {model.sections.map(s=><Menu key={s.key} model={model} name={s.key} label={s.label} fields hidden={s.parts.every(p=>p.hidden)}>{s.label}</Menu>)}</>;
}
