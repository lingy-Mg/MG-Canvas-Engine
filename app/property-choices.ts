import {propertyWidget} from "./property-view.ts";
export function propertySection(parent:HTMLElement,title:string){
  const section=document.createElement("section"),heading=document.createElement("h3"),grid=document.createElement("div");
  section.className="property-section";heading.textContent=title;grid.className="transform-fields";
  section.append(heading,grid);parent.append(section);return grid;
}

/** Native radios provide one Tab stop and arrow-key navigation per setting. */
export function propertyChoice<T extends string>(parent:HTMLElement,name:string,caption:string,options:readonly (readonly [T,string])[],initial:T,onChange:(input:HTMLInputElement)=>void){
  const field=propertyWidget(parent,{kind:"radio",name,caption,values:options,initial,change:onChange});
  const inputs=Array.from(field.querySelectorAll("input"));
  return {field,get value(){return (inputs.find(i=>i.checked)?.value??initial) as T;},
    set value(value:T){for(const input of inputs)input.checked=input.value===value;}};
}
