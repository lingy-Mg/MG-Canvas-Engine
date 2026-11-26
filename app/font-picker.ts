import {propertyWidget} from "./property-view.ts";
import type {TextFamily} from "../core/text-style.ts";
import {fontChoices} from "../platform/text-metrics.ts";

export function fontPicker(parent:HTMLElement,initial:TextFamily,onChange:(input:HTMLInputElement)=>void){
  const details=propertyWidget(parent,{kind:"font",initial}) as HTMLDetailsElement;
  const summary=details.querySelector("summary")!,name=summary.querySelector("strong")!,sample=summary.querySelector<HTMLElement>(".font-sample")!;
  const inputs=Array.from(details.querySelectorAll("input"));
  for(const input of inputs){
    input.addEventListener("change",()=>{set(input.value as TextFamily);onChange(input);});
    input.addEventListener("click",event=>{if(event.detail){details.open=false;summary.focus({preventScroll:true});}});
    input.addEventListener("keydown",event=>{
      if(event.key==="Enter"&&!event.isComposing){event.preventDefault();event.stopPropagation();details.open=false;summary.focus();}
    });
  }
  let selected=initial;
  function set(family:TextFamily){
    selected=family;const option=fontChoices[family];
    name.textContent=option.label;summary.setAttribute("aria-label","字体，"+option.label);
    sample.style.fontFamily=option.stack;
    for(const input of inputs)input.checked=input.value===family;
  }
  set(initial);
  return {get value(){return selected;},reset(){set(initial);details.open=false;}};
}
