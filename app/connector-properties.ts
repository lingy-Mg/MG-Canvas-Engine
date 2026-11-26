import {propertyWidget} from "./property-view.ts";
import {DEFAULT_CONNECTOR_STROKE,MAX_CONNECTOR_STROKE} from "../core/document.ts";
import type {BoardDocument,Connector} from "../core/document.ts";
import {planConnectorStyle} from "../features/flow.ts";
import type {ConnectorStyle} from "../features/flow.ts";
import {MAX_LABEL_LENGTH} from "../features/plain-text.ts";
import type {EditorSession} from "../session/editor.ts";
import {limitTextInput} from "./text-editor.ts";
import {liveColor} from "./property-color.ts";
import {propertyChoice,propertySection} from "./property-choices.ts";
import {liveProperties} from "./property-draft.ts";

export function connectorProperties(editor:EditorSession,item:Connector,enabled:()=>boolean){
  const form=document.createElement("form");form.className="transform";
  const live=liveProperties(editor,form,enabled),line=(d:BoardDocument)=>d.objects[item.id] as Connector;
  const update=(d:BoardDocument,patch:Partial<ConnectorStyle>)=>{
    const s=line(d);return planConnectorStyle(d,s,{arrow:s.arrow,routing:s.routing,label:s.label,...patch});
  };
  const routes=document.createElement("div");routes.style.display="contents";
  const choices=propertyWidget(routes,{kind:"routes"},form);
  for(const button of choices.querySelectorAll<HTMLButtonElement>("[data-route]")){
    const routing=button.dataset.route as "curve"|"orthogonal";
    button.addEventListener("click",()=>live.write(button,"修改连线走线",d=>update(d,{routing}),false));
    live.watch(()=>button.setAttribute("aria-pressed",String(line(editor.doc).routing===routing)));
  }
  const straight=choices.querySelector<HTMLElement>(".format-caption")!;
  live.watch(()=>{straight.hidden=line(editor.doc).routing!=="straight";});
  const label=propertyWidget(propertySection(form,"连线标签"),{kind:"input",name:"connectorLabel",label:"连线标签",
    placeholder:"连线标签",className:"flat-input"}) as HTMLInputElement;
  limitTextInput(label,Math.max(item.label.length,MAX_LABEL_LENGTH));
  live.input(label,"修改连线标签",d=>line(d).label,d=>update(d,{label:label.value}));
  const grid=propertySection(form,"连线样式");
  const route=propertyChoice(grid,"connectorRoute","走线",[["straight","直线"],["orthogonal","折线"],["curve","曲线"]],item.routing,
    input=>live.write(input,"修改连线走线",d=>update(d,{routing:route.value}),false));
  const arrow=propertyChoice(grid,"connectorArrow","箭头",[["none","无"],["start","起点"],["end","终点"],["both","两端"]],item.arrow,
    input=>live.write(input,"修改连线箭头",d=>update(d,{arrow:arrow.value}),false));
  live.watch(()=>{route.value=line(editor.doc).routing;arrow.value=line(editor.doc).arrow;});
  liveColor(live,()=>editor.doc,grid,"connectorStroke","描边颜色",d=>line(d).stroke,(d,stroke)=>update(d,{stroke}));
  live.number(grid,"connectorWidth","描边粗细",d=>line(d).strokeWidth??DEFAULT_CONNECTOR_STROKE,(d,strokeWidth)=>update(d,{strokeWidth}),.25,MAX_CONNECTOR_STROKE);
  return {...live,routes};
}
