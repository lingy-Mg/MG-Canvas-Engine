"""Verify native WebMCP, render feedback and editing in isolated Chrome profiles."""
import argparse
import hashlib
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DIAGRAM = ROOT / "docs/fixtures/MG-Canvas-Edit-Lifecycle.mgcanvas"
ORIGINAL_LAYOUT = ROOT / "tests/fixtures/edit-lifecycle-horizontal-fields.json"
SAMPLE = ["session-drag", "change-note", "change-set"]
TOOL_NAMES = {"canvas_read", "canvas_edit", "canvas_draw_flow", "canvas_history", "canvas_view"}


class StaticFiles(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


PAINT = r"""(() => {
  window.qaText = [];
  const draw = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
    if (this.canvas.id === 'canvas' && /session|编辑请求|通过|版本存储/i.test(text)) {
      const matrix = this.getTransform(), size = Number(this.font.match(/([.\d]+)px/)[1]);
      qaText.push({text, size: size * Math.hypot(matrix.a, matrix.b) / devicePixelRatio});
    }
    return draw.call(this, text, ...args);
  };
})();"""


def verify_groups(page, call):
    page.locator("#project-picker").set_input_files(ROOT / "docs/fixtures/M5X-Flow-Groups.mgcanvas")
    page.wait_for_function("document.querySelector('#layers [data-id=outside]') !== null")
    ids = ["a", "outside"]
    before = call("canvas_read", {"ids": ids, "detail": "full"})
    diagram = "flowchart TD\nsubgraph ui[交互层]\nA[输入] --> B[提交]\nend\nsubgraph store[存储层]\nC[保存] --> D[恢复]\nend\nB -->|写入| C"
    drawn = call("canvas_draw_flow", {"baseRevision": before["revision"], "operationId": "partitions", "mermaid": diagram})
    ui, db = drawn["groups"]
    titles = call("canvas_read", {"ids": [ui["titleId"], db["titleId"]]})["objects"]
    assert [(o["label"], o["group"]) for o in titles] == [("交互层", ui["id"]), ("存储层", db["id"])]
    edge = call("canvas_read", {"ids": [drawn["edgeIdMap"]["edge.1.B.C"]]})["objects"][0]
    assert edge["from"]["objectId"] == drawn["nodeIdMap"]["B"] and edge["to"]["objectId"] == drawn["nodeIdMap"]["C"]
    old = call("canvas_read", {"ids": ids, "detail": "full"})
    assert old["objects"] == before["objects"] and [o["group"] for o in old["objects"]] == ["group-intake", "group-review"]
    call("canvas_history", {"baseRevision": old["revision"], "operationId": "undo-partitions", "action": "undo"})
    after = call("canvas_read", {"ids": ids, "detail": "full"})
    assert after["board"] == before["board"] and after["objects"] == before["objects"]


def replay_append(page, call, directory):
    records = json.loads((directory / "calls.json").read_text(encoding="utf-8"))
    page.set_viewport_size({"width": 1280, "height": 840})
    page.locator("#project-picker").set_input_files(directory / "seed.mgcanvas")
    page.wait_for_function("document.querySelector('#layers [data-id=existing-note]') !== null")
    translated = {}
    def remap(arg):
        if isinstance(arg, dict):
            return {k: remap(v) for k, v in arg.items()}
        if isinstance(arg, list):
            return [remap(v) for v in arg]
        return translated.get(arg, arg)

    new_flow = {}
    comparison = {}
    for row in records:
        previous = row["result"]["structuredContent"]
        if row["phase"] == "650px 整板复核":
            page.set_viewport_size({"width": 650, "height": 760})
        if row["phase"] in ["650px 整板复核", "650px 分区复核"]:
            page.evaluate("qaText.length = 0")
        result = call(row["name"], remap(row["arguments"]), error=previous.get("code"))
        if result.get("ok"):
            translated[previous["revision"]] = result["revision"]
        if row["name"] == "canvas_draw_flow" and result.get("ok"):
            for key in ["nodeIdMap", "edgeIdMap"]:
                translated.update({v: result[key][k] for k, v in previous[key].items()})
            if not new_flow:
                new_flow = result
        if row["phase"] in ["650px 整板复核", "650px 分区复核"]:
            node = new_flow["nodeIdMap"]["A"]
            edge = new_flow["edgeIdMap"]["edge.1.B.C"]
            old_sizes = {remap(t["id"]): t["minFontPx"] for t in previous["screenText"]}
            new_sizes = {t["id"]: t["minFontPx"] for t in result["screenText"]}
            comparison[row["phase"]] = {"previous": [old_sizes[node], old_sizes[edge]], "current": [new_sizes[node], new_sizes[edge]],
                                        "zoom": result["viewport"]["zoom"]}
            page.wait_for_function("""samples => samples.every(([text, size]) =>
              qaText.some(t => t.text === text && Math.abs(t.size - size) < .012))""",
                                   arg=[["编辑请求", new_sizes[node]], ["通过", new_sizes[edge]]])
    full, section = comparison["650px 整板复核"], comparison["650px 分区复核"]
    assert full["zoom"] > .75 and full["current"][0] > 11 and full["current"][1] > 9, comparison
    assert section["zoom"] == 1.3 and all(new >= old for new, old in zip(section["current"], section["previous"])), comparison
    return comparison


def verify_toolbar_fit(page, call, project, evidence_dir):
    board = json.loads(project.read_text(encoding="utf-8-sig"))["document"]
    store = next(key for key, node in board["objects"].items() if node.get("label") == "版本存储")
    page.set_viewport_size({"width": 650, "height": 760})
    page.locator("#project-picker").set_input_files(project)
    page.wait_for_function("id => [...document.querySelectorAll('#layers [data-id]')].some(el => el.dataset.id === id)", arg=store)
    result = {}
    for method in ["tool", "key"]:
        call("canvas_view", {"action": "fit", "ids": [store]})
        page.evaluate("qaText.length = 0")
        if method == "tool":
            call("canvas_view", {"action": "fit", "measureIds": [store]})
        else:
            page.locator("#canvas").focus()
            page.keyboard.press("0")
        read = call("canvas_read", {"ids": [store]})
        view, bounds = read["viewport"], read["objects"][0]["bounds"]
        canvas = page.locator("#viewport").bounding_box()
        dock = page.locator("#main-tools").bounding_box()
        font = read["screenText"][0]["minFontPx"]
        page.wait_for_function("px => qaText.some(t => t.text === '版本存储' && Math.abs(t.size-px)<.012)", arg=font)
        bottom = canvas["y"] + view["offset"]["y"] + bounds["max"]["y"] * view["zoom"]
        top = canvas["y"] + view["offset"]["y"] + bounds["min"]["y"] * view["zoom"]
        left = canvas["x"] + view["offset"]["x"] + bounds["min"]["x"] * view["zoom"]
        right = canvas["x"] + view["offset"]["x"] + bounds["max"]["x"] * view["zoom"]
        assert left < dock["x"] + dock["width"] and right > dock["x"]
        assert bottom <= dock["y"] - 7.99 and font >= 12.4, (bottom, dock, font)
        assert page.evaluate("p => document.elementFromPoint(...p)?.id", [(left + right) / 2, bottom - 1]) == "canvas"
        actual_dock = next(r for r in view["occlusions"] if r["id"] == "main-tools")
        assert abs(actual_dock["top"] + canvas["y"] - dock["y"]) < .01
        branch = call("canvas_read", {"query": "通过", "kind": "connector", "limit": 1})["screenText"][0]["minFontPx"]
        result[method] = {"viewportCss": [canvas["width"], canvas["height"]], "zoom": view["zoom"], "fontCssPx": font, "branchFontCssPx": branch,
                          "nodeRect": [round(v, 2) for v in [left, top, right, bottom]],
                          "dockRect": [dock["x"], dock["y"], dock["x"] + dock["width"], dock["y"] + dock["height"]],
                          "gapCssPx": round(dock["y"] - bottom, 2)}
        if evidence_dir:
            evidence_dir.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=evidence_dir / f"group-fit-{method}.png")
    assert result["tool"] == result["key"], result
    page.locator("#tool-shapes").click()
    palette = page.locator("#shape-palette")
    assert palette.is_visible()
    read = call("canvas_view", {"action": "fit", "measureIds": [store]})
    bounds = call("canvas_read", {"ids": [store]})["objects"][0]["bounds"]
    view = read["viewport"]
    palette_box = palette.bounding_box()
    assert any(r["id"] == "shape-palette" for r in view["occlusions"])
    x = canvas["x"] + view["offset"]["x"] + view["zoom"] * (bounds["min"]["x"] + bounds["max"]["x"]) / 2
    y = canvas["y"] + view["offset"]["y"] + view["zoom"] * bounds["max"]["y"]
    assert page.evaluate("p => document.elementFromPoint(...p)?.id", [x, y - 1]) == "canvas"
    if palette_box["x"] <= x <= palette_box["x"] + palette_box["width"]:
        assert palette_box["y"] - y >= 7.99
    result["secondaryToolbar"] = {"top": palette_box["y"], "nodeBottom": round(y, 2), "zoom": view["zoom"]}
    if evidence_dir:
        evidence = {"source": project.name, "sha256": hashlib.sha256(project.read_bytes()).hexdigest(),
                    "windowCss": page.viewport_size, "nodeId": store, **result}
        (evidence_dir / "group-fit.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def verify_resize_fit(page):
    # Both operations happen before the browser can deliver a ResizeObserver notification.
    view = page.evaluate("""async () => {
      document.querySelector('#viewport').style.width = '598px';
      return (await mgCanvasTools.callTool('canvas_view',{action:'fit'})).structuredContent.viewport;
    }""")
    assert view["width"] == 598 and view["windowWidth"] == 650, view
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    settled = page.evaluate("async () => (await mgCanvasTools.callTool('canvas_read',{limit:1})).structuredContent.viewport")
    assert settled == view, (view, settled)
    page.locator("#viewport").evaluate("el => el.style.removeProperty('width')")


def discover_native(page):
    for _ in range(100):
        tools = page.evaluate("""async () => {
          const tools = await document.modelContext.getTools();
          if (tools.length !== 5) return null;
          window.qaTools = tools;
          return tools.map(({name,description,inputSchema}) => ({name,description,inputSchema}));
        }""")
        if tools is not None:
            return tools
        page.wait_for_timeout(40)
    raise AssertionError("Chrome did not finish registering the five page tools")


def verify(chromium, url, native, replay_dir, group_board, evidence_dir):
    browser = chromium.launch(channel="chrome", headless=True,
                              args=["--enable-blink-features=WebMCP"] if native else [])
    with browser:
        page = browser.new_page(viewport={"width": 650, "height": 950}, device_scale_factor=1.5)
        page.add_init_script(PAINT)
        page.on("dialog", lambda dialog: dialog.accept())
        page.goto(url)
        page.wait_for_function("window.mgCanvasTools?.listTools().length === 5")
        page.locator("#project-picker").set_input_files(DIAGRAM)
        page.wait_for_function("document.querySelector('#layers [data-id=session-drag]') !== null")
        if native:
            tools = discover_native(page)
            catalog = page.evaluate("window.mgCanvasTools.listTools()")
            assert {t["name"] for t in tools} == TOOL_NAMES
            assert sorted(tools, key=lambda t: t["name"]) == sorted(
                [{k: t[k] for k in ["name", "description", "inputSchema"]} for t in catalog], key=lambda t: t["name"])

        def call(name, args, *, error=None):
            if native:
                data = page.evaluate("""async ([name,args]) => {
                  const result = await document.modelContext.executeTool(qaTools.find(t => t.name === name), args);
                  return typeof result === 'string' ? JSON.parse(result) : result;
                }""", [name, args])
            else:
                reply = page.evaluate("([name,args]) => window.mgCanvasTools.callTool(name,args)", [name, args])
                data = reply["structuredContent"]
                assert json.loads(reply["content"][0]["text"]) == data
                assert bool(reply.get("isError")) == bool(error)
            assert data["ok"] is (not error), (name, data)
            if error:
                assert data["code"] == error, data
            return data

        start = call("canvas_read", {"limit": 1})
        assert start["board"]["objectCount"] == 30 and "screenText" not in start
        assert start["board"]["title"] == page.locator("#project-title").text_content() == "MG Canvas 编辑流程"
        # Replay the historical horizontal layout against the same objects. The single native project stays read-only.
        fields = json.loads(ORIGINAL_LAYOUT.read_text(encoding="utf-8"))
        edit = call("canvas_edit", {"baseRevision": start["revision"], "operationId": "old-layout",
                                    "operations": [{"op": "update", **row} for row in fields]})

        def fit():
            page.evaluate("qaText.length = 0")
            result = call("canvas_view", {"action": "fit", "measureIds": SAMPLE})
            view = result["viewport"]
            assert [view["windowWidth"], view["windowHeight"]] == [650, 950]
            assert [view["width"], view["height"]] == page.locator("#viewport").evaluate("el => [el.clientWidth,el.clientHeight]")
            sizes = {v["id"]: v["minFontPx"] for v in result["screenText"]}
            assert set(sizes) == set(SAMPLE)
            page.wait_for_function("expected => qaText.some(t => Math.abs(t.size - expected) < .012)", arg=sizes[SAMPLE[0]])
            return {"canvasCss": [view["width"], view["height"]], "zoom": view["zoom"], "fontCssPx": sizes}

        horizontal = fit()
        assert round(100 * horizontal["zoom"]) == 45, horizontal
        call("canvas_history", {"action": "undo", "operationId": "restore-portrait", "baseRevision": edit["revision"]})
        portrait = fit()
        # The unconstrained 119% fit puts content under the HUD. The usable portrait layout still fits at 114% or higher.
        assert 1.14 <= portrait["zoom"] <= 1.19, portrait
        assert portrait["fontCssPx"][SAMPLE[0]] > horizontal["fontCssPx"][SAMPLE[0]] * 2
        # A caller can measure all matches in one search, including labels on different native object types.
        call("canvas_view", {"action": "fit", "ids": ["undo", "change-note"]})
        search = call("canvas_read", {"query": "撤销", "limit": 8})
        found = {v["id"]: v["minFontPx"] for v in search["screenText"]}
        assert found == {"undo": 16.9, "change-note": 16.9}, found
        assert set(found) == {o["id"] for o in search["objects"]}
        stale = call("canvas_edit", {"baseRevision": edit["revision"], "operationId": "stale-write",
                                     "operations": [{"op":"update", "id":"session-drag", "fields":{"label":"stale"}}]}, error="STALE")
        assert stale["revision"] == search["revision"]
        invalid = call("canvas_edit", {"baseRevision": search["revision"], "operationId": "bad-endpoint",
                                       "operations": [{"op":"update", "id":"undo", "fields":{"label":"roll back"}},
                                                      {"op":"edge", "id":"bad", "from":"undo", "to":"missing"}]}, error="NOT_FOUND")
        assert invalid["operationIndex"] == 1
        before = call("canvas_read", {"ids": ["session-drag"], "detail": "full"})
        source = "flowchart LR\nA[提交] -->|同意| B{完成}"
        args = {"mermaid": source, "baseRevision": before["revision"], "operationId": "new-flow"}
        first = call("canvas_draw_flow", args)
        second = call("canvas_draw_flow", {**args, "operationId": "second-flow", "baseRevision": first["revision"]})
        retry = call("canvas_draw_flow", args)
        assert first["nodeIdMap"] == retry["nodeIdMap"] and first["edgeIds"] == retry["edgeIds"] and retry["replayed"]
        assert set(first["nodeIds"] + first["edgeIds"]).isdisjoint(second["nodeIds"] + second["edgeIds"])
        new_edge = call("canvas_read", {"ids": second["edgeIds"]})["objects"][0]
        assert [new_edge[port]["objectId"] for port in ["from", "to"]] == [second["nodeIdMap"][k] for k in ["A", "B"]]
        rename = {"operationId": "rename", "baseRevision": second["revision"], "operations": [
            {"op": "update", "id": second["nodeIdMap"]["B"], "fields": {"label": "验收完成"}}]}
        call("canvas_edit", rename)
        call("canvas_edit", {**rename, "operationId": "stale"}, error="STALE")
        assert call("canvas_read", {"ids": ["session-drag"], "detail": "full"})["objects"] == before["objects"]
        page.wait_for_function("document.querySelector('#status').dataset.workspace === 'saved'")
        page.reload()
        page.wait_for_function("window.mgCanvasTools?.listTools().length === 5")
        if native:
            discover_native(page)
        restored = call("canvas_read", {"ids": [first["nodeIdMap"]["B"], second["nodeIdMap"]["B"]]})
        assert [obj["label"] for obj in restored["objects"]] == ["完成", "验收完成"]
        assert restored["board"]["objectCount"] == 36
        verify_groups(page, call)
        verify_resize_fit(page)
        replay = replay_append(page, call, replay_dir) if replay_dir else None
        toolbar = verify_toolbar_fit(page, call, group_board, evidence_dir if native else None) if group_board else None
        return {"chrome": browser.version, "transport": "WebMCP" if native else "page",
                "horizontal": horizontal, "portrait": portrait, "searchCalls": 1, "searchFontCssPx": found,
                "restoredObjects": restored["board"]["objectCount"], "originalAndNewGroups": 4, "replay": replay, "toolbar": toolbar}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay", type=Path, help="directory containing the independent append audit's calls.json and seed.mgcanvas")
    parser.add_argument("--group-board", type=Path, help="verify the grouped audit board containing 版本存储 at 650 × 760")
    parser.add_argument("--evidence-dir", type=Path, help="write the grouped board's WebMCP and keyboard fit screenshots and measurements here")
    args = parser.parse_args()
    handler = partial(StaticFiles, directory=str(ROOT / "dist"))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server, sync_playwright() as pw:
        Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}/app/index.html"
        try:
            for transport in [True, False]:
                print(json.dumps(verify(pw.chromium, url, transport, args.replay, args.group_board, args.evidence_dir), ensure_ascii=False), flush=True)
        finally:
            server.shutdown()
