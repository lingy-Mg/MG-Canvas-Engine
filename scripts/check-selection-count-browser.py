"""Exercise the live selection badge on the standalone canvas in Chromium."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def project(rows):
    return dict(format="mg-canvas.project", version=1, assets={}, document=dict(
        schemaVersion=1, id="selection-count", theme="paper", assets={},
        order=[row["id"] for row in rows], objects={row["id"]: row for row in rows}))


def check(page, preview):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    # Read what the canvas actually painted, including CSS/device pixel conversion.
    page.add_init_script("""{
      const proto=CanvasRenderingContext2D.prototype, transform=proto.setTransform, stroke=proto.strokeRect;
      proto.setTransform=function(a,b,c,d,e,f){
        if(this.canvas.id==="canvas"&&(e||f)) window.camera=[a,d,e,f];
        return transform.apply(this,arguments);
      };
      proto.strokeRect=function(x,y,w,h){
        if(this.canvas.id==="canvas"&&this.getLineDash().join(",")==="4,3"){
          const r=this.canvas.getBoundingClientRect();window.dashed=[r.left+x,r.top+y,w,h];
        }
        return stroke.apply(this,arguments);
      };
    }""")
    page.goto(preview.resolve().as_uri())
    expect(page.locator("#status")).to_have_attribute("data-workspace","ready")
    badge = page.locator("#selection-count")
    canvas = page.locator("#canvas")

    def frame():
        page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

    def load(rows):
        page.locator("#project-picker").set_input_files(dict(name="选区验收.mgcanvas", mimeType="application/json",
                                                            buffer=json.dumps(project(rows)).encode()))
        expect(page.locator("#status")).to_contain_text("项目已打开")
        page.locator("#fit").click()
        frame()

    def at(x, y):
        return canvas.evaluate("""(el,[x,y])=>{
          const r=el.getBoundingClientRect(),[a,d,e,f]=camera;
          return [r.left+(a*x+e)*r.width/el.width,r.top+(d*y+f)*r.height/el.height];
        }""", [x, y])

    def count(n):
        frame()
        if n < 2:
            expect(badge).to_be_hidden()
            return
        expect(badge).to_be_visible()
        expect(badge).to_have_text(f"已选 {n} 个元素")
        assert badge.evaluate("""el=>{
          const r=el.getBoundingClientRect(), viewport=el.parentElement.getBoundingClientRect();
          const controls=document.querySelectorAll("#text-format-bar,#inspector,#view-zoom,#frame-meter,#main-tools");
          return r.left>=viewport.left && r.top>=viewport.top && r.right<=viewport.right && r.bottom<=viewport.bottom &&
            [...controls].every(c=>{const b=c.getBoundingClientRect();return !b.width||!b.height||
              b.right<=r.left||b.left>=r.right||b.bottom<=r.top||b.top>=r.bottom;}) &&
            document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id==="canvas";
        }""")
        return badge.bounding_box()

    def shape(name, x, y, title):
        return dict(id=name, at=dict(x=x, y=y), kind="shape", shape="rect", width=130, height=70,
                    rotation=0, cornerRadius=6, fill="#eef2ff", stroke="#4f65b6", label=title)

    rows = [shape("collect", -390, 0, "收集需求"), shape("design", -65, 0, "设计方案"), shape("test", 260, 70, "验证结果")]
    load(rows)
    start = at(-415, -30)
    page.mouse.move(*start)
    page.mouse.down()
    for x, n in [(-290, 1), (12, 2), (340, 3), (12, 2)]:
        page.mouse.move(*at(x, 110))
        box = count(n)
        if box:
            assert abs(box["x"]-start[0]) <= 1.5 and abs(box["y"]+box["height"]+3-start[1]) <= 1.5
    page.mouse.up()
    base = count(2)
    dashed = page.evaluate("dashed")
    assert abs(base["x"]-dashed[0]) <= 1 and abs(base["y"]+base["height"]+3-dashed[1]) <= 1

    page.keyboard.down("Shift")
    for x, y, n in [(320, 96, 3), (0, 35, 2), (320, 96, 1)]:
        page.mouse.click(*at(x, y))
        count(n)
    page.keyboard.up("Shift")
    page.mouse.click(*start)
    count(0)
    canvas.focus()
    page.keyboard.press("Control+a")
    normal = count(3)
    # The frame and badge move together during the drag as well as at rest.
    x, y = at(-336, 32)
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x+27, y+36, steps=4)
    moved = count(3)
    page.mouse.up()
    assert abs(moved["x"]-normal["x"]-27) < 2 and abs(moved["y"]-normal["y"]-36) < 2
    assert abs(count(3)["x"]-moved["x"]) < 1

    for _ in range(18):
        if page.locator("#zoom-read").inner_text()=="5%":
            break
        page.locator("#zoom-out").click()
    expect(page.locator("#zoom-read")).to_have_text("5%")
    for theme in ("dark", "light"):
        page.locator("#theme-"+theme).check()
        box = count(3)
        assert (box["width"], box["height"]) == (normal["width"], normal["height"])
        contrast = badge.evaluate(r"""el=>{
          const luminance=css=>css.match(/\d+(?:\.\d+)?/g).slice(0,3).map(Number).map(n=>n/255)
            .map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
          const css=getComputedStyle(el),a=luminance(css.color),b=luminance(css.backgroundColor);
          return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        }""")
        assert contrast >= 4.5, (theme, contrast)
        print(f"{theme} at 5%: {box['width']} x {box['height']} CSS px, contrast {contrast:.2f}:1")

    page.set_viewport_size({"width": 390, "height": 720})
    page.locator("#fit").click()
    count(3)
    # Drag around the only mind map: ordinary objects count once, each locally selected topic counts once.
    tree = dict(kind="mindmap", id="tree", origin=dict(x=0,y=0), layout="right", rootId="root", topics={
        "root": dict(id="root",text="计划",childIds=["a","b"],collapsed=False),
        "a": dict(id="a",text="设计",childIds=[],collapsed=False),
        "b": dict(id="b",text="交付",childIds=[],collapsed=False)})
    page.set_viewport_size({"width": 1360, "height": 820})
    load([tree])
    canvas.focus()
    page.keyboard.press("Control+a")
    count(1)
    v = canvas.bounding_box()
    page.mouse.move(v["x"]+45, v["y"]+105)
    page.mouse.down()
    page.mouse.move(v["x"]+v["width"]-45, v["y"]+v["height"]-105)
    count(3)
    page.mouse.up()
    count(3)
    page.mouse.click(v["x"]+45, v["y"]+110)
    count(0)
    assert not errors, errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview", type=Path)
    args = parser.parse_args()
    with sync_playwright() as pw, pw.chromium.launch(channel="chrome", headless=True, chromium_sandbox=True) as browser:
        check(browser.new_page(viewport={"width":1360,"height":820}, device_scale_factor=1.5), args.preview)
    print("Verified live and committed selection counts, Shift toggles, drag placement, zoom, themes, narrow viewport and mind map topics.")
