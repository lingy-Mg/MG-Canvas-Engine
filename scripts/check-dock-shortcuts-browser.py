"""Exercise dock shortcuts, contact areas, keyboard focus and secondary rail scrolling."""
import argparse
import json
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright


def contrast(a,b):
    def luminance(rgb):
        channels=[v/255 for v in rgb[:3]]
        linear=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in channels]
        return sum(v*w for v,w in zip(linear,(.2126,.7152,.0722)))
    low,high=sorted((luminance(a),luminance(b)))
    return (high+.05)/(low+.05)


def walk_focus(page, strip_id, ids, output=None):
    first=page.locator("#"+ids[0])
    first.focus()
    page.keyboard.press("Tab")
    page.keyboard.press("Shift+Tab")
    widths={}
    for index,id in enumerate(ids+list(reversed(ids[:-1]))):
        if index:
            page.keyboard.press("Tab" if index<len(ids) else "Shift+Tab")
        control=page.locator("#"+id)
        expect(control).to_be_focused()
        page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
        edges=control.evaluate("""(e,id)=>{
          const strip=document.getElementById(id),rail=strip.getBoundingClientRect(),r=e.getBoundingClientRect();
          const l=rail.left+strip.clientLeft,t=rail.top+strip.clientTop;
          const k=e.querySelector('kbd')?.getBoundingClientRect()??r;
          return {start:Math.min(r.left,k.left)-l,end:l+strip.clientWidth-Math.max(r.right,k.right),
            top:Math.min(r.top,k.top)-t,bottom:t+strip.clientHeight-Math.max(r.bottom,k.bottom),
            outline:getComputedStyle(e).outlineStyle,width:r.width};
        }""",strip_id)
        assert min(edges[k] for k in ("start","end","top","bottom"))>=0 and edges["outline"]!="none",(id,index,edges)
        widths[id]=edges["width"]
        if strip_id=="main-tools":
            hint=page.locator("#dock-hint")
            expect(hint).to_be_visible()
            expect(hint).to_have_text(control.get_attribute("title"))
            assert hint.evaluate("e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}")
        if output and (index==len(ids)-1 or index==2*len(ids)-2):
            rail=page.locator("#"+strip_id).bounding_box()
            page.screenshot(path=output/f"tab-{id}-390.png",
                clip={"x":0,"y":rail["y"]-4,"width":390,"height":rail["height"]+8})
    return widths


def capture_reference(browser, preview, output, version):
    # User's reference is a 1002 x 150 crop. Preserve its native pixel size,
    # including the surrounding canvas so clipped or shifted actions stay visible.
    width,height=1002,780
    ctx=browser.new_context(viewport={"width":width,"height":height},device_scale_factor=1,
                            reduced_motion="reduce",color_scheme="dark")
    try:
        p=ctx.new_page()
        p.on("dialog",lambda d:d.accept())
        p.goto(preview.as_uri())
        p.locator("#status[data-workspace=ready]").wait_for()
        doc={"schemaVersion":1,"id":"dock-reference","theme":"paper","order":[],"objects":{},"assets":{}}
        p.locator("#project-picker").set_input_files({"name":"dock.mgcanvas","mimeType":"application/json",
            "buffer":json.dumps(doc).encode()})
        expect(p.locator("#status")).to_contain_text("项目已打开")
        p.locator("#fit").click()
        expect(p.locator("#zoom-read")).to_have_text("100%")
        assert p.evaluate("[innerWidth,innerHeight,devicePixelRatio,visualViewport.scale]")==[width,height,1,1]
        dock=p.locator("#main-tools")
        def shoot(state):
            p.mouse.move(2,3)
            path=output/f"{version}-{state}.png"
            p.screenshot(path=path,clip={"x":0,"y":height-150,"width":width,"height":150})
            return path
        p.locator("#theme-dark").check()
        p.locator("#canvas").focus()
        expect(p.locator("#tool-select")).to_have_attribute("aria-pressed","true")
        shoot("select-dark")
        p.locator("#theme-light").check()
        select=p.locator("#tool-select").bounding_box()
        hand=p.locator("#tool-hand").bounding_box()
        with Image.open(shoot("select-light")) as shot:
            def tile_fill(button):
                x=int(button["x"]+12)
                y=int(button["y"]+button["height"]-9)-(height-150)
                return shot.getpixel((x,y))
            selection_ratio=contrast(tile_fill(select),tile_fill(hand))
        p.locator("#theme-dark").check()
        p.locator("#tool-ink").click()
        dot=p.locator("#ink-main-color").bounding_box()
        btn=p.locator("#tool-ink").bounding_box()
        with Image.open(shoot("ink-black-dark")) as shot:
            x,y=int(dot["x"]+dot["width"]/2),int(dot["y"]+dot["height"]/2)-(height-150)
            fill=shot.getpixel((int(btn["x"]+btn["width"]/2),int(btn["y"]+btn["height"]-5)-(height-150)))
            center,rim=shot.getpixel((x,y)),shot.getpixel((int(dot["x"])+1,y))
            ring_ratio=contrast(rim,fill)
        print(version,"light selected/idle fills",round(selection_ratio,2),"dark ink center",center,
            "rim",rim,"selected fill",fill,"rim/fill",round(ring_ratio,2),flush=True)
        if version=="after":
            assert selection_ratio>=3 and ring_ratio>=3 and center[:3]==(34,51,68)
        p.locator("#ink-swatch-e34935").click()
        shoot("ink-dark")
        p.locator("#theme-light").check()
        shoot("ink-light")
        print(version,"1002 CSS px, DPR 1, page and board at 100%",dock.evaluate(
            "e=>({width:e.getBoundingClientRect().width,overflow:e.scrollWidth-e.clientWidth})"),flush=True)
    finally:
        ctx.close()


def check_touch(browser,preview):
    ctx=browser.contexts[0]
    p=ctx.pages[0]
    url="http://127.0.0.1/mg-touch-dock"
    p.route(url,lambda r:r.fulfill(path=preview,content_type="text/html; charset=utf-8"))
    p.goto(url)
    p.locator("#status[data-workspace=ready]").wait_for()
    cdp=ctx.new_cdp_session(p)
    def tap(control):
        box=control.bounding_box()
        point={"x":box["x"]+box["width"]/2,"y":box["y"]+box["height"]/2}
        cdp.send("Input.synthesizeTapGesture",{**point,"duration":100,"gestureSourceType":"touch"})

    for theme in ("light","dark"):
        p.locator("#theme-"+theme).check()
        toggle=p.locator("#toggle-creation")
        ink=p.locator("#tool-ink")
        tap(toggle)
        expect(ink).to_be_visible()
        assert ink.bounding_box()["height"]>=44
        tap(ink)
        expect(ink).to_have_attribute("aria-pressed","true")
        expect(toggle).to_have_attribute("aria-expanded","false")
        expect(p.locator("#ink-tools")).to_be_visible()
        assert p.locator("#ink-pen").bounding_box()["height"]>=44
        tap(p.locator("#tool-select"))
    print("Android touch",p.evaluate("innerWidth"),"CSS px, tool menu and both themes verified",flush=True)
    cdp.detach()


def check(browser, preview, output, narrow=False, apple=False):
    width = 390 if narrow else 1002
    ctx = browser.new_context(viewport={"width":width,"height":780},device_scale_factor=1,reduced_motion="reduce")
    if apple:
        ctx.add_init_script("""Object.defineProperty(navigator,'platform',{get:()=>'MacIntel'});
          Object.defineProperty(navigator,'userAgentData',{get:()=>({platform:'macOS'})});""")
    p = ctx.new_page()
    p.set_default_timeout(6500)
    p.on("dialog",lambda d:d.accept())
    p.goto(preview.as_uri())
    p.locator("#status[data-workspace=ready]").wait_for()
    doc={"schemaVersion":1,"id":"dock-qa","theme":"paper","order":[],"objects":{},"assets":{}}
    p.locator("#project-picker").set_input_files({"name":"dock.mgcanvas","mimeType":"application/json","buffer":json.dumps(doc).encode()})
    expect(p.locator("#status")).to_contain_text("项目已打开")
    canvas=p.locator("#canvas")
    def press(key):
        canvas.focus()
        p.keyboard.press(key)
    def pressed(id,yes=True):
        expect(p.locator("#"+id)).to_have_attribute("aria-pressed","true" if yes else "false")
    def click_tool(id):
        if narrow:
            p.locator("#toggle-creation").click()
        p.locator("#"+id).click()

    try:
        for id,key in (("tool-select","V"),("tool-hand","H"),("tool-connect","C"),("tool-mind","M"),
                       ("tool-text","T"),("tool-ink","P"),("shape-process","R"),("shape-line","L"),
                       ("mind-child","Tab"),("mind-sibling","Enter"),("mind-edit","F2"),("mind-done","Esc"),
                       ("path-finish","Enter"),("path-cancel","Esc"),("path-insert","I"),
                       ("undo","⌘Z" if apple else "Ctrl+Z"),("redo","⇧⌘Z" if apple else "Ctrl+Y")):
            expect(p.locator("#"+id+" .dock-key")).to_have_text(key)
        redo=p.locator("#redo")
        groups=p.locator("#main-tools > .dock-group")
        expect(groups).to_have_count(3)
        assert [len(group.locator("button").all()) for group in groups.all()]==[2,10,2]
        expect(redo).to_have_attribute("aria-keyshortcuts","Meta+Shift+Z" if apple else "Control+Y Control+Shift+Z")
        expect(redo).to_have_attribute("title","重做（⇧⌘Z）" if apple else "重做（Ctrl+Y 或 Ctrl+Shift+Z）")
        if narrow:
            p.locator("#toggle-creation").click()
        for id,name in (("tool-shapes","图形"),("tool-image","图片"),("redo","重做")):
            expect(p.locator("#"+id)).to_have_accessible_name(name)
        if narrow:
            p.locator("#toggle-creation").click()
        for id in ("tool-shapes","tool-sticky","tool-table","tool-document","tool-path","tool-image","shape-triangle","shape-decision"):
            assert p.locator("#"+id+" .dock-key").count()==0
        for key,id in [("h","tool-hand"),("v","tool-select"),("m","tool-mind"),("c","tool-connect"),("t","tool-text")]:
            press(key)
            pressed(id)
        canvas.click(position={"x":width/2-35,"y":180})
        field=p.locator("textarea.inline-text")
        expect(field).to_be_focused()
        cdp=ctx.new_cdp_session(p)
        field.evaluate("""e=>{window.qaIME=[];for(const name of ['compositionstart','compositionend'])
          e.addEventListener(name,()=>qaIME.push(name));}""")
        cdp.send("Input.imeSetComposition",{"text":"中文","selectionStart":2,"selectionEnd":2})
        cdp.send("Input.insertText",{"text":"中文"})
        field.press("p")
        field.press("t")
        expect(field).to_have_value("中文pt")
        assert p.evaluate("qaIME")==["compositionstart","compositionend"]
        p.locator(".inline-actions").get_by_role("button",name="完成").click()
        expect(field).to_have_count(0)
        expect(p.locator("#layers .layer")).to_have_count(1)
        mod="Meta" if apple else "Control"
        press(mod+"+z")
        expect(p.locator("#layers .layer")).to_have_count(0)
        press(mod+"+Shift+z")
        expect(p.locator("#layers .layer")).to_have_count(1)
        if not apple:
            press("Control+z")
            press("Control+y")
            expect(p.locator("#layers .layer")).to_have_count(1)
        for key,message in (("r","拖出图形大小"),("l","自由直线")):
            press(key)
            pressed("tool-shapes")
            expect(p.locator("#flow-help")).to_contain_text(message)
        click_tool("tool-shapes")
        expect(p.locator("#shape-palette")).to_be_visible()
        if narrow:
            walk_focus(p,"shape-palette",["shape-process","shape-decision","shape-triangle","shape-line"])
        for id in ("shape-process","shape-line"):
            item=p.locator("#"+id)
            item.scroll_into_view_if_needed()
            assert item.evaluate("""e=>{const r=e.getBoundingClientRect(),l=e.querySelector('span').getBoundingClientRect(),
                k=e.querySelector('kbd').getBoundingClientRect();return r.height>=44&&l.bottom<=k.top+1&&k.right<=r.right}""")
        if not narrow and not apple:
            p.locator("#theme-light").check()
            p.locator("#shape-process").hover()
            top=p.locator("#shape-palette").bounding_box()
            dock=p.locator("#main-tools").bounding_box()
            p.screenshot(path=output/"dock-shapes.png",clip={"x":dock["x"]-6,"y":top["y"]-6,
                "width":dock["width"]+12,"height":dock["y"]+dock["height"]-top["y"]+12})
        click_tool("tool-path")
        canvas.click(position={"x":130,"y":160})
        canvas.click(position={"x":170,"y":170})
        press("Enter")
        expect(p.locator("#path-tools")).to_be_hidden()
        expect(p.locator("#layers .layer")).to_have_count(2)
        click_tool("tool-path")
        press("Escape")
        expect(p.locator("#path-tools")).to_be_hidden()
        press(mod+"+z") # Keep both history buttons enabled for actual Tab navigation.
        expect(redo).to_be_enabled()
        expect(p.locator("#undo")).to_be_enabled()
        press("p")
        pressed("tool-ink")
        p.locator("#ink-swatch-e34935").click()
        for theme in ("light","dark"):
            p.locator("#theme-"+theme).check()
            rects=p.locator("#main-tools").evaluate("""dock=>{
              const box=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};};
              const rows=Array.from(dock.querySelectorAll('button')).filter(b=>b.getClientRects().length).map(b=>{
                const hint=b.querySelector('kbd'), chip=b.querySelector('i');
                const icon=b.querySelector('svg'), label=b.querySelector('span');
                return {id:b.id,button:box(b),icon:box(icon),captionClip:getComputedStyle(label).clipPath,
                  tip:b.title,hint:hint&&box(hint),hintBorder:hint&&getComputedStyle(hint).borderTopWidth,
                  chip:chip&&box(chip)};
              });
              const upper=document.querySelector('#ink-tools');
              return {dock:box(dock),upper:box(upper),rows,scroll:dock.scrollWidth-dock.clientWidth,
                vertical:[dock,upper].map(e=>e.scrollHeight-e.clientHeight)};
            }""")
            assert rects["scroll"]==0,(width,rects["scroll"])
            assert rects["vertical"]==[0,0],(width,rects["vertical"])
            gap=rects["dock"]["y"]-rects["upper"]["y"]-rects["upper"]["h"]
            assert gap>=5,(theme,gap)
            assert len({r["icon"]["y"] for r in rects["rows"] if r["id"]!="toggle-creation"})==1
            for row in rects["rows"]:
                k,icon,b=row["hint"],row["icon"],row["button"]
                assert b["h"]>=44 and b["w"]>=44,(row["id"],b)
                if row["id"]=="toggle-creation":
                    assert narrow and icon["w"]==icon["h"]==17 and row["captionClip"]=="none"
                    continue
                assert icon["w"]==icon["h"]==26 and row["captionClip"]=="inset(50%)" and row["tip"],row["id"]
                if k:
                    assert row["hintBorder"]=="0px"
                    assert k["x"]>=b["x"]-1 and k["x"]+k["w"]<=b["x"]+b["w"]+1
                    assert k["y"]>=icon["y"]+icon["h"]-1 and k["y"]+k["h"]<=b["y"]+b["h"]
                    assert abs((b["x"]+b["w"])-(k["x"]+k["w"])-5)<1
                    assert abs((b["y"]+b["h"])-(k["y"]+k["h"])-4)<1
                if row["chip"]:
                    assert row["chip"]["x"]+row["chip"]["w"]<=b["x"]+b["w"]
                    assert row["chip"]["y"]+row["chip"]["h"]<=k["y"]
            if narrow:
                widths=walk_focus(p,"main-tools",[row["id"] for row in rects["rows"]],output if theme=="dark" else None)
                print(theme,"390px Tab / Shift+Tab verified",len(widths),"buttons, redo fully visible",widths["redo"],"px",flush=True)
                for id in ("tool-select","redo","ink-pen","ink-finger"):
                    e=p.locator("#"+id)
                    e.scroll_into_view_if_needed()
                    assert e.evaluate("e=>{let r=e.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth}")
                toggle=p.locator("#toggle-creation")
                toggle.focus()
                toggle.press("Enter")
                expect(p.locator("#tool-shapes")).to_be_focused()
                p.keyboard.press("Tab")
                expect(p.locator("#tool-connect")).to_be_focused()
                p.keyboard.press("Escape")
                expect(toggle).to_be_focused()
                expect(p.locator("#creation-tools")).to_be_hidden()
            if not apple:
                p.mouse.move(1,1)
                x=0 if narrow else max(0,rects["dock"]["x"]-6)
                y=rects["upper"]["y"]-7
                p.screenshot(path=output/f"dock-{theme}-{width}.png",
                    clip={"x":x,"y":y,"width":min(width-x,rects["dock"]["w"]+12),
                          "height":rects["dock"]["y"]+rects["dock"]["h"]-y+7})
            # Keyboard focus should be visible despite the scroll container's clipping.
            p.locator("#tool-select").focus()
            p.keyboard.press("Tab")
            assert p.evaluate("getComputedStyle(document.activeElement).outlineStyle")!="none"
        if not narrow:
            for test_width in (650,760,780,800,1002,1100):
                p.set_viewport_size({"width":test_width,"height":780})
                for brush in ("highlighter","eraser","pen"):
                    p.locator("#ink-"+brush).click()
                    horizontal,vertical=p.locator("#main-tools").evaluate(
                        "e=>[e.scrollWidth-e.clientWidth,e.scrollHeight-e.clientHeight]")
                    assert vertical==0,(test_width,brush,vertical)
                    assert horizontal==0,(test_width,brush,horizontal)
                    assert p.locator("#ink-main-color").is_visible()==(test_width>800 and brush!="eraser")
        print(width,"Mac legend" if apple else "Windows", "dock width",round(rects["dock"]["w"]),
              "scroll overshoot",rects["scroll"],"gap",gap,flush=True)
    finally:
        ctx.close()


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview",type=Path)
    parser.add_argument("output",type=Path)
    parser.add_argument("--touch-cdp",help="Use a narrow Android test browser at this loopback CDP endpoint")
    parser.add_argument("--reference",choices=["before","after"],help="Capture native-size views in desktop Chrome")
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as pw:
        if args.touch_cdp:
            check_touch(pw.chromium.connect_over_cdp(args.touch_cdp),args.preview.resolve())
        else:
            browser=pw.chromium.launch(channel="chrome",chromium_sandbox=True,headless=False,
                args=["--force-device-scale-factor=1","--window-position=-12000,20"])
            try:
                if args.reference:
                    capture_reference(browser,args.preview.resolve(),args.output,args.reference)
                else:
                    for narrow,apple in ((False,False),(True,False),(False,True)):
                        check(browser,args.preview.resolve(),args.output,narrow,apple)
            finally:
                browser.close()
