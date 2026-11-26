// A key may serve different actions in different editing modes. The dispatcher
// decides the scope. The dock reads the very same binding for its legend.
export function dockTool(key:string){return toolByKey.get(key);}
export const dockEscapeKey="Escape";
const tools={
  "tool-select":"V","tool-hand":"H","tool-connect":"C","tool-mind":"M","tool-text":"T","tool-ink":"P",
  "shape-process":"R","shape-line":"L",
} as const;
const contextual={
  "mind-child":["Tab"],"mind-sibling":["Enter"],"mind-edit":["F2"],"mind-done":[dockEscapeKey],
  "path-insert":["I","Insert"],"path-finish":["Enter"],"path-cancel":[dockEscapeKey],
} as const;
// The first applicable binding is the visible keycap. Keep aliases in the
// accessible shortcut list and tooltip.
const history={undo:["Mod+Z"],redo:["Control+Y","Mod+Shift+Z"]} as const;
type Tool=keyof typeof tools;
type ContextKey=keyof typeof contextual;
type HistoryAction=keyof typeof history;
type Binding=Tool|ContextKey|HistoryAction;
const toolByKey=new Map(Object.entries(tools).map(([id,key])=>[key.toLowerCase(),id as Tool]));
export const dockContextKey=(id:ContextKey,key:string)=>contextual[id].some(k=>k.toLowerCase()===key);

export function dockHistory(event:Pick<KeyboardEvent,"ctrlKey"|"metaKey"|"shiftKey"|"altKey"|"key">):HistoryAction|undefined{
  if(event.altKey||!(event.ctrlKey||event.metaKey))return;
  const tail=(event.shiftKey?"Shift+":"")+event.key.toUpperCase();
  for(const id of ["undo","redo"] as const){
    if(history[id].some(chord=>chord==="Mod+"+tail||event.ctrlKey&&!event.metaKey&&chord==="Control+"+tail))return id;
  }
}
export function appleShortcuts(nav:Navigator):boolean{
  return /Mac|iPhone|iPad|iPod/i.test((nav as Navigator&{userAgentData?:{platform?:string}}).userAgentData?.platform||nav.platform||nav.userAgent);
}
function keyNames(id:Binding,apple:boolean){
  if(id in tools)return [tools[id as Tool]];
  if(id in contextual)return [...contextual[id as ContextKey]];
  return history[id as HistoryAction].filter(chord=>!apple||chord.startsWith("Mod+")).map(chord=>
    chord.replace("Mod+",apple?"Meta+":"Control+"));
}
function legend(chord:string){
  if(chord.startsWith("Meta+"))return chord.replace("Meta+Shift+","⇧⌘").replace("Meta+","⌘");
  return chord.replace("Control+","Ctrl+").replace("Escape","Esc");
}
export function dockTitle(id:Binding,label:string,apple=false):string{
  return label+"（"+keyNames(id,apple).map(legend).join(" 或 ")+"）";
}
export function dockShortcut(id:string,apple:boolean){
  if(!(id in tools||id in contextual||id in history))return;
  const keys=keyNames(id as Binding,apple);
  return {keys:keys.join(" "),keycap:legend(keys[0]),title:(label:string)=>dockTitle(id as Binding,label,apple)};
}

