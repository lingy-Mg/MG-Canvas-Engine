"""Browser recovery regression. Each run owns a disposable persistent Chromium profile."""
import argparse
import json
import hashlib
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from urllib.request import url2pathname

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HOOK = """(() => {
  window.recoveryWrites = [];
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, key) {
    if (this.transaction.db.name === 'mg-canvas-workspaces') {
      if (window.failWorkspace) throw new DOMException('quota test', 'QuotaExceededError');
      window.recoveryWrites.push(key[1]);
    }
    return put.apply(this, arguments);
  };
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (window.failWorkspace && key.includes('workspace-exit')) throw new DOMException('quota test', 'QuotaExceededError');
    return set.apply(this, arguments);
  };
  window.checkpoint = () => new Promise((resolve, reject) => {
    const r = indexedDB.open('mg-canvas-workspaces', 1);
    r.onsuccess = () => {
      const db = r.result, tx = db.transaction('sessions'), store = tx.objectStore('sessions');
      const get = part => store.get([location.pathname, part]);
      const h = get('head'), d = get('document'), a = get('assets');
      tx.oncomplete = () => { db.close(); resolve({head:h.result, doc:d.result, images:a.result?.map(i=>i.bytes.length)}); };
      tx.onabort = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  });
})();"""
DENY_INDEXED = """(() => {
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function(name, ...args) {
    if (name === 'mg-canvas-workspaces') throw new DOMException('denied in test', 'SecurityError');
    return open.call(this, name, ...args);
  };
})();"""
DELAY_MANUAL = """(() => {
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function(name, ...args) {
    const request = open.call(this, name, ...args);
    if (name === 'mg-canvas-previews') request.addEventListener('success', event => {
      event.stopImmediatePropagation();
      window.finishManualRead = () => request.onsuccess.call(request, event);
    }, {once:true});
    return request;
  };
})();"""
LOCAL = """(() => {
  const key = 'mg-canvas:workspace-local:' + location.pathname;
  const set = Storage.prototype.setItem;
  window.localWrites = [];
  Storage.prototype.setItem = function(k, v) {
    if (k.startsWith(key)) {
      if (window.failWorkspace && k === key) throw new DOMException('quota test', 'QuotaExceededError');
      window.localWrites.push(k.slice(key.length));
    }
    return set.apply(this, arguments);
  };
  window.checkpoint = async () => {
    const record = JSON.parse(localStorage.getItem(key));
    if (!record) return {};
    const project = JSON.parse(localStorage.getItem(key+':'+record.slot));
    const doc = record.docSlot === undefined ? project.document : JSON.parse(localStorage.getItem(key+':doc:'+record.docSlot));
    return {head:record.head, doc, images:Object.values(project.assets).map(b=>atob(b).length)};
  };
})();"""


def boot(chromium, profile, channel, entry, extra="", wait=True, controlled_clock=False):
    ctx = chromium.launch_persistent_context(str(profile), channel=channel, headless=True,
                                             viewport={"width": 1440, "height": 900},
                                             args=["--disable-background-networking", "--disable-sync"])
    ctx.add_init_script(HOOK + extra)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    if controlled_clock:
        page.clock.install()
    observe(page)
    page.goto(entry)
    if wait:
        ready(page)
    return ctx, page


def observe(page):
    page.on("dialog", lambda dialog: dialog.accept())


def ready(page):
    expect(page.locator("#layers .layer").first).to_be_attached()
    expect(page.locator("#status")).to_have_attribute("data-workspace", re.compile("^(ready|saved|pending|unavailable|conflict)$"))


def select(page, obj):
    if not page.locator("#layers-panel").is_visible():
        page.locator("#toggle-layers").click()
    page.locator(f'#layers [data-id="{obj}"]').click()
    page.locator("#canvas").focus()


def edit_label(page, value, commit=True, obj="flow-submit"):
    select(page, obj)
    page.keyboard.press("F2")
    field = page.locator("textarea.inline-text")
    field.fill(value)
    if commit:
        field.press("Enter")
    return field


def latest(page, predicate):
    deadline = time.monotonic() + 10
    read = "async () => {const s = await checkpoint(); return s.head && s.doc && (" + predicate + ") ? JSON.stringify(s) : null;}"
    while time.monotonic() < deadline:
        state = page.evaluate(read)
        if state:
            return json.loads(state)
        page.wait_for_timeout(50)
    raise AssertionError((predicate, page.locator("#status").inner_text(), page.evaluate("async () => (await checkpoint()).head")))


def label_is(label):
    return "s.doc.objects['flow-submit']?.label === " + json.dumps(label)


def canvas_tool(page, name="canvas_read", **args):
    page.wait_for_function("typeof window.mgCanvasTools?.callTool === 'function'")
    result = page.evaluate("async ([name,args]) => (await mgCanvasTools.callTool(name,args)).structuredContent", [name, args])
    assert result["ok"], result
    return result


def camera(view):
    return {"zoom": view["zoom"], "offset": view["offset"]}


def fitted_board(page):
    read = canvas_tool(page, limit=100)
    v = read["viewport"]
    groups = [o["bounds"] for o in read["objects"] if not o["hidden"]]
    for b in groups:
        x1, x2 = [v["offset"]["x"] + v["zoom"] * b[k]["x"] for k in ("min", "max")]
        y1, y2 = [v["offset"]["y"] + v["zoom"] * b[k]["y"] for k in ("min", "max")]
        assert 0 <= x1 <= x2 <= v["usableWidth"] and 0 <= y1 <= y2 <= v["height"], (v, b)
        for bar in v["occlusions"]:
            assert x2 <= bar["left"] or x1 >= bar["right"] or y2 <= bar["top"] or y1 >= bar["bottom"], (b, bar, v)
    if not groups:
        assert camera(v) == {"zoom": 1, "offset": {"x": v["usableWidth"]/2, "y": v["height"]/2}}, v
    assert camera(canvas_tool(page, "canvas_view", action="fit")["viewport"]) == camera(v)
    return read


def test_find_content(chromium, root, channel, entry, evidence_dir=None):
    ctx, p = boot(chromium, root / "find-content", channel, entry)
    results = {}

    def leave_board():
        p.mouse.move(325, 420)
        p.mouse.wheel(12000, 17000)
        for _ in range(50):
            if canvas_tool(p, scope="viewport", limit=1)["total"] == 0:
                return
            p.wait_for_timeout(20)
        raise AssertionError("The wheel pan did not move the test board off screen")

    try:
        first = fitted_board(p)
        assert first["board"]["objectCount"] == 6 and not first["canUndo"]
        results["firstOpen"] = camera(first["viewport"])
        p.set_viewport_size({"width": 650, "height": 760})
        btn = p.get_by_role("button", name="回到内容", exact=True)
        expect(btn).to_be_visible()
        expect(btn).to_have_attribute("aria-keyshortcuts", "0")
        expect(btn).to_contain_text("回到内容")
        leave_board()
        far = camera(canvas_tool(p)["viewport"])
        canvas_tool(p, "canvas_edit", baseRevision=first["revision"], operationId="away-from-board",
                    operations=[{"op": "update", "id": "flow-source", "fields": {"label": "离屏编辑"}}])
        stored = latest(p, "s.doc.objects['flow-source']?.label==='离屏编辑'")["head"]
        assert stored["camera"] == far == camera(canvas_tool(p)["viewport"])
        results["visibleBeforeRefresh"] = canvas_tool(p, scope="viewport")["total"]
        if evidence_dir:
            evidence_dir.mkdir(parents=True, exist_ok=True)
            p.screenshot(path=evidence_dir / "away-650.png")
        p.reload()
        restored = fitted_board(p)
        home = camera(restored["viewport"])
        assert home != far and not restored["canUndo"] and restored["board"]["objectCount"] == 6
        results["savedFarCamera"], results["refreshCamera"] = far, home
        results["visibleAfterRefresh"] = canvas_tool(p, scope="viewport")["total"]
        if evidence_dir:
            p.screenshot(path=evidence_dir / "restored-650.png")
        for method in ["button", "shortcut"]:
            p.locator("#zoom-in").click()
            leave_board()
            if method == "button":
                btn.click()
            else:
                p.locator("#canvas").press("0")
            r = canvas_tool(p)
            assert camera(r["viewport"]) == home and r["revision"] == restored["revision"]
            assert not r["dirty"] and not r["canUndo"] and not r["canRedo"]
            results[method] = camera(r["viewport"])
        p.wait_for_timeout(400)
        assert p.evaluate("recoveryWrites") == [], p.evaluate("recoveryWrites")
        assert latest(p, "true")["head"] == stored
        results["viewOnlyWrites"] = 0
        # Camera controls preserve an uncommitted text edit and its caret.
        field = edit_label(p, "仍在编辑", False, "flow-source")
        field.evaluate("el=>el.setSelectionRange(1,3)")
        draft = latest(p, "s.head.draft?.value==='仍在编辑' && s.head.draft.end===3")["head"]
        before = p.evaluate("recoveryWrites.length")
        btn.click()
        expect(field).to_be_focused()
        assert field.evaluate("el=>[el.selectionStart,el.selectionEnd]") == [1, 3]
        p.wait_for_timeout(400)
        assert p.evaluate("recoveryWrites.length") == before and latest(p, "true")["head"] == draft
        field.press("Escape")
        latest(p, "!s.head.draft")
        if p.locator("#layers-panel").is_visible():
            p.locator("#close-layers").click()
        leave_board()
        r = canvas_tool(p)
        # Remove bound edges first so each ID in this batch exists when addressed.
        ordered = sorted(r["objects"], key=lambda o: o["kind"] != "connector")
        canvas_tool(p, "canvas_edit", baseRevision=r["revision"], operationId="empty-from-away",
                    operations=[{"op":"remove","id":o["id"]} for o in ordered])
        empty = latest(p, "!s.doc.order.length")["head"]
        p.reload()
        r = fitted_board(p)
        assert r["board"]["objectCount"] == 0 and not r["canUndo"] and empty["camera"] != camera(r["viewport"])
        results["empty"] = camera(r["viewport"])
        # An older checkpoint can contain a standalone text draft without a corresponding board object.
        p.evaluate("""() => new Promise((resolve,reject)=>{
          const open=indexedDB.open('mg-canvas-workspaces');
          open.onsuccess=()=>{
            const db=open.result,tx=db.transaction('sessions','readwrite'),store=tx.objectStore('sessions');
            const key=[location.pathname,'head'],get=store.get(key);
            get.onsuccess=()=>store.put({...get.result,draft:{target:{kind:'text',id:'draft-only',at:{x:44000,y:-48000}},
              value:'找回草稿',start:1,end:3}},key);
            tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error);
          };
        })""")
        p.reload()
        expect(field).to_have_value("找回草稿")
        r = canvas_tool(p)
        v = r["viewport"]
        x, y = v["offset"]["x"] + 44000 * v["zoom"], v["offset"]["y"] - 48000 * v["zoom"]
        assert r["board"]["objectCount"] == 0 and 0 < x < v["width"] and 0 < y < v["height"]
        assert field.evaluate("el=>[el.selectionStart,el.selectionEnd]") == [1,3]
        p.wait_for_timeout(400)
        assert p.evaluate("recoveryWrites") == [] and not r["canUndo"]
        results["draftOnly"] = camera(v)
    finally:
        ctx.close()

    test_local_fit(chromium, root, channel, entry, results, evidence_dir)
    if evidence_dir:
        source = urlsplit(entry)
        results["entry"] = entry
        if source.scheme == "file":
            results["previewSha256"] = hashlib.sha256(Path(url2pathname(source.path)).read_bytes()).hexdigest()
        (evidence_dir / "find-content.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print("Find content:", json.dumps(results), flush=True)


def test_local_fit(chromium, root, channel, entry, results, evidence_dir):
    pkg = json.loads((ROOT / "docs/fixtures/MG-Canvas-Edit-Lifecycle.mgcanvas").read_text(encoding="utf-8"))
    node = pkg["document"]["objects"]["session-drag"]
    nodes = {key: {**node, "id":key, "at":{"x":x, "y":-48000}, "label":key} for key, x in [("west",44000),("east",74000)]}
    pkg["document"].update(id="find-local-content", objects=nodes, order=list(nodes))
    encoded = json.dumps(pkg)
    local = "localStorage.setItem('mg-canvas-engine:m1:board'," + json.dumps(encoded) + ");"
    # Reveal the actual viewport only after the local copy was loaded.
    hide = """new MutationObserver((_,observer)=>{
      const el=document.getElementById('viewport'); if(el){el.style.display='none';observer.disconnect();}
    }).observe(document,{childList:true,subtree:true});"""
    ctx, p = boot(chromium, root / "startup-copy", channel, entry, local + hide, wait=False)
    try:
        assert canvas_tool(p)["board"]["id"] == "find-local-content" and not p.locator("#viewport").is_visible()
        p.set_viewport_size({"width": 375, "height": 740})
        p.locator("#viewport").evaluate("el=>el.style.removeProperty('display')")
        expect(p.locator("#zoom-read")).to_have_text("<1%")
        r = fitted_board(p)
        assert r["viewport"]["zoom"] < .05 and not r["canUndo"]
        results["localCopyAfterLayout"] = camera(r["viewport"])
        select(p, "east")
        if not p.locator("#layers-panel").is_visible():
            p.locator("#toggle-layers").click()
        p.locator("#layer-hide").click()
        p.get_by_role("button", name="回到内容", exact=True).click()
        expect(p.locator("#layers-panel")).to_be_hidden()
        r = fitted_board(p)
        assert [o["id"] for o in r["objects"] if not o["hidden"]] == ["west"] and r["viewport"]["zoom"] == 1.3
        assert not r["canUndo"] and p.evaluate("recoveryWrites") == []
        results["narrowLayerSheetDismissed"] = True
        for w in [320, 375, 435, 650]:
            p.set_viewport_size({"width": w, "height": 740})
            layout = p.evaluate("""()=>{const rect=id=>document.getElementById(id).getBoundingClientRect();
              const bar=rect('view-zoom'),b=rect('fit');
              const control=document.querySelector('#diagnostics summary').getBoundingClientRect();
              return b.left>=0 && b.right<=innerWidth && (bar.right<=control.left || bar.bottom<=control.top);
            }""")
            assert layout, w
            if w == 375 and evidence_dir:
                p.screenshot(path=evidence_dir / "return-to-content-375.png")
    finally:
        ctx.close()
    source, preview = root / "local.mgcanvas", root / "local.html"
    source.write_text(encoded, encoding="utf-8")
    subprocess.run(["node", "scripts/mgcanvas.mjs", "preview", "--file", str(source), "--out", str(preview)], cwd=ROOT,
                   check=True, capture_output=True)
    ctx, p = boot(chromium, root / "embedded", channel, preview.resolve().as_uri())
    try:
        r = fitted_board(p)
        assert r["board"]["id"] == "find-local-content" and r["viewport"]["zoom"] < .05
        results["embeddedLocalProject"] = camera(r["viewport"])
    finally:
        ctx.close()


def test_project_names(chromium, root, channel, entry, screenshot=None):
    ctx, page = boot(chromium, root / "project-names", channel, entry)
    try:
        heading = page.locator("#project-title")
        picker = page.locator("#project-picker")
        fixture = ROOT / "docs/fixtures/MG-Canvas-Edit-Lifecycle.mgcanvas"
        project = json.loads(fixture.read_text(encoding="utf-8"))
        fixture_name = project.get("title") or fixture.stem
        expect(heading).to_have_text("会议室系统")
        picker.set_input_files(fixture)
        expect(heading).to_have_text(fixture_name)
        latest(page, "s.doc.id === 'mg-canvas-edit-lifecycle'")
        page.reload()
        expect(heading).to_have_text(fixture_name)
        expect(heading).to_have_attribute("title", fixture_name)
        if screenshot:
            screenshot.parent.mkdir(parents=True, exist_ok=True)
            page.set_viewport_size({"width": 650, "height": 950})
            page.locator(".header").screenshot(path=screenshot)

        def open_bytes(name, content):
            picker.set_input_files({"name": name, "mimeType": "application/json", "buffer": content})

        # Two files can share a board ID. The newly opened file owns its name.
        untitled = {key: value for key, value in project.items() if key != "title"}
        open_bytes("流程校对.v2.MGCANVAS", json.dumps(untitled).encode())
        expect(heading).to_have_text("流程校对.v2")
        page.locator("#save").click()
        expect(page.locator("#open")).to_be_enabled()
        named = {**project, "title": "项目 <A> & B"}
        open_bytes("副本.mgcanvas", json.dumps(named).encode())
        expect(heading).to_have_text(named["title"])
        latest(page, "s.head.names.title === '项目 <A> & B'")
        page.reload()
        expect(heading).to_have_text(named["title"])
        open_bytes("坏文件.mgcanvas", b"{")
        expect(page.locator("#status")).to_contain_text("打开失败")
        expect(heading).to_have_text(named["title"])
        page.locator("#file-history summary").click()
        page.locator("#open").click()
        expect(heading).to_have_text("流程校对.v2")

        # Older recovery heads have no saved title or filename.
        latest(page, "s.head.names.fileName === '流程校对.v2.MGCANVAS'")
        page.evaluate("""() => new Promise((resolve, reject) => {
          const open = indexedDB.open('mg-canvas-workspaces');
          open.onsuccess = () => {
            const db = open.result, tx = db.transaction('sessions', 'readwrite');
            const store = tx.objectStore('sessions'), key = [location.pathname, 'head'], get = store.get(key);
            get.onsuccess = () => { const head = get.result; delete head.names; store.put(head, key); };
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onabort = () => reject(tx.error);
          };
        })""")
        page.reload()
        expect(heading).to_have_text("mg-canvas-edit-lifecycle")
        print("Verified the lifecycle fixture name after import and refresh, explicit titles, same-ID files, failed imports, manual reopen and old recovery heads.")
    finally:
        ctx.close()


def navigate(page):
    old_zoom = page.locator("#zoom-read").inner_text()
    page.locator("#zoom-in").click()
    expect(page.locator("#zoom-read")).not_to_have_text(old_zoom)
    page.mouse.move(620, 480)
    for _ in range(12):
        page.mouse.wheel(11, 7)
    page.keyboard.down("Control")
    for dy in [-12, 12] * 3:
        page.mouse.wheel(0, dy)
    page.keyboard.up("Control")


def test_browser(chromium, root, channel, entry):
    profile = root / "profile"
    first_load = "if (!sessionStorage.getItem('recovery-test-started')) { sessionStorage.setItem('recovery-test-started','1'); " + DELAY_MANUAL + " }"
    ctx, p = boot(chromium, profile, channel, entry, first_load, wait=False, controlled_clock=True)
    p.wait_for_function("typeof finishManualRead === 'function'")
    navigate(p)
    p.evaluate("finishManualRead()")
    ready(p)
    navigate(p)
    expect(p.locator("#status")).to_have_attribute("data-workspace", "ready")
    expect(p.locator("#undo")).to_be_disabled()
    p.wait_for_timeout(400)
    assert p.evaluate("recoveryWrites.length") == 0
    assert p.evaluate("async () => !(await checkpoint()).head")
    select(p, "flow-source")
    p.keyboard.press("F2")
    untouched = p.locator("textarea.inline-text")
    untouched.press("End")
    untouched.press("Escape")
    p.wait_for_timeout(400)
    assert p.evaluate("recoveryWrites.length") == 0
    old = json.loads((ROOT / "docs/fixtures/M5S-Cubic-Paths.mgcanvas").read_text(encoding="utf-8"))
    node = old["document"]["objects"]["flow-submit"]
    node.update(at={"x": 391.37586, "y": 53.66846}, width=333.076, height=209.23)
    src = root / "old.mgcanvas"
    src.write_text(json.dumps(old, ensure_ascii=False), encoding="utf-8")
    p.locator("#project-picker").set_input_files(src)
    expect(p.locator('#layers [data-id="flow-submit"]')).to_be_attached()
    s = latest(p, "s.doc.objects['flow-submit']?.width === 333")
    assert s["doc"]["objects"]["flow-submit"]["at"] == {"x": 391, "y": 54}
    assert s["images"] and s["doc"]["schemaVersion"] == 4
    assert p.evaluate("recoveryWrites.filter(s=>s==='assets').length") == 1
    edit_label(p, "first committed")
    latest(p, label_is("first committed"))
    p.locator("#undo").click()
    undone = latest(p, label_is(node["label"]))
    # Redo at t=0 and hold a real middle-button pan across its save deadline.
    # Every move is within the debounce interval. A camera-driven timer would still be pending at t=400.
    p.clock.pause_at(datetime.now(timezone.utc) + timedelta(seconds=2))
    writes = p.evaluate("recoveryWrites.length")
    p.locator("#redo").dispatch_event("click")
    assert p.locator("#status").get_attribute("data-workspace") == "pending"
    p.mouse.move(530, 390)
    p.mouse.down(button="middle")
    for i in range(1, 11):
        p.mouse.move(530 + 3 * i, 390 + 2 * i)
        p.clock.run_for(40)
    redone = p.evaluate("checkpoint()")
    assert redone["doc"]["objects"]["flow-submit"]["label"] == "first committed"
    assert redone["head"]["camera"]["offset"] != undone["head"]["camera"]["offset"]
    assert p.evaluate("recoveryWrites")[writes:] == ["document", "head"]
    assert p.locator("#status").get_attribute("data-workspace") == "saved"
    p.mouse.up(button="middle")
    p.clock.resume()
    before = p.evaluate("recoveryWrites.slice()")
    navigate(p)
    expect(p.locator("#status")).to_have_attribute("data-workspace", "saved")
    p.wait_for_timeout(400)
    assert p.evaluate("recoveryWrites") == before
    assert p.evaluate("async () => (await checkpoint()).head") == redone["head"]
    field = edit_label(p, "草稿一二三", False)
    field.evaluate("e=>e.setSelectionRange(1, 4)")
    draft = latest(p, "s.head.draft?.value==='草稿一二三' && s.head.draft.start===1")
    assert draft["head"]["camera"]["zoom"] != redone["head"]["camera"]["zoom"]
    assert draft["head"]["draft"]["end"] == 4
    assert draft["doc"]["objects"]["flow-submit"]["label"] == "first committed"
    assert "document" not in p.evaluate("recoveryWrites.slice()")[len(before):]
    assert "assets" not in p.evaluate("recoveryWrites.slice()")[len(before):]
    # Reload immediately after changing the value, inside the normal debounce interval.
    field.fill("刷新前的最后几个字")
    p.reload()
    field = p.locator("textarea.inline-text")
    expect(field).to_have_value("刷新前的最后几个字")
    field.press("End")
    # Chromium's native composition event sequence. Unconfirmed candidates stay with the IME.
    ime = ctx.new_cdp_session(p)
    ime.send("Input.imeSetComposition", {"text": "pin", "selectionStart": 3, "selectionEnd": 3})
    expect(field).to_have_value(re.compile("pin$"))
    p.reload()
    expect(field).to_have_value("刷新前的最后几个字")
    p.locator("textarea.inline-text").press("Escape")
    state = latest(p, "!s.head.draft && " + label_is("first committed"))
    # A fresh process restores the document and frames it using the actual startup viewport.
    navigate(p)
    expect(p.locator("#status")).to_have_attribute("data-workspace", "saved")
    ctx.close()
    ctx, p = boot(chromium, profile, channel, entry)
    startup_view = fitted_board(p)["viewport"]
    assert latest(p, "true")["head"] == state["head"]
    canvas = p.locator("#canvas")
    bounds = canvas.bounding_box()
    x, y = 775, 465
    p.locator("#tool-text").click()
    canvas.click(position={"x": x, "y": y})
    p.locator("textarea.inline-text").fill("new uncommitted note")
    # Reloading this new text must preserve its creation point and leave it outside the document.
    d = latest(p, "s.head.draft?.value === 'new uncommitted note'")
    target = d["head"]["draft"]["target"]
    for axis, pixel in (("x", x), ("y", y)):
        assert abs(target["at"][axis] - (pixel - startup_view["offset"][axis]) / startup_view["zoom"]) <= .501, (target, startup_view, bounds)
    placed = d["doc"]["objects"][target["id"]]
    assert placed["at"] == target["at"] and placed["text"] == ""
    p.locator("textarea.inline-text").fill("last text before close")
    p.close(run_before_unload=True)
    ctx.close()
    ctx, p = boot(chromium, profile, channel, entry)
    expect(p.locator("textarea.inline-text")).to_have_value("last text before close")
    p.locator("textarea.inline-text").press("Control+Enter")
    latest(p, "Object.values(s.doc.objects).some(o=>o.text==='last text before close') && !s.head.draft")
    # Long pointer gestures may preview many samples. Only the released change goes into the project.
    p.locator("#tool-ink").click()
    origin = p.locator("#canvas").bounding_box()
    prior_writes = p.evaluate("recoveryWrites.filter(k=>k==='document').length")
    x, y = origin["x"] + 390, origin["y"] + 360
    p.mouse.move(x, y)
    p.mouse.down()
    p.mouse.move(x + 90, y + 35, steps=24)
    p.wait_for_timeout(350)
    assert p.evaluate("recoveryWrites.filter(k=>k==='document').length") == prior_writes
    p.mouse.up()
    ink = latest(p, "s.doc.order.length === " + str(len(d["doc"]["order"]) + 1))
    assert any(o["kind"] == "ink" and oid not in d["doc"]["objects"] for oid, o in ink["doc"]["objects"].items())
    assert p.evaluate("recoveryWrites.filter(k=>k==='document').length") == prior_writes + 1
    p.locator("#tool-select").click()
    select(p, target["id"])
    if p.locator("#layers-panel").is_visible():
        p.locator("#toggle-layers").click()
    p.locator("#canvas").focus()
    expect(p.locator("#status")).to_have_attribute("data-workspace", "saved")
    current = latest(p, "true")
    text_id = json.dumps(target["id"])
    note = current["doc"]["objects"][target["id"]]
    view = current["head"]["camera"]
    x = origin["x"] + view["offset"]["x"] + (note["at"]["x"] + 11) * view["zoom"]
    y = origin["y"] + view["offset"]["y"] + (note["at"]["y"] + note["height"] / 2) * view["zoom"]
    prior_writes = p.evaluate("recoveryWrites.filter(k=>k==='document').length")
    p.mouse.move(x, y)
    p.mouse.down()
    p.mouse.move(x + 29, y - 24, steps=10)
    p.wait_for_timeout(350)
    assert p.evaluate("recoveryWrites.filter(k=>k==='document').length") == prior_writes
    p.mouse.up()
    moved = latest(p, "s.doc.objects[" + text_id + "].at.x !== " + str(note["at"]["x"]))
    assert p.evaluate("recoveryWrites.filter(k=>k==='document').length") == prior_writes + 1
    p.locator("#canvas").press("Delete")
    latest(p, "!s.doc.objects[" + text_id + "]")
    p.locator("#undo").click()
    latest(p, "s.doc.objects[" + text_id + "]?.at.x === " + str(moved["doc"]["objects"][target["id"]]["at"]["x"]))
    with p.expect_download() as dl:
        p.locator("#project-export").click()
    file = root / "restored.mgcanvas"
    dl.value.save_as(file)
    restored = json.loads(file.read_text(encoding="utf-8"))
    assert restored["assets"] == old["assets"] and restored["document"]["schemaVersion"] == 4
    # A stale tab writes after a different tab has already committed.
    newer = ctx.new_page()
    observe(newer)
    newer.goto(entry)
    ready(newer)
    edit_label(newer, "newer tab")
    latest(newer, label_is("newer tab"))
    edit_label(p, "stale tab")
    expect(p.locator("#status")).to_contain_text("另一标签页")
    p.reload()
    ready(p)
    latest(p, label_is("newer tab"))
    expect(p.locator('#layers [data-id="flow-submit"]')).to_have_attribute("aria-label", "newer tab")
    # A write failure aborts even if the application could stage part of the transaction.
    p.evaluate("window.failWorkspace = true")
    edit_label(p, "quota draft")
    expect(p.locator("#status")).to_contain_text("自动保存失败")
    assert p.evaluate("(async()=> (await checkpoint()).doc.objects['flow-submit'].label)()") == "newer tab"
    p.reload()
    ready(p)
    expect(p.locator('#layers [data-id="flow-submit"]')).to_have_attribute("aria-label", "newer tab")
    ctx.close()
    # If the established IndexedDB temporarily disappears, a fallback starter must not take ownership.
    ctx, p = boot(chromium, profile, channel, entry, DENY_INDEXED)
    expect(p.locator("#status")).to_contain_text("现场存储不可用")
    assert not p.evaluate("localStorage.getItem('mg-canvas:workspace-local:'+location.pathname)")
    ctx.close()
    ctx, p = boot(chromium, profile, channel, entry)
    expect(p.locator('#layers [data-id="flow-submit"]')).to_have_attribute("aria-label", "newer tab")
    ctx.close()
    # An edit on the starter while startup reads are outstanding cannot overwrite the old board.
    ctx, p = boot(chromium, profile, channel, entry, DELAY_MANUAL, wait=False)
    p.wait_for_function("typeof finishManualRead === 'function'")
    edit_label(p, "edited during startup", obj="flow-source")
    p.evaluate("finishManualRead()")
    expect(p.locator("#status")).to_contain_text("读取上次现场时已有新编辑")
    expect(p.locator('#layers [data-id="flow-source"]')).to_have_attribute("aria-label", "edited during startup")
    latest(p, label_is("newer tab"))
    assert p.evaluate("recoveryWrites.length") == 0
    navigating = ctx.new_page()
    observe(navigating)
    navigating.goto(entry)
    navigating.wait_for_function("typeof finishManualRead === 'function'")
    navigating.mouse.move(490, 380)
    navigating.mouse.down(button="middle")
    navigating.mouse.move(510, 405)
    navigating.evaluate("finishManualRead()")
    expect(navigating.locator("#status")).to_have_attribute("data-workspace", "saved")
    expect(navigating.locator('#layers [data-id="flow-submit"]')).to_have_attribute("aria-label", "newer tab")
    navigating.mouse.up(button="middle")
    assert navigating.evaluate("recoveryWrites.length") == 0
    ctx.close()
    print("IndexedDB recovery passed edit-only scheduling, zero navigation writes, uninterrupted save during a pan, startup fit, legacy geometry, images, drag, ink, undo/redo, reload, IME, restart, quota, slow startup and stale tabs.")


def test_fallback(chromium, root, channel, entry):
    profile = root / "fallback-profile"
    legacy = (ROOT / "docs/fixtures/M5S-Cubic-Paths.mgcanvas").read_text(encoding="utf-8")
    manual_key = "mg-canvas-engine:m1:board"
    seed = "if (!localStorage.getItem(" + json.dumps(manual_key) + ")) localStorage.setItem(" + json.dumps(manual_key) + "," + json.dumps(legacy) + ");"
    ctx, p = boot(chromium, profile, channel, entry, DENY_INDEXED + LOCAL + seed)
    expect(p.locator('#layers [data-id="flow-submit"]')).to_be_attached()
    navigate(p)
    p.wait_for_timeout(400)
    assert p.evaluate("localWrites") == []
    assert p.evaluate("checkpoint()") == {}
    edit_label(p, "fallback committed")
    latest(p, label_is("fallback committed"))
    edit_label(p, "fallback next")
    d = latest(p, label_is("fallback next"))
    assert d["images"] and p.evaluate("localWrites.filter(k=>/^:[01]$/.test(k)).length") == 1
    edit_label(p, "fallback draft", False)
    p.reload()
    expect(p.locator("textarea.inline-text")).to_have_value("fallback draft")
    p.locator("textarea.inline-text").press("Escape")
    latest(p, "!s.head.draft && " + label_is("fallback next"))
    p.evaluate("window.failWorkspace=true")
    edit_label(p, "fallback staged quota")
    expect(p.locator("#status")).to_contain_text("自动保存失败")
    assert p.evaluate("async () => (await checkpoint()).doc.objects['flow-submit'].label") == "fallback next"
    ctx.close()
    # IndexedDB is available after restart. Keep the previously chosen, verified fallback.
    ctx, p = boot(chromium, profile, channel, entry, LOCAL)
    expect(p.locator('#layers [data-id="flow-submit"]')).to_have_attribute("aria-label", "fallback next")
    assert p.evaluate("k => localStorage.getItem(k)", manual_key) == legacy
    second = ctx.new_page()
    observe(second)
    second.goto(entry)
    ready(second)
    edit_label(second, "fallback winner")
    latest(second, label_is("fallback winner"))
    edit_label(p, "fallback older")
    expect(p.locator("#status")).to_contain_text("另一标签页")
    latest(p, label_is("fallback winner"))
    ctx.close()
    print("Locked localStorage fallback passed legacy manual-copy recovery, document-only edits, drafts, restart, staged quota failure and stale-tab protection.")


def test_text_targets(chromium, root, channel, entry):
    ctx, p = boot(chromium, root / "text-profile", channel, entry)
    blank = dict(schemaVersion=1, id="recovery-types", theme="paper", order=[], objects={}, assets={})
    p.locator("#project-picker").set_input_files({"name": "blank.mgcanvas", "mimeType": "application/json",
                                                  "buffer": json.dumps(blank).encode()})
    latest(p, "s.doc.id==='recovery-types'")
    canvas, field = p.locator("#canvas"), p.locator("textarea.inline-text")
    p.locator("#tool-mind").click()
    canvas.click(position={"x": 350, "y": 200})
    field.fill("中心草稿")
    root_draft = latest(p, "s.head.draft?.target.kind==='map' && s.head.draft.value==='中心草稿'")
    assert root_draft["doc"]["order"] == []
    p.reload()
    expect(field).to_have_value("中心草稿")
    field.press("Tab")
    field.fill("子主题草稿")
    child = latest(p, "s.head.draft?.target.kind==='child' && s.head.draft.value==='子主题草稿'")
    map_id, topic = child["head"]["draft"]["target"]["mapId"], child["head"]["draft"]["target"]["id"]
    assert topic not in child["doc"]["objects"][map_id]["topics"]
    p.reload()
    expect(field).to_have_value("子主题草稿")
    field.press("Enter")
    latest(p, "s.doc.objects[" + json.dumps(map_id) + "].topics[" + json.dumps(topic) + "]?.text==='子主题草稿'")
    writes = p.evaluate("recoveryWrites.slice()")
    p.locator("#tool-sticky").click()
    canvas.hover(position={"x":640,"y":300})
    expect(p.locator("#placement-preview")).to_be_visible()
    p.locator("#sticky-palette").get_by_role("radio",name="杏橙").click()
    p.wait_for_timeout(400)
    assert p.evaluate("recoveryWrites") == writes
    p.locator("#canvas").press("Escape")
    expect(p.locator("#placement-preview")).to_be_hidden()
    p.locator("#tool-sticky").click()
    canvas.click(position={"x": 680, "y": 320})
    note = p.locator(".card-input")
    placed = latest(p, "Object.values(s.doc.objects).some(o=>o.content?.kind==='sticky' && o.fill==='#ffceaa' && o.label==='')")
    assert len(placed["doc"]["order"]) == 2
    note.fill("便签草稿")
    p.locator('#text-format-bar button[data-format="bold"]').click()
    draft = latest(p, "s.head.draft?.target.content?.fontWeight===700 && s.head.draft.value==='便签草稿'")
    note_id = json.dumps(draft["head"]["draft"]["target"]["id"])
    p.reload()
    expect(note).to_have_value("便签草稿")
    note.press("Control+Enter")
    latest(p, "s.doc.objects[" + note_id + "]?.content.fontWeight===700 && s.doc.objects[" + note_id + "].label==='便签草稿'")
    writes = p.evaluate("recoveryWrites.slice()")
    p.locator("#tool-document").click()
    canvas.hover(position={"x":520,"y":245})
    expect(p.locator("#placement-preview")).to_have_attribute("data-kind","markdown")
    expect(p.locator("#placement-preview")).to_be_visible()
    canvas.press("Escape")
    p.wait_for_timeout(400)
    assert p.evaluate("recoveryWrites") == writes
    p.locator("#tool-document").click()
    canvas.click(position={"x":540,"y":245})
    empty = latest(p, "Object.values(s.doc.objects).some(o=>o.content?.kind==='markdown' && o.label==='')")
    doc_id = next(key for key,obj in empty["doc"]["objects"].items() if obj.get("content",{}).get("kind")=="markdown")
    p.reload()
    latest(p, "s.doc.objects[" + json.dumps(doc_id) + "]?.label==='' && !s.head.draft")
    p.locator("#tool-table").click()
    canvas.click(position={"x": 440, "y": 510})
    canvas.press("F2")
    field.fill("单元格草稿")
    p.locator('#text-format-bar button[data-format="underline"]').click()
    draft = latest(p, "s.head.draft?.target.style?.underline && s.head.draft.value==='单元格草稿'")
    cell = "s.doc.objects[" + json.dumps(draft["head"]["draft"]["target"]["id"]) + "].cells[0][0]"
    assert draft["doc"]["schemaVersion"] == 6
    p.reload()
    expect(field).to_have_value("单元格草稿")
    field.press("Enter")
    latest(p, cell + ".text==='单元格草稿' && " + cell + ".style.underline")
    ctx.close()
    print("Uncommitted mind-map roots and children, sticky-note formatting and v6 table-cell text and formatting survived reload and normal commit.")


if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("entry", help="Preview file or local development URL")
    args.add_argument("--channel", default="chrome")
    args.add_argument("--heading-only", action="store_true", help="Run project-name recovery cases only")
    args.add_argument("--heading-shot", type=Path, help="Capture the header after restoring the lifecycle project")
    args.add_argument("--find-content-only", action="store_true", help="Run startup, recovery and find-content camera cases only")
    args.add_argument("--find-content-evidence", type=Path, help="Save camera measurements and narrow-view screenshots")
    opts = args.parse_args()
    entry = opts.entry if opts.entry.startswith(("http://", "https://", "file:")) else Path(opts.entry).resolve().as_uri()
    with TemporaryDirectory(prefix="mg-workspace-recovery-") as tmp, sync_playwright() as pw:
        if not opts.heading_only:
            test_find_content(pw.chromium, Path(tmp), opts.channel, entry, opts.find_content_evidence)
        if not opts.find_content_only:
            test_project_names(pw.chromium, Path(tmp), opts.channel, entry, opts.heading_shot)
        if not opts.heading_only and not opts.find_content_only:
            test_browser(pw.chromium, Path(tmp), opts.channel, entry)
            test_fallback(pw.chromium, Path(tmp), opts.channel, entry)
            test_text_targets(pw.chromium, Path(tmp), opts.channel, entry)
