export const DEFAULT_TEXT_COLOR="#243854";
export const textFamilies=["system","arial","roboto","yahei","pingfang","noto-sans","serif","georgia","times","songti","simsun","noto-serif"] as const;
export type TextFamily=typeof textFamilies[number];
export type TextWeight=400|500|600|700;
export type TextFace=Readonly<{fontFamily?:TextFamily;fontWeight?:TextWeight;italic?:boolean}>;
export type TextPaint=Readonly<{color:string;colorMode?:"auto"|"custom";background?:string}>;

/** Older projects only stored a color. An explicit choice matching the old default needs a marker. */
export function automaticTextColor(paint:TextPaint & {id?:string}):boolean{
  if(paint.colorMode)return paint.colorMode==="auto";
  return paint.color===DEFAULT_TEXT_COLOR||paint.color==="#52647e"&&(paint.id==="flow-heading"||paint.id==="mind-heading");
}
