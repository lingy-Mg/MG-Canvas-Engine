"""Exercise the real CLI and the built editor in an isolated local Chromium profile."""
import argparse
import base64
import hashlib
from http import client
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / "scripts" / "mgcanvas.mjs"
FIXTURE = ROOT / "docs" / "fixtures" / "Meeting-Room-Mobile-QA.mgcanvas"


def cli(*args, data=None, code=0):
    proc = subprocess.run(["node", str(ENTRY), *map(str, args)], cwd=ROOT, capture_output=True,
                          encoding="utf-8", input=json.dumps(data) if data is not None else None, timeout=30)
    assert proc.returncode == code, (args[0], proc.stdout, proc.stderr)
    return json.loads(proc.stdout)


def patch(rev, name, label):
    return {"baseRevision": rev, "operationId": name, "operations": [
        {"op": "update", "id": "flow-submit", "fields": {"label": label}}]}


def http(port, path, headers, data=None, method="POST"):
    conn = client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(method, path, json.dumps(data or {}) if method == "POST" else None, headers)
        return conn.getresponse().status
    finally:
        conn.close()


def layer(page, obj="flow-submit"):
    return page.locator('#layers [data-id="' + obj + '"]')


def show_panel(page, name):
    if not page.locator("#" + name + "-panel").is_visible():
        page.locator("#toggle-" + name).click()


def select_layer(page, obj="flow-submit", *, section=None):
    show_panel(page, "layers")
    layer(page, obj).click()
    if section:
        trigger = page.locator("#text-format-bar").get_by_role("button", name=section, exact=True)
        if trigger.get_attribute("aria-expanded") != "true":
            trigger.click()


def set_label(page, value, obj="flow-submit"):
    select_layer(page, obj, section="节点文字")
    field = page.get_by_role("textbox", name="节点文字", exact=True)
    field.fill(value)
    field.press("Enter")
    page.locator("#zoom-in").focus()
    expect(layer(page, obj)).to_contain_text(value)


def export_page(page, path):
    with page.expect_download() as download:
        page.locator("#project-export").click()
    download.value.save_as(path)
    return json.loads(path.read_text(encoding="utf-8"))


def check_layout_and_subtree(page, session):
    before = cli("inspect", *session)
    rev = before["revision"]
    layout = {"op": "layoutFlow", "ids": ["flow-submit", "flow-review"]}
    move = {"op": "moveTopic", "id": "mind-booking", "topicId": "topic-booking",
            "targetId": "topic-display", "place": "child"}
    invalid = {"operationId": "invalid-descendant", "baseRevision": rev,
               "operations": [layout, {**move, "targetId": "topic-detail"}]}
    assert cli("apply", *session, "--batch", "-", data=invalid, code=2)["code"] == "INVALID"
    check = cli("inspect", *session)
    assert check["revision"] == rev and check["data"] == before["data"]

    batch = {"operationId": "layout-and-move", "baseRevision": rev, "operations": [layout, move]}
    assert cli("apply", *session, "--batch", "-", data=batch)["changed"]
    layout_doc = cli("inspect", *session)["data"]
    rows = layout_doc["objects"]
    assert rows["flow-review"]["at"] == {"x": -35, "y": -127}
    assert rows["flow-first"] == before["data"]["objects"]["flow-first"]
    topics = rows["mind-booking"]["topics"]
    assert topics["topic-display"]["childIds"] == ["topic-booking"] and not topics["topic-display"]["collapsed"]
    assert topics["topic-booking"]["childIds"] == ["topic-detail"]
    select_layer(page, "flow-review", section="变换")
    expect(page.locator('#inspector [data-shape-properties] input[name="x"]')).to_have_value("-35")
    select_layer(page, "mind-booking")
    expect(page.locator('#topic-tree [data-topic-id="topic-detail"]')).to_have_attribute("aria-level", "4")
    page.locator("#undo").click()
    undone = cli("inspect", *session)
    assert undone["data"] == before["data"]
    cli("redo", *session, "--rev", undone["revision"])
    assert cli("inspect", *session)["data"] == layout_doc
    return rows["flow-review"]["at"]

def edit_structure(target, *, file=None, page=None):
    board = "mind-booking"
    def add(anchor, relation, new_id, text):
        return {"op": "addTopic", "id": board, "topicId": anchor, "relation": relation,
                **({"newId": new_id} if new_id else {}), "text": text}
    ops = [
        {"op": "setMapLayout", "id": board, "layout": "left"},
        add("topic-root", "child", "stage-review", "交付评审"),
        add("stage-review", "sibling", "stage-release", "发布"),
        add("stage-review", "child", "stage-draft", "临时分支"),
        add("stage-draft", "child", "stage-note", "临时叶"),
        {"op": "deleteTopic", "id": board, "topicId": "stage-draft"},
        {"op": "setBranchSide", "id": board, "topicId": "stage-release", "side": "right"},
        {"op": "addDownstream", "id": "flow-review", "nodeId": "stage-node", "connectorId": "stage-edge"},
        {"op": "update", "id": "stage-node", "fields": {"label": "交付上线"}},
        add("stage-review", "child", None, "验收记录"),
    ]
    before = cli("inspect", *target)
    old_bytes = file.read_bytes() if file else None
    batch = {"operationId": "edit-structure", "baseRevision": before["revision"], "operations": ops}
    bad = {**batch, "operations": [*ops, {"op": "deleteTopic", "id": board, "topicId": "topic-root"}]}
    assert cli("apply", *target, "--batch", "-", data=bad, code=2)["code"] == "INVALID"
    same = cli("inspect", *target)
    assert same["revision"] == before["revision"] and same["data"] == before["data"]
    if file:
        assert file.read_bytes() == old_bytes
    result = cli("apply", *target, "--batch", "-", data=batch)
    assert result["source"] == before["source"] and result["changed"]
    details = {r["index"]: r for r in result["results"]}
    assert set(details) == {0, 1, 2, 3, 4, 5, 6, 7, 9}
    assert details[0]["layout"] == "left" and details[1]["topicId"] == "stage-review"
    assert details[5]["removedIds"] == ["stage-draft", "stage-note"]
    assert details[6]["layout"] == "balanced" and details[6]["side"] == "right"
    assert (details[7]["nodeId"], details[7]["connectorId"]) == ("stage-node", "stage-edge")
    generated = details[9]["topicId"]
    def assert_structure(doc):
        objs = doc["objects"]
        m = objs[board]
        topics = m["topics"]
        assert m["layout"] == "balanced" and topics["stage-release"]["side"] == "right"
        assert all(topics[k]["side"] == "left" for k in topics[m["rootId"]]["childIds"] if k != "stage-release")
        assert topics["stage-review"]["childIds"] == [generated] and topics[generated]["text"] == "验收记录"
        assert "stage-draft" not in topics and "stage-note" not in topics
        assert objs["stage-node"]["label"] == "交付上线" and objs["stage-node"]["at"] == details[7]["at"]
        line = objs["stage-edge"]
        assert line["from"] == details[7]["from"] == {"kind":"anchor", "objectId":"flow-review", "portId":"east"}
        assert line["to"] == details[7]["to"] and line["to"]["objectId"] == "stage-node"
    applied = cli("inspect", *target)["data"]
    assert_structure(applied)
    if page:
        select_layer(page, "stage-node")
        expect(layer(page, "stage-node")).to_contain_text("交付上线")
        select_layer(page, board)
        expect(page.locator('#topic-tree [data-topic-id="' + generated + '"]')).to_contain_text("验收记录")
        expect(page.locator('#topic-tree [data-topic-id="stage-draft"]')).to_have_count(0)
        page.locator("#undo").click()
        restored = cli("inspect", *target)
        assert restored["data"] == before["data"]
        cli("redo", *target, "--rev", restored["revision"])
        assert cli("inspect", *target)["data"] == applied
        replay = cli("apply", *target, "--batch", "-", data=batch)
        receipt = cli("receipt", *target, "--id", batch["operationId"])
        for response in (replay, receipt):
            assert response["results"] == result["results"]
            assert response["appliedRevision"] == result["appliedRevision"] != response["revision"]
    return applied, {"generatedTopic": generated, "deleted": details[5]["removedIds"], "node": details[7]["nodeId"],
                     "connector": details[7]["connectorId"], "position": details[7]["at"]}


def write_artifacts(target, out, assets):
    project, preview, archive = out / "board.mgcanvas", out / "preview.html", out / "board.zip"
    for command, path in (("export", project), ("preview", preview), ("pack", archive)):
        cli(command, *target, "--out", path)
    assert cli("verify", "--file", archive)["assets"] == len(assets)
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.read("board.mgcanvas") == project.read_bytes() and bundle.read("index.html") == preview.read_bytes()
    return project, preview, archive


def read_png(path, metadata):
    from PIL import Image
    with Image.open(path) as png:
        assert png.format == "PNG" and png.size == (metadata["width"], metadata["height"])
        png.load()
        pixels = png.convert("RGB")
    assert hashlib.sha256(path.read_bytes()).hexdigest() == metadata["sha256"]
    return pixels


def check_png_pixels(work, out, seed):
    from io import BytesIO
    from PIL import Image, ImageChops
    from unittest.mock import patch as env_patch
    import math

    board = json.loads(json.dumps(seed))
    objects = board["document"]["objects"]
    triangle = dict(objects["flow-submit"], id="qa-rotated", label="", shape="triangle", rotation=math.pi/2,
                    at={"x": -380, "y": 160}, width=96, height=54, fill="#db461a", stroke="#234579")
    objects[triangle["id"]] = triangle
    board["document"]["order"].append(triangle["id"])
    # Four solid quadrants distinguish the decoded asset from a rectangle or loading placeholder.
    asset = Image.new("RGB", (32, 16))
    colors = [(242, 48, 66), (53, 173, 93), (47, 96, 220), (249, 203, 57)]
    for i, color in enumerate(colors):
        x, y = (i%2)*16, (i//2)*8
        asset.paste(color, (x, y, x+16, y+8))
    stream = BytesIO()
    asset.save(stream, "PNG")
    board["assets"]["asset-1"] = base64.b64encode(stream.getvalue()).decode("ascii")
    board["document"]["assets"]["asset-1"].update(pixelWidth=32, pixelHeight=16)
    objects["flow-submit"]["label"] = "中"
    source = out / "pixel-proof.mgcanvas"
    source.write_text(json.dumps(board, ensure_ascii=False), encoding="utf-8")
    def paint(target, dest, *opts):
        meta = cli("png", "--file", target, "--out", dest, *opts)
        return meta, read_png(dest, meta)
    full, whole = paint(source, out / "board.png")
    assert full["networkRequests"] == 0
    assert full["scope"] == {"kind":"board"} and full["imageCount"] == 1 and full["objectCount"] == 8
    def pixel(meta, image, x, y):
        return image.getpixel((round(meta["offset"]["x"] + x*meta["scale"]), round(meta["offset"]["y"] + y*meta["scale"])))
    image = objects["qa-picture"]
    for i,color in enumerate(colors):
        x = image["at"]["x"] + image["width"]*(.25 if i%2==0 else .75)
        y = image["at"]["y"] + image["height"]*(.25 if i<2 else .75)
        assert pixel(full, whole, x, y) == color
    cropped, shape = paint(source, out / "rotated.png", "--id", "qa-rotated", "--scale", "2")
    assert cropped["objectCount"] == 1 and cropped["scope"] == {"kind":"object","id":"qa-rotated"}
    assert (cropped["width"],cropped["height"]) == (156,240)
    cx,cy = triangle["at"]["x"]+48,triangle["at"]["y"]+27
    for meta, pixels in ((cropped,shape), (full,whole)):
        # Local coordinate (48,40) is inside, (7,6) outside. Rotate 90 degrees around the box center.
        assert pixel(meta,pixels,cx-13,cy) == (219,70,26)
        assert min(pixel(meta,pixels,cx+21,cy-41)) > 200
    glyphs = []
    for i,label in enumerate(("中","文","")):
        objects["flow-submit"]["label"] = label
        variant = work / ("glyph-"+str(i)+".mgcanvas")
        variant.write_text(json.dumps(board,ensure_ascii=False),encoding="utf-8")
        _, bitmap = paint(variant,work/("glyph-"+str(i)+".png"),"--id","flow-submit","--scale","2")
        glyphs.append(bitmap.crop((95,38,210,110)).convert("L").point(lambda v: 255 if v<120 else 0))
    changed = sum(ImageChops.difference(glyphs[0],glyphs[1]).histogram()[1:])
    assert changed>50 and sum(glyphs[0].histogram()[1:])>80 and sum(glyphs[1].histogram()[1:])>80
    assert glyphs[2].getbbox() is None
    rejected = work/"should-not-exist.png"
    for args,code in [(("--id","missing"),"NOT_FOUND"),(("--scale","0"),"INVALID")]:
        assert cli("png","--file",source,"--out",rejected,*args,code=2)["code"]==code and not rejected.exists()
    with env_patch.dict(os.environ,{"MGCANVAS_BROWSER":str(work/"unavailable"/"chrome.exe")}):
        assert cli("png","--file",source,"--out",rejected,code=4)["code"]=="BROWSER_UNAVAILABLE" and not rejected.exists()
    giant = work/"too-large.mgcanvas"
    # At this width, binary floating-point multiplication rounds just above the cap.
    objects["flow-submit"]["width"]=2181
    giant.write_text(json.dumps(board),encoding="utf-8")
    assert cli("png","--file",giant,"--id","flow-submit","--scale","2","--out",rejected,code=2)["code"]=="TOO_LARGE"
    fitted,_=paint(giant,work/"auto-fit.png","--id","flow-submit","--scale","auto")
    assert fitted["width"]==1600 and 0<fitted["scale"]<1
    occupied = work/"occupied.png"
    occupied.write_bytes(b"existing content")
    assert cli("png","--file",source,"--id","qa-picture","--out",occupied,code=3)["code"]=="EXISTS"
    assert occupied.read_bytes()==b"existing content" and not rejected.exists()
    empty=work/"empty.mgcanvas"
    cli("new","--out",empty)
    blank,background=paint(empty,work/"empty.png")
    assert blank["objectCount"]==0 and background.size==(256,192) and background.getpixel((0,0))==(243,245,249)
    return {"fullSize":list(whole.size),"boardSha256":full["sha256"],"rotatedSize":list(shape.size),
            "negativeChecks":["unknown-object","invalid-scale","missing-browser","too-large","no-overwrite"],
            "imageQuadrants":colors,"distinctChineseGlyphPixels":changed,"renderNetworkRequests":full["networkRequests"]}


def check_layer_controls(page, session, disk, work):
    id = "flow-submit"
    select_layer(page, id, section="节点文字")
    state = cli("edit-state",*session,"--id",id)
    assert state["selectedIds"]==[id] and not state["activeDraft"]
    field = page.get_by_role("textbox",name="节点文字",exact=True)
    field.focus()
    focused=cli("edit-state",*session,"--id",id)
    assert focused["busy"] and not focused["activeDraft"] and "INSPECTOR_FOCUS" in focused["blockingReasons"]
    show_panel(page, "layers")
    page.locator("#layer-lock").click()
    locked=cli("edit-state",*session,"--id",id)
    assert locked["layers"][0]["reasons"]==["LOCKED"] and locked["stateRevision"]!=state["stateRevision"]
    assert cli("set-layer",*session,"--id",id,"--rev",state["stateRevision"],"--locked","false",code=3)["code"]=="STALE"
    hidden=cli("set-layer",*session,"--id",id,"--rev",locked["stateRevision"],"--visible","false")
    expect(layer(page,id)).to_have_attribute("data-hidden","true")
    assert hidden["selectedIds"]==[] and hidden["layers"][0]["locked"]
    assert set(hidden["affectedIds"])=={id,"flow-first"}
    edge=cli("edit-state",*session,"--id","flow-first")["layers"][0]
    assert edge["hiddenBy"]==[id] and not edge["directlyHidden"]
    hidden_png=cli("png",*session,"--id",id,"--out",work/"hidden.png")
    disk_png=cli("png",*disk,"--id",id,"--out",work/"visible-on-disk.png")
    assert hidden_png["sha256"]==disk_png["sha256"] and hidden_png["networkRequests"]==0
    shown=cli("set-layer",*session,"--id","flow-first","--rev",hidden["stateRevision"],"--visible","true")
    expect(layer(page,id)).to_have_attribute("data-hidden","false")
    expect(layer(page,id)).to_have_attribute("data-locked","true")
    assert cli("set-layer",*session,"--rev",shown["stateRevision"],"--locked","false",code=2)["code"]=="USAGE"
    unlocked=cli("set-layer",*session,"--id",id,"--rev",shown["stateRevision"],"--locked","false")
    expect(layer(page,id)).to_have_attribute("data-locked","false")
    assert unlocked["revision"]==state["revision"] and unlocked["dirty"]==state["dirty"]
    assert cli("edit-state",*disk,code=2)["code"]=="USAGE"


def check_draft_png(page,session,work):
    state=cli("edit-state",*session,"--id","flow-submit")
    draft=page.get_by_role("textbox",name="节点文字",exact=True).input_value()
    assert state["activeDraft"] and "INSPECTOR_DRAFT" in state["blockingReasons"]
    assert draft not in json.dumps(state,ensure_ascii=False)
    for option in ("--locked","--visible"):
        assert cli("set-layer",*session,"--id","flow-submit","--rev",state["stateRevision"],option,"true",code=3)["code"]=="BUSY"
    args=["--id","flow-submit","--scale","2"]
    before=cli("png",*session,*args,"--out",work/"during-draft.png")
    saved=work/"committed.mgcanvas"
    cli("export",*session,"--out",saved)
    assert before["revision"]==state["revision"] and before["source"]=="session"
    copy=cli("png","--file",saved,*args,"--out",work/"committed.png")
    assert before["sha256"]==copy["sha256"] and (work/"during-draft.png").read_bytes()==(work/"committed.png").read_bytes()
    assert page.get_by_role("textbox",name="节点文字",exact=True).input_value()==draft
    return before["sha256"]


def run(browser, work, out, png=False, arrange=False):
    file, descriptor = work / "board.mgcanvas", work / "session.json"
    source = json.loads(FIXTURE.read_text(encoding="utf-8"))
    # Give the connected nodes a free destination and the moved branch a real descendant.
    objects = source["document"]["objects"]
    tree = objects["mind-booking"]
    # Reserve a separate band for the map so switching its branches left stays legible beside the flow.
    tree["origin"].update(x=320, y=395)
    tree["topics"]["topic-booking"]["childIds"] = ["topic-detail"]
    tree["topics"]["topic-detail"] = {"id": "topic-detail", "text": "预约明细", "collapsed": False, "childIds": []}
    tree["topics"]["topic-display"]["collapsed"] = True
    objects["flow-first"].update(routing="orthogonal", waypoints=[{"x": -142, "y": -60}])
    file.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
    disk_out = out / "disk"
    disk_out.mkdir()
    disk_seed = work / "disk-seed.mgcanvas"
    disk_seed.write_bytes(file.read_bytes())
    disk_target = ["--file", disk_seed]
    disk_doc, disk_structure = edit_structure(disk_target, file=disk_seed)
    disk_project, disk_preview, disk_zip = write_artifacts(disk_target, disk_out, source["assets"])
    assert cli("inspect", "--file", disk_project)["data"] == disk_doc
    assert json.loads(disk_seed.read_bytes()) == json.loads(disk_project.read_bytes())
    disk = ["--file", file]
    session = ["--session", descriptor]
    old_disk = cli("status", *disk)["revision"]
    proc = subprocess.Popen(["node", str(ENTRY), "serve", *disk, *session], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8")
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    ctx.add_init_script("""(() => {
      window.boardDatabasesOpened = [];
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function(name, ...args) {
        window.boardDatabasesOpened.push(name);
        return open.call(this, name, ...args);
      };
    })();""")
    page = ctx.new_page()
    page.set_default_timeout(8000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        line = proc.stdout.readline()
        assert line, proc.stderr.read()
        launch = json.loads(line)
        creds = json.loads(descriptor.read_text(encoding="utf-8"))
        port = creds["port"]
        origin = f"http://127.0.0.1:{port}"
        headers = {"Origin": origin, "Content-Type": "application/json", "Authorization": "Bearer " + creds["token"]}
        assert http(port, "/cli", {**headers, "Origin": "null"}) == 403
        assert http(port, "/cli", {**headers, "Host": "wrong.invalid"}) == 403
        assert http(port, "/cli", {**headers, "Authorization": ""}) == 403
        assert http(port, "/page/open", headers) == 403
        assert http(port, "/unknown", headers) == 404
        assert cli("status", *session, code=4)["code"] == "OFFLINE"
        page.goto(launch["url"])
        expect(layer(page)).to_contain_text("提交预约")
        page.wait_for_function("!document.body.inert")
        assert page.evaluate("boardDatabasesOpened") == [], "CLI page opened the local board stores"
        before = cli("status", *session)
        assert not before["dirty"]
        png_report = {}
        if png:
            png_report = check_png_pixels(work, out, source)
            check_layer_controls(page, session, disk, work)
        invalid = patch(before["revision"], "rollback", "should roll back")
        invalid["operations"].append({"op": "update", "id": "flow-submit", "fields": {"width": 7.25}})
        assert cli("apply", *session, "--batch", "-", data=invalid, code=2)["code"] == "INVALID"
        assert cli("status", *session)["revision"] == before["revision"]
        batch = patch(before["revision"], "lost-reply-1", "CLI 已处理")
        batch["operations"].append({"op": "topic", "id": "mind-booking", "topicId": "topic-root",
                                    "fields": {"text": "预约评审"}})
        batch["operations"].append({"op": "addTopic", "id": "mind-booking", "topicId": "topic-root",
                                    "relation": "child", "text": "回执追踪"})
        # Drop the caller connection after the page has applied the batch and before the server gets its reply.
        lost = client.HTTPConnection("127.0.0.1", port, timeout=5)
        observed = {}

        def drop_response(route):
            result = route.request.post_data_json["result"]
            observed.update(result["data"])
            lost.close()
            route.continue_()

        page.route("**/page/result", drop_response, times=1)
        lost.request("POST", "/cli", json.dumps({"command": "apply", "args": batch}), headers)
        expect(layer(page)).to_contain_text("CLI 已处理")
        expect(layer(page, "mind-booking")).to_contain_text("预约评审")
        for _ in range(100):
            if observed:
                break
            page.wait_for_timeout(20)
        assert observed.get("appliedRevision")
        assert cli("inspect", *disk, "--id", "flow-submit")["data"]["label"] == "提交预约"
        select_layer(page, section="节点文字")
        field = page.get_by_role("textbox", name="节点文字", exact=True)
        draft = patch(observed["appliedRevision"], "during-draft", "must not replace input")
        # Exercise a composition that remains pending after keyboard focus moves.
        field.focus()
        field.dispatch_event("compositionstart")
        field.fill("尚未确认")
        page.locator("#zoom-in").focus()
        assert cli("apply", *session, "--batch", "-", data=draft, code=3)["code"] == "BUSY"
        assert field.input_value() == "尚未确认"
        field.fill("CLI 已处理")
        field.dispatch_event("compositionend")
        field.focus()
        field.select_text()
        ime = ctx.new_cdp_session(page)
        ime.send("Input.imeSetComposition", {"text": "页面已确认", "selectionStart": 5, "selectionEnd": 5})
        if png:
            private_sha = check_draft_png(page, session, work)
        assert cli("apply", *session, "--batch", "-", data=draft, code=3)["code"] == "BUSY"
        assert field.input_value() == "页面已确认"
        ime.send("Input.insertText", {"text": "页面已确认"})
        page.locator("#zoom-in").focus()
        ime.detach()
        ui = cli("inspect", *session, "--id", "flow-submit")
        assert ui["data"]["label"] == "页面已确认"
        assert not cli("edit-state", *session, "--id", "flow-submit")["busy"]
        if png:
            meta=cli("png",*session,"--id","flow-submit","--scale","2","--out",out/"session-node.png")
            read_png(out/"session-node.png",meta)
            assert meta["revision"]==ui["revision"] and meta["sha256"]!=private_sha
            png_report["draftExcluded"]=True
            png_report["stateChecks"]=["selection","focus","private-draft","busy-write","stale-layer-token",
                                       "locked-source","inherited-hide","explicit-target","session-only-layer-change"]
        replay = cli("apply", *session, "--batch", "-", data=batch)
        assert replay["replayed"] and replay["revision"] == ui["revision"]
        assert replay["appliedRevision"] == observed["appliedRevision"] != ui["revision"]
        receipt = cli("receipt", *session, "--id", batch["operationId"])
        assert receipt["appliedRevision"] == replay["appliedRevision"]
        assert receipt["results"] == replay["results"] == observed["results"]
        created = receipt["results"][0]["topicId"]
        actual_map = cli("inspect", *session, "--id", "mind-booking")["data"]
        assert actual_map["topics"]["topic-root"]["childIds"].count(created) == 1
        assert cli("apply", *session, "--batch", "-", data={**batch, "operationId": "stale"}, code=3)["code"] == "STALE"
        assert cli("apply", *session, "--batch", "-", data={**batch, "label": "changed"}, code=3)["code"] == "ID_CONFLICT"
        assert cli("status", *session)["revision"] == ui["revision"]
        page.locator("#undo").click()
        expect(layer(page)).to_contain_text("CLI 已处理")
        rev = cli("status", *session)["revision"]
        step = cli("undo", *session, "--rev", rev)
        expect(layer(page)).to_contain_text("提交预约")
        expect(layer(page, "mind-booking")).to_contain_text("会议室预约")
        cli("redo", *session, "--rev", step["revision"])
        page.locator("#redo").click()
        expect(layer(page)).to_contain_text("页面已确认")
        expect(layer(page, "mind-booking")).to_contain_text("预约评审")
        layout_position = check_layout_and_subtree(page, session)
        _, live_structure = edit_structure(session, page=page)
        # First the page wins a save; a CLI batch prepared against the old file must leave its bytes alone.
        page.locator("#save").click()
        expect(page.locator("#status")).to_contain_text("已保存到工程文件")
        latest = file.read_bytes()
        assert json.loads(latest)["document"]["objects"]["flow-submit"]["label"] == "页面已确认"
        assert cli("apply", *disk, "--batch", "-", data=patch(old_disk, "old-disk", "older disk draft"), code=3)["code"] == "STALE"
        assert file.read_bytes() == latest
        # Reverse the writers. Keep a real page draft, then let a disk CLI save win.
        set_label(page, "页面保留的草稿")
        current = cli("status", *disk)["revision"]
        cli("apply", *disk, "--batch", "-", data=patch(current, "disk-wins", "磁盘另存的修改"))
        winner = file.read_bytes()
        pending = cli("status", *session)
        assert not pending["busy"], pending
        assert cli("save", *session, "--rev", pending["revision"], code=3)["code"] == "STALE"
        assert file.read_bytes() == winner
        retained = cli("inspect", *session, "--id", "flow-submit")
        assert retained["dirty"] and retained["data"]["label"] == "页面保留的草稿"
        assert cli("inspect", *disk, "--id", "flow-submit")["data"]["label"] == "磁盘另存的修改"
        artifact, preview, archive = write_artifacts(session, out, source["assets"])
        if png:
            meta=cli("png",*session,"--out",out/"session.png")
            read_png(out/"session.png",meta)
            assert meta["revision"]==retained["revision"] and meta["objectCount"]==9
            png_report["sessionSha256"]=meta["sha256"]
        exported = json.loads(artifact.read_bytes())
        assert export_page(page, work / "browser-export.mgcanvas") == exported
        assert file.read_bytes() == winner and exported["assets"] == source["assets"]
        arrange_report = {}
        if arrange:
            from ai.arrange_checks import check_arrange
            arrange_report = check_arrange(cli, layer, select_layer, set_label, page, session, out)
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        ctx.close()
    # Fresh browser context, no server and no network. Import the actual export through the normal HTML file picker.
    offline = browser.new_context(viewport={"width": 1440, "height": 900}, offline=True, accept_downloads=True)
    page = offline.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    traffic = []
    page.on("request", lambda r: traffic.append(r.url) if r.url.startswith(("http:", "https:")) else None)
    page.goto(preview.as_uri())
    expect(layer(page)).to_contain_text("页面保留的草稿")
    expect(layer(page, "mind-booking")).to_contain_text("预约评审")
    current_build = subprocess.check_output(["node", "--input-type=module", "-e",
        "import {previewFile} from './scripts/release.mjs'; console.log(previewFile)"], cwd=ROOT, text=True).strip()
    built_html = ROOT / "dist" / current_build
    page.goto(built_html.as_uri())
    page.locator("#project-picker").set_input_files(artifact)
    expect(page.locator("#status")).to_contain_text("项目已打开")
    expect(layer(page)).to_contain_text("页面保留的草稿")
    show_panel(page, "layers")
    expect(layer(page, "qa-picture")).to_be_visible()
    roundtrip = export_page(page, work / "reopened.mgcanvas")
    assert roundtrip == exported and roundtrip["assets"] == source["assets"]
    restored = roundtrip["document"]["objects"]
    assert restored["flow-review"]["at"] == layout_position
    assert restored["flow-first"] == source["document"]["objects"]["flow-first"]
    assert restored["mind-booking"]["topics"]["topic-display"]["childIds"] == ["topic-booking"]
    assert restored["mind-booking"]["topics"]["topic-booking"]["childIds"] == ["topic-detail"]
    assert restored["mind-booking"]["topics"]["stage-review"]["childIds"] == [live_structure["generatedTopic"]]
    expect(layer(page, "stage-node")).to_contain_text("交付上线")
    page.screenshot(path=out / "offline.png")
    page.goto(disk_preview.as_uri())
    expect(layer(page, "stage-node")).to_contain_text("交付上线")
    select_layer(page, "mind-booking")
    expect(page.locator('#topic-tree [data-topic-id="' + disk_structure["generatedTopic"] + '"]')).to_contain_text("验收记录")
    page.goto(built_html.as_uri())
    page.locator("#project-picker").set_input_files(disk_project)
    expect(page.locator("#status")).to_contain_text("项目已打开")
    show_panel(page, "layers")
    expect(layer(page, "qa-picture")).to_be_visible()
    disk_reopened = work / "disk-reopened.mgcanvas"
    disk_roundtrip = export_page(page, disk_reopened)
    assert disk_roundtrip == json.loads(disk_project.read_bytes())
    # The package stores some connector properties in its compatibility metadata.
    assert cli("inspect", "--file", disk_reopened)["data"] == disk_doc
    assert disk_roundtrip["assets"] == source["assets"]
    page.screenshot(path=disk_out / "offline.png")
    if arrange:
        proof = out / "arrange"
        page.goto(built_html.as_uri())
        page.locator("#project-picker").set_input_files(proof / "session-edited.mgcanvas")
        expect(page.locator("#status")).to_contain_text("项目已打开")
        select_layer(page, arrange_report["arrangedCapture"]["id"], section="变换")
        expect(page.locator('#inspector [data-shape-properties] input[name="x"]')).to_have_value("-422")
        expect(page.locator('#inspector [data-shape-properties] input[name="y"]')).to_have_value("-400")
        show_panel(page, "layers")
        expect(layer(page, "qa-picture")).to_be_visible()
        restored = export_page(page, proof / "offline-reopened.mgcanvas")
        assert restored == json.loads((proof / "disk-edited.mgcanvas").read_bytes())
        assert restored["assets"] == source["assets"]
        arrange_report["offlineReopened"] = True
        arrange_report["offlineNetworkRequests"] = len(traffic)
        (proof / "verification.json").write_text(json.dumps(arrange_report, indent=2), encoding="utf-8")
    offline.close()
    assert not traffic and not errors, (traffic, errors)
    return {**({"png":png_report} if png else {}),**({"arrange":arrange_report} if arrange else {}),"browser": browser.version, "batchAppliedRevision": replay["appliedRevision"], "afterPageEdit": replay["revision"],
            "imageSha256": {k: hashlib.sha256(base64.b64decode(v)).hexdigest() for k, v in source["assets"].items()},
            "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "offlineNetworkRequests": len(traffic),
            "structure": {"disk": disk_structure, "session": live_structure},
            "diskArchiveSha256": hashlib.sha256(disk_zip.read_bytes()).hexdigest(),
            "layoutPosition": layout_position, "subtreePath": ["topic-root", "topic-display", "topic-booking", "topic-detail"],
            "verified": ["cli-to-page", "page-to-cli", "no-local-board-store", "one-undo", "atomic-rollback", "draft-busy", "lost-reply",
                         "stale-new-id", "different-content", "disk-wins", "page-wins", "zip", "offline-project-reopen",
                         "flow-layout", "subtree-move", "descendant-rollback", "combined-layout-undo-redo",
                         "disk-structure-save-export-preview-offline", "session-structure-save-export-preview-offline",
                         "root-delete-rollback", "structure-batch-page-undo", "generated-id-loss-and-replay"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="new directory to keep the real output files")
    parser.add_argument("--png",action="store_true",help="also verify static PNG pixels and session edit controls; requires Pillow")
    parser.add_argument("--arrange",action="store_true",help="verify pixel-guided disk/session arrangement, one undo and stale image rejection; requires Pillow")
    parser.add_argument("--browser", help="local Chrome or Edge executable")
    args = parser.parse_args()
    exe = args.browser or next((str(p) for p in [
        Path(os.environ.get("ProgramFiles", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft/Edge/Application/msedge.exe"] if p.is_file()), None)
    with tempfile.TemporaryDirectory(prefix="mgcanvas-e2e-") as directory, sync_playwright() as pw:
        work = Path(directory)
        out = (args.out or work / "artifacts").resolve()
        out.mkdir()
        if (args.png or args.arrange) and args.browser:
            os.environ["MGCANVAS_BROWSER"]=str(Path(args.browser).resolve())
        browser = pw.chromium.launch(executable_path=exe, headless=True)
        try:
            report = run(browser, work, out, args.png, args.arrange)
        finally:
            browser.close()
        (out / "verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report))


if __name__ == "__main__":
    main()
