"""Exercise the selected object's actual toolbar in the shipped offline editor."""
import argparse
import json
from pathlib import Path
import runpy
import subprocess
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright


def ticks(p):
    p.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")


def export(p,disk=False):
    if disk:
        p.evaluate("window.allowProjectDownload=true")
        try:
            with p.expect_download() as dl:p.locator("#project-export").evaluate("b=>b.click()")
            return json.loads(Path(dl.value.path()).read_bytes())
        finally:p.evaluate("window.allowProjectDownload=false")
    return p.evaluate("""async()=>{
      window.packageText=null;document.querySelector('#project-export').click();
      if(!window.packageText)throw new Error('No export: '+document.querySelector('#status').textContent+' / '+document.activeElement.outerHTML.slice(0,180));
      return JSON.parse(await window.packageText);
    }""")


def load(p,doc):
    p.locator("#project-picker").set_input_files({"name":"工具栏验收.mgcanvas","mimeType":"application/json","buffer":json.dumps(doc,ensure_ascii=False).encode()})
    expect(p.locator("#status")).to_contain_text("项目已打开")
    ticks(p);p.locator("#fit").click();ticks(p)


def choose(p,id):
    if not p.locator("#layers-panel").is_visible():p.locator("#toggle-layers").click()
    p.locator(f'#layers [data-id="{id}"]').click()
    if p.locator("#layers-panel").is_visible():p.locator("#close-layers").click()
    ticks(p)


def react_control(locator):
    expect(locator).to_be_visible()
    assert locator.evaluate("e=>Object.keys(e).some(k=>k.startsWith('__reactFiber$'))"), locator


def sample(p):
    initial=export(p)["document"]["objects"]
    text=dict(initial["mind-heading"],id="title",text="发布计划",at={"x":-425,"y":-52},width=190,height=51,fontSize=32,color="#243854")
    shape=dict(initial["flow-source"],shape="rect",rotation=0,cornerRadius=4,strokeWidth=0)
    sticky=dict(shape,id="memo",at={"x":-173,"y":-58},width=202,height=139,fill="#fff0a6",label="发布前核对\n确认文案与配图\n周五交付",content={"kind":"sticky","fontSize":19})
    doc=dict(shape,id="guide",at={"x":105,"y":-82},width=314,height=193,fill="#ffffff",label="## 编辑说明\n核对正文中的关键文字。\n- 更新会议纪要\n- 确认最终版本",content={"kind":"markdown","fontSize":16})
    return {"schemaVersion":1,"id":"toolbar-review","theme":"paper","assets":{},"objects":{o["id"]:o for o in [text,sticky,doc]},"order":["title","memo","guide"]}


def run(page,preview,shots):
    p=page;p.set_default_timeout(5000);p.on("dialog",lambda d:d.accept());errors=[]
    p.on("pageerror",lambda e:errors.append(str(e)))
    p.add_init_script("""{
      const actual=HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click=function(){
        if(this.download.endsWith('.mgcanvas')&&!window.allowProjectDownload){window.packageText=fetch(this.href).then(r=>r.text());return;}
        return actual.call(this);
      };
    }""")
    p.goto(preview.as_uri());expect(p.locator("#layers .layer").first).to_be_attached()
    assert p.locator("#inspector-panel,#toggle-inspector,#close-inspector").count()==0
    p.locator("#theme-light").check();doc=sample(p)
    bar=p.locator("#text-format-bar");strip=bar.locator(".format-strip")
    widths={}
    for id,kind in (("title","text"),("memo","sticky"),("guide","markdown")):
        load(p,doc)
        choose(p,id);expect(bar).to_have_attribute("data-layout",kind);expect(bar).to_be_visible()
        assert strip.evaluate("s=>s.scrollWidth<=s.clientWidth+1")
        widths[kind]=bar.bounding_box()["width"]
        assert widths[kind]<p.viewport_size["width"]*.68 and strip.bounding_box()["height"]<52,(kind,widths,strip.bounding_box())
        size=strip.get_by_role("spinbutton",name="自定义字号");expect(size).to_have_count(1)
        if kind=="sticky":
            expect(size).to_have_value("19");expect(size).to_have_attribute("data-current","true")
            expect(strip.get_by_role("button",name="便签纸色 · 浅黄")).to_have_attribute("aria-pressed","true")
        if shots:p.screenshot(path=shots/f"M5BA-Toolbar-{kind}.png")
        presets={"text":[16,24,32],"sticky":[16,20,24],"markdown":[14,16,20]}[kind]
        sizes=strip.get_by_role("group",name="整篇文档字号" if kind=="markdown" else "字号",exact=True)
        expect(sizes.get_by_role("button")).to_have_count(3)
        def item():return export(p)["document"]["objects"][id]
        def style():
            record=item()
            return record if kind=="text" else json.loads(record["stroke"].removeprefix("mgcanvas:card-style/1:"))[1]
        for n in presets:
            direct=sizes.get_by_role("button",name=f"{n} 像素",exact=True);direct.click()
            expect(direct).to_have_attribute("aria-pressed","true");expect(size).to_have_value(str(n))
            assert style()["fontSize"]==n
        size.fill("19");size.press("Enter");expect(size).to_have_attribute("data-current",str(19 not in presets).lower())
        assert style()["fontSize"]==19
        for paint in strip.locator("[data-quick-paint]").all():
            key=paint.get_attribute("data-quick-paint");swatches=paint.locator("button[data-paint-value]")
            assert 2<=swatches.count()<=4
            for direct in swatches.all():
                value=direct.get_attribute("data-paint-value");direct.click()
                expect(direct).to_have_attribute("aria-pressed","true")
                expect(paint.locator('button[aria-pressed="true"]')).to_have_count(1)
                expect(bar.locator("#format-options")).to_be_hidden()
                if key=="ink" and value!="auto":assert style()["color"].lower()==value
                elif key=="background":assert item().get("background" if kind=="text" else "fill","transparent")==value
        if kind=="sticky":
            before=item();strip.get_by_role("button",name="便签纸色 · 薄荷").click()
            after=item();assert after["fill"]=="#c2ebd9"
            p.locator("#undo").click();assert item()==before
            p.locator("#redo").click();assert item()==after
    load(p,doc)
    choose(p,"title")
    bar.get_by_role("button",name="选择字体",exact=True).click()
    bar.get_by_role("button",name="思源宋体",exact=True).click()
    spin=bar.get_by_role("spinbutton",name="自定义字号")
    spin.fill("30");spin.fill("31");spin.press("Control+z");expect(spin).to_have_value("32")
    spin.press("Control+Shift+z");expect(spin).to_have_value("31")
    spin.press("Enter");strip.get_by_role("button",name="32 像素").click()
    assert export(p)["document"]["objects"]["title"]["fontFamily"]=="noto-serif"
    choose(p,"memo")
    bar.get_by_role("button",name="更多纸色").click()
    bar.get_by_role("button",name="#14785a",exact=True).click()
    bar.get_by_role("button",name="居中",exact=True).click()
    note=export(p)["document"]["objects"]["memo"]
    assert note["fill"]=="#14785a" and json.loads(note["stroke"].removeprefix("mgcanvas:card-style/1:"))[1]["align"]=="center"
    choose(p,"guide");p.locator("#canvas").press("F2");rich=p.locator(".markdown-field");expect(rich).to_be_focused()
    def select_words(row,word):
        rich.locator(".card-block").nth(row).evaluate("""(el,word)=>{
          const t=[...el.childNodes].find(n=>n.nodeType===3&&n.textContent.includes(word)),i=t.textContent.indexOf(word);
          const r=document.createRange();r.setStart(t,i);r.setEnd(t,i+word.length);getSelection().removeAllRanges();getSelection().addRange(r);
        }""",word)
        ticks(p)
    select_words(1,"关键文字")
    strip.get_by_role("button",name="20 像素").click()
    expect(p.locator(".card-editor")).to_have_css("font-size","20px")
    strip.get_by_role("button",name="整篇字色 · 蓝色").click()
    expect(rich).to_be_focused();assert p.evaluate("getSelection().toString()")=="关键文字"
    bar.get_by_role("button",name="所选文字粗体").click()
    expect(rich.locator("strong")).to_have_text("关键文字")
    assert p.evaluate("getSelection().toString()")=="关键文字"
    bar.get_by_role("button",name="当前段落设为一级标题").click()
    expect(rich.locator("h1")).to_have_text("核对正文中的关键文字。")
    assert p.evaluate("getSelection().toString()")=="关键文字"
    bar.get_by_role("button",name="编号列表",exact=True).click()
    expect(rich.locator(".card-block").nth(1)).to_have_attribute("data-marker","1.")
    rich.press("Control+z");expect(rich.locator("h1")).to_be_visible()
    rich.press("Control+Shift+z");expect(rich.locator(".card-block").nth(1)).to_have_attribute("data-marker","1.")
    rich.dispatch_event("compositionstart")
    bar.get_by_role("button",name="当前段落设为二级标题").click()
    expect(rich).to_be_focused()
    expect(rich.locator(".card-block").nth(1)).to_have_attribute("data-marker","1.")
    rich.dispatch_event("compositionend");p.wait_for_timeout(60)
    rich.press("Control+Enter")
    saved=export(p,disk=True);load(p,saved);assert export(p)["document"]==saved["document"]
    for theme in ("dark","light"):
        p.set_viewport_size({"width":375,"height":650});p.locator("#theme-"+theme).check();p.locator("#fit").click()
        for id,kind,menu in [("title","text","选择字体"),("memo","sticky","更多纸色"),("guide","markdown","段落样式")]:
            choose(p,id);bar.get_by_role("button",name=menu,exact=True).click();panel=bar.locator("#format-options")
            expect(panel).to_be_visible()
            for el in (bar,panel):
                bounds=el.bounding_box()
                assert bounds["x"]>=-1 and bounds["x"]+bounds["width"]<=376 and bounds["y"]>=0 and bounds["y"]+bounds["height"]<=651,(kind,bounds)
            p.keyboard.press("Escape")
    check_table_switch(p,doc["objects"]["memo"])
    assert not errors,errors
    print("Object toolbar widths (CSS px)",widths,"verified selection, immediate edits, history, reopen, IME and narrow menus.",flush=True)

def check_table_switch(p,memo):
    table={"kind":"table","id":"grid","at":{"x":140,"y":-80},"width":320,"height":120,"rotation":0,
           "style":{"background":"#fcf2d8"},"cells":[[{"text":"甲"},{"text":"乙"}],[{"text":"丙"},{"text":"丁"}]]}
    doc={"schemaVersion":6,"id":"shared-bar","theme":"paper","objects":{"memo":memo,"grid":table},"order":["memo","grid"],"assets":{}}
    p.set_viewport_size({"width":1180,"height":760});load(p,doc);choose(p,"grid")
    bar=p.locator("#text-format-bar");strip=bar.locator(".format-strip")
    expect(bar).to_have_attribute("data-layout","table")
    width=bar.bounding_box()["width"]
    assert strip.bounding_box()["height"]<52 and strip.evaluate("s=>s.scrollWidth<=s.clientWidth+1")
    expect(strip.locator('[data-quick-paint="background"]')).to_have_count(0)
    def click(name):
        b=strip.get_by_role("button",name=name,exact=True);b.click();expect(b).to_have_attribute("aria-pressed","true")
    def grid():return export(p)["document"]["objects"]["grid"]
    click("24 像素");click("字色 · 蓝色")
    whole=grid();assert whole["style"]=={"fontSize":24,"color":"#3567bd","background":"#fcf2d8"}
    rect=p.locator(".table-controls").bounding_box()
    p.mouse.click(rect["x"]+rect["width"]*.75,rect["y"]+rect["height"]*.75)
    click("14 像素");click("字色 · 红色")
    cell=grid();assert cell["cells"][1][1]["style"]=={"fontSize":14,"color":"#be384c"}
    assert cell["style"]==whole["style"] and cell["cells"][0]==whole["cells"][0] and cell["cells"][1][0]==whole["cells"][1][0]
    p.locator("#undo").click();assert grid()["cells"][1][1]["style"]=={"fontSize":14}
    p.locator("#redo").click();assert grid()==cell
    for theme in ("dark","light"):
        p.set_viewport_size({"width":375,"height":650});p.locator("#theme-"+theme).check();p.locator("#fit").click()
        choose(p,"memo");expect(bar).to_have_attribute("data-layout","sticky");click("便签纸色 · 天蓝")
        choose(p,"grid");expect(bar).to_have_attribute("data-layout","table")
        assert strip.evaluate("s=>s.scrollWidth<=s.clientWidth+1")
        expect(strip.locator('[data-quick-paint="background"]')).to_have_count(0)
        strip.get_by_role("button",name="更多字色").click()
        expect(bar.locator("#format-options")).to_be_visible()
        expect(bar.locator("#format-options").get_by_role("button",name="透明背景")).to_have_count(0)
        p.keyboard.press("Escape")
    load(p,export(p,disk=True));assert grid()==cell and export(p)["document"]["objects"]["memo"]["fill"]=="#cde5fd"
    print("Table toolbar width (CSS px)",width,"verified direct whole/cell formatting and sticky paper after switching.",flush=True)

def migrated(p):
    errors=[]
    p.on("pageerror",lambda e:errors.append(str(e)))
    fixture=Path(__file__).resolve().parents[1]/"docs/fixtures/M5S-Cubic-Paths.mgcanvas"
    board=json.loads(fixture.read_bytes());p.set_viewport_size({"width":1180,"height":760});load(p,board)
    bar=p.locator("#text-format-bar");options=bar.locator("#inspector")
    def state(id):return export(p)["document"]["objects"][id]
    def open_group(name):
        b=bar.get_by_role("button",name=name,exact=True)
        if b.get_attribute("aria-expanded")!="true":b.click()
        expect(options).to_be_visible()
    for id,section,field,path,value in [
        ("flow-submit","变换","radius",["cornerRadius"],15),
        ("flow-review","线宽与颜色","strokeWidth",["strokeWidth"],7),
        ("flow-first","连线样式","connectorWidth",["strokeWidth"],9),
        ("open-path","路径样式","pathWidth",["strokeWidth"],8),
        ("sample-ink","笔迹样式","selectedInkWidth",["baseWidth"],13),
        ("qa-label","变换","textRotation",["rotation"],45),
        ("qa-picture","变换","x",["at","x"],137)]:
        choose(p,id);expect(bar).to_be_visible();open_group(section)
        f=options.locator(f'[name="{field}"]');expect(f).to_be_visible()
        before=state(id);f.fill("");assert state(id)==before
        f.fill(str(value+1));f.fill(str(value));f.press("Tab");after=state(id)
        v=after
        for k in path:v=v[k]
        assert abs(v-(value*3.141592653589793/180 if field=="textRotation" else value))<1e-6,(field,v)
        p.locator("#undo").click();assert state(id)==before,(field,"undo")
        p.locator("#redo").click();assert state(id)==after,(field,"redo")
    choose(p,"qa-picture");shadow=bar.get_by_role("checkbox",name="图片阴影");lock=bar.get_by_role("checkbox",name="锁定图片宽高比")
    expect(shadow).to_be_checked();shadow.uncheck();expect(shadow).not_to_be_checked()
    projected=export(p);image=projected["document"]["objects"]["qa-picture"]
    assert "shadow" not in image and projected["shadowlessImages"]==["qa-picture"] and projected["assets"]==board["assets"]
    p.locator("#undo").click();expect(shadow).to_be_checked()
    p.locator("#redo").click();expect(shadow).not_to_be_checked()
    lock.uncheck();open_group("变换")
    options.locator('[name="height"]').fill("23");p.keyboard.press("Escape")
    bar.get_by_role("button",name="恢复原始比例").click()
    img=state("qa-picture");asset=board["document"]["assets"][img["assetId"]]
    assert abs(img["width"]/img["height"]-asset["pixelWidth"]/asset["pixelHeight"])<.022
    saved=export(p,disk=True);load(p,saved);choose(p,"qa-picture")
    expect(shadow).not_to_be_checked();expect(lock).not_to_be_checked()
    for id,group,marker in [("flow-first","端点与折点","端点"),("flow-submit","节点文字","节点文字"),("closed-path","路径样式","填充"),("mind-booking","整图布局","整图")]:
        choose(p,id);open_group(group);expect(options).to_contain_text(marker)
    choose(p,"open-path");react_control(bar.get_by_role("button",name="编辑顶点",exact=True))
    choose(p,"qa-label");open_group("更多");react_control(options.locator("summary").first)
    choose(p,"flow-submit");open_group("节点文字")
    label=options.get_by_role("textbox",name="节点文字");remove=options.get_by_role("button",name="删除节点")
    for control in [bar,options,label,remove,bar.get_by_role("button",name="排列后续节点")]:
        react_control(control)
    original=state("flow-submit");label.focus();label.press("Control+a")
    native_field=label.element_handle()
    ime=p.context.new_cdp_session(p)
    ime.send("Input.imeSetComposition",{"text":"审批","selectionStart":2,"selectionEnd":2})
    expect(label).to_be_focused()
    assert label.evaluate("(e,original)=>e===original",native_field)
    ime.send("Input.insertText",{"text":"审批通过"});ime.detach()
    expect(label).to_have_value("审批通过");label.press("Enter")
    assert state("flow-submit")["label"]=="审批通过"
    label.press("Control+z");assert state("flow-submit")==original
    label.press("Control+Shift+z");assert state("flow-submit")["label"]=="审批通过"
    remove.click();assert "flow-submit" not in export(p)["document"]["objects"]
    p.locator("#undo").click();assert state("flow-submit")["label"]=="审批通过"
    choose(p,"flow-first");open_group("端点与折点")
    before=state("flow-first")
    end=options.locator(".endpoint-rows").last
    rebind=end.get_by_role("button",name="重绑");detach=end.get_by_role("button",name="解绑")
    for control in [rebind,detach,options.get_by_role("button",name="添加拐点"),options.get_by_role("button",name="删除连线")]:
        react_control(control)
    target=state("flow-display");rebind.click()
    xy=p.evaluate("""async point=>{
      const {viewport:c}=(await mgCanvasTools.callTool("canvas_read",{limit:1})).structuredContent;
      const r=document.querySelector("#canvas").getBoundingClientRect();
      return [r.left+c.offset.x+point.x*c.zoom,r.top+c.offset.y+point.y*c.zoom];
    }""",{"x":target["at"]["x"]+target["width"]/2,"y":target["at"]["y"]})
    p.mouse.click(*xy);ticks(p)
    rebound=state("flow-first");assert rebound["to"]=={"kind":"anchor","objectId":"flow-display","portId":"north"},rebound
    p.locator("#undo").click();assert state("flow-first")==before
    p.locator("#redo").click();assert state("flow-first")==rebound
    choose(p,"flow-first");open_group("端点与折点");detach.click()
    assert state("flow-first")["to"]["kind"]=="free"
    p.locator("#undo").click();assert state("flow-first")==rebound
    print("Verified React-rendered node label, delete and endpoint actions, Chinese composition, rebind and undo/redo.",flush=True)
    # Multi-select via the layer list and check that group-level tools replace the single-object palette.
    choose(p,"flow-submit");p.locator("#toggle-layers").click()
    p.locator('#layers [data-id="flow-review"]').click(modifiers=["Shift"])
    p.locator("#close-layers").click();ticks(p);open_group("整体位移")
    before=state("flow-submit")["at"]["x"];options.locator('[name="deltaX"]').fill("12")
    assert state("flow-submit")["at"]["x"]==before+12
    p.locator("#undo").click();assert state("flow-submit")["at"]["x"]==before
    open_group("流程组");options.get_by_role("button",name="创建流程组").click()
    assert export(p)["document"]["flowGroups"]["members"]
    open_group("流程组");expect(options.get_by_role("button",name="取消分组")).to_be_visible()
    options.get_by_role("button",name="取消分组").click()
    for id,group in [("qa-picture","变换"),("flow-submit","变换"),("flow-first","端点与折点"),("open-path","路径样式"),("sample-ink","笔迹样式")]:
        p.set_viewport_size({"width":320,"height":640});p.locator("#fit").click();choose(p,id)
        open_group(group)
        for el in [bar,options]:
            box=el.bounding_box();assert box["x"]>=-1 and box["x"]+box["width"]<=321 and box["y"]>=0 and box["y"]+box["height"]<=641,(id,box)
        p.keyboard.press("Escape")
    assert not errors,errors
    print("Verified image controls and asset bytes, shape/line/path/ink/text live geometry, grouped undo/redo, multi-select/group and narrow properties.",flush=True)


def remounted(browser):
    """Use the lifecycle suite's real StrictMode entry so both editors live in the same tab."""
    root=Path(__file__).resolve().parents[1]
    fixture=runpy.run_path(str(root/"scripts/check-viewport-lifecycle-browser.py"))
    ready=fixture["RECOVERY"]["ready"]
    origin=fixture["ORIGIN"]
    def read(p,id):
        return fixture["RECOVERY"]["canvas_tool"](p,ids=[id],detail="full")["objects"][0]["object"]
    with TemporaryDirectory(prefix="mg-object-remount-") as tmp, browser.new_context(viewport={"width":1180,"height":780}) as ctx:
        bundle=Path(tmp)/"main.js"
        subprocess.run(["node","--input-type=module","-e",fixture["BUNDLE"],str(bundle)],cwd=root,
                       input=fixture["ENTRY"],text=True,encoding="utf-8",check=True)
        files={"/":(root/"app/index.html","text/html"),"/main.js":(bundle,"text/javascript"),"/style.css":(root/"app/style.css","text/css")}
        def local_asset(route):
            asset=files.get(route.request.url.removeprefix(origin))
            if asset:route.fulfill(path=asset[0],content_type=asset[1])
            else:route.abort()
        ctx.route("**/*",local_asset)
        p=ctx.new_page();p.set_default_timeout(5000);p.on("dialog",lambda d:d.accept());errors=[]
        p.on("pageerror",lambda x:errors.append(str(x)))
        p.goto(origin);p.evaluate("mountEditor()");ready(p);choose(p,"mind-heading")
        bar=p.locator("#text-format-bar")
        old_button=bar.get_by_role("button",name="24 像素",exact=True).element_handle()
        bar.get_by_role("button",name="更多",exact=True).click()
        p.locator("#inspector").get_by_role("button",name="编辑文字",exact=True).click()
        field=p.get_by_role("textbox",name="独立文字内容")
        expect(field).to_be_focused();field.fill("重挂后保留的输入");old_input=field.element_handle()
        p.evaluate("unmountEditor();mountEditor()");ready(p)
        expect(field).to_have_value("重挂后保留的输入")
        assert not old_input.evaluate("e=>e.isConnected") and not old_button.evaluate("e=>e.isConnected")
        expect(field).to_be_focused();field.press("Control+Enter")
        assert read(p,"mind-heading")["text"]=="重挂后保留的输入"
        load(p,json.loads((root/"docs/fixtures/M5S-Cubic-Paths.mgcanvas").read_bytes()));choose(p,"qa-label")
        before=read(p,"qa-label")
        old_button.evaluate("e=>e.click()")
        assert read(p,"qa-label")==before
        size=16 if before["fontSize"]!=16 else 24
        new_button=bar.get_by_role("button",name=f"{size} 像素",exact=True)
        react_control(new_button);new_button.click()
        assert read(p,"qa-label")["fontSize"]==size
        p.locator("#undo").click();assert read(p,"qa-label")==before
        p.evaluate("unmountEditor()");assert not errors,errors
        print("Verified same-tab StrictMode remount, draft recovery, expired controls and one-step undo on the new board.",flush=True)


if __name__=="__main__":
    args=argparse.ArgumentParser(description=__doc__)
    args.add_argument("preview",type=Path);args.add_argument("--screenshots",type=Path);args=args.parse_args()
    with sync_playwright() as pw:
        b=pw.chromium.launch(channel="chrome",headless=True,chromium_sandbox=True)
        p=b.new_page(viewport={"width":1180,"height":760},device_scale_factor=1)
        run(p,args.preview.resolve(),args.screenshots);migrated(p);remounted(b);b.close()
