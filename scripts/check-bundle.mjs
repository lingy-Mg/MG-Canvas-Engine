import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { previewFile } from "./release.mjs";

const file=process.argv[2]??"dist/"+previewFile;
const html=readFileSync(file,"utf8");
const bundle=readFileSync("dist/app/main.js","utf8");
const css=readFileSync("dist/app/style.css","utf8");
assert.equal(html.match(/<script type="module" data-mgcanvas-editor>\n([\s\S]*?)<\/script>/)?.[1],bundle);
assert.equal(html.match(/<style>\n([\s\S]*?)\n<\/style>/)?.[1],css);
assert(html.includes("<!-- mgcanvas-input -->"));
assert.doesNotMatch(html,/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i);
const index=readFileSync("dist/app/index.html","utf8");
assert.match(index,/<script type="module" src="\.\/main\.js"><\/script>/);
assert.match(index,/<link rel="stylesheet" href="\.\/style\.css">/);
console.log("Offline preview and HTTP entry use the same local React and CSS bytes.");
