"""Exercise the real editor under React Strict Mode, including a full unmount in the same tab."""
import argparse
import json
from pathlib import Path
import runpy
import subprocess
import sys
import time
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
RECOVERY = runpy.run_path(str(ROOT / "scripts/check-recovery-browser.py"))
ORIGIN = "http://127.0.0.1:43298"

# The test supplies root controls, environment and CSS. All components and the engine are the real app.
ENTRY = """
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {WorkspaceApp} from './app/react/WorkspaceApp.tsx';
import {readWorkspaceSource} from './app/workspace-source.ts';
const source=readWorkspaceSource(document);
let root;
window.renderEditor = version => flushSync(()=>root.render(<StrictMode><WorkspaceApp source={source} version={version}/></StrictMode>));
window.mountEditor = () => {
  root=createRoot(document.querySelector('#root'));renderEditor('QA');
};
window.unmountEditor = () => root.unmount();
"""
BUNDLE = """
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
await build({stdin:{contents:readFileSync(0,'utf8'),resolveDir:process.cwd(),loader:'tsx'},
  jsx:'automatic',bundle:true,format:'esm',platform:'browser',
  define:{'process.env.NODE_ENV':'"development"'},outfile:process.argv[1]});
"""
AUDIT = """
window.viewportObservers=new Set();
window.ResizeObserver=class extends ResizeObserver {
  observe(el,...args){if(el.id==='viewport')viewportObservers.add(this);return super.observe(el,...args);}
  disconnect(){viewportObservers.delete(this);return super.disconnect();}
};
const raf=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
window.drawFrames={requested:0,delivered:0,pending:new Set()};
window.requestAnimationFrame=fn=>{
  const id=raf(time=>{drawFrames.pending.delete(id);drawFrames.delivered++;fn(time);});
  drawFrames.requested++;drawFrames.pending.add(id);return id;
};
window.cancelAnimationFrame=id=>{drawFrames.pending.delete(id);cancel(id);};
window.manualConnections=new Set();
const openDB=IDBFactory.prototype.open,closeDB=IDBDatabase.prototype.close;
IDBFactory.prototype.open=function(name,...args){
  const request=openDB.call(this,name,...args);
  if(name==='mg-canvas-previews')request.addEventListener('success',()=>manualConnections.add(request.result),{once:true});
  return request;
};
IDBDatabase.prototype.close=function(){
  manualConnections.delete(this);
  return closeDB.call(this);
};
"""
GLOBAL_EVENTS = {"wheel", "pointerdown", "pointercancel", "pointerup", "keydown", "keyup", "focusin",
                 "click", "resize", "scroll", "blur", "beforeunload", "pagehide", "visibilitychange"}


def listeners(session):
    result = {}
    for expression in ("window", "document", "visualViewport"):
        obj = session.send("Runtime.evaluate", {"expression": expression, "objectGroup": "mount-audit"})
        handlers = session.send("DOMDebugger.getEventListeners", {"objectId": obj["result"]["objectId"]})
        counts = {}
        for record in handlers["listeners"]:
            kind = record["type"]
            if kind in GLOBAL_EVENTS:
                counts[kind] = counts.get(kind, 0) + 1
        result[expression] = counts
    session.send("Runtime.releaseObjectGroup", {"objectGroup": "mount-audit"})
    return result


def check(page, session):
    page.goto(ORIGIN)
    page.wait_for_function("typeof mountEditor==='function'")
    baseline = listeners(session)
    page.evaluate("mountEditor()")
    RECOVERY["ready"](page)
    page.wait_for_function("manualConnections.size===1")
    start = RECOVERY["fitted_board"](page)
    assert page.evaluate("viewportObservers.size") == 1
    live = listeners(session)
    assert page.evaluate("""() => {
      const canvas=document.querySelector('#canvas'),tools=mgCanvasTools;
      renderEditor('QA update');
      return canvas===document.querySelector('#canvas') && tools===mgCanvasTools && viewportObservers.size===1;
    }""")
    assert listeners(session) == live
    assert page.evaluate("recoveryWrites.length") == 0
    page.wait_for_function("!drawFrames.pending.size")
    enqueued = page.evaluate("""() => {
      const canvas=document.querySelector('#canvas'),box=canvas.getBoundingClientRect(),before=drawFrames.requested;
      for(let i=0;i<100;i++)canvas.dispatchEvent(new PointerEvent('pointermove',{
        clientX:box.x+12+i,clientY:box.y+200,pointerId:1,pointerType:'mouse',bubbles:true}));
      return drawFrames.requested-before;
    }""")
    assert enqueued == 1, enqueued
    page.locator("#canvas").press("0")
    page.locator("#fit").click()
    page.wait_for_timeout(350)
    assert page.evaluate("recoveryWrites.length") == 0
    # Leave before the debounce fires. Cleanup must finish this one edit before the next editor adopts.
    previous = page.evaluate("""async revision=>{
      const old=mgCanvasTools;
      const edit=await old.callTool('canvas_edit',{baseRevision:revision,operationId:'before-unmount',
        operations:[{op:'update',id:'flow-source',fields:{label:'重挂载前最后一笔'}}]});
      if(!edit.structuredContent.ok)throw Error(JSON.stringify(edit));
      unmountEditor();
      return (await old.callTool('canvas_read')).structuredContent.code;
    }""", start["revision"])
    assert previous == "CANCELLED"
    assert page.evaluate("viewportObservers.size===0 && !drawFrames.pending.size && !window.mgCanvasTools")
    page.wait_for_function("manualConnections.size===0")
    detached = listeners(session)
    assert detached == baseline, {"baseline": baseline, "afterUnmount": detached}
    page.evaluate("mountEditor()")
    RECOVERY["ready"](page)
    page.wait_for_function("manualConnections.size===1")
    after = RECOVERY["fitted_board"](page)
    assert len(after["objects"]) == len(start["objects"]) and not after["canUndo"]
    row = RECOVERY["canvas_tool"](page, ids=["flow-source"])["objects"][0]
    assert row["label"] == "重挂载前最后一笔", row
    assert listeners(session) == live
    expect(page.locator("#canvas")).to_have_count(1)
    assert page.evaluate("recoveryWrites.filter(p=>p==='head').length") == 1
    field = RECOVERY["edit_label"](page, "未提交文字", False, "flow-source")
    page.evaluate("unmountEditor();mountEditor()")
    RECOVERY["ready"](page)
    expect(field).to_have_value("未提交文字")
    assert page.evaluate("recoveryWrites.filter(p=>p==='head').length") == 2
    page.evaluate("unmountEditor()")
    page.wait_for_function("manualConnections.size===0")
    page.wait_for_timeout(450)
    assert page.evaluate("recoveryWrites.filter(p=>p==='head').length") == 2
    assert listeners(session) == baseline
    return {"strictMode": True, "mountedObservers": 1, "unmountedObservers": 0,
            "listenerCountsAfterUnmount": baseline, "pointerMoves": 100, "queuedFrames": enqueued,
            "viewOnlyCheckpointWrites": 0, "editCheckpointWrites": 1, "draftCheckpointWrites": 1,
            "manualConnectionsAfterUnmount": 0,
            "expiredTool": previous, "visibleObjectsAfterRemount": len(after["objects"])}


def verify_bridge(browser, bundle, folder):
    fixture = ROOT / "docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas"
    project, descriptor = folder / "board.mgcanvas", folder / "session.json"
    project.write_bytes(fixture.read_bytes())
    caller = """import {sessionCall} from './scripts/ai/bridge.mjs';
        const [file,command,args]=process.argv.slice(1);
        console.log(JSON.stringify(await sessionCall(file,command,JSON.parse(args))));"""
    def call(command, args):
        with subprocess.Popen(["node", "--input-type=module", "-e", caller, str(descriptor), command,
                json.dumps(args, ensure_ascii=False)], cwd=ROOT, encoding="utf-8", stdout=subprocess.PIPE) as cli:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    output, _ = cli.communicate(timeout=.05)
                    assert cli.returncode == 0, command
                    return json.loads(output)
                except subprocess.TimeoutExpired:
                    page.wait_for_timeout(20)
            cli.kill()
            raise TimeoutError(command)
    with subprocess.Popen(["node", "scripts/mgcanvas.mjs", "serve", "--file", str(project), "--session", str(descriptor)],
                          cwd=ROOT, stdout=subprocess.PIPE, text=True, encoding="utf-8") as server:
        try:
            address = json.loads(server.stdout.readline())["url"]
            assert urlsplit(address).hostname == "127.0.0.1"
            origin = address.split("/#", 1)[0]
            with browser.new_context() as context:
                html = (ROOT / "app/index.html").read_text(encoding="utf-8").replace(
                    "<!-- mgcanvas-input -->", '<meta id="mgcanvas-bridge" content="1">')
                context.route(origin + "/", lambda r: r.fulfill(body=html, content_type="text/html"))
                context.route(origin + "/main.js", lambda r: r.fulfill(path=bundle, content_type="text/javascript"))
                context.route(origin + "/style.css", lambda r: r.fulfill(path=ROOT / "app/style.css", content_type="text/css"))
                page = context.new_page()
                page.set_default_timeout(5000)
                claims = []
                page.on("response", lambda res: claims.append(res.status) if res.url.endswith("/page/open") else None)
                page.goto(address)
                page.evaluate("mountEditor()")
                page.wait_for_function("!document.body.inert && !!window.mgCanvasTools")
                assert len(call("tools/list", {})["tools"]) == 5
                initial = call("status", {})
                edit = {"baseRevision": initial["revision"], "operationId": "mounted-bridge",
                        "operations": [{"op": "update", "id": "flow-submit", "fields": {"label": "重挂载的桥接工程"}}]}
                def tool(name, args):
                    return call("tools/call", {"name": name, "arguments": args})["structuredContent"]
                assert tool("canvas_edit", edit)["ok"]
                page.evaluate("unmountEditor();mountEditor()")
                page.wait_for_function("!document.body.inert && !!window.mgCanvasTools")
                restored = tool("canvas_read", {"ids": ["flow-submit"]})
                assert restored["objects"][0]["label"] == "重挂载的桥接工程" and restored["dirty"], restored
                assert tool("canvas_edit", edit)["code"] == "STALE"
                assert project.read_bytes() == fixture.read_bytes()
                call("save", {"baseRevision": restored["revision"]})
                assert json.loads(project.read_bytes())["document"]["objects"]["flow-submit"]["label"] == "重挂载的桥接工程"
                assert claims == [200], claims
                other = context.new_page()
                other.goto(address)
                with other.expect_response("**/page/open") as rejected:
                    other.evaluate("mountEditor()")
                assert rejected.value.status == 409
                return {"sameTabClaims": len(claims), "diskUnchangedUntilSave": True,
                        "unsavedEditRestored": True, "staleRetry": "STALE", "secondTabResponse": rejected.value.status}
        finally:
            server.terminate()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, help="Write the measured result as JSON")
    args = parser.parse_args()
    with TemporaryDirectory(prefix="mg-viewport-react-") as tmp:
        bundle = Path(tmp) / "main.js"
        subprocess.run(["node", "--input-type=module", "-e", BUNDLE, str(bundle)], input=ENTRY, cwd=ROOT,
                       text=True, encoding="utf-8", check=True)
        with sync_playwright() as pw, pw.chromium.launch(channel="chrome", headless=True) as browser:
            context = browser.new_context(viewport={"width": 650, "height": 950})
            files = {"/": (ROOT / "app/index.html", "text/html"), "/style.css": (ROOT / "app/style.css", "text/css"),
                     "/main.js": (bundle, "text/javascript")}
            def route_local(route):
                file = files.get(route.request.url.removeprefix(ORIGIN))
                if file:
                    route.fulfill(path=file[0], content_type=file[1])
                else:
                    route.abort()
            context.route("**/*", route_local)
            context.add_init_script(RECOVERY["HOOK"] + AUDIT)
            page = context.new_page()
            page.set_default_timeout(5000)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            try:
                result = check(page, context.new_cdp_session(page))
            finally:
                if errors:
                    print(json.dumps(errors, ensure_ascii=False), file=sys.stderr)
            assert not errors, errors
            context.close()
            result["bridge"] = verify_bridge(browser, bundle, Path(tmp))
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if args.evidence:
                args.evidence.parent.mkdir(parents=True, exist_ok=True)
                args.evidence.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
