import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = resolve(root, "src-tauri");
const read = (file) => readFile(file, "utf8");
const json = async (file) => JSON.parse(await read(file));
const config = await json(resolve(host, "tauri.conf.json"));
const { app, build, bundle } = config;

assert.equal(config.$schema, "https://schema.tauri.app/config/2");
assert.equal(config.identifier, "app.mgcanvas.desktop");
assert.deepEqual(build, {
  beforeBuildCommand: "npm run desktop:assets",
  frontendDist: "../dist/desktop",
});
assert.equal(app.windows.length, 1);
assert.equal(app.windows[0].label, "main");
assert.equal(app.windows[0].url, "index.html");
assert.equal(app.windows[0].dragDropEnabled, false);
assert.equal(app.withGlobalTauri, false);
assert.deepEqual(app.security.capabilities, ["workbench"]);
assert.equal(app.security.assetProtocol, undefined);
assert.equal(config.plugins, undefined);
assert.deepEqual(await readdir(resolve(host, "capabilities")), ["workbench.json"]);
assert.deepEqual(await json(resolve(host, "capabilities/workbench.json")), {
  identifier: "workbench",
  webviews: ["main"],
  permissions: ["allow-desktop-bridge"],
});
assert.deepEqual(await readdir(resolve(host, "permissions")), ["desktop-bridge.toml"]);
assert.match(await read(resolve(host, "permissions/desktop-bridge.toml")),
  /^\[\[permission\]\]\s+identifier = "allow-desktop-bridge"\s+description = "[^"\r\n]+"\s+commands\.allow = \["desktop_next", "desktop_complete"\]\s*$/);

function checkCsp(csp, expected) {
  assert.deepEqual(csp.split(";").map((entry) => entry.trim()).filter(Boolean).sort(),
    expected.sort());
}

checkCsp(app.security.csp, [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' blob:",
  "font-src 'self'", "connect-src ipc: http://ipc.localhost", "form-action 'none'",
  "object-src 'none'", "base-uri 'none'", "frame-src 'none'",
]);
const renderer = await read(resolve(host, "src/desktop_png.rs"));
assert.match(renderer, /const WEBVIEW: &str = "png-render";/);
assert.match(renderer, /const SCHEME: &str = "mgcanvas-render";/);
const renderCsp = renderer.match(/const CSP: &str = "([^"]+)";/)?.[1];
assert(renderCsp, "missing PNG renderer CSP");
checkCsp(renderCsp, [
  "default-src 'none'", "script-src 'self'", "img-src blob:", "connect-src 'self'",
  "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'",
]);
assert.doesNotMatch(renderer, /\.invoke_handler\s*\(/);

assert.equal(bundle.active, true);
assert.deepEqual(bundle.targets, ["nsis"]);
assert.equal(bundle.externalBin, undefined);
assert.deepEqual(bundle.resources, {
  "../LICENSE": "LICENSE",
  "../THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md",
  "../THIRD-PARTY-RUST.txt": "THIRD-PARTY-RUST.txt",
});
assert.deepEqual(bundle.fileAssociations, [{
  ext: ["mgcanvas"], name: "MGCanvas.Project", description: "MG Canvas 画板",
}]);
assert.deepEqual(bundle.windows, {
  nsis: { installMode: "currentUser", installerHooks: "windows/installer-hooks.nsh" },
  webviewInstallMode: { type: "offlineInstaller" },
});
const hooks = await read(resolve(host, bundle.windows.nsis.installerHooks));
assert.match(hooks, /WriteRegStr SHCTX "\S+\\OpenWithProgids" "\$\{FILECLASS\}" ""/);
assert.doesNotMatch(hooks, /(?:WriteReg\w+|DeleteReg\w+)[^\r\n]*\bUserChoice\b/);
const crate = await read(resolve(host, "Cargo.toml"));
assert.match(crate, /^\s*default-run = "mg-canvas-desktop"\s*$/m);
assert.deepEqual(await readdir(resolve(host, "src/bin")), ["mgcanvas.rs"]);
assert.deepEqual(bundle.icon, ["icons/icon.ico"]);
const icon = await readFile(resolve(host, bundle.icon[0]));
assert.equal(icon.readUInt16LE(2), 1);
assert(icon.readUInt16LE(4) >= 1);

const staged = resolve(host, build.frontendDist);
assert.deepEqual((await readdir(staged)).sort(), ["app", "index.html", "png-render.html"]);
assert.deepEqual((await readdir(resolve(staged, "app"))).sort(),
  ["desktop-png.js", "main.js", "style.css"]);
for (const [path, references] of [
  ["index.html", ["./app/style.css", "./app/main.js"]],
  ["png-render.html", ["./app/desktop-png.js"]],
]) {
  const html = await read(resolve(staged, path));
  assert.doesNotMatch(html, /<script\b[^>]*>\s*[^<\s]/i);
  assert.deepEqual([...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1]), references);
}
for (const path of ["app/main.js", "app/style.css"]) {
  assert.deepEqual(await readFile(resolve(staged, path)), await readFile(resolve(root, "dist", path)));
}
console.log("Desktop asset allowlist, isolated IPC, NSIS configuration and shared frontend verified.");
