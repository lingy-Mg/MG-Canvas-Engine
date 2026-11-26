"""Drive the selected topic's toolbar through the offline preview in Chromium."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def check(page, preview, shots):
    page.set_default_timeout(5000)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    page.add_init_script("""{
      window.topicPoints = {};
      const fill = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text,x,y,...rest) {
        if (this.canvas.id === 'canvas' && this.textAlign === 'center' && this.globalAlpha >= .99) {
          const point = new DOMPoint(x,y).matrixTransform(this.getTransform());
          const rect = this.canvas.getBoundingClientRect();
          topicPoints[text] = [rect.x + point.x * rect.width / this.canvas.width, rect.y + point.y * rect.height / this.canvas.height];
        }
        return fill.call(this,text,x,y,...rest);
      };
    }""")
    page.goto(preview.resolve().as_uri())
    expect(page.locator("#layers .layer").first).to_be_attached()
    data = json.loads((Path(__file__).resolve().parents[1] / "docs/fixtures/M5AI-Topic-Tree.mgcanvas").read_text(encoding="utf8"))
    map_id = "booking-map"
    data["document"]["order"] = [map_id, "archive-map"]
    data["document"]["objects"] = {key:data["document"]["objects"][key] for key in data["document"]["order"]}
    tree = data["document"]["objects"][map_id]
    tree["topics"]["desk"]["collapsed"] = False
    tree["topics"]["dup-a"]["text"] = "分时预约"
    original_other = data["document"]["objects"]["archive-map"]

    def load(project):
        page.locator("#project-picker").set_input_files({"name":"脑图浮栏.mgcanvas","mimeType":"application/json","buffer":json.dumps(project).encode()})
        expect(page.locator("#status")).to_contain_text("项目已打开")
        page.locator("#fit").click()

    def project():
        with page.expect_download() as download:
            page.locator("#project-export").evaluate("e => e.click()")
        return json.loads(Path(download.value.path()).read_text(encoding="utf8"))

    def current():
        return project()["document"]["objects"][map_id]

    def frame():
        page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")

    def topic(text):
        frame()
        page.wait_for_function("text => !!topicPoints[text]", arg=text)
        if not page.evaluate("text=>document.elementFromPoint(...topicPoints[text])?.id==='canvas'",text):
            page.locator("#fit").click()
            frame()
        x, y = page.evaluate("text => topicPoints[text]", text)
        assert page.evaluate("p=>document.elementFromPoint(...p)?.id", [x, y]) == "canvas", (text, x, y)
        page.mouse.click(x, y)
        frame()
        return x, y

    def screenshot(name):
        if shots:
            shots.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=shots / (name + ".png"))

    def show(group, field):
        if not field.is_visible():
            trigger = page.get_by_role("button", name=group, exact=True)
            if not trigger.is_visible():
                selected = page.evaluate("async()=> (await mgCanvasTools.callTool('canvas_read',{scope:'selection'})).structuredContent.selection")
                raise AssertionError((group, selected, page.locator(".format-strip").inner_text(), errors))
            trigger.click()
        expect(field).to_be_visible()
        return field

    def number(group, name, value):
        field = show(group, page.locator(f'input[name="{name}"]'))
        field.fill(str(value))
        field.press("Tab")

    def choice(group, name, value):
        radio = show(group, page.locator(f'input[name="{name}"][value="{value}"]'))
        radio.check()
        expect(radio).to_be_checked()

    def close_options():
        page.keyboard.press("Escape")
        frame()

    def action(group, name):
        show(group, page.get_by_role("button", name=name, exact=True)).click()

    bar = page.locator("#text-format-bar")
    def anchored(text):
        frame()
        x, y = page.evaluate("text=>topicPoints[text]", text)
        box = bar.bounding_box()
        assert abs(box["x"] + box["width"]/2 - x) < 3 and box["y"] + box["height"] < y, (text, box, x, y)

    load(data)
    expect(page.locator("aside#inspector-panel")).to_have_count(0)
    topic("会议室预约")
    layout, theme = "整图布局", "主题与配色"
    root_look, look, structure = "根节点外观", "节点外观", "分支操作"
    for label in [layout, theme, root_look, "脑图操作"]:
        expect(page.get_by_role("button", name=label, exact=True)).to_be_visible()
    expect(page.locator('[name="mindPalette"]:visible')).to_have_count(0)
    anchored("会议室预约")
    screenshot("root-toolbar")
    number(layout, "mindSpacing", 32)
    number(layout, "mindScale", 120)
    choice(layout, "mindLayout", "balanced")
    choice(theme, "mindSkin", "capsule")
    choice(theme, "mindPalette", "mint")
    screenshot("root-theme")
    number(layout, "x", 155)
    number(layout, "y", 174)
    number(root_look, "topicWidth", 144)
    styled = current()
    assert styled["layout"] == "balanced"
    assert styled["origin"] == {"x":155,"y":174} and styled["topics"]["root"]["appearance"]["width"] == 144
    close_options()
    topic("预约管理")
    for label in [layout, theme, root_look, "脑图操作"]:
        expect(page.get_by_role("button", name=label, exact=True)).to_have_count(0)
    expect(page.get_by_role("button", name=look, exact=True)).to_be_visible()
    anchored("预约管理")
    screenshot("branch-toolbar")
    number(look, "topicWidth", 130)
    for name, val in [("topicFill","#315589"),("topicInk","#ffffff"),("topicStroke","#293f64")]:
        field = show(look, page.locator(f'[name="{name}"]'))
        field.fill(val)
        field.press("Tab")
    number(look, "topicStrokeWidth", 3)
    appearance = current()["topics"]["booking"]["appearance"]
    assert appearance == {"width":130,"fill":"#315589","textColor":"#ffffff","stroke":"#293f64","strokeWidth":3}
    action(look, "恢复自动宽度")
    assert current()["topics"]["booking"]["appearance"] == {k:v for k,v in appearance.items() if k != "width"}
    action(look, "恢复继承的填充")
    assert "fill" not in current()["topics"]["booking"]["appearance"]
    action(look, "继承脑图样式")
    assert "appearance" not in current()["topics"]["booking"]
    close_options()
    before = current()
    action(structure, "下移")
    assert current()["topics"]["root"]["childIds"][:2] == ["archive", "booking"]
    page.locator("#undo").click()
    assert current() == before
    topic("分时预约")
    expect(page.get_by_role("button", name=layout, exact=True)).to_have_count(0)
    number(look, "topicStrokeWidth", 2.5)
    expect(page.locator('[name="topicStrokeWidth"]')).to_have_attribute("aria-label", "下划线粗细")
    expect(page.locator('[name="topicFill"]')).to_have_count(0)
    line = show(look, page.locator('[name="topicStroke"]'))
    expect(line).to_have_attribute("aria-label", "下划线颜色")
    line.fill("#36855e")
    line.press("Tab")
    screenshot("deep-appearance")
    changed = current()
    assert changed["topics"]["dup-a"]["appearance"]["stroke"] == "#36855e"
    page.locator("#undo").click()
    assert "stroke" not in current()["topics"]["dup-a"]["appearance"]
    page.locator("#redo").click()
    assert current() == changed
    topic("现场")
    action(structure,"折叠分支")
    assert current()["topics"]["desk"]["collapsed"]
    branch_menu = bar.get_by_role("button", name=structure, exact=True)
    if branch_menu.get_attribute("aria-expanded") == "true":
        branch_menu.click()
    expect(branch_menu).to_have_attribute("aria-expanded", "false")
    branch_menu.click()
    page.evaluate("delete topicPoints['分时预约']")
    page.get_by_role("button", name="展开分支", exact=True).click()
    assert not current()["topics"]["desk"]["collapsed"]
    page.wait_for_function("!!topicPoints['分时预约']")
    close_options()
    topic("分时预约")
    action(structure,"删除此分支")
    assert "dup-a" not in current()["topics"]
    page.locator("#undo").click()
    saved = project()
    assert saved["document"]["objects"][map_id] == changed
    assert saved["document"]["objects"]["archive-map"] == original_other
    load(saved)
    topic("会议室预约")
    expect(show(layout, page.locator('[name="mindSpacing"]'))).to_have_value("32")
    expect(page.locator('[name="mindScale"]')).to_have_value("120")
    expect(page.locator('[name="mindLayout"][value="balanced"]')).to_be_checked()
    expect(show(theme, page.locator('[name="mindSkin"][value="capsule"]'))).to_be_checked()
    expect(page.locator('[name="mindPalette"][value="mint"]')).to_be_checked()
    close_options()
    topic("分时预约")
    expect(show(look, page.locator('[name="topicStroke"]'))).to_have_value("#36855e")
    close_options()
    if not page.locator("#layers-panel").is_visible():
        page.locator("#toggle-layers").click()
    page.locator('#layers [data-id="booking-map"]').click()
    if page.locator("#layers-panel").is_visible():
        page.locator("#close-layers").click()
    expect(page.get_by_role("button",name=root_look,exact=True)).to_have_count(0)
    action("脑图操作","编辑脑图")
    expect(page.get_by_role("button",name=root_look,exact=True)).to_be_visible()
    action("脑图操作","折叠脑图")
    assert current()["topics"]["root"]["collapsed"]
    action("脑图操作","展开脑图")
    action("脑图操作","编辑节点文字")
    field = page.locator(".node-editor textarea")
    expect(field).to_be_focused()
    field.fill("会议室计划")
    field.press("Enter")
    assert current()["topics"]["root"]["text"] == "会议室计划"
    page.locator("#undo").click()
    assert current()["topics"]["root"]["text"] == "会议室预约"
    page.locator('label:has(#theme-dark)').click()
    page.set_viewport_size({"width":390,"height":780})
    page.locator("#fit").click()
    frame()
    if not page.get_by_role("button",name=theme,exact=True).is_visible():
        topic("会议室预约")
    expect(show(theme,page.locator('[name="mindPalette"][value="mint"]'))).to_be_checked()
    for control in [bar,page.locator("#inspector")]:
        box=control.bounding_box()
        assert box["x"]>=0 and box["x"]+box["width"]<=391 and box["y"]>=0 and box["y"]+box["height"]<=781,box
    screenshot("narrow-dark-theme")
    assert not errors, errors
    print("Verified the floating root, branch and underline topic tools, live map and topic styles, inheritance, ordering, folding, removal, undo/redo and project reopen.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview", type=Path)
    parser.add_argument("--shots", type=Path)
    args = parser.parse_args()
    with sync_playwright() as pw, pw.chromium.launch(channel="chrome") as browser:
        check(browser.new_page(viewport={"width":1440,"height":900}), args.preview, args.shots)
