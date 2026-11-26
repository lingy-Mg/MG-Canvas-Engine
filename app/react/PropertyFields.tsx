import React,{memo,useLayoutEffect,useRef} from "react";
import type {PropertyWidget} from "../property-view.ts";
import {textFamilies} from "../../core/text-style.ts";
import {fontChoices} from "../../platform/text-metrics.ts";
import {mindPalette} from "../../scene/board.ts";

function Disclosure({field}:{field:Extract<PropertyWidget,{kind:"disclosure"}>}){
  const content=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{content.current!.append(...field.parts);},[field]);
  return <details className={field.className}><summary>{field.label}</summary><div ref={content} style={{display:"contents"}}/></details>;
}

/** Uncontrolled field values are synchronized by the current document transaction or the native IME. */
export const PropertyField=memo(function PropertyField({field:f}:{field:PropertyWidget}){
  switch(f.kind){
    case "number":return <label><span>{f.caption}</span><input name={f.name} type="number" step="any" required aria-label={f.caption}
      min={f.min} max={f.max} defaultValue={f.value}/></label>;
    case "radio":return <fieldset className="property-choice"><legend>{f.caption}</legend><div className="choice-strip">
      {f.values.map(([value,title])=><label key={value}><input type="radio" name={f.name} value={value} defaultChecked={value===f.initial}
        onChange={e=>f.change(e.currentTarget)}/><span>{title}</span></label>)}</div></fieldset>;
    case "color":return <div className="appearance-paint"><label><span>{f.caption}</span><input type="text" name={f.name} spellCheck={false}
      autoComplete="off" placeholder={f.placeholder??"#RRGGBB"} title={f.allowTransparent?"输入六位十六进制颜色或 transparent，或使用选色器":"输入六位十六进制颜色，或使用选色器"}
      aria-label={f.caption}/></label><label className="paint-choice" title={"选择"+f.caption}><span className="paint-chip" aria-hidden="true"/>
        <input type="color" name={f.name+"Picker"} aria-label={"选择"+f.caption}/></label></div>;
    case "font":return <details className="font-picker"><summary><span>字体</span><strong>{fontChoices[f.initial].label}</strong>
      <span className="font-sample" style={{fontFamily:fontChoices[f.initial].stack}}>中文 Ag 09</span></summary><div className="font-options">
        {[false,true].map(serif=><fieldset key={String(serif)}><legend>{serif?"衬线":"无衬线"}</legend>
          {textFamilies.filter(f=>fontChoices[f].serif===serif).map(family=><label key={family}>
            <input type="radio" name="textFamily" value={family} defaultChecked={family===f.initial}/><span>{fontChoices[family].label}</span>
            <span aria-hidden="true" style={{fontFamily:fontChoices[family].stack}}>中文 Ag 09</span></label>)}</fieldset>)}</div></details>;
    case "image-options":return <div className="ratio-options"><label className="property-switch"><span>锁定比例</span>
      <input type="checkbox" name="imageAspectLock" aria-label="锁定图片宽高比"/></label>
      <button type="button" className="button">恢复原始比例</button>
      <label className="property-switch"><span>阴影</span><input type="checkbox" name="imageShadow" aria-label="图片阴影"/></label></div>;
    case "switch":return <label className="property-switch"><span>{f.caption}</span><input type="checkbox" name={f.name} aria-label={f.caption}/></label>;
    case "input":{
      const input=<input type={f.type??"text"} name={f.name} aria-label={f.label} placeholder={f.placeholder} className={f.className}
        min={f.min} max={f.max} step={f.type==="range"?1:undefined} inputMode={f.inputMode}/>;
      return f.caption?<label><span>{f.caption}</span>{input}</label>:input;
    }
    case "routes":return <div className="format-group connector-routes" role="group" aria-label="连线走线">
      <button type="button" data-route="curve">曲线</button><button type="button" data-route="orthogonal">折线</button><span className="format-caption">当前为直线</span></div>;
    case "stepper":return <div className="mind-number"><label htmlFor={"field-"+f.name}>{f.caption}</label><div className="mind-stepper">
      <button type="button" aria-label={"减小"+f.caption}>−</button><input id={"field-"+f.name} name={f.name} type="number" required aria-label={f.caption}
        min={f.min} max={f.max} step="1" inputMode="numeric"/><button type="button" aria-label={"增大"+f.caption}>+</button></div></div>;
    case "mind-choice":return <fieldset className="mind-choice"><legend>{f.caption}</legend><div className="mind-choice-grid">
      {Object.entries(f.values).map(([v,title])=><label key={v}><input type="radio" name={f.name} value={v}/><span className="mind-choice-card">
        {f.setting==="theme"?<span className="mind-swatches" aria-hidden="true">{mindPalette(v).branches.map((c,i)=><span key={i} style={{backgroundColor:c}}/>)}</span>:
          <span className={f.setting==="skin"?"mind-skin-icon":"mind-layout-icon"} data-skin={f.setting==="skin"?v:undefined}
            data-layout={f.setting==="layout"?v:undefined} aria-hidden="true">{f.setting==="layout"&&<i/>}</span>}<span>{title}</span></span></label>)}</div></fieldset>;
    case "disclosure":return <Disclosure field={f}/>;
    case "action":return <button type="button" className={f.className??"button"} disabled={f.disabled} title={f.title} aria-label={f.title} onClick={f.run}>{f.label}</button>;
  }
});
