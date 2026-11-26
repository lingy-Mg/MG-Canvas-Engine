import {textFamilies} from "./text-style.ts";
import type {TextFace} from "./text-style.ts";

/** Both cards use a rectangle's geometry and ports. The label holds Markdown source or literal sticky text. */
export type CardKind="markdown"|"sticky";
export type CardStyle=TextFace & Readonly<{kind:CardKind;fontSize:number;color?:string;align?:"left"|"center"|"right";strike?:boolean;underline?:boolean}>;
export const MAX_CARD_TEXT=262144;
export function validCardStyle(value:unknown):value is CardStyle{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return Object.keys(v).every(k=>["kind","fontSize","color","fontFamily","fontWeight","italic","align","strike","underline"].includes(k))&&
    (v.kind==="markdown"||v.kind==="sticky")&&typeof v.fontSize==="number"&&Number.isFinite(v.fontSize)&&v.fontSize>=6&&v.fontSize<=160&&
    (v.color===undefined||typeof v.color==="string"&&/^#[0-9a-f]{6}$/i.test(v.color))&&
    (v.fontFamily===undefined||textFamilies.some(f=>f===v.fontFamily))&&(v.fontWeight===undefined||[400,500,600,700].includes(v.fontWeight as number))&&
    (v.align===undefined||["left","center","right"].includes(v.align as string))&&
    ["italic","strike","underline"].every(k=>v[k]===undefined||typeof v[k]==="boolean");
}
