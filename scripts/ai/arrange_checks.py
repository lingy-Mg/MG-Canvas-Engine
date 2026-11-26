"""Verify native arrangement and pixel-guided edits against an already-open test session."""
import json
import math

from PIL import Image, ImageChops
from playwright.sync_api import expect

MARKER = (222, 45, 106)
LEFT = "swatch-a17"
RIGHT = "swatch-c32"


def locate(cli, target, path, scale):
    frame = cli("png", *target, "--out", path, "--scale", scale)
    with Image.open(path) as png:
        png.load()
        assert png.format == "PNG" and png.size == (frame["width"], frame["height"])
        red, green, blue = png.convert("RGB").split()
        masks = [band.point(lambda v, key=key: 255 if v == key else 0)
                 for band, key in zip((red, green, blue), MARKER)]
        mask = ImageChops.multiply(masks[0], ImageChops.multiply(masks[1], masks[2]))
        box = mask.getbbox()
        assert box and mask.histogram()[255] > 200, "Marker pixels missing"
    # Pillow boxes are half open. This is the center of the matching pixel footprint.
    px, py = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    wx = (px - frame["offset"]["x"]) / frame["scale"]
    wy = (py - frame["offset"]["y"]) / frame["scale"]
    inspected = cli("inspect", *target)
    assert inspected["revision"] == frame["revision"], "Re-capture before matching a changed board"
    candidates = []
    for item in inspected["data"]["objects"].values():
        if item["kind"] != "shape" or item["shape"] != "rect":
            continue
        dx = wx - (item["at"]["x"] + item["width"]/2)
        dy = wy - (item["at"]["y"] + item["height"]/2)
        angle = item["rotation"]
        x, y = dx*math.cos(angle) + dy*math.sin(angle), -dx*math.sin(angle) + dy*math.cos(angle)
        if abs(x) < item["width"]/2 and abs(y) < item["height"]/2:
            candidates.append(item)
    assert len(candidates) == 1, "Ambiguous visual hit"
    hit = candidates[0]
    assert hit["fill"].lower() == "#de2d6a" and wx < 0 and wy < 0
    return {"id": hit["id"], "source": frame["source"], "revision": frame["revision"], "scale":frame["scale"],
            "offset":frame["offset"], "pixelBounds":box, "centerPx":[px,py], "world":[wx,wy], "pngSha256":frame["sha256"]}


def arrange_from_capture(cli, target, seen):
    obj = seen["id"]
    ids = [LEFT, obj, RIGHT]
    request = {"operationId":"arrange-" + seen["source"], "baseRevision":seen["revision"], "operations":[
        {"op":"update","id":obj,"fields":{"label":"按图定位"}},
        {"op":"arrange","command":"top","ids":ids},
        {"op":"arrange","command":"distribute-x","ids":ids},
        {"op":"arrange","command":"front","ids":[obj]},
    ]}
    result = cli("apply",*target,"--batch","-",data=request)
    assert result["changed"] and [row["index"] for row in result["results"]] == [1,2,3]
    assert all(row["changed"] for row in result["results"])
    state = cli("inspect",*target)
    assert state["revision"] == result["appliedRevision"]
    doc = state["data"]
    first, marked, last = (doc["objects"][key] for key in ids)
    assert all(item["at"]["y"] == -400 for item in (first,marked,last))
    assert marked["at"]["x"] == -422 and marked["label"] == "按图定位"
    assert marked["at"]["x"]-first["at"]["x"]-first["width"] == last["at"]["x"]-marked["at"]["x"]-marked["width"] == 132
    assert doc["order"][-1] == obj
    return doc, result


def check_protected_layers(cli, session, revision, marker):
    ids = [LEFT, marker, RIGHT]
    starting = cli("inspect", *session)["data"]
    for flag, protected, restored in (("--locked", "true", "false"), ("--visible", "false", "true")):
        state = cli("edit-state", *session, "--id", marker)
        cli("set-layer", *session, "--id", marker, "--rev", state["stateRevision"], flag, protected)
        attempt = {"baseRevision": revision, "operationId": "guard-" + flag[2:], "operations": [
            {"op": "update", "id": LEFT, "fields": {"label": "应整批撤回"}},
            {"op": "arrange", "command": "top", "ids": ids},
        ]}
        assert cli("apply", *session, "--batch", "-", data=attempt, code=3)["code"] == "CONFLICT"
        current = cli("inspect", *session)
        assert current["revision"] == revision and current["data"] == starting
        state = cli("edit-state", *session, "--id", marker)
        cli("set-layer", *session, "--id", marker, "--rev", state["stateRevision"], flag, restored)


def check_arrange(cli, layer, select_layer, set_label, page, session, out):
    proof = out/"arrange"
    proof.mkdir()
    snapshot = cli("inspect",*session)
    prototype = snapshot["data"]["objects"]["flow-submit"]
    # The scanner only receives the color, PNG and same-revision model. IDs are resolved after decoding.
    swatches = [(LEFT,-650,-400,96,48,"#6292bd"),("swatch-b09",-510,-280,80,52,"#de2d6a"),
                (RIGHT,-210,-200,96,54,"#78a66a")]
    ops = [{"op":"create","value":dict(prototype,id=id,shape="rect",rotation=0,cornerRadius=3,label="",
                                       at={"x":x,"y":y},width=w,height=h,fill=color)}
           for id,x,y,w,h,color in swatches]
    cli("apply",*session,"--batch","-",data={"operationId":"prepare-swatches","baseRevision":snapshot["revision"],"operations":ops})
    before = cli("inspect",*session)
    seed = proof/"initial.mgcanvas"
    cli("export",*session,"--out",seed)
    disk_path = proof/"disk-edited.mgcanvas"
    disk_path.write_bytes(seed.read_bytes())
    disk = ["--file",disk_path]
    disk_before = locate(cli,disk,proof/"disk-before.png","0.75")
    session_before = locate(cli,session,proof/"before.png","1.25")
    for seen in (disk_before,session_before):
        assert seen["id"] not in (LEFT,RIGHT)
        assert abs(seen["world"][0]+470) <= 1/seen["scale"] and abs(seen["world"][1]+254) <= 1/seen["scale"]
    assert before["revision"] == session_before["revision"]
    check_protected_layers(cli, session, session_before["revision"], session_before["id"])
    disk_doc, disk_result = arrange_from_capture(cli,disk,disk_before)
    live_doc, live_result = arrange_from_capture(cli,session,session_before)
    assert disk_doc == live_doc and disk_result["results"] == live_result["results"]
    target = session_before["id"]
    select_layer(page, target, section="变换")
    expect(layer(page,target)).to_contain_text("按图定位")
    expect(page.locator('#inspector [data-shape-properties] input[name="x"]')).to_have_value("-422")
    expect(page.locator('#inspector [data-shape-properties] input[name="y"]')).to_have_value("-400")
    page.locator("#undo").click()
    undone = cli("inspect",*session)
    assert undone["data"] == before["data"]
    page.locator("#redo").click()
    assert cli("inspect",*session)["data"] == live_doc
    matched = proof/"session-edited.mgcanvas"
    cli("export",*session,"--out",matched)
    assert disk_path.read_bytes() == matched.read_bytes()
    assert json.loads(matched.read_bytes())["assets"] == json.loads(seed.read_bytes())["assets"]
    after = locate(cli,session,proof/"after.png","1.25")
    assert after["id"] == target and after["revision"] != session_before["revision"]
    assert abs(after["world"][0]+382) < 1 and abs(after["world"][1]+374) < 1
    # A real competing page commit edits the very object found in the second image.
    set_label(page, "页面先提交", target)
    latest = cli("inspect",*session)
    assert latest["revision"] != after["revision"] and latest["data"]["objects"][target]["label"] == "页面先提交"
    stale = {"operationId":"stale-from-image","baseRevision":after["revision"],"operations":[
        {"op":"arrange","command":"back","ids":[target]},{"op":"update","id":target,"fields":{"label":"旧图编辑"}}]}
    refusal = cli("apply",*session,"--batch","-",data=stale,code=3)
    assert refusal["code"] == "STALE"
    retained = cli("inspect",*session)
    assert retained["revision"] == latest["revision"] and retained["data"] == latest["data"]
    expect(layer(page,target)).to_contain_text("页面先提交")
    report = {"diskCapture":disk_before,"sessionCapture":session_before,"arrangedCapture":after,
              "appliedRevision":live_result["appliedRevision"],"pageRevision":latest["revision"],
              "staleCode":refusal["code"],"gapWorld":132,"restoredByOneUndo":True,"identicalDiskAndSessionExports":True,
              "guardedWholeBatch":["locked","hidden"],"retainedPageEdit":True,"staleExitCode":3,
              "results":live_result["results"]}
    return report
