import {Children,cloneElement,createContext,createElement,isValidElement,useContext,useSyncExternalStore} from "react";
import type {ElementType,ReactElement,ReactNode,SyntheticEvent,HTMLAttributes} from "react";
import {appleShortcuts,dockShortcut} from "../dock-shortcuts.ts";
import type {WorkspaceUI,ViewState} from "./workspace-ui.ts";

export const WorkspaceContext=createContext<WorkspaceUI|null>(null);
export function useWorkspace(){
  const ui=useContext(WorkspaceContext);
  if(!ui)throw new Error("Workspace provider missing");
  return ui;
}
export function useView<T>(view:ViewState<T>){return useSyncExternalStore(view.subscribe,view.read,view.read);}
const apple=typeof navigator!=="undefined"&&appleShortcuts(navigator);
type Props=HTMLAttributes<HTMLElement>&{as?:ElementType;id:string;children?:ReactNode;[name:string]:unknown};
/** Session commands run from React events. Each control subscribes only to its own presentation. */
export function Control({as:Tag="div",id,children,className,...initial}:Props){
  const ui=useWorkspace(),{caption,selected,shortcut,...state}=useView(ui.control(id));
  const dispatch=(event:string)=>(e:SyntheticEvent)=>ui.dispatch(id,event,e.nativeEvent);
  const props:Record<string,unknown>={...initial,...state,id,className,
    onClick:dispatch("click"),onKeyDown:dispatch("keydown"),onInput:dispatch("input"),
    onChange:dispatch("change"),onCompositionStart:dispatch("compositionstart"),onCompositionEnd:dispatch("compositionend"),
    onContextMenu:dispatch("contextmenu"),onPointerLeave:dispatch("pointerleave"),onBlur:dispatch("focusout")};
  if(selected!==undefined){
    props.className=[className?.split(" ").filter(c=>c!=="selected").join(" "),selected?"selected":""].filter(Boolean).join(" ");
    props["aria-pressed"]=selected;
  }
  if(state.value!==undefined)delete props.defaultValue;
  if(state.checked!==undefined)delete props.defaultChecked;
  if(Tag==="input"||Tag==="use"||Tag==="circle"||Tag==="path")return createElement(Tag,props);
  let content=children;
  const isTool=Tag==="button"&&className?.split(" ").includes("tool");
  if(caption!==undefined){
    content=isTool?Children.map(children,child=>isValidElement<{children?:ReactNode}>(child)&&child.type==="span"?cloneElement(child,{},caption):child):caption;
  }
  const binding=isTool&&shortcut!==false?dockShortcut(id,apple):undefined;
  if(binding){
    const span=Children.toArray(children).find(child=>isValidElement(child)&&child.type==="span") as ReactElement<{children?:ReactNode}>|undefined;
    if(state.title===undefined){
      const label=initial.title??caption??span?.props.children;
      if(typeof label==="string")props.title=binding.title(label);
    }
    props["aria-keyshortcuts"]=binding.keys;
    content=<>{content}<kbd className="dock-key" aria-hidden="true">{binding.keycap}</kbd></>;
  }
  return createElement(Tag,props,content);
}
