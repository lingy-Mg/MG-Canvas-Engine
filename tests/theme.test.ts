import assert from "node:assert/strict";
import { test } from "node:test";
import { autoLabelInk,canvasThemes,contrastRatio,parseTheme,resolveTheme } from "../platform/theme.ts";

test("workspace preference is independent of document and follows system only in automatic mode",()=>{
  assert.equal(parseTheme(null),"system");
  assert.equal(parseTheme("unknown"),"system");
  assert.equal(parseTheme("dark"),"dark");
  assert.equal(resolveTheme("system",true),"dark");
  assert.equal(resolveTheme("system",false),"light");
  assert.equal(resolveTheme("light",true),"light");
  assert.equal(resolveTheme("dark",false),"dark");
});
test("theme canvas controls and auto node labels have accessible contrast",()=>{
  for(const colors of Object.values(canvasThemes)){
    assert.ok((contrastRatio(colors.accent,colors.bg)??0)>=3);
    assert.ok((contrastRatio(colors.guide,colors.bg)??0)>=3);
    assert.ok((contrastRatio(colors.spacing,colors.bg)??0)>=4.5);
    assert.ok((contrastRatio(colors.ink,colors.bg)??0)>=4.5);
    assert.ok((contrastRatio(colors.placeholderInk,colors.placeholder)??0)>=4.5);
  }
  assert.equal(autoLabelInk("#212735","#112238"),"#ffffff");
  assert.equal(autoLabelInk("#212735","#eee"),"#212735");
  for(const fill of ["#222","#717989","#2075aa","#ddd","#228822"]){
    assert.ok((contrastRatio(autoLabelInk("#212735",fill),fill)??0)>=4.5);
  }
});
