"""Check the successor layout preview, pointer and touch activation, and saved project in Chromium."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def fixture():
    labels = dict(start="审批", yes="通过", no="退回", join="汇合", before="上游", aside="独立")
    def shape(name, x, y, kind="rect"):
        width, height = (112, 90) if kind == "diamond" else (136, 62)
        return dict(id=name, kind="shape", shape=kind, at=dict(x=x, y=y), width=width, height=height,
                    rotation=0, cornerRadius=5, fill="#e1eafd", stroke="#546f99", label=labels[name])

    def edge(name, source, target, outlet="east", inlet="west", label="", pins=()):
        return dict(id=name, kind="connector", routing="orthogonal", arrow="end", label=label, stroke="#546f99",
                    waypoints=[dict(x=x, y=y) for x, y in pins],
                    **{"from": dict(kind="anchor", objectId=source, portId=outlet),
                       "to": dict(kind="anchor", objectId=target, portId=inlet)})

    rows = [shape("start", 60, 60, "diamond"), shape("yes", 360, 220), shape("no", 270, -140),
            shape("join", 580, 205), shape("before", -185, 60), shape("aside", -130, 240),
            edge("entry", "before", "start"), edge("approved", "start", "yes", "north", "west", "Yes", [(190, 10)]),
            edge("rejected", "start", "no", "south", "west", "No"), edge("yes-join", "yes", "join"),
            edge("no-join", "no", "join"), edge("retry", "join", "no", "south", "east", "修改", [(645, 310)])]
    return dict(format="mg-canvas.project", version=1, assets={}, document=dict(
        id="successor-layout", schemaVersion=1, theme="paper", order=[v["id"] for v in rows],
        objects={v["id"]: v for v in rows}, assets={}))


def successive_forks(routing):
    positions = [(0,0),(176,0),(352,-45),(352,45),(528,0),(528,90),(704,90)]
    nodes = [dict(kind="shape", id=key, shape="rect", at=dict(x=x,y=y), width=136,height=62,rotation=0,
                  cornerRadius=9,fill="#d4dce7",stroke="#6598d6",label="流程 "+key.upper())
             for key,(x,y) in zip("abcdefg",positions)]
    lines = []
    for first,last in ["ab","bc","bd","de","df","fg"]:
        fork = last in ("d","f")
        lines.append(dict(id=first+last, kind="connector", arrow="end", routing=routing, waypoints=[],label="",stroke="#475a75",
                     **{"from":dict(kind="anchor",objectId=first,portId="south" if fork else "east"),
                        "to":dict(kind="anchor",objectId=last,portId="north" if fork else "west")}))
    all_items = nodes + lines
    ids = [v["id"] for v in lines]
    return dict(format="mg-canvas.project",version=1,assets={},autoFrom=ids,autoTo=ids,uneditedConnectors=ids,
                **({"portCurves":ids} if routing=="curve" else {}),document=dict(schemaVersion=1,id="nested-forks",theme="paper",
                order=[v["id"] for v in all_items],objects={v["id"]:v for v in all_items},assets={}))


def check(page, preview, shots):
    page.set_default_timeout(6000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    page.add_init_script("""{
      window.painted = {};
      const fill = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text,x,y,...args){
        if(this.canvas.id==='canvas' && this.textAlign==='center'){
          const p=new DOMPoint(x,y).matrixTransform(this.getTransform()), r=this.canvas.getBoundingClientRect();
          painted[text]=[r.x+p.x*r.width/this.canvas.width, r.y+p.y*r.height/this.canvas.height];
        }
        return fill.call(this,text,x,y,...args);
      };
    }""")
    page.goto(preview.resolve().as_uri())
    expect(page.locator("#layers .layer").first).to_be_attached()
    original = fixture()

    def frame():
        page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

    def load(project):
        page.locator("#project-picker").set_input_files(dict(name="审批流程.mgcanvas", mimeType="application/json",
                                                           buffer=json.dumps(project, ensure_ascii=False).encode()))
        expect(page.locator("#status")).to_contain_text("项目已打开")
        expect(page.locator("#layers .layer")).to_have_count(len(project["document"]["order"]))
        page.locator("#fit").click()
        frame()

    def saved():
        with page.expect_download() as download:
            page.locator("#project-export").evaluate("e=>e.click()")
        return json.loads(Path(download.value.path()).read_bytes())

    labels = ["审批", "通过", "退回", "汇合", "上游", "独立"]

    def points():
        frame()
        return page.evaluate("keys=>Object.fromEntries(keys.map(k=>[k,painted[k]]))", labels)

    def select(name):
        xy = points()[name]
        assert xy, (name, page.evaluate("Object.keys(painted)"), errors)
        assert page.evaluate("p=>document.elementFromPoint(...p)?.id", xy) == "canvas", (name, xy, page.locator("#zoom-read").inner_text(),errors)
        page.mouse.click(*xy)
        frame()

    button = page.get_by_role("button", name="排列后续节点", exact=True)
    help_text = page.locator("#flow-help")
    undo, redo = page.locator("#undo"), page.locator("#redo")
    load(original)
    select("审批")
    before = points()
    button.hover()
    expect(help_text).to_contain_text("预览 3 个后续节点")
    projected = points()
    assert projected["通过"][1] < projected["审批"][1] < projected["退回"][1]
    assert projected["汇合"][0] > projected["通过"][0] > projected["审批"][0]
    for name in ["上游", "独立", "审批"]:
        assert projected[name] == before[name]
    assert projected != before and saved() == original
    expect(undo).to_be_disabled()
    page.keyboard.press("Escape")
    expect(help_text).not_to_contain_text("预览")
    assert points() == before
    expect(button).to_be_visible()
    page.mouse.move(1, 1)
    button.hover()
    page.mouse.move(1, 1)
    expect(help_text).not_to_contain_text("预览")
    assert points() == before

    # Re-enter the action and apply the exact on-screen preview with one pointer click.
    page.mouse.move(1, 1)
    button.hover()
    expect(help_text).to_contain_text("预览 3 个后续节点")
    button.click()
    expect(page.locator("#status")).to_contain_text("已排列 3 个后续节点")
    assert points() == projected
    arranged = saved()
    for key, item in original["document"]["objects"].items():
        final = arranged["document"]["objects"][key]
        if key in ["yes", "no", "join"]:
            assert final["at"] != item["at"] and dict(final, at=item["at"]) == item
        else:
            assert final == item
    undo.click()
    assert saved() == original
    expect(undo).to_be_disabled()
    redo.click()
    assert saved() == arranged
    load(arranged)
    assert saved() == arranged
    select("审批")
    button.focus()
    expect(help_text).to_contain_text("3 个后续节点已按当前流向排齐")
    button.press("Enter")
    expect(undo).to_be_disabled()
    select("独立")
    button.hover()
    expect(help_text).to_contain_text("没有可排列的后续节点")
    button.click()
    expect(undo).to_be_disabled()

    for routing in ["curve", "orthogonal"]:
        initial = successive_forks(routing)
        labels = [n["label"] for n in initial["document"]["objects"].values() if n["kind"]=="shape"]
        load(initial)
        for _ in range(2):
            page.locator("#zoom-out").click()
        select("流程 A")
        before_forks = points()
        if shots:
            shots.mkdir(parents=True,exist_ok=True)
            page.screenshot(path=shots / ("downstream-"+routing+"-before.png"))
        button.hover()
        expect(help_text).to_contain_text("预览 6 个后续节点")
        shown = points()
        assert shown["流程 A"]==before_forks["流程 A"]
        assert all(abs(shown["流程 "+k][1]-shown["流程 A"][1])<.01 for k in "BDFG"),shown
        assert abs(shown["流程 C"][1]-shown["流程 E"][1])<.01 and shown["流程 C"][1]<shown["流程 D"][1],shown
        assert saved()==initial
        button.click()
        expect(page.locator("#status")).to_contain_text("已排列 6 个后续节点")
        page.wait_for_function("before=>Object.entries(before).every(([k,p])=>painted[k]?.every((n,i)=>Math.abs(n-p[i])<.01))",arg=shown)
        page.mouse.move(1,1)
        if shots:
            page.screenshot(path=shots / ("downstream-"+routing+"-after.png"))
        final = saved()
        for key in initial["autoFrom"]:
            line = final["document"]["objects"][key]
            assert line["from"]==dict(kind="anchor",objectId=key[0],portId="east")
            assert line["to"]==dict(kind="anchor",objectId=key[1],portId="west")
            assert line["routing"]==routing
        button.hover()
        expect(help_text).to_contain_text("已按当前流向排齐")
        button.click()
        assert saved()==final
        undo.click()
        assert saved()==initial
        expect(undo).to_be_disabled()
        redo.click()
        assert saved()==final
        load(final)
        assert saved()==final

    labels = ["审批", "通过", "退回", "汇合", "上游", "独立"]
    page.set_viewport_size({"width": 390, "height": 780})
    page.locator("label:has(#theme-dark)").click()
    load(original)
    # At fit-to-board on a narrow phone the renderer omits labels smaller than five pixels.
    for _ in range(2):
        page.locator("#zoom-in").click()
    select("审批")
    bar = page.locator("#text-format-bar").bounding_box()
    assert bar["x"] >= 0 and bar["x"] + bar["width"] <= 391, bar
    button.tap()
    expect(help_text).to_contain_text("预览 3 个后续节点")
    expect(undo).to_be_disabled()
    button.tap()
    expect(undo).to_be_enabled()
    assert saved() == arranged
    assert not errors, errors
    print("Verified paint coordinates before/during/after preview, fixed upstream and unrelated nodes, "
          "decision ports, joined branch with a feedback edge, consecutive forks in curve and orthogonal routing, "
          "Esc, one click/two taps, undo/redo and reopening.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview", type=Path)
    parser.add_argument("--shots",type=Path)
    args = parser.parse_args()
    with sync_playwright() as pw, pw.chromium.launch(channel="chrome") as browser:
        check(browser.new_page(viewport={"width": 1440, "height": 900}, has_touch=True), args.preview,args.shots)
