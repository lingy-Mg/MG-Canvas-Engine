"""Exercise canvas text paints, toolbar editing and the floating property panels in Chromium."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


FIXTURES = Path(__file__).resolve().parents[1] / "docs/fixtures"
BRANCHES = ["预约管理", "门禁控制", "黄色分支", "绿色分支", "蓝色分支", "紫色分支"]
FILLS = ["#c74450", "#bd782e", "#9e8531", "#24846d", "#3e71bd", "#7759ae"]


def export_board(page, preserve_focus=False):
    with page.expect_download() as event:
        button=page.locator("#project-export")
        if preserve_focus:
            button.evaluate("el=>el.click()")
        else:
            button.click()
    return json.loads(Path(event.value.path()).read_text(encoding="utf8"))


def load(page, data, layer):
    page.locator("#project-picker").set_input_files({
        "name": "text-review.mgcanvas", "mimeType": "application/json", "buffer": json.dumps(data).encode()
    })
    expect(page.locator(f'#layers [data-id="{layer}"]')).to_be_attached()
    expect(page.locator("#status")).to_contain_text("项目已打开")
    page.locator("#fit").click()


def select(page, object_id):
    if not page.locator("#layers-panel").is_visible():
        page.locator("#toggle-layers").click()
    page.locator(f'#layers [data-id="{object_id}"]').click()
    if page.locator("#layers-panel").is_visible():page.locator("#close-layers").click()
    ticks(page)


def ticks(page):
    page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")


def group(page,label):
    trigger=page.locator("#text-format-bar .format-strip").get_by_role("button",name=label,exact=True)
    if trigger.get_attribute("aria-expanded")!="true":trigger.click()


def full_text(page):
    group(page,"更多")
    details=page.locator("details.advanced-properties")
    if details.get_attribute("open") is None:details.locator(":scope>summary").click()


def contrast(fg, bg):
    def light(hexcolor):
        rgb = [int(hexcolor[i:i+2],16)/255 for i in (1,3,5)]
        return sum(c*w for c,w in zip([b/12.92 if b<=.04045 else ((b+.055)/1.055)**2.4 for b in rgb], [.2126,.7152,.0722]))
    a,b = sorted([light(fg),light(bg)])
    return (b+.05)/(a+.05)


def compare_theme(page, output, baseline):
    board = export_board(page)
    objects = board["document"]["objects"]
    # Use the original two heading records to exercise old files without color provenance.
    for key in ("mind-heading","flow-heading"):
        objects[key].pop("colorMode",None)
    src = objects["mind-heading"]
    note = dict(src,id="digits",text="123123",color="#243854",at={"x":120,"y":-95},fontSize=24,width=180,height=34)
    objects["digits"]=note
    objects["explicit"]=dict(note,id="explicit",text="Custom ink",color="#a64276",at={"x":125,"y":-48})
    board["document"]["order"].extend(["digits","explicit"])
    tree = objects["mind-room"]
    root = tree["topics"][tree["rootId"]]
    root["childIds"]=[]
    for i,name in enumerate(BRANCHES):
        key = "branch-"+str(i)
        tree["topics"][key]={"id":key,"text":name,"side":"right","collapsed":False,"childIds":[]}
        root["childIds"].append(key)
    tree["topics"]={k:v for k,v in tree["topics"].items() if k in root["childIds"] or k==tree["rootId"]}
    load(page,board,"digits")
    page.locator("#fit").click()
    for theme in ("light","dark","light"):
        page.locator("#theme-"+theme).check()
        page.evaluate("window.paints={};window.outlines={}")
        page.locator("#fit").click()
        ticks(page)
        paints,strokes=page.evaluate("[window.paints,window.outlines]")
        bg="#1b1d23" if theme=="dark" else "#f3f5f9"
        head=next(key for key in paints if "功能脑图" in key)
        if baseline and theme=="dark":
            assert head in strokes and "123123" in strokes
            assert contrast(paints["123123"]["ink"],bg)<2
        else:
            assert head not in strokes and "123123" not in strokes
            for text in (head,"123123","进入审批"):
                assert contrast(paints[text]["ink"],bg)>=4.5,(text,theme,paints[text])
            # Count actual opaque text-colored pixels inside the draw call's transformed ink bounds.
            for text in (head,"123123"):
                assert paints[text]["pixels"]>=4,(text,theme,paints[text])
        assert paints["Custom ink"]["ink"]=="#a64276"
        assert contrast(paints["提交预约"]["ink"],objects["flow-source"]["fill"])>=4.5
        for label,fill in zip(BRANCHES,FILLS):
            assert contrast(paints[label]["ink"],fill)>=4.5,(label,fill,paints[label])
        if output: page.screenshot(path=output/("board-"+theme+".png"))
    return board


def text_panel(page,board,output):
    select(page,"digits")
    form=page.locator("#inspector form.text-properties")
    field=lambda name: form.locator(f'[name="{name}"]')
    radio=lambda name,value: form.locator(f'[name="{name}"][value="{value}"]')
    expect(form.get_by_role("button",name="应用文字属性")).to_have_count(0)
    for theme in ("light","dark"):
        page.locator("#theme-"+theme).check()
        group(page,"变换")
        expect(field("textHeight")).to_be_disabled()
        expect(field("textBackground")).to_be_disabled()
        radio("textHeightMode","fit").focus()
        page.keyboard.press("ArrowRight")
        expect(radio("textHeightMode","fixed")).to_be_checked()
        expect(field("textHeight")).to_be_enabled()
        assert radio("textHeightMode","fixed").evaluate("n=>getComputedStyle(n.nextElementSibling).outlineStyle==='solid'")
        if output:
            page.locator("#inspector").screenshot(path=output/("panel-"+theme+".png"))
        page.keyboard.press("Control+z")
        expect(radio("textHeightMode","fit")).to_be_checked()
    full_text(page)
    form.locator(".font-picker summary").click()
    expect(form.get_by_text("无衬线",exact=True)).to_be_visible()
    expect(form.get_by_text("衬线",exact=True)).to_be_visible()
    radio("textFamily","georgia").check()
    if form.locator(".font-picker[open]").count(): form.locator(".font-picker summary").click()
    radio("textWeight","700").check()
    field("textItalic").check()
    radio("textAlign","center").check()
    radio("textBackgroundMode","solid").check()
    field("textBackground").fill("#14253a")
    expect(field("textInk")).to_have_value("#ffffff")
    before_size=export_board(page,preserve_focus=True)["document"]["objects"]["digits"]
    field("textSize").fill("")
    field("textSize").press_sequentially("26")
    expect(field("textSize")).to_be_focused()
    ticks(page)
    assert "26px" in page.evaluate("window.paints['123123'].font")
    styled=export_board(page)
    item=styled["document"]["objects"]["digits"]
    assert (item["fontFamily"],item["fontSize"],item["fontWeight"],item["italic"],item["align"],item["background"])==("georgia",26,700,True,"center","#14253a")
    page.locator("#undo").click()
    assert export_board(page)["document"]["objects"]["digits"]==before_size
    page.locator("#redo").click()
    assert export_board(page)["document"]["objects"]["digits"]==item
    load(page,styled,"digits")
    select(page,"digits")
    full_text(page)
    expect(radio("textWeight","700")).to_be_checked()
    field("textInk").fill("#314159")
    expect(radio("textInkMode","custom")).to_be_checked()
    expect(form.get_by_role("button",name="取消")).to_have_count(0)
    field("textInk").press("Control+z")
    expect(radio("textInkMode","auto")).to_be_checked()
    return item


def toolbar(page,original,output):
    panel=page.locator("#inspector")
    bar=page.locator("#text-format-bar")
    control=lambda key: bar.locator(f'.format-strip [data-format="{key}"]')
    expect(bar).to_be_visible()
    expect(control("strike")).to_be_hidden()
    group(page,"更多")
    panel.get_by_role("button",name="编辑文字").click()
    edit=page.locator("textarea.inline-text")
    text="文字 Ag 0123456789\n第二行中文 Mixed 09"
    edit.fill(text)
    edit.evaluate("n=>n.setSelectionRange(2,7,'backward')")
    control("italic").click()
    expect(edit).to_be_focused()
    assert edit.evaluate("n=>[n.selectionStart,n.selectionEnd,n.selectionDirection]")==[2,7,"backward"]
    assert edit.evaluate("n=>getComputedStyle(n).fontStyle")=="normal"
    assert edit.evaluate("n=>getComputedStyle(n).backgroundColor")=="rgb(20, 37, 58)"
    edit.dispatch_event("compositionstart")
    control("bold").click()
    expect(edit).to_be_focused()
    expect(edit).to_have_value(text)
    edit.press("Escape")
    expect(edit).to_be_visible()
    edit.dispatch_event("compositionend")
    page.wait_for_timeout(60)
    edit.press("Alt+F10")
    expect(bar.get_by_role("button",name="选择字体")).to_be_focused()
    size=bar.get_by_role("spinbutton",name="自定义字号");size.fill("32");size.press("Enter")
    expect(edit).to_be_focused()
    assert edit.evaluate("n=>[n.selectionStart,n.selectionEnd]")==[2,7]
    edit.press("Escape")
    expect(edit).to_have_count(0)
    assert export_board(page)["document"]["objects"]["digits"]==original
    select(page,"digits")
    group(page,"更多")
    panel.get_by_role("button",name="编辑文字").click()
    edit.fill(text)
    group(page,"选择字体")
    bar.get_by_role("button",name="思源宋体",exact=True).click()
    bar.get_by_role("button",name="文字背景 · 透明",exact=True).click()
    bar.get_by_role("button",name="居右",exact=True).click()
    if output: page.screenshot(path=output/"format-editing.png")
    edit.press("Control+Enter")
    result=export_board(page)["document"]["objects"]["digits"]
    assert result["text"]==text and result["fontFamily"]=="noto-serif" and result["align"]=="right" and "background" not in result
    ticks(page)
    fonts=page.evaluate("Object.entries(window.paints).filter(([s,p])=>s&&p.font.includes('Source Han Serif')).map(([s,p])=>p.font)")
    assert fonts and all(f.startswith(("italic bold ","italic 700 ")) for f in fonts),fonts
    assert page.evaluate("window.measured.some(f=>f===Object.values(window.paints).find(row=>row.font.includes('Source Han Serif'))?.font)")
    page.locator("#undo").click()
    assert export_board(page)["document"]["objects"]["digits"]==original
    page.locator("#redo").click()
    select(page,"digits")
    control("bold").click()
    assert export_board(page)["document"]["objects"]["digits"].get("fontWeight",500)==500
    page.locator("#fit").click();ticks(page)
    at=bar.bounding_box()
    page.locator("#canvas").focus();page.keyboard.press("Shift+ArrowRight");ticks(page)
    moved=bar.bounding_box()
    # A wide flat toolbar can be clamped horizontally on both frames.
    assert abs(moved["y"]-at["y"])<1 and moved["x"]>=at["x"]
    page.locator("#zoom-in").click();ticks(page)
    zoomed=bar.bounding_box()
    assert zoomed["width"]==moved["width"] and abs(zoomed["y"]-moved["y"])>1
    for width,height in [(375,680),(320,480)]:
        page.set_viewport_size({"width":width,"height":height})
        page.locator("#fit").click()
        ticks(page)
        strip=bar.locator(".format-strip")
        assert strip.evaluate("s=>s.scrollWidth<=s.clientWidth+1")
        for menu,option in (("选择字体","思源宋体"),(None,"居中"),(None,"文字背景 · 透明")):
            if menu:group(page,menu)
            item=bar.get_by_role("button",name=option,exact=True);item.scroll_into_view_if_needed();bounds=item.bounding_box()
            assert 0<=bounds["x"] and bounds["x"]+bounds["width"]<=width+1 and 0<=bounds["y"] and bounds["y"]+bounds["height"]<=height+1,(option,bounds)
            item.click()
            if menu:group(page,menu)
            expect(item).to_have_attribute("aria-pressed","true")
            if menu:page.keyboard.press("Escape")
        size=bar.get_by_role("spinbutton",name="自定义字号");size.fill("24");size.press("Enter")
        expect(size).to_have_value("24")
        if output: page.screenshot(path=output/f"format-{width}.png")


def other_panels(page):
    project=json.loads((FIXTURES/"M5S-Cubic-Paths.mgcanvas").read_text(encoding="utf8"))
    load(page,project,"qa-picture")
    for theme in ("light","dark"):
        page.locator("#theme-"+theme).check()
        for key,name in [("qa-label","textSize"),("flow-submit","width"),("flow-review","strokeWidth"),("flow-first","connectorRoute"),
                         ("open-path","pathWidth"),("closed-path","pathFilled"),("sample-ink","selectedInkWidth"),("qa-picture","imageAspectLock")]:
            select(page,key)
            if name=="textSize":full_text(page)
            elif name!="imageAspectLock":group(page,{"width":"变换","strokeWidth":"线宽与颜色","connectorRoute":"连线样式","selectedInkWidth":"笔迹样式"}.get(name,"路径样式"))
            field=page.locator(f'#text-format-bar [name="{name}"]').first
            field.scroll_into_view_if_needed();expect(field).to_be_visible()
            shell=page.locator("#inspector") if name!="imageAspectLock" else page.locator("#text-format-bar")
            assert shell.evaluate("n=>n.scrollWidth<=n.clientWidth+1"),(key,theme)
        page.locator("#canvas").focus()
        page.keyboard.press("Control+a");group(page,"整体位移")
        expect(page.locator('#inspector [name="deltaX"]')).to_be_visible()


def shape_palette(page,project,output):
    page.set_viewport_size({"width":1160,"height":780})
    doc=project["document"]
    shape=dict(doc["objects"]["flow-source"],id="front",at={"x":0,"y":0},label="流程步骤",fill="#dbeafe",stroke="#5677bb",strokeWidth=4)
    under=dict(shape,id="under",label="",width=shape["width"]+18,height=shape["height"]+18,at={"x":-9,"y":-9},fill="#fff1cb",stroke="#bc905d")
    end=dict(doc["objects"]["flow-decision"],at={"x":275,"y":-14})
    edge=dict(doc["objects"]["flow-arrow"],waypoints=[],**{"from":{"kind":"anchor","objectId":"front","portId":"east"}})
    doc.update(objects={o["id"]:o for o in (under,shape,end,edge)},order=["under","front",end["id"],edge["id"]])
    load(page,project,"front")
    select(page,"front")
    bar=page.locator("#text-format-bar")
    clear=bar.get_by_role("button",name="无填充",exact=True)
    clear.click()
    expect(clear).to_have_attribute("aria-pressed","true")
    assert export_board(page)["document"]["objects"]["front"]==dict(shape,fill="transparent")
    for theme in ("light","dark"):
        page.locator("#theme-"+theme).check();ticks(page)
        painted=page.evaluate("window.shapeBox")
        x,y,w,h=[painted[k] for k in ("x","y","w","h")]
        sample=page.locator("#canvas").evaluate("(c,p)=>[...c.getContext('2d').getImageData(p[0],p[1],1,1).data].slice(0,3)",[int(x+w*.22),int(y+h*.25)])
        assert sample==[255,241,203],(theme,sample)
        assert contrast(page.evaluate("window.paints['流程步骤'].ink"),"#fff1cb")>=4.5
        canvas=page.locator("#canvas").bounding_box()
        b=bar.bounding_box();bx=b["x"]-canvas["x"];by=b["y"]-canvas["y"]
        for px,py in ((x+w/2,y-42),(x,y+h/2),(x+w,y+h/2),(x+w/2,y),(x+w/2,y+h),(x,y),(x+w,y+h)):
            assert not (bx-8<=px<=bx+b["width"]+8 and by-8<=py<=by+b["height"]+8),(theme,b,px,py)
        if output:page.screenshot(path=output/("shape-"+theme+".png"))
    page.locator("#undo").click()
    assert export_board(page)["document"]["objects"]["front"]==shape
    page.locator("#redo").click()
    canvas_el=page.locator("#canvas")
    canvas_el.click(position={"x":12,"y":140})
    ticks(page)
    box=page.evaluate("window.shapeBox");canvas=canvas_el.bounding_box()
    x=canvas["x"]+box["x"]+box["w"]*.26;y=canvas["y"]+box["y"]+box["h"]*.32
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+30,y+20,steps=5);page.mouse.up()
    moved=export_board(page)["document"]["objects"]
    assert moved["front"]["at"]!=shape["at"] and moved["under"]==under and moved[edge["id"]]==edge
    blue=bar.get_by_role("button",name="浅蓝",exact=True)
    blue.click()
    result=export_board(page)
    assert result["document"]["objects"]["front"]["fill"]=="#dbeafe"
    red=bar.get_by_role("button",name="边框红色",exact=True)
    group(page,"边框颜色");red.click()
    def appearance():
        item=export_board(page)["document"]["objects"]["front"]
        return item["fill"],item["stroke"]
    assert appearance()==("#dbeafe","#bd4054")
    clear.click()
    assert appearance()==("transparent","#bd4054")
    page.locator("#undo").click()
    assert appearance()==("#dbeafe","#bd4054")
    page.locator("#redo").click()
    assert appearance()==("transparent","#bd4054")
    # Sample the deselected border on the straight top edge, away from the label and ports.
    def sample(x,y):
        return canvas_el.evaluate("(c,p)=>[...c.getContext('2d').getImageData(...p,1,1).data].slice(0,3)",[int(x),int(y)])
    def deselect():
        canvas_el.click(position={"x":12,"y":140})
        expect(bar).to_be_hidden();ticks(page)
    for theme in ("light","dark"):
        page.locator("#theme-"+theme).check()
        deselect()
        rect=page.evaluate("shapeBox")
        assert sample(rect["x"]+rect["w"]*.4,rect["y"])==[189,64,84]
        select(page,"front")
        expect(clear).to_have_attribute("aria-pressed","true")
        group(page,"边框颜色");expect(red).to_have_attribute("aria-pressed","true");page.keyboard.press("Escape")
    blue.click()
    deselect()
    rect=page.evaluate("shapeBox")
    assert sample(rect["x"]+rect["w"]*.4,rect["y"])==[189,64,84]
    assert sample(rect["x"]+rect["w"]*.3,rect["y"]+rect["h"]*.25)==[219,234,254]
    filled_board=export_board(page)
    load(page,filled_board,"front");select(page,"front")
    expect(blue).to_have_attribute("aria-pressed","true")
    group(page,"边框颜色");expect(red).to_have_attribute("aria-pressed","true");page.keyboard.press("Escape")
    clear.click()
    saved=export_board(page)
    load(page,saved,"front");select(page,"front")
    expect(clear).to_have_attribute("aria-pressed","true")
    group(page,"边框颜色");expect(red).to_have_attribute("aria-pressed","true");page.keyboard.press("Escape")
    assert export_board(page)["document"]["objects"]==saved["document"]["objects"]
    # Also retain the actual chosen pigment when it almost matches the underlying shape.
    pale=bar.get_by_role("textbox",name="自定义边框色")
    group(page,"边框颜色");pale.fill("#fff1cc");pale.press("Enter");deselect()
    rect=page.evaluate("shapeBox")
    assert sample(rect["x"]+rect["w"]*.4,rect["y"])==[255,241,204]
    select(page,"under")
    clear.click()
    custom=bar.get_by_role("textbox",name="自定义边框色")
    group(page,"边框颜色");custom.fill("#229966");custom.press("Enter")
    ordinary=export_board(page)["document"]["objects"]["under"]
    assert (ordinary["fill"],ordinary["stroke"])==("transparent","#229966")


def live_field_recovery(page):
    colors=json.loads((FIXTURES/"M5AA-Connector-Colors.mgcanvas").read_text(encoding="utf8"))
    load(page,colors,"route")
    select(page,"route")
    group(page,"连线样式")
    picker=page.locator('#inspector [name="connectorStrokePicker"]')
    expect(picker).to_have_value("#663399")
    picker.evaluate("""el=>{
        for(const color of ['#225566','#663399']){el.value=color;el.dispatchEvent(new Event('input',{bubbles:true}));}
        el.dispatchEvent(new Event('change',{bubbles:true}));
    }""")
    assert export_board(page)["document"]["objects"]["route"]["stroke"]=="rebeccapurple"
    expect(page.locator("#undo")).to_be_disabled()
    project=json.loads((FIXTURES/"M5S-Cubic-Paths.mgcanvas").read_text(encoding="utf8"))
    load(page,project,"flow-submit")
    select(page,"flow-submit")
    name="flow-submit"
    field=page.locator('#inspector [name="width"]')
    size=lambda:export_board(page,preserve_focus=True)["document"]["objects"][name]["width"]
    initial=project["document"]["objects"][name]["width"]
    group(page,"变换");field.fill("")
    assert size()==initial
    # Resizing the object can move a neighboring hover action underneath a stationary pointer.
    page.locator('[data-action="arrange-downstream"]').hover()
    expect(field).to_be_visible();expect(field).to_be_focused()
    for digit,expected in (("2",2),("6",26),("4",264)):
        field.press(digit)
        expect(field).to_be_focused()
        assert size()==expected
    field.fill("")
    assert size()==264
    field.press("Control+z")
    assert size()==initial
    expect(field).to_be_focused()
    field.press("Control+Shift+z")
    assert size()==264
    label=page.locator("#flow-label")
    group(page,"节点文字");label.focus()
    label.evaluate("el=>el.select()")
    cdp=page.context.new_cdp_session(page)
    original=project["document"]["objects"][name]["label"]
    cdp.send("Input.imeSetComposition",{"text":"审","selectionStart":1,"selectionEnd":1})
    assert export_board(page,preserve_focus=True)["document"]["objects"][name]["label"]==original
    cdp.send("Input.insertText",{"text":"审核会议"})
    expect(label).to_have_value("审核会议")
    assert export_board(page,preserve_focus=True)["document"]["objects"][name]["label"]=="审核会议"
    expect(label).to_be_focused()
    expect(page.locator("#status")).to_have_attribute("data-workspace","saved",timeout=10000)
    page.reload()
    select(page,name)
    expect(field).to_have_value("264")
    expect(label).to_have_value("审核会议")
    select(page,"mind-booking")
    slider=page.get_by_role("slider",name="整图大小滑块")
    group(page,"整图布局");slider.scroll_into_view_if_needed()
    box=slider.bounding_box()
    value=page.locator('#inspector [name="mindScale"]')
    initial=int(value.input_value())
    y=box["y"]+box["height"]/2
    page.mouse.move(box["x"]+box["width"]*.50,y)
    page.mouse.down()
    page.mouse.move(box["x"]+box["width"]*.80,y,steps=12)
    adjusted=int(value.input_value())
    assert adjusted!=initial
    page.mouse.up()
    adjusted_board=export_board(page)
    page.locator("#undo").click()
    expect(value).to_have_value(str(initial))
    page.locator("#redo").click()
    expect(value).to_have_value(str(adjusted))
    load(page,adjusted_board,"mind-booking")
    select(page,"mind-booking")
    expect(value).to_have_value(str(adjusted))


def new_text_theme(page):
    page.emulate_media(color_scheme="light")
    page.locator("#theme-system").check()
    page.locator("#tool-text").click()
    page.locator("#canvas").click(position={"x":82,"y":165})
    edit=page.locator("textarea.inline-text")
    edit.fill("新文字 New 09")
    for mode,ink in (("dark","rgb(233, 238, 251)"),("light","rgb(36, 56, 84)")):
        page.emulate_media(color_scheme=mode)
        expect(page.locator("html")).to_have_attribute("data-workspace-theme",mode)
        expect(edit).to_have_css("color",ink)
        expect(edit).to_have_css("-webkit-text-stroke-width","0px")
    edit.press("Control+Enter")
    ticks(page)
    assert page.evaluate("window.paints['新文字 New 09'].ink")=="#243854"
    page.emulate_media(color_scheme="dark")
    expect(page.locator("html")).to_have_attribute("data-workspace-theme","dark")
    ticks(page)
    assert page.evaluate("window.paints['新文字 New 09'].ink")=="#e9eefb"


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("preview",type=Path)
    parser.add_argument("--channel",default="msedge")
    parser.add_argument("--baseline",action="store_true")
    parser.add_argument("--screenshots",type=Path)
    args=parser.parse_args()
    if args.screenshots: args.screenshots.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as pw,pw.chromium.launch(channel=args.channel) as browser:
        page=browser.new_page(viewport={"width":1280,"height":820},device_scale_factor=1)
        errors=[]
        page.on("pageerror",lambda e:errors.append(str(e)))
        page.on("dialog",lambda dialog:dialog.accept())
        page.set_default_timeout(5000)
        page.add_init_script("""{
          window.paints={};window.outlines={};window.measured=[];
          const proto=CanvasRenderingContext2D.prototype,fill=proto.fillText,stroke=proto.strokeText;
          const measure=proto.measureText;
          proto.measureText=function(text){if(this.canvas.id!=='canvas'&&this.font.includes('Source Han Serif'))window.measured.push(this.font);return measure.call(this,text)};
          const round=proto.roundRect;
          proto.roundRect=function(x,y,w,h,...rest){
            if(this.canvas.id==='canvas'&&['#5677bb','#bd4054','#fff1cc'].includes(this.strokeStyle)){
              const m=this.getTransform();window.shapeBox={x:m.e+x*m.a,y:m.f+y*m.d,w:w*m.a,h:h*m.d};
            }
            return round.call(this,x,y,w,h,...rest);
          };
          proto.strokeText=function(t,...args){if(this.canvas.id==='canvas')window.outlines[t]=this.strokeStyle;return stroke.call(this,t,...args)};
          proto.fillText=function(t,x,y,...args){
            fill.call(this,t,x,y,...args);if(this.canvas.id!=='canvas')return;
            let pixels=0;
            if((t.includes('功能脑图')||t==='123123')&&/^#[0-9a-f]{6}$/i.test(this.fillStyle)){
              const m=this.measureText(t),matrix=this.getTransform(),a=new DOMPoint(x-m.actualBoundingBoxLeft,y-m.actualBoundingBoxAscent).matrixTransform(matrix),
                b=new DOMPoint(x+m.actualBoundingBoxRight,y+m.actualBoundingBoxDescent).matrixTransform(matrix);
              const w=Math.ceil(b.x-a.x)+2,h=Math.ceil(b.y-a.y)+2;
              if(w>0&&h>0&&w*h<500000){
                const data=this.getImageData(Math.floor(a.x)-1,Math.floor(a.y)-1,w,h).data,rgb=parseInt(this.fillStyle.slice(1),16);
                for(let i=0;i<data.length;i+=4)if(data[i]===(rgb>>16)&&data[i+1]===((rgb>>8)&255)&&data[i+2]===(rgb&255))pixels++;
              }
            }
            window.paints[t]={ink:this.fillStyle,font:this.font,pixels};
          }
        }""")
        page.goto(args.preview.resolve().as_uri())
        expect(page.locator("#layers .layer").first).to_be_attached()
        board=compare_theme(page,args.screenshots,args.baseline)
        if not args.baseline:
            original=text_panel(page,board,args.screenshots)
            toolbar(page,original,args.screenshots)
            other_panels(page)
            shape_palette(page,board,args.screenshots)
            new_text_theme(page)
            live_field_recovery(page)
        assert not errors,errors
        print(args.channel,browser.version,"verified", "original fills and outlines" if args.baseline else "theme pixels, property panels, type metrics, caret, composition events, toolbar tracking, transparent shapes, bound endpoints, per-field undo, IME commit and autosave reload")


if __name__=="__main__":main()
