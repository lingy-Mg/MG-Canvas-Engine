"""Check the standalone workspace with Playwright and a local Chromium browser."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def show(page, panel):
    if not page.locator("#" + panel + "-panel").is_visible():
        page.locator("#toggle-" + panel).click()


def select(page, object_id):
    show(page, "layers")
    page.locator(f'#layers [data-id="{object_id}"]').click()
    if page.locator("#layers-panel").is_visible():page.locator("#close-layers").click()


def use_tool(page, tool, touch=False):
    toggle = page.locator("#toggle-creation")
    activate = "tap" if touch else "click"
    if toggle.is_visible():
        getattr(toggle, activate)()
    getattr(page.locator("#tool-" + tool), activate)()


def check_strip(page, selector):
    strip = page.locator(selector)
    expect(strip).to_be_visible()
    items = strip.locator(":scope > button:visible, :scope > label:visible, :scope > .dock-group > button:visible")
    geometry = items.evaluate_all("""nodes => nodes.map(n => {
      const r=n.getBoundingClientRect();
      return {center:r.y+r.height/2, icon:!!n.querySelector("svg"), name:n.innerText.trim()};
    })""")
    if selector=="#ink-tools" and strip.locator("#ink-pen").count():
        for tool in ("pen","highlighter","eraser","thin","thick","finger"):
            control=strip.locator("#ink-"+tool)
            assert control.get_attribute("aria-label") and control.locator("svg").count()==1
        expect(strip.locator("#ink-width")).to_have_accessible_name("笔触粗细")
        expect(strip.locator("#ink-color")).to_have_accessible_name("自选颜色")
        assert strip.locator("#ink-swatches button[aria-label]").count()>1
    else:
        assert geometry and all(item["icon"] and item["name"] for item in geometry), (selector, geometry)
    assert max(i["center"] for i in geometry) - min(i["center"] for i in geometry) <= 1
    if strip.evaluate("n=>n.scrollWidth>n.clientWidth"):
        strip.evaluate("n=>n.scrollLeft=0")
        strip.hover()
        page.mouse.wheel(0, 140)
        page.wait_for_function("s=>document.querySelector(s).scrollLeft>0", arg=selector)
        strip.locator("button:enabled").first.focus()
        page.keyboard.press("Tab")
        assert strip.evaluate("n=>n.contains(document.activeElement)")
    for item in items.all():
        item.scroll_into_view_if_needed()
        assert item.evaluate("""n => {
          const r=n.getBoundingClientRect(), b=n.parentElement.getBoundingClientRect();
          const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return r.x>=b.x-1 && r.right<=b.right+1 && n.contains(hit);
        }"""), (selector, item.inner_text())


def shot(page, output, name):
    if output:
        page.screenshot(path=output / (name + ".png"))


def check_layout(page, entry, width, height, output):
    page.set_viewport_size({"width": width, "height": height})
    page.goto(entry)
    expect(page.locator("#layers .layer").first).to_be_attached()
    canvas = page.locator("#canvas")
    bounds = canvas.bounding_box()
    assert bounds["x"] == 0 and bounds["width"] == width
    expect(page.locator("#layers-panel")).to_be_hidden()
    expect(page.locator("#inspector-panel,#toggle-inspector")).to_have_count(0)
    initial = page.locator("#inspector")
    for theme in ("light", "dark"):
        page.locator("#theme-" + theme).check()
        expect(page.locator("html")).to_have_attribute("data-workspace-theme", theme)
        assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
        for control in ("#save", "#project-open", "#project-export", "#file-history summary",
                        "#theme-system", "#toggle-layers"):
            assert page.locator(control).evaluate("""n=>{
              const r=n.getBoundingClientRect(), p=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
              return r.x>=0 && r.right<=innerWidth && n.contains(p);
            }"""), (width, control)
        page.locator("#file-history summary").click()
        expect(page.locator("#open")).to_be_visible()
        page.keyboard.press("Escape")
        expect(page.locator("#file-history")).not_to_have_attribute("open", "")
        select(page, "flow-source")
        trigger=page.locator("#text-format-bar").get_by_role("button",name="变换",exact=True)
        page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")
        assert trigger.is_visible(), (width,theme,page.locator("#tool-select").get_attribute("aria-pressed"),page.locator("#text-format-bar").get_attribute("data-layout"),page.locator("#layers [aria-pressed=true]").all_text_contents())
        trigger.click()
        p = initial.bounding_box()
        assert p["x"] > bounds["x"] and p["x"] + p["width"] < width
        assert initial.evaluate("n=>n.scrollWidth===n.clientWidth")
        assert canvas.bounding_box() == bounds
        initial.locator('input[name="x"]').focus()
        assert initial.locator('input[name="x"]').evaluate("n=>n.closest('label').matches(':focus-within')")
        page.keyboard.press("Escape");expect(trigger).to_be_focused()
        use_tool(page, "shapes")
        check_strip(page,"#main-tools");check_strip(page,"#shape-palette")
        page.locator("#main-tools").evaluate("n=>n.scrollLeft=0")
        page.locator("#shape-palette").evaluate("n=>n.scrollLeft=0")
        if width in (375, 1440):
            shot(page, output, f"workspace-{width}-{theme}")
        page.locator("#tool-select").click()

    use_tool(page, "path")
    check_strip(page, "#path-tools")
    page.locator("#path-cancel").click()
    use_tool(page, "ink")
    check_strip(page, "#ink-tools")
    page.locator("#tool-select").click()
    use_tool(page, "mind")
    canvas.click(position={"x": int(width * .48), "y": int(bounds["height"] * .48)})
    page.keyboard.press("Escape")
    # Re-enter a saved map through its existing layer and inspector actions.
    select(page, "mind-room")
    if width==1440:
        for theme in ("light","dark"):
            page.locator("#theme-"+theme).check()
            shot(page,output,"workspace-map-"+theme)
        style = page.locator(".mind-style")
        expect(style.locator("select")).to_have_count(0)
        for group, count in (("mindLayout", 3), ("mindSkin", 3), ("mindPalette", 4)):
            expect(style.locator(f'input[type="radio"][name="{group}"]')).to_have_count(count)
        page.get_by_role("button",name="主题与配色",exact=True).click()
        warm = style.get_by_role("radio", name="暖橙")
        warm.check()
        expect(warm).to_be_focused()
        page.keyboard.press("ArrowRight")
        spectrum = style.get_by_role("radio", name="缤纷")
        expect(spectrum).to_be_checked()
        expect(spectrum).to_be_focused()
    page.get_by_role("button",name="脑图操作",exact=True).click()
    page.get_by_role("button", name="编辑脑图", exact=True).click()
    check_strip(page, "#mind-tools")
    point=canvas.evaluate("""c=>{
      const box=c.getBoundingClientRect();
      for(let y=box.height*.5;y>0;y-=12)for(let x=8;x<box.width;x+=18)
        if(document.elementFromPoint(box.left+x,box.top+y)===c)return {x,y};
    }""")
    assert point, (width,height)
    canvas.click(button="right",position=point)
    expect(page.locator("#arrange-menu")).to_be_visible()
    page.keyboard.press("Escape")


def check_text(page, entry):
    page.set_viewport_size({"width": 1280, "height": 800})
    page.goto(entry)
    expect(page.locator("#layers .layer").first).to_be_attached()
    text = "画布 Mg 0123456789\n上下 Agj 09"
    project = json.loads((Path(__file__).resolve().parents[1] /
                         "docs/fixtures/M5Y-Text-Layout.mgcanvas").read_text(encoding="utf8"))
    board = project["document"]
    item = dict(board["objects"]["approval"], text=text, width=290, height=73, fontSize=26, color="#12345a")
    board.update(objects={item["id"]: item}, order=[item["id"]])
    page.locator("#project-picker").set_input_files({
        "name": "mixed-text.mgcanvas", "mimeType": "application/json", "buffer": json.dumps(project).encode()
    })
    expect(page.locator("#status")).to_contain_text("项目已打开")
    page.wait_for_function("window.drawn?.length>=2")
    lines = page.evaluate("window.drawn.slice(-2)")
    assert [row["text"] for row in lines] == text.splitlines()
    for row in lines:
        assert row["y"] >= row["ascent"] and row["y"] + row["descent"] <= item["height"] + 1
    assert abs(lines[1]["y"] - lines[0]["y"] - 26 * 1.4) < .01
    assert page.evaluate("""() => {
      const p=document.createElement("span");p.style.font=window.drawn.at(-1).font;document.body.append(p);
      const family=getComputedStyle(p).fontFamily, ui=getComputedStyle(document.body).fontFamily;
      p.remove();return family===ui && window.measured.includes(window.drawn.at(-1).font);
    }""")
    select(page, item["id"])
    page.get_by_role("button", name="更多", exact=True).click()
    page.get_by_role("button", name="编辑文字", exact=True).click()
    edit = page.locator("textarea.inline-text")
    expect(edit).to_have_value(text)
    assert edit.evaluate("""n=> {
      const s=getComputedStyle(n);return s.fontFamily===getComputedStyle(document.body).fontFamily &&
        Math.abs(parseFloat(s.lineHeight)/parseFloat(s.fontSize)-1.4)<.01 && n.scrollHeight<=n.clientHeight+1;
    }""")
    page.keyboard.press("Escape")
    with page.expect_download() as downloading:
        page.locator("#project-export").click()
    exported = json.loads(Path(downloading.value.path()).read_text(encoding="utf8"))
    assert exported["document"]["objects"][item["id"]] == item


def actual_fonts(page):
    cdp = page.context.new_cdp_session(page)
    try:
        cdp.send("DOM.enable")
        cdp.send("CSS.enable")
        root = cdp.send("DOM.getDocument")["root"]["nodeId"]
        node = cdp.send("DOM.querySelector", {"nodeId": root, "selector": ".doc strong"})["nodeId"]
        return [font["familyName"] for font in cdp.send("CSS.getPlatformFontsForNode", {"nodeId": node})["fonts"]]
    finally:
        cdp.detach()


def check_touch_scrolling(browser, entry):
    with browser.new_context(viewport={"width": 320, "height": 640}, device_scale_factor=2,
                             has_touch=True, is_mobile=True) as context:
        page = context.new_page()
        page.goto(entry)
        use_tool(page, "shapes", touch=True)
        cdp = context.new_cdp_session(page)
        strip = page.locator("#shape-palette")
        bounds = strip.bounding_box()
        x = bounds["x"] + bounds["width"] - 18
        y = bounds["y"] + bounds["height"]/2
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        for fraction in (.15, .35, .55, .75):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [
                {"x": x - fraction*bounds["width"], "y": y}]})
            page.evaluate("new Promise(requestAnimationFrame)")
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_function("document.querySelector('#shape-palette').scrollLeft>0")
        page.locator("#shape-line").tap()
        expect(page.locator("#shape-palette")).to_be_hidden()
        expect(page.locator("#tool-shapes")).to_have_attribute("aria-pressed", "true")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("preview", type=Path)
    parser.add_argument("--channel", default="chromium")
    parser.add_argument("--screenshots", type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw, pw.chromium.launch(channel=args.channel) as browser:
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_default_timeout(5500)
        page.add_init_script("""{
          window.drawn=[];window.measured=[];
          const p=CanvasRenderingContext2D.prototype, fill=p.fillText, measure=p.measureText;
          p.measureText=function(text){if(String(text).includes("Agj")) window.measured.push(this.font);return measure.call(this,text)};
          p.fillText=function(text,x,y,...rest){
            if(this.canvas.id==="canvas" && this.fillStyle==="#12345a"){
              const m=measure.call(this,text);window.drawn.push({text,y,font:this.font,ascent:m.actualBoundingBoxAscent,descent:m.actualBoundingBoxDescent});
            }
            return fill.call(this,text,x,y,...rest);
          }
        }""")
        entry = args.preview.resolve().as_uri()
        for width,height in ((1440,900),(820,740),(568,360),(375,740),(320,640)):
            check_layout(page,entry,width,height,args.screenshots)
        check_text(page,entry)
        check_touch_scrolling(browser,entry)
        assert not errors, errors
        print(f"{args.channel} {browser.version}: panels, toolbar rows, both themes, mixed text metrics and editor verified. Rendered title fonts: {actual_fonts(page)}.")


if __name__ == "__main__":
    main()
