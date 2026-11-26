"""Exercise flow shape placement and animated mind map naming through the built canvas in Chrome."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import expect, sync_playwright


def project(items):
    return dict(format="mg-canvas.project", version=1, assets={}, document=dict(
        id="interaction-check", schemaVersion=1, theme="paper", assets={},
        order=list(items), objects=items))


def check(page, preview):
    page.set_default_timeout(6000)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    page.add_init_script("""{
      const p=CanvasRenderingContext2D.prototype;
      window.paints={}; window.curves=[]; window.storeWrites=0;
      const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(...args){storeWrites++;return put.apply(this,args);};
      function tap(name,observe){
        const original=p[name];
        p[name]=function(...args){if(this.canvas.id==='canvas')observe.apply(this,args);return original.apply(this,args);};
      }
      tap('setTransform',function(a,b,c,d,e,f){
        if(a>0&&a===d&&!b&&!c&&(e||f)){const r=this.canvas.getBoundingClientRect(),ratio=r.width/this.canvas.width;
          window.worldScreen={x:r.x+e*ratio,y:r.y+f*ratio,k:a*ratio};}
      });
      tap('fillRect',function(x,y,w,h){if(!x&&!y&&w>=this.canvas.clientWidth&&h>=this.canvas.clientHeight){curves=[];paints={};}});
      tap('fillText',function(text,x,y){if(this.textAlign==='center'){
        const v=new DOMPoint(x,y).matrixTransform(this.getTransform()),r=this.canvas.getBoundingClientRect();
        paints[text]=[r.x+v.x*r.width/this.canvas.width,r.y+v.y*r.height/this.canvas.height];
      }});
      tap('bezierCurveTo',function(){curves.push(this.globalAlpha);});
      window.watch=()=>{
        const frames=[];window.framesSeen=frames;
        function take(){
          if(window.framesSeen!==frames||frames.length>=140)return;
          const field=document.querySelector('.node-editor'),b=field?.getBoundingClientRect();
          frames.push({x:b?b.x+b.width/2:null,y:b?b.y+b.height/2:null,curves:[...curves],points:{...paints}});
          requestAnimationFrame(take);
        }
        take();
      };
    }""")
    page.goto(preview.resolve().as_uri())
    canvas=page.locator("#canvas")
    expect(page.locator("#layers .layer").first).to_be_attached()

    def frame():
        page.evaluate("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))")

    def open_board(data):
        page.locator("#project-picker").set_input_files(dict(name="交互验证.mgcanvas",mimeType="application/json",
                                                            buffer=json.dumps(data,ensure_ascii=False).encode()))
        expect(page.locator("#layers .layer")).to_have_count(len(data["document"]["order"]))
        expect(page.locator("#status")).to_contain_text("项目已打开")
        page.locator("#fit").click()
        frame()

    def export():
        with page.expect_download() as event:
            page.locator("#project-export").evaluate("e=>e.click()")
        return json.loads(Path(event.value.path()).read_bytes())

    def select_tool(kind):
        page.locator("#tool-shapes").click()
        page.locator("#shape-"+kind).click()

    ghost=page.locator("#placement-preview")
    undo=page.locator("#undo")
    open_board(project({}))
    # Zoom and pan before arming. Pick the actual projection used by Canvas2D for the comparisons.
    page.locator("#zoom-in").click()
    page.mouse.move(520,327)
    page.mouse.down(button="middle")
    page.mouse.move(587,362,steps=3)
    page.mouse.up(button="middle")
    frame()
    cam=page.evaluate("worldScreen")
    assert cam["k"]>1,cam
    expect(page.locator("#status")).to_have_attribute("data-workspace","saved")
    baseline=page.evaluate("storeWrites")
    select_tool("decision")
    page.mouse.move(422,301)
    expect(ghost).to_be_visible()
    expect(ghost.locator(".diamond")).to_be_visible()
    page.mouse.move(485,341)
    b=ghost.bounding_box()
    assert abs(b["x"]+b["width"]/2-485)<1 and abs(b["width"]-112*cam["k"])<.06,b
    page.keyboard.press("Escape")
    expect(ghost).to_be_hidden()
    expect(undo).to_be_disabled()
    select_tool("triangle")
    page.mouse.move(550,370)
    expect(ghost.locator(".triangle")).to_be_visible()
    page.locator("#tool-select").click()
    expect(ghost).to_be_hidden()
    page.wait_for_timeout(360)  # Exceed the workspace's 280 ms debounce to detect an accidental write.
    assert page.evaluate("storeWrites")==baseline
    assert export()["document"]["objects"]=={}
    for kind,shape,drag in [("process","rect",False),("decision","diamond",True),("triangle","triangle",True)]:
        select_tool(kind)
        page.mouse.move(713,435)
        expect(ghost).to_be_visible()
        page.mouse.down()
        page.mouse.move(*( (555,354) if drag else (718,438) ),steps=3)
        frame()
        bounds=ghost.bounding_box()
        expect(undo).to_be_disabled()
        page.mouse.up()
        expect(ghost).to_be_hidden()
        obj=next(iter(export()["document"]["objects"].values()))
        assert obj["shape"]==shape
        actual=dict(x=cam["x"]+obj["at"]["x"]*cam["k"],y=cam["y"]+obj["at"]["y"]*cam["k"],
                    width=obj["width"]*cam["k"],height=obj["height"]*cam["k"])
        assert max(abs(actual[k]-bounds[k]) for k in actual)<.06,(actual,bounds)
        if not drag:
            assert (obj["width"],obj["height"])==(136,62)
        undo.click()
        expect(undo).to_be_disabled()
        assert not export()["document"]["order"]

    topics={}
    for key,label,children in [("root","根主题",["r","l"]),("r","右主题",["r0"]),("l","左主题",["l0"]),
                               ("r0","原右主题",[]),("l0","原左主题",[])]:
        topics[key]=dict(id=key,text=label,childIds=children,collapsed=False)
    topics["l"]["side"]="left"
    topics["r"]["side"]="right"
    original=project({"tree":dict(kind="mindmap",id="tree",rootId="root",origin=dict(x=250,y=220),layout="balanced",theme="spectrum",topics=topics)})
    open_board(original)
    def select(text):
        page.wait_for_function("text=>!!paints[text]",arg=text)
        xy=page.evaluate("text=>paints[text]",text)
        assert page.evaluate("xy=>document.elementFromPoint(...xy)?.id",xy)=="canvas",(text,xy)
        page.mouse.click(*xy)
    field=page.get_by_role("textbox",name="脑图主题内容")
    def start(text):
        select(text)
        page.evaluate("watch()")
        page.keyboard.press("Tab")
        assert field.evaluate("e=>e===document.activeElement")
    def check_frames(sibling):
        frames=page.evaluate("framesSeen")
        assert any(any(0<a<1 for a in f["curves"]) for f in frames), "no partial branch was painted"
        assert len({round(f["x"],1) for f in frames if f["x"] is not None})>=2,"the native editor stayed stationary"
        ys={round(f["points"][sibling][1]-f["points"]["根主题"][1],1) for f in frames if sibling in f["points"] and "根主题" in f["points"]}
        assert len(ys)>1,(sibling,ys)

    start("右主题")
    cdp=page.context.new_cdp_session(page)
    cdp.send("Input.imeSetComposition",{"text":"预","selectionStart":1,"selectionEnd":1})
    expect(field).to_be_focused()
    cdp.send("Input.insertText",{"text":"预约管理"})
    expect(field).to_have_value("预约管理")
    page.wait_for_timeout(55)  # Pass the candidate-confirmation guard while layout is still moving.
    page.keyboard.press("Tab")
    page.keyboard.insert_text("次级主题")
    page.keyboard.press("Tab")
    page.keyboard.insert_text("深层说明")
    page.keyboard.press("Enter")
    expect(field).not_to_be_attached()
    page.wait_for_function("()=>!!paints['深层说明']&&!curves.some(a=>a<1)")
    check_frames("原右主题")
    start("左主题")
    page.keyboard.insert_text("左侧新增")
    page.wait_for_function("()=>framesSeen.filter(f=>f.x!==null).length>=3")
    page.keyboard.press("Enter")
    page.wait_for_function("()=>!!paints['左侧新增']&&!curves.some(a=>a<1)")
    check_frames("原左主题")
    final=export()
    rows=final["document"]["objects"]["tree"]["topics"]
    assert len(rows)==len(topics)+4
    parent={child:r["text"] for r in rows.values() for child in r["childIds"]}
    for label,expected in [("预约管理","右主题"),("次级主题","预约管理"),("深层说明","次级主题"),("左侧新增","左主题")]:
        assert parent[next(k for k,r in rows.items() if r["text"]==label)]==expected
    select("右主题")
    page.evaluate("watch()")
    page.keyboard.press("Delete")
    page.wait_for_function("()=>framesSeen.some(f=>f.curves.some(a=>a>.05&&a<.95))")
    page.keyboard.press("Control+z")
    page.wait_for_function("()=>!!paints['深层说明']&&!curves.some(a=>a<1)")
    assert export()==final
    open_board(final)
    page.wait_for_function("()=>!!paints['左侧新增']&&!!paints['深层说明']")
    assert export()==final

    # Normal editing starts on a printable key. The very click that submits it must also perform its usual action.
    flow=dict(kind="shape",id="step",shape="rect",at=dict(x=0,y=0),width=136,height=62,rotation=0,
              cornerRadius=9,fill="#d4dce7",stroke="#6598d6",label="流程编辑")
    root=dict(kind="mindmap",id="map",origin=dict(x=400,y=35),rootId="root",layout="right",
              topics={"root":dict(id="root",text="编辑根节点",childIds=[],collapsed=False)})
    open_board(project({"step":flow,"map":root}))
    select("流程编辑")
    page.keyboard.type("7")
    label_field=page.get_by_role("textbox",name="流程节点名称")
    expect(label_field).to_have_value("7")
    page.keyboard.insert_text("号申请")
    select("编辑根节点")
    expect(label_field).not_to_be_attached()
    page.keyboard.type("8")
    expect(field).to_have_value("8")
    page.mouse.click(920,710)
    expect(field).not_to_be_attached()
    select("7号申请")
    select("7号申请")
    expect(label_field).to_be_focused()
    label_field.fill("会议审批")
    page.locator("#tool-hand").click()
    expect(label_field).not_to_be_attached()
    expect(page.locator("#tool-hand")).to_have_attribute("aria-pressed","true")
    contents=export()["document"]["objects"]
    assert contents["step"]["label"]=="会议审批" and contents["map"]["topics"]["root"]["text"]=="8"
    assert not errors,errors
    print("Verified three flow silhouettes, cancelled idle placement without a save, the exact projected bounds after pan/zoom, "
          "left and right animated branches, sibling reflow, immediate IME input, chained Tab, interrupted deletion, undo and reopening. "
          "Direct typing, a second click to edit, and one-click exits to another node, the blank canvas and the bottom dock also passed.")


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview",type=Path)
    args=parser.parse_args()
    with sync_playwright() as pw, pw.chromium.launch(channel="chrome") as browser:
        check(browser.new_page(viewport={"width":1440,"height":900}),args.preview)
