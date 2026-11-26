import {propertyWidget} from "./property-view.ts";
import type {BoardDocument} from "../core/document.ts";
import type {LiveProperties,PropertyResult} from "./property-draft.ts";
import {isHexPaint} from "../core/document.ts";

const shortHex=/^#[0-9a-f]{3}$/i;
function literalHex(token:string):string|undefined{
  if(isHexPaint(token))return token.toLowerCase();
  if(shortHex.test(token))return "#"+[...token.slice(1)].map(d=>d.toLowerCase().repeat(2)).join("");
}
const surfaces=new WeakMap<Document,CanvasRenderingContext2D|null>();
/** Derive only the seed for the opaque native picker. Keep the stored token separate. */
export function opaquePickerColor(token:string,doc:Document):string|undefined{
  const direct=literalHex(token);
  if(direct||!token||token.trim().toLowerCase()==="transparent")return direct;
  try{
    if(!surfaces.has(doc)){
      const canvas=doc.createElement("canvas");canvas.width=canvas.height=1;
      surfaces.set(doc,canvas.getContext("2d",{willReadFrequently:true}));
    }
    const ctx=surfaces.get(doc);if(!ctx)return;
    // Invalid assignments are ignored. Two sentinels also admit either sentinel as a legitimate color.
    ctx.fillStyle="#010203";ctx.fillStyle=token;
    if(ctx.fillStyle==="#010203"){ctx.fillStyle="#040506";ctx.fillStyle=token;if(ctx.fillStyle==="#040506")return;}
    const resolved=literalHex(String(ctx.fillStyle));if(resolved)return resolved;
    ctx.clearRect(0,0,1,1);ctx.fillRect(0,0,1,1);
    const pixel=ctx.getImageData(0,0,1,1)?.data;
    if(pixel?.length===4&&pixel[3]===255)return "#"+[pixel[0],pixel[1],pixel[2]].map(v=>v.toString(16).padStart(2,"0")).join("");
  }catch{/* The text field and original token are independent of Canvas availability. */}
}

type ColorOptions=Readonly<{effective?:string;placeholder?:string;emptyUnchanged?:boolean;allowTransparent?:boolean;onInput?:(value:string|undefined,source:HTMLInputElement)=>void}>;
/** The text value owns the edit. Picker activation, blur and unchanged native values are passive. */
export function propertyColor(grid:HTMLElement,name:string,caption:string,stored:string|undefined,options:ColorOptions={}){
  const root=propertyWidget(grid,{kind:"color",name,caption,placeholder:options.placeholder,allowTransparent:options.allowTransparent});
  const [input,picker]=Array.from(root.querySelectorAll("input")),chip=root.querySelector<HTMLElement>(".paint-chip")!;
  return bindPropertyColor(input,picker,chip,stored,options);
}
export function bindPropertyColor(input:HTMLInputElement,picker:HTMLInputElement,chip:HTMLElement,stored:string|undefined,options:ColorOptions={}){
  let initial=stored??"";
  let effective=stored??options.effective??"";
  let originalHex=isHexPaint(initial)?initial.toLowerCase():undefined;
  let resolved=opaquePickerColor(effective,document),seed=resolved??"#000000";
  input.value=initial;let shownInitial=input.value;
  let lastPicker=seed;
  function read(){
    const raw=input.value.trim();
    if(input.value===shownInitial||raw===""&&options.emptyUnchanged||isHexPaint(raw)&&raw.toLowerCase()===originalHex)return;
    return raw;
  }
  function show(value:string|undefined){
    const valid=isHexPaint(value);
    const transparent=options.allowTransparent&&value==="transparent";
    chip.style.backgroundColor=valid||transparent?value!:effective||"transparent";
    lastPicker=valid?value.toLowerCase():seed;picker.value=lastPicker;
    input.setCustomValidity?.(value===undefined||valid||transparent?"":"请输入六位十六进制颜色，例如 #000000。");
  }
  function update(source:HTMLInputElement){const value=read();show(value);options.onInput?.(value,source);}
  function reset(){input.value=shownInitial;show(undefined);}
  function fromPicker(){
    const next=picker.value.toLowerCase();
    if(!isHexPaint(next)||next===lastPicker)return;
    input.value=next===resolved?shownInitial:next;
    update(picker);
  }
  let composing=false;
  input.addEventListener("compositionstart",()=>{composing=true;});
  input.addEventListener("compositionend",()=>{composing=false;update(input);});
  input.addEventListener("input",event=>{if(!composing&&!event.isComposing)update(input);});
  picker.addEventListener("input",fromPicker);picker.addEventListener("change",fromPicker);
  reset();
  function setEffective(color:string){
    if(stored!==undefined||color===effective)return;
    effective=color;resolved=opaquePickerColor(color,document);seed=resolved??"#000000";show(read());
  }
  function display(value:string){input.value=value;show(read());}
  function sync(value:string|undefined,ink=value??""){
    if(value===stored&&ink===effective){reset();return;}
    stored=value;initial=value??"";originalHex=isHexPaint(initial)?initial.toLowerCase():undefined;
    effective=ink;resolved=opaquePickerColor(ink,document);seed=resolved??"#000000";
    input.value=initial;shownInitial=input.value;reset();
  }
  return {input,picker,read,reset,setEffective,display,sync};
}

export function liveColor(live:LiveProperties,doc:()=>BoardDocument,grid:HTMLElement,name:string,caption:string,
  read:(d:BoardDocument)=>string|undefined,plan:(d:BoardDocument,value:string)=>PropertyResult,
  options:ColorOptions={},effective?:(d:BoardDocument)=>string){
  const color=propertyColor(grid,name,caption,read(doc()),{...options,effective:effective?.(doc()),onInput:(changed,source)=>{
    const value=color.input.value.trim();
    // Returning the picker to its seed also restores an inherited or legacy named color.
    const restore=changed===undefined&&(source===color.picker||!isHexPaint(value));
    live.write(source,"修改"+caption,d=>restore?new Map():plan(d,value));
  }});
  live.watch(skip=>{if(skip!==color.input&&skip!==color.picker)color.sync(read(doc()),effective?.(doc()));});
  for(const source of [color.input,color.picker])source.addEventListener("blur",()=>live.finish(source));
  color.picker.addEventListener("change",()=>live.finish(color.picker));
  return color;
}
