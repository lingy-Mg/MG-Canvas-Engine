import React,{useLayoutEffect,useRef,useState,useSyncExternalStore} from "react";
import {createPortal,flushSync} from "react-dom";
import {cardPlaceholders} from "../../features/card-content.ts";
import {bindObjectEditingView} from "../object-editing-view.ts";
import type {CardFieldSpec,ObjectEditingView,TableAction,TableMenuChoice,TextFieldSpec,ToolbarModel} from "../object-editing-view.ts";
import {FormatControls,FormatOptions,PropertySections} from "./format-controls.tsx";
import {PropertyField} from "./PropertyFields.tsx";
import type {PropertyWidget} from "../property-view.ts";

function channel<T>(initial:T){
  let value=initial;
  const listeners=new Set<()=>void>();
  return {read:()=>value,subscribe(fn:()=>void){listeners.add(fn);return ()=>{listeners.delete(fn);};},
    set(next:T,immediate=true){
      if(value===next)return;
      value=next;
      if(!listeners.size)return;
      const publish=()=>{for(const notify of listeners)notify();};
      // The editor must be able to focus, measure or read the new control in this very event.
      if(immediate)flushSync(publish);else publish();
    }};
}
type EditingField=({kind:"plain";spec:TextFieldSpec}|{kind:"card";spec:CardFieldSpec;source:boolean})&{session:number};
type PropertyEntry={id:number;form:HTMLElement;parent:HTMLElement;field:PropertyWidget};
function createChannels(){
  return {toolbar:channel<ToolbarModel|undefined>(undefined),menu:channel<readonly TableMenuChoice[]>([]),
    properties:channel<readonly PropertyEntry[]>([]),field:channel<EditingField|undefined>(undefined),
    tableAction:undefined as ((action:TableAction)=>void)|undefined};
}
type Channels=ReturnType<typeof createChannels>;
function useChannel<T>(c:ReturnType<typeof channel<T>>){return useSyncExternalStore(c.subscribe,c.read,c.read);}

function FormattingBar({views}:{views:Channels}){
  const model=useChannel(views.toolbar);
  const downstream=model?.actions.some(a=>a.id==="downstream-control")??false;
  return <div id="text-format-bar" className="format-bar" hidden>
    <button type="button" className="format-scroll" title="向左滚动格式栏" aria-label="向左滚动格式栏" hidden>‹</button>
    <div className="format-strip" role="toolbar">
      {model&&<FormatControls key={model.target?.id??model.shape?.id??"object"} model={model}/>}
      <div className="format-extras">
        <button id="downstream-control" type="button" hidden={!downstream} disabled={!downstream}
          data-action={downstream?"arrange-downstream":undefined} title="预览并排列此节点沿出线连接的后续步骤" aria-describedby="flow-help">排列后续节点</button>
        {model&&<PropertySections model={model}/>}
      </div>
    </div>
    <button type="button" className="format-scroll" title="向右滚动格式栏" aria-label="向右滚动格式栏" hidden>›</button>
    <button type="button" className="format-sheet-close" aria-label="收起属性">关闭</button>
    <div className="local-options" id="format-options" role="group" hidden>
      {model?.open&&!model.fieldsOpen&&<FormatOptions key={model.open} model={model}/>}
    </div>
    <div id="inspector" className="local-options object-properties" role="group" hidden/>
  </div>;
}
const handles:readonly [TableAction,string,string][]=[
  ["addRow","在表格底部添加行","+"],["addCol","在表格右侧添加列","+"],["row","行操作",""],["col","列操作",""],["whole","选择整张表格",""],
];
function TableControls({views}:{views:Channels}){
  const menu=useChannel(views.menu);
  return <div className="table-controls" role="group" hidden>
    <div className="table-selection" aria-hidden="true"/>
    {handles.map(([action,label,caption])=><button type="button" key={action} className={"table-control table-"+action} data-table-action={action}
      title={label} aria-label={label} aria-expanded={action==="col"||action==="row"?false:undefined}
      onClick={()=>views.tableAction?.(action)}>{caption}</button>)}
    <div className="table-axis-menu" role="group" hidden>{menu.map(choice=><button type="button" key={choice.label}
      title={choice.label} aria-label={choice.label} disabled={choice.disabled} onClick={choice.run}>{choice.label}</button>)}</div>
  </div>;
}
const fieldLabels={text:"独立文字内容",cell:"表格单元格内容",topic:"脑图主题内容",label:"流程节点名称"};
const fieldHints={text:"输入文字…",cell:"",topic:"输入主题…",label:"输入节点名称…"};
function InlineTextEditor({spec}:{spec:TextFieldSpec}){
  const {mode}=spec;
  return <div className={mode==="text"?"text-overlay":mode==="cell"?"table-cell-editor":"node-editor"} data-inline-editor=""
    data-auto-width={spec.autoWidth?"true":undefined}>
    <textarea className="inline-text" aria-label={fieldLabels[mode]} placeholder={fieldHints[mode]} wrap={spec.autoWidth?"off":"soft"}
      enterKeyHint={mode==="text"?undefined:"done"} defaultValue={spec.text}/>
    {mode==="text"&&<div className="inline-actions">
      <button type="button" className="button" onClick={()=>spec.finish(false)}>取消</button>
      <button type="button" className="button primary" onClick={()=>spec.finish(true)}>完成</button>
    </div>}
  </div>;
}
function CardInput({spec,source}:{spec:CardFieldSpec;source:boolean}){
  const sticky=spec.kind==="sticky",formatted=!sticky&&!source;
  return <div className="card-editor" data-kind={spec.kind}>
    <div className="card-sheet">
      <textarea className="card-input" aria-label={sticky?"便签内容":"Markdown 源文"} placeholder={cardPlaceholders[spec.kind]}
        spellCheck={false} hidden={formatted}/>
      <div className="markdown-field" contentEditable suppressContentEditableWarning spellCheck={false} role="textbox" aria-label="Markdown 文档内容"
        aria-multiline="true" aria-placeholder={cardPlaceholders.markdown} hidden={!formatted}/>
    </div>
    <button type="button" className="card-source-switch" hidden={sticky} aria-pressed={source} onPointerDown={e=>e.preventDefault()}
      onClick={spec.changeMode}>{source?"排版视图":"Markdown 源文"}</button>
  </div>;
}
function InlineEditors({views}:{views:Channels}){
  const field=useChannel(views.field);
  if(!field)return null;
  return field.kind==="plain"?<InlineTextEditor key={field.session} spec={field.spec}/>:<CardInput key={field.session} spec={field.spec} source={field.source}/>;
}
function PropertyFields({views}:{views:Channels}){
  return useChannel(views.properties).map(entry=>createPortal(<PropertyField field={entry.field}/>,entry.parent,String(entry.id)));
}

/** Mount inside CanvasViewport before binding its runtime. Native editing surfaces are uncontrolled. */
export function ObjectEditingLayer(){
  const ref=useRef<HTMLDivElement>(null),[views]=useState(createChannels);
  useLayoutEffect(()=>{
    const layer=ref.current!,lifetime=new AbortController();
    let session=0,propertyId=0;
    const close=(id:number)=>{if(views.field.read()?.session===id)views.field.set(undefined);};
    const port:ObjectEditingView={layer,signal:lifetime.signal,toolbar:views.toolbar.set,tableMenu:views.menu.set,
      properties:{
        widget(form,parent,field){
          views.properties.set([...views.properties.read(),{id:++propertyId,form,parent,field}]);
          return parent.lastElementChild as HTMLElement;
        },
        release(form){
          if(lifetime.signal.aborted)return;
          const fields=views.properties.read(),keep=fields.filter(e=>e.form!==form);
          if(keep.length!==fields.length)views.properties.set(keep,false);
        }
      },
      tableActions(action){views.tableAction=action;},
      text(spec){
        const id=++session;views.field.set({kind:"plain",spec,session:id});
        const frame=layer.querySelector<HTMLElement>("[data-inline-editor]")!;
        return {frame,input:frame.querySelector("textarea")!,actions:frame.querySelector<HTMLElement>(".inline-actions"),close:()=>close(id)};
      },
      card(spec){
        const id=++session;views.field.set({kind:"card",spec,source:false,session:id});
        const frame=layer.querySelector<HTMLElement>(".card-editor")!;
        return {frame,sheet:frame.querySelector<HTMLElement>(".card-sheet")!,plain:frame.querySelector("textarea")!,
          rich:frame.querySelector<HTMLDivElement>(".markdown-field")!,
          mode(source){const f=views.field.read();if(f?.session===id&&f.kind==="card"&&f.source!==source)views.field.set({...f,source});},close:()=>close(id)};
      }};
    const unbind=bindObjectEditingView(port);
    return ()=>{lifetime.abort();unbind();views.tableAction=undefined;};
  },[views]);
  return <div ref={ref} data-object-editing-layer="" style={{display:"contents"}}>
    <FormattingBar views={views}/><TableControls views={views}/><InlineEditors views={views}/><PropertyFields views={views}/>
  </div>;
}
