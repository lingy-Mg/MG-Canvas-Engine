"""Exercise the React shell's focus, composition, and document-bound commands in Chrome."""
import argparse
import json
import os
from pathlib import Path
import subprocess

from playwright.sync_api import expect, sync_playwright


def check(page, entry):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(entry)
    layers = page.locator("#layers")
    page.locator("#toggle-layers").click()
    source = layers.locator('[data-id="flow-source"]')
    source.click()
    expect(source).to_have_attribute("aria-pressed", "true")
    page.locator("#layer-lock").click()
    expect(source).to_have_attribute("data-locked", "true")
    page.locator("#layer-unlock").click()
    expect(source).to_have_attribute("data-locked", "false")

    search = page.locator("#layer-search")
    count = layers.locator("button").count()
    search.focus()
    search.dispatch_event("compositionstart", {"data": ""})
    search.fill("提交")
    expect(layers.locator("button")).to_have_count(count)
    search.dispatch_event("compositionend", {"data": "提交"})
    expect(layers.locator("button")).to_have_count(1)
    expect(source).to_be_visible()
    page.locator("#layer-search-clear").click()
    expect(layers.locator("button")).to_have_count(count)
    expect(search).to_be_focused()

    menu = page.locator("#arrange-menu")
    source.click(button="right")
    expect(menu).to_be_visible()
    visibility = menu.locator("[data-visibility-action=toggle]")
    visibility.click()
    expect(source).to_have_attribute("data-hidden", "true")
    expect(source).to_be_focused()
    source.click()
    expect(source).to_have_attribute("data-hidden", "false")
    layers.locator('[data-id="mind-room"]').click()
    tree = page.locator("#topic-tree-list")
    root = tree.get_by_role("treeitem").first
    root.focus()
    root.press("ArrowRight")
    child = tree.get_by_role("treeitem").nth(1)
    expect(child).to_be_focused()
    child.press("Space")
    expect(child).to_have_attribute("aria-selected", "true")
    child.press("Escape")
    canvas = page.locator("#canvas")
    expect(canvas).to_be_focused()

    for theme in ("dark", "light"):
        page.locator("#theme-" + theme).check()
        expect(page.locator("html")).to_have_attribute("data-workspace-theme", theme)
        canvas.click(position={"x": 50, "y": 200}, button="right")
        expect(menu).to_have_accessible_name("画布操作")
        expect(menu.get_by_role("menuitem").first).to_be_focused()
        page.keyboard.press("End")
        expect(menu.get_by_role("menuitem", name="查看整板")).to_be_focused()
        page.keyboard.press("Escape")
        expect(menu).to_be_hidden()
        expect(canvas).to_be_focused()
    page.locator("#toggle-layers").click()
    source.click()
    bar = page.locator("#text-format-bar")
    downstream = bar.locator('[data-action="arrange-downstream"]')
    expect(downstream).to_be_visible()
    # Verify these two regressions on the visible controls, including the summary itself.
    owned = "el => Object.keys(el).some(key => key.startsWith('__reactFiber$'))"
    ownership = {"downstream": downstream.evaluate(owned)}
    layers.locator('[data-id="flow-heading"]').click()
    page.locator("#close-layers").click()
    bar.get_by_role("button", name="更多", exact=True).click()
    disclosure = bar.locator("details.advanced-properties")
    summary = disclosure.locator(":scope > summary")
    expect(summary).to_have_text("完整文字属性")
    ownership.update({"details": disclosure.evaluate(owned), "summary": summary.evaluate(owned)})
    summary.focus()
    summary.press("Enter")
    expect(disclosure).to_have_attribute("open", "")
    field = disclosure.get_by_role("spinbutton", name="字号", exact=True)
    expect(field).to_be_visible()
    initial_size = field.input_value()
    field.fill("22")
    field.press("Enter")
    expect(field).to_have_value("22")
    page.locator("#undo").click()
    if not summary.is_visible():
        bar.get_by_role("button", name="更多", exact=True).click()
    if not disclosure.evaluate("el=>el.open"):
        summary.click()
    expect(field).to_have_value(initial_size)
    assert all(ownership.values()), ownership
    assert not errors, errors
    return {"reactOwned": ownership, "fontSizeUndo": True, "pageErrors": errors}


def hit_test(control):
    return control.evaluate("""element => {
      const r=element.getBoundingClientRect();
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && element.contains(hit);
    }""")


def check_compact(page, entry, screenshots):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    page.goto(entry)
    status = page.locator("#status")
    expect(status).to_have_attribute("data-workspace", "ready")

    header = page.locator(".header")
    wide_height = header.bounding_box()["height"]
    page.set_viewport_size({"width": 820, "height": 420})
    assert header.bounding_box()["height"] == wide_height
    assert page.locator("#canvas").bounding_box()["height"] >= 350
    page.locator("#tool-ink").click()
    page.locator("#toggle-layers").click()
    search = page.locator("#layer-search")
    assert hit_test(search)
    layer_panel = page.locator("#layers-panel")
    short_panel = round(layer_panel.bounding_box()["height"])
    assert short_panel >= 125
    page.set_viewport_size({"width": 821, "height": 420})
    assert hit_test(search) and round(layer_panel.bounding_box()["height"]) == short_panel
    page.locator("#close-layers").click()
    page.locator("#tool-select").click()

    page.set_viewport_size({"width": 400, "height": 420})
    canvas = page.locator("#canvas")
    expect(canvas).to_have_js_property("width", 800)
    page.wait_for_function("""() => {
      const c=document.querySelector('#canvas');
      return devicePixelRatio===2 && c.height===c.clientHeight*2;
    }""")
    for id in ("save", "project-open", "project-export", "tool-select", "toggle-creation", "undo", "redo"):
        assert hit_test(page.locator("#" + id)), id

    save = page.locator("#save")
    save.focus()
    page.keyboard.press("Enter")
    expect(status).to_contain_text("已保存")
    history = page.locator("#file-history summary")
    history.focus()
    page.keyboard.press("Enter")
    page.keyboard.press("Tab")
    expect(page.locator("#open")).to_be_focused()
    page.keyboard.press("Enter")
    expect(page.locator("#file-history")).not_to_have_attribute("open", "")
    expect(status).not_to_contain_text("正在打开")
    expect(history).to_be_focused()

    toggle = page.locator("#toggle-creation")
    toggle.focus()
    page.keyboard.press("Enter")
    expect(toggle).to_have_attribute("aria-expanded", "true")
    expect(page.locator("#tool-shapes")).to_be_focused()
    for id in ("tool-shapes", "tool-connect", "tool-mind", "tool-text", "tool-document",
               "tool-sticky", "tool-table", "tool-path", "tool-ink", "tool-image"):
        assert hit_test(page.locator("#" + id)), id
    if screenshots:
        page.screenshot(path=screenshots / "workbench-400x420-tools.png")
    page.keyboard.press("Escape")
    expect(toggle).to_be_focused()
    expect(page.locator("#creation-tools")).to_be_hidden()

    diagnostics = page.locator("#diagnostics summary")
    diagnostics.focus()
    page.keyboard.press("Enter")
    expect(page.locator("#frame-rate")).to_be_visible()
    page.keyboard.press("Tab")
    expect(page.locator("#frame-rate")).to_be_focused()
    page.keyboard.press("Escape")
    expect(diagnostics).to_be_focused()

    layers = page.locator("#toggle-layers")
    layers.focus()
    page.keyboard.press("Enter")
    expect(search).to_be_focused()
    search.fill("预约流程")
    heading = page.locator('#layers [data-id="flow-heading"]')
    heading.click()
    strip = page.locator("#text-format-bar")
    expect(strip).to_have_attribute("data-docked", "")
    more = strip.get_by_role("button", name="更多", exact=True)
    forward = strip.get_by_role("button", name="向右滚动格式栏")
    expect(forward).to_be_visible()
    for _ in range(6):
        if hit_test(more):
            break
        forward.click()
    assert hit_test(more)
    more.click()
    panel = page.locator("#inspector")
    expect(panel).to_have_attribute("data-sheet", "")
    details = panel.get_by_text("完整文字属性", exact=True)
    details.click()
    field = panel.get_by_role("spinbutton", name="字号", exact=True)
    panel_height = panel.evaluate("element=>element.clientHeight")
    assert panel_height >= 165
    field.fill("22")
    field.press("Enter")
    expect(field).to_have_value("22")
    close = strip.get_by_role("button", name="收起属性", exact=True)
    assert hit_test(diagnostics) and hit_test(close)
    if screenshots:
        page.screenshot(path=screenshots / "workbench-400x420-properties.png")
    page.keyboard.press("Escape")
    expect(more).to_be_focused()
    page.locator("#close-layers").click()
    page.locator("#undo").click()

    more.click()
    panel.get_by_text("完整文字属性", exact=True).click()
    assert panel.bounding_box()["height"] >= 165
    expect(panel.get_by_role("spinbutton", name="字号", exact=True)).to_be_visible()
    assert hit_test(diagnostics) and hit_test(close)
    close.click()
    expect(panel).to_be_hidden()
    expect(more).to_be_focused()

    more.click()
    diagnostics.click()
    expect(panel).to_be_hidden()
    expect(page.locator("#frame-rate")).to_be_visible()
    page.keyboard.press("Escape")
    expect(diagnostics).to_be_focused()

    fixture = Path(__file__).resolve().parents[1] / "docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas"
    picker = page.locator("#project-picker")
    # Leave the native dialog to the platform. Verify the visible action requests
    # that picker before supplying the same file through Playwright.
    picker.evaluate("""field=>field.addEventListener('click',event=>{
      event.preventDefault();field.dataset.requested='true';
    },{once:true})""")
    page.locator("#project-open").focus()
    page.keyboard.press("Enter")
    expect(picker).to_have_attribute("data-requested", "true")
    picker.set_input_files(fixture)
    expect(status).to_contain_text("项目已打开")
    layers.click()
    search.fill("提交预约")
    node = page.locator('#layers [data-id="flow-submit"]')
    node.click()
    search.fill("")
    edit_node = strip.get_by_role("button", name="节点文字", exact=True)
    edit_node.click()
    label = page.get_by_role("textbox", name="节点文字", exact=True)
    label.fill("小窗编辑")
    label.press("Enter")
    strip.get_by_role("button", name="收起属性", exact=True).click()
    expect(node).to_contain_text("小窗编辑")
    page.locator("#undo").click()
    expect(node).to_contain_text("提交预约")
    page.locator("#redo").click()
    expect(node).to_contain_text("小窗编辑")
    page.locator("#undo").click()

    page.locator("#project-export").focus()
    with page.expect_download() as download:
        page.keyboard.press("Enter")
    exported = json.loads(download.value.path().read_bytes())
    original = json.loads(fixture.read_bytes())
    assert exported["document"] == original["document"] and exported["assets"] == original["assets"]
    page.set_viewport_size({"width": 820, "height": 420})
    cdp = page.context.new_cdp_session(page)
    # A bare DPR override in headless Chrome does not dispatch media query changes.
    cdp.send("Emulation.setDeviceMetricsOverride",
             {"width": 821, "height": 420, "deviceScaleFactor": 1.5, "mobile": False})
    expect(page.locator("#canvas")).to_have_js_property("width", 1232)
    cdp.send("Emulation.setDeviceMetricsOverride",
             {"width": 820, "height": 420, "deviceScaleFactor": 2, "mobile": False})
    expect(page.locator("#canvas")).to_have_js_property("width", 1640)
    cdp.detach()
    assert not errors, errors
    return {"headerHeightAt820And821": wide_height, "shortLayerPanelHeight": short_panel,
            "propertySheetHeight": panel_height, "canvasDpr": 2, "fileRoundTrip": True}


def check_compact_touch(page, entry, screenshots):
    page.goto(entry)
    toggle = page.locator("#toggle-creation")
    page.locator("#theme-dark").tap()
    expect(page.locator("html")).to_have_attribute("data-workspace-theme", "dark")
    assert hit_test(page.locator("#save")) and hit_test(page.locator("#redo"))
    toggle.tap()
    ink = page.locator("#tool-ink")
    assert ink.bounding_box()["height"] >= 44 and hit_test(ink)
    if screenshots:
        page.screenshot(path=screenshots / "workbench-touch-390x844-dark.png")
    ink.tap()
    expect(toggle).to_have_attribute("aria-expanded", "false")
    expect(page.locator("#ink-pen")).to_be_visible()
    assert page.locator("#ink-pen").bounding_box()["height"] >= 44
    page.locator("#theme-light").tap()
    expect(page.locator("html")).to_have_attribute("data-workspace-theme", "light")
    page.locator("#tool-select").tap()
    page.locator("#toggle-layers").tap()
    page.locator('#layers [data-id="flow-heading"]').tap()
    bar = page.locator("#text-format-bar")
    more = bar.get_by_role("button", name="更多", exact=True)
    forward = bar.get_by_role("button", name="向右滚动格式栏")
    for _ in range(6):
        if hit_test(more):
            break
        forward.tap()
    assert hit_test(more)
    more.tap()
    expect(page.locator("#inspector")).to_be_visible()
    bar.get_by_role("button", name="收起属性").tap()
    expect(page.locator("#inspector")).to_be_hidden()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview", type=Path)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--screenshots", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    result = {}
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    with subprocess.Popen(["node", "scripts/serve.mjs"], cwd=root, text=True,
                          stdout=subprocess.PIPE, env={**os.environ, "PORT": "0"}) as server:
        try:
            url = server.stdout.readline().strip().removeprefix("Local preview ")
            assert url.startswith("http://127.0.0.1:")
            with sync_playwright() as pw, pw.chromium.launch(channel="chrome") as browser:
                for mode, entry in (("http", url), ("offline", args.preview.resolve().as_uri())):
                    with browser.new_context(viewport={"width": 1280, "height": 800}, offline=mode=="offline") as context:
                        page = context.new_page()
                        result[mode] = check(page, entry)
                        if mode == "http" and args.screenshots:
                            page.locator("#fit").click()
                            page.screenshot(path=args.screenshots / "workbench-1280x800.png")
                with browser.new_context(viewport={"width": 821, "height": 420}, device_scale_factor=2) as context:
                    result["compact"] = check_compact(context.new_page(), url, args.screenshots)
                with browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3,
                                         has_touch=True, is_mobile=True) as context:
                    check_compact_touch(context.new_page(), url, args.screenshots)
                    result["touch"] = True
        finally:
            server.terminate()
    if args.evidence:
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        args.evidence.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
