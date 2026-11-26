"""Run the content-card, branch drag and decision-Tab regressions against the built local preview."""
import argparse
import io
import json
import math
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright


def check_rich_size(page,rich,frame):
    size=page.locator("#text-format-bar").get_by_role("spinbutton",name="自定义字号")
    initial_size=size.input_value()
    rich.locator("strong").evaluate("""e=>{
        const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);
    }""")
    frame()
    size.fill("");size.press_sequentially("72")
    expect(size).to_be_focused()
    expect(page.locator(".card-editor")).to_have_css("font-size","72px")
    size.press("Enter")
    expect(rich).to_be_focused()
    assert page.evaluate("getSelection().toString()")=="重点"
    page.keyboard.press("Control+z")
    expect(size).to_have_value(initial_size)


def check(page, url, shots=None):
    page.set_default_timeout(6000)
    page.on("dialog", lambda dialog: dialog.accept())
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    canvas = page.locator("#canvas")
    expect(page.locator("#layers .layer").first).to_be_attached()
    page.evaluate("""async () => {
      const {worldToScreen}=await import('../core/geometry.js');
      const {topicBox}=await import('../features/mindmap-layout.js');
      const {cardLayout}=await import('../features/card-content.js');
      const {decodeProject}=await import('../platform/project.js');
      const read=async args=>(await window.mgCanvasTools.callTool("canvas_read",args)).structuredContent;
      window.readCamera=async()=>(await read({limit:1})).viewport;
      window.readSelection=async()=>(await read({scope:"selection",detail:"full"})).objects.map(row=>row.object);
      window.paintedText=[];
      const fillRect=CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect=function(x,y,w,h){
        if(this.canvas.id==="canvas"&&x===0&&y===0&&w>=this.canvas.clientWidth&&h>=this.canvas.clientHeight)window.paintedText=[];
        return fillRect.call(this,x,y,w,h);
      };
      const make=URL.createObjectURL.bind(URL);
      URL.createObjectURL=blob=>{window.lastBlob=blob;return make(blob)};
      const click=HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click=function(){if(!this.download)return click.call(this)};
      window.readBoard=async()=>{document.querySelector('#project-export').click();const raw=await lastBlob.text();window.projectWire=raw;return decodeProject(raw).document};
      window.position=async(object,topic,x,y)=>{
        const box=topic?topicBox(object,topic).box:object;
        const p=worldToScreen({x:box.at.x+box.width*x,y:box.at.y+box.height*y},await readCamera());
        const rect=document.querySelector('#canvas').getBoundingClientRect();return [p.x+rect.left,p.y+rect.top];
      };
      window.glyphPoint=(card,word,n)=>{
        const g=cardLayout(card).glyphs.find(r=>r.text===word);
        const c=document.createElement("canvas").getContext("2d");c.font=g.font;
        return position(card,null,(g.x+c.measureText(word.slice(0,n)).width+.1)/card.width,(g.baseline-g.size*.32)/card.height);
      };
      window.lastLabel={};window.labelInks={};window.topicCenters={};
      const fill=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,...args){
        const m=this.getTransform();window.lastLabel[text]=Math.atan2(m.b,m.a);window.labelInks[text]=this.fillStyle;
        if(this.canvas.id==="canvas"&&this.textAlign==="center"&&this.globalAlpha>=.99){
          const p=new DOMPoint(args[0],args[1]).matrixTransform(m),rect=this.canvas.getBoundingClientRect();
          window.topicCenters[text]=[rect.x+p.x*rect.width/this.canvas.width,rect.y+p.y*rect.height/this.canvas.height];
        }
        window.paintedText?.push(text);
        return fill.call(this,text,...args);
      };
    }""")

    page.locator("#fit").click()
    page.wait_for_function("!!window.mgCanvasTools")
    get = lambda: page.evaluate("readBoard()")
    pos = lambda item, topic=None, x=.5, y=.5: page.evaluate("args=>position(...args)", [item, topic, x, y])
    glyph = lambda item, word, n: page.evaluate("args=>glyphPoint(...args)", [item,word,n])
    client=page.context.new_cdp_session(page)
    def compose(text):
        client.send("Input.imeSetComposition",{"text":text,"selectionStart":len(text),"selectionEnd":len(text)})
        client.send("Input.insertText",{"text":text})

    def frame():
        page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

    def screenshot(name):
        if shots:
            shots.mkdir(parents=True,exist_ok=True)
            page.screenshot(path=shots/(name+".png"))

    def ink_center(cx,cy,radius):
        crop={"x":math.floor(cx-radius),"y":math.floor(cy-radius),"width":2*radius,"height":2*radius}
        image=Image.open(io.BytesIO(page.screenshot(clip=crop))).convert("RGB")
        points=[(x,y) for y in range(image.height) for x in range(image.width) if max(image.getpixel((x,y)))<110]
        assert points
        return [(min(v)+max(v))/2 for v in zip(*points)]

    def drag(a, b):
        page.mouse.move(*a)
        page.mouse.down()
        page.mouse.move(*b, steps=8)
        page.mouse.up()
        frame()

    def zoom_and_pan(x,y):
        start=page.evaluate("readCamera()")
        page.mouse.move(x,y)
        page.keyboard.down("Control")
        page.mouse.wheel(0,115)
        page.keyboard.up("Control")
        page.wait_for_function("async z=>Math.abs((await readCamera()).zoom-z)>.001",arg=start["zoom"])
        offset=page.evaluate("readCamera().then(c=>c.offset)")
        page.mouse.down(button="middle")
        page.mouse.move(x+22,y-16,steps=4)
        page.mouse.up(button="middle")
        frame()
        assert page.evaluate("readCamera().then(c=>c.offset)")!=offset

    def save_reopen():
        before = get()
        wire = page.evaluate("projectWire")
        page.locator("#project-picker").set_input_files({"name": "核对.mgcanvas", "mimeType": "application/json", "buffer": wire.encode()})
        expect(page.locator("#status")).to_contain_text("项目已打开")
        assert get() == before
        return before

    # Real pointer paths use the canvas hit-test and EditorSession's normal history.
    board = get()
    mid = "mind-room"
    mind = board["objects"][mid]
    root = mind["rootId"]
    a = pos(mind, root)
    drag(a, [a[0]-25, a[1]+30])
    moved = get()["objects"][mid]
    assert moved["origin"] != mind["origin"] and moved["topics"] == mind["topics"]
    page.locator("#undo").click()
    drag(pos(mind,"child-a"), pos(mind,"child-b",.5,.75))
    sorted_map = get()["objects"][mid]
    assert sorted_map["origin"] == mind["origin"] and sorted_map["topics"][root]["childIds"] == ["child-b","child-a"]
    # A reorder updates the document before the animated topic reaches its new hit location.
    child = sorted_map["topics"]["child-a"]
    page.wait_for_function("""([label, p]) => {
      const drawn=topicCenters[label];return drawn && Math.abs(drawn[0]-p[0])<3 && Math.abs(drawn[1]-p[1])<4;
    }""", arg=[child["text"], pos(sorted_map, "child-a")])
    a = pos(sorted_map, root)
    drag(pos(sorted_map,"child-a"), [a[0]-115,a[1]+30])
    switched = get()["objects"][mid]
    assert switched["topics"]["child-a"]["side"] == "left" and switched["origin"] == mind["origin"]
    page.locator("#undo").click()
    assert get()["objects"][mid] == sorted_map
    page.locator("#undo").click()

    diamond=board["objects"]["flow-decision"]
    for answer,port in [("Yes","north"),("No","south")]:
        cx,cy=pos(diamond)
        page.mouse.click(cx,cy)
        page.mouse.move(cx,cy-90)
        canvas.press("Tab")
        flow=get()["objects"]
        edge=next(e for e in flow.values() if e["kind"]=="connector" and e["label"]==answer)
        assert edge["from"]=={"kind":"anchor","objectId":diamond["id"],"portId":port}
        assert edge["to"]["objectId"] in flow
    page.locator("#undo").click()
    assert not any(o.get("label")=="No" for o in get()["objects"].values())
    page.locator("#redo").click()
    save_reopen()


    source = "# 会议纪要\n\n记录 **重点** 和 [资料](https://example.org)\n- 预约\n- 门禁\n> 引用\n```js\nconst x = 123;\n```"
    page.locator("#tool-document").click()
    page.mouse.click(160,165)
    rich = page.locator(".markdown-field")
    field = page.locator(".card-input")
    expect(rich).to_be_focused()
    page.evaluate("s=>navigator.clipboard.writeText(s)", source)
    page.keyboard.press("Control+v")
    expect(page.locator('.card-block[data-block="heading"]')).to_have_text("会议纪要")
    expect(page.locator(".card-block strong")).to_have_text("重点")
    page.locator("#tool-select").click()
    doc = next(i for i in get()["objects"].values() if i.get("content",{}).get("kind")=="markdown")
    assert doc["label"] == source
    frame()
    page.mouse.click(*glyph(doc,"门禁",1))
    expect(rich).to_be_focused()
    assert page.evaluate("getSelection().anchorNode.textContent==='门禁' && getSelection().anchorOffset===1")
    expect(page.locator(".card-source-switch")).to_be_visible()
    page.keyboard.press("End")
    compose("控制")
    expect(page.locator('.card-block[data-block="list"]').last).to_have_text("门禁控制")
    expect(rich.locator("strong")).to_have_text("重点")
    page.keyboard.press("Control+z")
    expect(page.locator('.card-block[data-block="list"]').last).to_have_text("门禁")
    page.keyboard.press("Control+Shift+z")
    expect(page.locator('.card-block[data-block="list"]').last).to_have_text("门禁控制")
    check_rich_size(page,rich,frame)
    page.locator(".card-source-switch").click()
    expect(field).to_have_value(source.replace("- 门禁","- 门禁控制"))
    field.evaluate("e=>{const i=e.value.indexOf('门禁控制');e.setSelectionRange(i,i+4)}")
    page.get_by_role("button",name="插入或编辑链接").click()
    page.get_by_role("textbox",name="链接地址").fill("https://example.org/room")
    page.get_by_role("button",name="应用链接").click()
    assert "[门禁控制](https://example.org/room)" in field.input_value()
    page.keyboard.press("Control+z")
    assert "[门禁控制]" not in field.input_value()
    page.keyboard.press("Control+Enter")
    doc=get()["objects"][doc["id"]]
    assert "**重点**" in doc["label"] and "- 门禁控制" in doc["label"]
    frame()
    screenshot("markdown-document")
    br=pos(doc,None,1,1)
    drag(br,[br[0]+65,br[1]])
    wider=get()["objects"][doc["id"]]
    assert wider["width"]>doc["width"] and wider["label"]==doc["label"]

    before=get()
    page.locator("#tool-sticky").click()
    palette=page.locator("#sticky-palette")
    ghost=page.locator("#placement-preview")
    expect(palette.get_by_role("radio",checked=True)).to_have_count(1)
    page.mouse.move(830,230)
    expect(ghost).to_be_visible()
    assert ghost.evaluate("e=>getComputedStyle(e,'::before').content.includes('写点什么…')")
    screenshot("sticky-preview")
    zoom_and_pan(828,233)
    expect(ghost).to_be_visible()
    palette.get_by_role("radio",name="薄荷",exact=True).click()
    expect(palette.get_by_role("radio",name="薄荷")).to_be_checked()
    expect(ghost).to_be_visible()
    expect(ghost).to_have_css("background-color","rgb(194, 235, 217)")
    page.mouse.move(850,180)
    expect(ghost).to_have_css("background-color","rgb(194, 235, 217)")
    assert get()==before
    expected=ghost.bounding_box()
    page.mouse.click(850,180)
    expect(field).to_be_focused()
    placed=[i for i in page.evaluate("readSelection()") if i.get("content",{}).get("kind")=="sticky"][0]
    assert placed["label"]=="" and placed["fill"]=="#c2ebd9"
    assert math.dist(pos(placed,None,0,0),[expected["x"],expected["y"]])<1.1
    assert abs(expected["width"]-placed["width"]*page.evaluate("readCamera().then(c=>c.zoom)"))<.1
    assert abs(expected["height"]-placed["height"]*page.evaluate("readCamera().then(c=>c.zoom)"))<.1
    expect(palette).to_be_hidden()
    client.send("Input.imeSetComposition",{"text":"预约","selectionStart":2,"selectionEnd":2})
    client.send("Input.insertText",{"text":"预约会议"})
    page.keyboard.press("Enter")
    page.keyboard.insert_text("第二行")
    expect(field).to_have_value("预约会议\n第二行")
    toolbar=page.locator("#text-format-bar")
    assert set(toolbar.locator("[data-format-group]").evaluate_all("els=>els.map(b=>b.dataset.formatGroup)"))=={"size","background","face","align"}
    assert toolbar.locator("[data-format-group=face] button").count()==1
    page.evaluate("""async()=>navigator.clipboard.write([new ClipboardItem({'text/html':new Blob(['<p><b>第一段</b></p><div>第二段<br>第三行</div>'],{type:'text/html'})})])""")
    page.keyboard.press("Control+v")
    expect(field).to_have_value("预约会议\n第二行第一段\n第二段\n第三行")
    page.keyboard.press("Control+z")
    expect(field).to_have_value("预约会议\n第二行")
    field.evaluate("e=>e.setSelectionRange(0,2)")
    screenshot("sticky-palette")
    toolbar.get_by_role("button",name="更多纸色").click()
    toolbar.get_by_role("button",name="#14785a",exact=True).click()
    toolbar.locator('button[data-format="bold"]').click()
    expect(field).to_have_value("预约会议\n第二行")
    expect(field).to_have_css("font-weight","700")
    expect(field).to_have_css("color","rgb(255, 255, 255)")
    custom=toolbar.get_by_role("spinbutton",name="自定义字号")
    custom.fill("")
    custom.press_sequentially("37")
    expect(custom).to_be_focused()
    expect(field).to_have_css("font-size","37px")
    custom.press("Enter")
    expect(field).to_be_focused()
    assert field.evaluate("n=>[n.selectionStart,n.selectionEnd]")==[0,2]
    page.keyboard.press("Control+z")
    expect(custom).not_to_have_value("37")
    custom.fill("24");custom.press("Enter")
    expect(custom).to_have_value("24")
    toolbar.get_by_role("button",name="居右",exact=True).click()
    expect(field).to_have_css("text-align","right")
    page.keyboard.press("Control+z")
    expect(field).to_have_css("text-align","left")
    page.keyboard.press("Control+Shift+z")
    expect(field).to_have_css("text-align","right")
    page.mouse.click(70,110)
    note=next(i for i in get()["objects"].values() if i.get("content",{}).get("kind")=="sticky")
    assert note["fill"]=="#14785a" and note["content"]["fontWeight"]==700 and note["content"]["fontSize"]==24 and note["content"]["align"]=="right" and note["label"]=="预约会议\n第二行"
    pt=pos(note)
    drag(pt,[pt[0]-55,pt[1]+47])
    moved=get()["objects"][note["id"]]
    assert moved["at"]!=note["at"]
    corner=pos(moved,None,1,1)
    drag(corner,[corner[0]+52,corner[1]+32])
    resized=get()["objects"][note["id"]]
    assert resized["width"]>moved["width"] and resized["height"]>moved["height"]
    page.locator("#undo").click()
    assert get()["objects"][note["id"]]==moved
    page.locator("#redo").click()
    canvas.focus()
    page.keyboard.press("Control+c")
    page.keyboard.press("Control+v")
    frame()
    notes=[i for i in get()["objects"].values() if i.get("content",{}).get("kind")=="sticky"]
    assert len(notes)==2 and all(i["label"]==note["label"] and i["fill"]==note["fill"] for i in notes)
    page.locator("#tool-document").click()
    expect(page.locator("#import-markdown")).to_be_visible()
    page.locator("#markdown-picker").set_input_files({"name":"导入.md","mimeType":"text/markdown","buffer":("# 外部文档\r\n\r\n"+source).encode()})
    expect(page.locator("#status")).to_contain_text("导入.md")
    final=save_reopen()
    assert len([o for o in final["objects"].values() if o.get("content",{}).get("kind")=="markdown"])==2
    imported=next(o for o in final["objects"].values() if o.get("label","").startswith("# 外部文档"))
    page.mouse.click(*glyph(imported,"重点",1))
    expect(rich).to_be_focused()
    assert page.evaluate("getSelection().anchorNode.parentElement.tagName==='STRONG'&&getSelection().anchorOffset===1")
    compose("核")
    expect(rich.locator("strong")).to_have_text("重核点")
    page.locator("#tool-select").click()
    assert get()["objects"][imported["id"]]["label"]==imported["label"].replace("**重点**","**重核点**")
    # An ordinary canvas paste recognizes Markdown and the first click edits its painted body in place.
    page.mouse.click(365,142)
    canvas.focus()
    pasted="## 剪贴板\n\n1) __项目__\n2) 后续"
    page.evaluate("s=>navigator.clipboard.writeText(s)",pasted)
    page.keyboard.press("Control+v")
    frame()
    card=next(o for o in get()["objects"].values() if o.get("label")==pasted)
    page.mouse.click(*glyph(card,"项目",1))
    expect(rich).to_be_focused()
    compose("二")
    expect(rich.locator("strong")).to_have_text("项二目")
    page.mouse.click(85,145)
    final=save_reopen()
    assert final["objects"][card["id"]]["label"]==pasted.replace("项目","项二目")

    # A document extending past the viewport must keep its origin and wrap width on the first click.
    page.mouse.click(1230,237)
    canvas.focus()
    page.evaluate("navigator.clipboard.writeText('1) __甲乙丙__')")
    page.keyboard.press("Control+v")
    frame()
    edge=next(o for o in get()["objects"].values() if o.get("label")=="1) __甲乙丙__")
    point=glyph(edge,"甲乙丙",1)
    page.mouse.click(*point)
    expect(rich).to_be_focused()
    caret=page.evaluate("()=>{const r=getSelection().getRangeAt(0).getBoundingClientRect();return [r.x,r.top+r.height/2]}")
    assert abs(caret[0]-point[0])<2 and abs(caret[1]-point[1])<7,(point,caret)
    page.keyboard.press("Enter")
    assert rich.locator("strong").all_text_contents()==["甲","乙丙"]
    assert rich.locator("[data-marker]").evaluate_all("items=>items.map(e=>e.dataset.marker)")==["1)","2)"]
    page.locator("#tool-select").click()
    assert get()["objects"][edge["id"]]["label"]=="1) __甲__\n2) __乙丙__"
    page.locator("#tool-document").click()
    page.mouse.click(275,242)
    page.keyboard.type("# ")
    compose("手写标题")
    expect(rich.locator("h1")).to_have_text("手写标题")
    page.locator("#tool-select").click()
    assert any(o.get("label")=="# 手写标题" for o in get()["objects"].values())

    steps={}
    for kind,name,anchor,label in [("rect","step",-230,"矩形步骤"),("diamond","decide",64,"判断节点")]:
        steps[name]=dict(diamond,id=name,shape=kind,label=label,at={"x":anchor,"y":-48},width=160,height=96,rotation=0)
    small=dict(schemaVersion=1,id="pointer-and-rotation",theme="paper",assets={},objects=steps,order=list(steps))
    page.locator("#project-picker").set_input_files({"name":"旋转.mgcanvas","mimeType":"application/json","buffer":json.dumps(small).encode()})
    expect(page.locator("#status")).to_contain_text("项目已打开")

    page.locator("#fit").click()
    page.locator("#zoom-out").click()
    page.mouse.move(355,235)
    page.mouse.down(button="middle")
    page.mouse.move(391,264)
    page.mouse.up(button="middle")
    frame()
    for dx,dy,port in [(-80,0,"west"),(80,0,"east"),(0,-80,"north"),(0,80,"south")]:
        step=steps["step"]
        page.mouse.click(185,160)
        cx,cy=pos(step)
        page.mouse.click(cx,cy)
        page.mouse.move(cx+dx,cy+dy)
        canvas.press("Tab")
        objects=get()["objects"]
        line=next(o for o in objects.values() if o["kind"]=="connector")
        assert line["from"]=={"kind":"anchor","objectId":"step","portId":port}
        child=objects[line["to"]["objectId"]]
        assert (child["at"]["x"]-step["at"]["x"])*dx+(child["at"]["y"]-step["at"]["y"])*dy>0
        page.locator("#undo").click()
        assert get()["objects"]==steps
        frame()

    # Hit the real circular grip and compare actual fillText transforms with the rotated native field.
    for original in steps.values():
        item=original
        for degrees in [90,32]:
            page.mouse.click(185,160)
            page.mouse.click(*pos(item))
            frame()
            cx,cy=pos(item)
            radius=item["height"]*page.evaluate("readCamera().then(c=>c.zoom)")/2+42
            knob=lambda angle:(cx+radius*math.sin(angle),cy-radius*math.cos(angle))
            angle=math.radians(degrees)
            page.mouse.move(*knob(item["rotation"]))
            page.mouse.down()
            if degrees==90:
                page.keyboard.down("Shift")
            page.mouse.move(*knob(angle),steps=6)
            frame()
            painted=page.evaluate("name=>lastLabel[name]",item["label"])
            assert abs(painted-angle)<.025,(painted,angle,item)
            page.mouse.up()
            if degrees==90:
                page.keyboard.up("Shift")
            rotated=get()["objects"][item["id"]]
            frame()
            assert abs(rotated["rotation"]-angle)<.025 and abs(page.evaluate("name=>lastLabel[name]",item["label"])-rotated["rotation"])<1e-6
            radius=math.ceil(len(item["label"])*13*page.evaluate("readCamera().then(c=>c.zoom)")/2)+4
            painted_ink=ink_center(cx,cy,radius)
            canvas.press("F2")
            editor=page.locator(".node-editor")
            expect(editor.locator("textarea")).to_be_focused()
            turn=editor.evaluate("e=>{const m=new DOMMatrix(getComputedStyle(e).transform);return Math.atan2(m.b,m.a)}")
            bounds=editor.bounding_box()
            assert abs(turn-rotated["rotation"])<1e-5 and math.dist([cx,cy],[bounds["x"]+bounds["width"]/2,bounds["y"]+bounds["height"]/2])<1.1
            page.keyboard.press("ArrowRight")
            editor.locator("textarea").evaluate("e=>e.style.caretColor='transparent'")
            edit_ink=ink_center(cx,cy,radius)
            assert math.dist(painted_ink,edit_ink)<=2,(degrees,painted_ink,edit_ink)
            editor.locator("textarea").evaluate("e=>e.style.removeProperty('caret-color')")
            page.keyboard.insert_text("改")
            expect(editor.locator("textarea")).to_have_value(item["label"]+"改")
            page.keyboard.press("Escape")
            page.locator("#undo").click()
            assert get()["objects"][item["id"]]==item
            page.locator("#redo").click()
            assert save_reopen()["objects"][item["id"]]==rotated

            frame()
            item=rotated

    before=get()
    page.mouse.click(285,174)
    canvas.press("t")
    expect(ghost).to_be_visible()
    zoom_and_pan(335,182)
    page.mouse.move(390,212)
    frame()
    first=ghost.bounding_box()
    page.mouse.move(461,265)
    frame()
    actual=ghost.bounding_box()
    assert actual["x"]>first["x"]+68 and actual["y"]>first["y"]+50
    canvas.press("Escape")
    expect(ghost).to_be_hidden()
    assert get()==before
    page.locator("#tool-sticky").click()
    page.mouse.move(412,221)
    expect(ghost).to_be_visible()
    page.locator("#tool-text").click()
    expect(palette).to_be_hidden()
    page.mouse.move(472,278)
    expect(ghost).to_have_attribute("data-kind","text")
    expect(ghost).to_be_visible()
    assert not ghost.evaluate("e=>e.hasAttribute('data-hint')")
    actual=ghost.bounding_box()
    assert get()==before
    page.mouse.click(472,278)
    plain=page.locator("textarea.inline-text")
    assert not errors, errors
    expect(plain).to_be_focused()
    obj=next(o for o in page.evaluate("readSelection()") if o["kind"]=="text")
    assert math.dist(pos(obj,None,0,0),[actual["x"],actual["y"]])<1.1
    assert abs(actual["width"]-obj["width"]*page.evaluate("readCamera().then(c=>c.zoom)"))<.1
    assert obj["width"]==360 and abs(plain.bounding_box()["width"]-actual["width"])<1
    first_line="这是一段正常宽度的中文文本"
    english="English words with spaces "
    plain.fill(first_line)
    one_line=plain.bounding_box()["height"]
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    page.keyboard.insert_text(english*6)
    value=first_line+"\n"+english*6
    expect(plain).to_have_value(value)
    assert plain.bounding_box()["height"]>one_line*2 and plain.evaluate("e=>e.scrollHeight<=e.clientHeight+1")
    screenshot("multiline-text-edit")
    page.mouse.click(260,123)
    written=get()["objects"][obj["id"]]
    assert written["text"]==value and written["width"]==obj["width"]
    page.mouse.click(*pos(written))
    frame()
    right=pos(written,None,1,.5)
    drag(right,[right[0]-110*page.evaluate("readCamera().then(c=>c.zoom)"),right[1]])
    narrowed=get()["objects"][obj["id"]]
    assert abs(narrowed["width"]-250)<=2 and narrowed["height"]>written["height"] and narrowed["text"]==value
    page.mouse.click(*pos(narrowed))
    expect(plain).to_be_focused()
    assert abs(plain.bounding_box()["width"]-narrowed["width"]*page.evaluate("readCamera().then(c=>c.zoom)"))<1
    page.keyboard.press("Escape")
    page.locator("#undo").click()
    assert get()["objects"][obj["id"]]==written
    page.locator("#undo").click()
    assert get()==before
    # Reopen a legacy note with explicit old ink on a transparent sheet above a dark object.
    backing=dict(steps["step"],at={"x":0,"y":0},width=300,height=250,fill="#242424",label="")
    old=dict(note,at={"x":25,"y":22},fill="transparent",content=dict(note["content"],color="#141414"))
    stacked=dict(small,order=[backing["id"],old["id"]],objects={backing["id"]:backing,old["id"]:old})
    page.locator("#project-picker").set_input_files({"name":"旧便签.mgcanvas","mimeType":"application/json","buffer":json.dumps(stacked).encode()})
    expect(page.locator("#status")).to_contain_text("项目已打开")
    frame()
    assert page.evaluate("labelInks['预约会议']")=="#ffffff"
    page.mouse.click(*pos(old))
    canvas.press("F2")
    expect(field).to_have_value("预约会议\n第二行")
    expect(field).to_have_css("color","rgb(255, 255, 255)")
    expect(page.locator(".card-editor")).to_have_css("background-color","rgba(0, 0, 0, 0)")
    toolbar.get_by_role("button",name="更多纸色").click()
    toolbar.get_by_role("button",name="#ffffff",exact=True).click()
    expect(field).to_have_css("color","rgb(38, 48, 65)")
    page.keyboard.press("Control+Enter")
    assert save_reopen()["objects"][old["id"]]["label"]==old["label"]

    blank=dict(small,id="empty-cards",order=[],objects={})
    page.locator("#project-picker").set_input_files({"name":"空白画板.mgcanvas","mimeType":"application/json","buffer":json.dumps(blank).encode()})
    expect(page.locator("#status")).to_contain_text("项目已打开")

    frame()
    page.mouse.move(350,220)
    page.locator("#tool-document").evaluate("b=>b.click()")
    expect(ghost).to_be_visible()
    expect(ghost).to_have_attribute("data-kind","markdown")
    assert ghost.evaluate("e=>getComputedStyle(e,'::before').content.includes('输入或粘贴 Markdown…')")
    canvas.press("Escape")
    expect(ghost).to_be_hidden()
    assert get()==blank
    page.locator("#tool-document").click()
    page.mouse.move(340,230)
    expect(ghost).to_be_visible()
    old_pos=ghost.bounding_box()
    page.mouse.move(418,258)
    frame()
    assert ghost.bounding_box()["x"]>old_pos["x"]+76
    page.locator("#tool-select").click()
    expect(ghost).to_be_hidden()
    assert get()==blank
    page.locator("#tool-document").click()
    zoom_and_pan(300,190)
    page.mouse.move(268,170)
    expect(ghost).to_be_visible()
    screenshot("document-placement")
    rect=ghost.bounding_box()
    page.mouse.click(268,170)
    expect(rich).to_be_focused()
    expect(ghost).to_be_hidden()
    document=next(iter(page.evaluate("readSelection()")))
    z=page.evaluate("readCamera().then(c=>c.zoom)")
    assert document["label"]=="" and document["content"]["kind"]=="markdown"
    assert math.dist(pos(document,None,0,0),[rect["x"],rect["y"]])<1.1
    assert abs(document["width"]*z-rect["width"])<.1 and abs(document["height"]*z-rect["height"])<.1
    assert abs(page.locator(".card-editor").bounding_box()["width"]-rect["width"])<1
    hint="输入或粘贴 Markdown…"
    def rich_hint():
        return rich.evaluate("e=>getComputedStyle(e,'::before').content.includes(e.getAttribute('aria-placeholder'))")
    assert rich_hint() and rich.inner_text().strip()==""
    compose("文档")
    assert not rich_hint()
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    assert rich_hint()
    page.keyboard.insert_text("# 清除整篇")
    expect(rich.locator("h1")).to_have_text("清除整篇")
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    assert rich_hint()
    page.keyboard.press("Control+z")
    expect(rich.locator("h1")).to_have_text("清除整篇")
    page.keyboard.press("Control+Shift+z")
    assert rich_hint()
    page.locator(".card-source-switch").click()
    expect(field).to_have_value("")
    expect(field).to_have_attribute("placeholder",hint)
    page.locator("#tool-select").click()
    frame()
    assert hint in page.evaluate("paintedText.join('')")
    page.locator("#tool-sticky").click()
    page.mouse.click(836,252)
    expect(field).to_be_focused()
    expect(field).to_have_attribute("placeholder","写点什么…")
    assert field.evaluate("e=>e.matches(':placeholder-shown')")
    field.fill("临时内容")
    assert not field.evaluate("e=>e.matches(':placeholder-shown')")
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    assert field.evaluate("e=>e.matches(':placeholder-shown')")
    toolbar.get_by_role("button",name="更多纸色").click()
    toolbar.get_by_role("button",name="透明背景",exact=True).click()
    page.locator("#tool-select").click()
    empty=save_reopen()
    assert len(empty["order"])==2 and all(o["label"]=="" for o in empty["objects"].values())
    assert all(h not in page.evaluate("projectWire") for h in [hint,"写点什么…"])
    for theme in ["dark","light"]:
        page.locator('label:has(#theme-'+theme+')').click()
        frame()
        displayed=page.evaluate("paintedText.join('')")
        assert hint in displayed and "写点什么…" in displayed
        screenshot("empty-cards-"+theme)
    for item in empty["objects"].values():
        page.mouse.click(*pos(item,None,.6,.68))
        canvas.focus()
        page.keyboard.press("Control+c")
        copied=page.evaluate("""async()=>{const {decodeClipboard}=await import('../features/clipboard.js');return decodeClipboard(await navigator.clipboard.readText()).document}""")
        assert len(copied["order"])==1 and next(iter(copied["objects"].values()))["label"]==""
    # Exercise the actual PNG entry. The interior of an exported empty white document is all paper.
    png=page.context.new_page()
    try:
        worker_url=page.url.rsplit("/",1)[0]+"/empty-card-export.html"
        png.route(worker_url,lambda route:route.fulfill(content_type="text/html",body=
            '<canvas id="png-canvas"></canvas><a id="png-download"></a><output id="status"></output>'
            '<script type="application/json" id="mgcanvas-project"></script><script type="application/json" id="png-options"></script>'))
        png.goto(worker_url)
        png.evaluate("""async ([wire,id])=>{
          document.querySelector('#mgcanvas-project').textContent=wire;
          document.querySelector('#png-options').textContent=JSON.stringify({id,scale:1});
          await import('./png-render.js');
        }""",[page.evaluate("projectWire"),document["id"]])
        png.wait_for_function("document.querySelector('#status').textContent.length>0")
        exported=json.loads(png.locator("#status").inner_text())
        assert exported["ok"],exported
        assert png.evaluate("""async([item,offset])=>{
          const png=await (await fetch(document.querySelector('#png-download').href)).blob();
          const bitmap=await createImageBitmap(png),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
          const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
          const data=ctx.getImageData(Math.round(offset.x+item.at.x+12),Math.round(offset.y+item.at.y+12),item.width-24,item.height-24).data;
          return data.every(v=>v===255);
        }""",[document,exported["offset"]])
    finally:
        png.close()
    assert not errors, errors
    print("Verified document and sticky placement, multiline T text and manual width, empty hints in both themes, actual empty project/clipboard/PNG output, rich Markdown, IME, structural dragging, directional Tab, rotation and project reopen.")


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url",help="Development preview URL. Defaults to serving the local dist modules inside the test context.")
    parser.add_argument("--cdp")
    parser.add_argument("--shots",type=Path)
    args=parser.parse_args()
    with sync_playwright() as pw:
        browser=pw.chromium.connect_over_cdp(args.cdp) if args.cdp else pw.chromium.launch(channel="chrome")
        context=browser.new_context(viewport={"width":1440,"height":960},permissions=["clipboard-read","clipboard-write"])
        try:
            origin="http://mgcanvas.localhost"
            if not args.url:
                dist=(Path(__file__).resolve().parents[1]/"dist").resolve()
                def asset(route):
                    path=(dist/route.request.url.removeprefix(origin+"/")).resolve()
                    if path.is_relative_to(dist) and path.is_file():
                        mime={".js":"text/javascript",".css":"text/css",".html":"text/html; charset=utf-8"}.get(path.suffix)
                        route.fulfill(path=path,content_type=mime)
                    else:
                        route.fulfill(status=404)
                context.route(origin+"/**",asset)
            check(context.new_page(),args.url or origin+"/app/index.html",args.shots)
        finally:
            context.close()
            if not args.cdp:
                browser.close()
