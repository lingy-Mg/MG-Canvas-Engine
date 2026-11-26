import {automaticTextColor} from "../core/text-style.ts";
import type {TextPaint} from "../core/text-style.ts";
export type ThemePreference="system"|"light"|"dark";
export type WorkspaceTheme=Exclude<ThemePreference,"system">;
export const THEME_STORAGE_KEY="mg-canvas:workspace-theme";
export function parseTheme(value:unknown):ThemePreference{return value==="light"||value==="dark"?value:"system";}
export function resolveTheme(preference:ThemePreference,prefersDark:boolean):WorkspaceTheme{
  return preference==="system"?(prefersDark?"dark":"light"):preference;
}
export const canvasThemes={
  light:{bg:"#f3f5f9",grid:"#d8dee9",imageShadow:"rgba(27,39,59,.38)",accent:"#3566e7",hover:"#18778c",guide:"#b02570",spacing:"#0b716a",accentMuted:"#89a6ef",accentFill:"#3566e721",handle:"#ffffff",
    valid:"#16886e",invalid:"#c54a3e",placeholder:"#e7edf6",placeholderBorder:"#b4c3dc",placeholderInk:"#52647d",ink:"#212735",halo:"#ffffff"},
  dark:{bg:"#1b1d23",grid:"#363b49",imageShadow:"rgba(188,202,223,.36)",accent:"#84a7ff",hover:"#78d6e5",guide:"#ff91ca",spacing:"#65ddca",accentMuted:"#6178ac",accentFill:"#84a7ff29",handle:"#252938",
    valid:"#4bd7ae",invalid:"#ff8e82",placeholder:"#2b3443",placeholderBorder:"#687c9a",placeholderInk:"#d9e4f5",ink:"#e9eefb",halo:"#a2b5d3"},
} as const;
function rgb(hex:string):number|undefined{
  const spec=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)?.[1];
  return spec?Number.parseInt(spec.length===3?[...spec].map(x=>x+x).join(""):spec,16):undefined;
}
function luminance(hex:string):number|undefined{
  const n=rgb(hex);
  if(n===undefined)return;
  const lin=(b:number)=>{const x=b/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;};
  return .2126*lin(n>>16)+.7152*lin((n>>8)&255)+.0722*lin(n&255);
}
export function contrastRatio(fg:string,bg:string):number|undefined{
  const a=luminance(fg),b=luminance(bg);
  return a===undefined||b===undefined?undefined:(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}
export function contrastInk(background:string):"#000"|"#fff"{
  const lightness=luminance(background);
  if(lightness===undefined)return "#fff";
  const black=(lightness+.05)/.05,white=1.05/(lightness+.05);
  return white>=black?"#fff":"#000";
}
/** A dark, opaque connector gets one lighter tint for both the shaft and its heads. */
export function canvasStroke(ink:string,theme:WorkspaceTheme){
  const contrast=contrastRatio(ink,canvasThemes[theme].bg)??Infinity;
  const color=theme==="dark"&&contrast<3?rgb(ink):undefined;
  if(color===undefined)return {contrast,connector:ink};
  const tint=(channel:number)=>Math.round(channel*.55+255*.45).toString(16).padStart(2,"0");
  return {contrast,connector:"#"+tint(color>>16)+tint((color>>8)&255)+tint(color&255)};
}
/** Applies to automatically chosen diagram labels only, never persistent object ink. */
export function autoLabelInk(preferred:string,fill:string):string{
  const score=contrastRatio(preferred,fill);
  if(score===undefined||score>=4.5)return preferred;
  return (contrastRatio("#ffffff",fill)??0)>=(contrastRatio("#000000",fill)??0)?"#ffffff":"#000000";
}

/** Legacy shape fills may be named CSS colors or translucent. Composite them over the canvas first. */
const surfaces=new Map<string,string>();
let sampler:CanvasRenderingContext2D|null|undefined;
export function labelSurface(fill:string|undefined,theme:WorkspaceTheme):string{
  const bg=canvasThemes[theme].bg;
  if(!fill||fill==="transparent")return bg;
  if(rgb(fill)!==undefined)return fill;
  const key=bg+" "+fill,cached=surfaces.get(key);
  if(cached)return cached;
  if(typeof document==="undefined")return bg;
  if(sampler===undefined){
    const pixel=document.createElement("canvas");pixel.width=pixel.height=1;
    sampler=pixel.getContext("2d",{willReadFrequently:true});
  }
  if(!sampler)return bg;
  sampler.fillStyle=bg;sampler.fillRect(0,0,1,1);sampler.fillStyle=fill;sampler.fillRect(0,0,1,1);
  const data=sampler.getImageData(0,0,1,1)?.data;
  if(!data)return bg;
  const surface="#"+Array.from(data.subarray(0,3),v=>v.toString(16).padStart(2,"0")).join("");
  if(surfaces.size>=256)surfaces.clear();
  surfaces.set(key,surface);return surface;
}
export function standaloneInk(paint:TextPaint,theme:WorkspaceTheme):string{
  if(!automaticTextColor(paint))return paint.color;
  if(paint.background)return autoLabelInk(paint.color,paint.background);
  const palette=canvasThemes[theme];
  return (contrastRatio(paint.color,palette.bg)??0)>=4.5?paint.color:palette.ink;
}
