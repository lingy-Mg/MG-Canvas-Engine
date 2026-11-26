"""Verify canvas hover, record real layout edits, and measure visible bulk operations in Chromium."""
import argparse
import base64
import io
import json
import statistics
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def point(x, y):
    return dict(x=x, y=y)


def shape(key, x, y, title, color="#e1ebfc"):
    return dict(id=key, kind="shape", shape="rect", at=point(x,y), width=120, height=56, rotation=0,
                cornerRadius=9, fill=color, stroke="#517ab1", label=title)


def link(key, a, b):
    return dict(id=key, kind="connector", routing="straight", waypoints=[], arrow="end", stroke="#506784", label="",
                **{"from":dict(kind="anchor",objectId=a,portId="east"),"to":dict(kind="anchor",objectId=b,portId="west")})


def project(rows, schema=1):
    return dict(format="mg-canvas.project", version=1, assets={}, document=dict(schemaVersion=schema, id="motion-qa",
                theme="paper", assets={}, order=[o["id"] for o in rows], objects={o["id"]:o for o in rows}))


def fixture(name):
    return json.loads((ROOT/"docs"/"fixtures"/name).read_text(encoding="utf8"))


class Board:
    def __init__(self, page, preview):
        self.page = page
        self.errors = []
        page.on("pageerror", lambda e:self.errors.append(str(e)))
        page.on("dialog", lambda d:d.accept())
        page.add_init_script("""{
          const proto=CanvasRenderingContext2D.prototype, trans=proto.setTransform, fill=proto.fillRect, stroke=proto.stroke;
          const fillText=proto.fillText;window.labels=[];
          proto.fillText=function(text,x,y,...rest){
            if(this.canvas.id==="canvas"&&["收集需求","交付","评审","流程步骤"].includes(text)){
              const p=new DOMPoint(x,y).matrixTransform(this.getTransform());
              labels.push({text,x:p.x,y:p.y,alpha:this.globalAlpha});
            }
            return fillText.call(this,text,x,y,...rest);
          };
          window.paintTimes=[];window.hoverStrokes=0;window.hovers=[];let ops=[];
          proto.setTransform=function(a,b,c,d,e,f){
            if(this.canvas.id==="canvas"&&(e||f))window.viewMatrix=[a,d,e,f];
            return trans.apply(this,arguments);
          };
          proto.fillRect=function(x,y,w,h){
            if(this.canvas.id==="canvas"&&x===0&&y===0&&w>=this.canvas.clientWidth-1&&h>=this.canvas.clientHeight-1)
              paintTimes.push(performance.now());
            return fill.apply(this,arguments);
          };
          for(const name of ["beginPath","moveTo","lineTo","bezierCurveTo","roundRect","arc"]){
            const original=proto[name];proto[name]=function(...args){
              if(this.canvas.id==="pointer-feedback"){if(name==="beginPath")ops=[];else ops.push(name);}
              return original.apply(this,args);
            };
          }
          proto.stroke=function(){
            if(this.canvas.id==="pointer-feedback"&&["#18778c","#78d6e5"].includes(this.strokeStyle)){
              window.hoverStrokes++;window.hovers=ops.slice();window.hoverWidth=this.lineWidth;
            }
            return stroke.apply(this,arguments);
          };
          // Count CPU time between the start and end of editor-owned animation callbacks.
          const raf=window.requestAnimationFrame.bind(window);
          window.costs=[];window.requestAnimationFrame=fn=>raf(time=>{
            const n=paintTimes.length,begin=performance.now();fn(time);
            if(paintTimes.length>n)costs.push(performance.now()-begin);
          });
        }""")
        page.goto(preview.resolve().as_uri())
        expect(page.locator("#layers .layer").first).to_be_attached()
        expect(page.locator("#status")).to_have_attribute("data-workspace","ready")

    def load(self, data):
        page=self.page
        page.locator("#project-picker").set_input_files(dict(name="交互验收.mgcanvas",mimeType="application/json",
                                                             buffer=json.dumps(data,ensure_ascii=False).encode()))
        expect(page.locator("#status")).to_contain_text("项目已打开")
        page.locator("#fit").click()
        self.frame()

    def frame(self):
        self.page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

    def at(self,x,y):
        return self.page.locator("#canvas").evaluate("""(c,[x,y])=>{const b=c.getBoundingClientRect(),[a,d,e,f]=viewMatrix;
          return [b.left+(a*x+e)*b.width/c.width,b.top+(d*y+f)*b.height/c.height];}""",[x,y])

    def selection(self):
        return self.page.locator('#layers .layer[aria-pressed="true"]').evaluate_all("ns=>ns.map(n=>n.dataset.id)")

    def click(self,x,y):
        self.page.mouse.click(*self.at(x,y))
        self.frame()

    def hover(self,x,y,op,jitter=.2):
        page=self.page
        page.mouse.move(2,2)
        self.frame()
        before=page.evaluate("[hoverStrokes,paintTimes.length]")
        px,py=self.at(x,y)
        page.mouse.move(px,py)
        self.frame()
        assert page.evaluate("hoverStrokes")>before[0] and op in page.evaluate("hovers"), (x,y,op,page.evaluate("hovers"))
        assert page.evaluate("hoverWidth") == 2
        count=page.evaluate("hoverStrokes")
        page.mouse.move(px+jitter,py+jitter)
        self.frame()
        assert page.evaluate("[hoverStrokes,paintTimes.length]") == [count,before[1]], (x,y,before,page.evaluate("[hoverStrokes,paintTimes.length]"))


def check_hover(board):
    page=board.page
    prior=fixture("M5S-Cubic-Paths.mgcanvas")
    old=prior["document"]["objects"]
    image=next(dict(o,id="photo",at=point(600,0),width=120,height=56,rotation=.13) for o in old.values() if o["kind"]=="image")
    path=next(dict(o,id="curve",at=point(0,140)) for o in old.values() if o["kind"]=="path" and o.get("curves"))
    ink=next(dict(o,id="ink",at=point(210,160)) for o in old.values() if o["kind"]=="ink")
    text=dict(id="text",kind="text",at=point(410,0),width=120,height=50,rotation=0,text="备注",fontSize=18,color="#223344",align="left")
    note=dict(shape("note",400,140,"便签","#ffe890"),content=dict(kind="sticky",fontSize=19))
    doc=dict(shape("doc",595,140,"# 文档"),width=160,height=80,content=dict(kind="markdown",fontSize=16))
    table=dict(id="table",kind="table",at=point(0,300),width=140,height=86,rotation=0,cells=[[dict(text="甲"),dict(text="乙")]])
    tree=dict(id="tree",kind="mindmap",origin=point(330,320),rootId="root",layout="right",topics={
        "root":dict(id="root",text="计划",childIds=["child"],collapsed=False),"child":dict(id="child",text="交付",childIds=[],collapsed=False)})
    rows=[shape("back",0,0,"底层"),dict(shape("front",25,7,"前景"),shape="diamond"),shape("node",210,0,"步骤"),
          link("line","back","node"),text,image,path,ink,note,doc,table,tree]
    data=project(rows,6)
    data["assets"]=prior["assets"]; data["document"]["assets"]=prior["document"]["assets"]
    board.load(data)
    for theme in ["light","dark"]:
        page.locator("#theme-"+theme).check()
        for x,y,op in [(7,25,"roundRect"),(85,35,"lineTo"),(250,30,"roundRect"),(165,28,"lineTo"),(450,11,"roundRect"),
                       (651,25,"roundRect"),(0,140,"bezierCurveTo"),(228,163,"lineTo"),(455,165,"roundRect"),
                       (648,162,"roundRect"),(45,325,"roundRect"),(337,337,"roundRect")]:
            board.hover(x,y,op)
    board.click(85,35)
    assert board.selection()==["front"], board.selection()
    page.mouse.move(2,2);board.frame()
    assert page.evaluate("""()=>{
      const c=document.querySelector('#pointer-feedback'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      for(let i=0;i<p.length;i+=4)if(p[i]===120&&p[i+1]===214&&p[i+2]===229&&p[i+3]>240)return false;return true;
    }""")
    board.load(fixture("M5X-Flow-Groups.mgcanvas"))
    group=fixture("M5X-Flow-Groups.mgcanvas")["document"]["objects"]["a"]
    x=group["at"]["x"]+group["width"]/2;y=group["at"]["y"]+group["height"]/2
    board.hover(x,y,"roundRect")
    assert page.evaluate("hovers.filter(n=>n==='roundRect').length")>=2
    board.click(x,y);assert len(board.selection())>=3
    print("Hover verified for rotated images, shapes, overlapping objects, text, document, sticky, table, topic, connector, cubic path, ink and group in both themes.")


def record_motion(board, output):
    page=board.page
    rows=[shape("start",-260,-60,"收集需求"),shape("review",-25,90,"评审","#e1f0e9"),
          shape("deliver",250,-65,"交付","#f6e5d0"),link("a","start","review"),link("b","review","deliver")]
    board.load(project(rows));page.locator("#theme-light").check()
    for _ in range(2):page.locator("#zoom-out").click()
    board.frame()
    # Capture presented browser frames, including the editor controls, at their actual presentation times.
    frames=[]
    if output:
        cdp=page.context.new_cdp_session(page)
        def captured(event):
            frames.append((event["metadata"]["timestamp"],event["data"]))
            cdp.send("Page.screencastFrameAck",{"sessionId":event["sessionId"]})
        cdp.on("Page.screencastFrame",captured)
        cdp.send("Page.startScreencast",dict(format="png",maxWidth=1024,maxHeight=720,everyNthFrame=1))
    board.click(-205,-32)
    page.wait_for_timeout(440)
    before=page.locator("#layers .layer").count()
    page.keyboard.press("Tab")
    expect(page.locator("#layers .layer")).to_have_count(before+2)
    page.wait_for_timeout(520)
    assert page.evaluate("labels.some(p=>p.text==='流程步骤'&&p.alpha>0&&p.alpha<1)")
    page.locator("#canvas").focus();page.keyboard.press("Control+a")
    board.frame()
    page.mouse.click(*board.at(-205,-32),button="right")
    page.evaluate("labels.length=0")
    page.locator('[data-flow-layout="true"]').click()
    page.wait_for_timeout(640)
    assert page.evaluate("['收集需求','交付','评审'].some(s=>new Set(labels.filter(p=>p.text===s).map(p=>Math.round(p.x)+','+Math.round(p.y))).size>2)")
    page.evaluate("labels.length=0")
    page.keyboard.press("Delete")
    expect(page.locator("#layers .layer")).to_have_count(0)
    page.wait_for_timeout(350)
    assert page.evaluate("labels.some(p=>p.alpha>0&&p.alpha<1)")
    if output:
        cdp.send("Page.stopScreencast");cdp.detach()
        assert len(frames)>=10, len(frames)
        images=[Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB") for _,data in frames]
        samples=Image.new("RGB",(160,100*len(images)))
        for i,img in enumerate(images):samples.paste(img.resize((160,100)),(0,100*i))
        palette=samples.quantize(colors=192)
        images=[img.quantize(palette=palette,dither=Image.Dither.NONE) for img in images]
        durations=[max(20,round((b[0]-a[0])*1000)) for a,b in zip(frames,frames[1:])]+[420]
        images[0].save(output,format="GIF",save_all=True,append_images=images[1:],duration=durations,loop=0,disposal=1)
        with Image.open(output) as recording:assert recording.n_frames>=10
        print(f"Saved {len(frames)} presented browser frames to {output}.")
    page.keyboard.press("Control+z")
    expect(page.locator("#layers .layer")).to_have_count(before+2)
    page.wait_for_timeout(40)
    page.keyboard.press("Control+y")
    expect(page.locator("#layers .layer")).to_have_count(0)
    page.wait_for_timeout(40);page.keyboard.press("Control+z")
    expect(page.locator("#layers .layer")).to_have_count(before+2)
    page.wait_for_timeout(350)
    n=page.evaluate("paintTimes.length");page.wait_for_timeout(250);assert page.evaluate("paintTimes.length")==n
    print("Recorded Tab insertion, connection-based arrangement and group removal. Undo restored the board and animation scheduling stopped.")


def benchmark(board,count=512):
    page=board.page
    columns=32 if count<=512 else 64
    rows=[shape(f"n{i}",(i%columns)*270,(i//columns)*180,"节点") for i in range(count)]
    page.emulate_media(reduced_motion="no-preference")
    board.load(project(rows))
    while page.locator("#zoom-read").inner_text()!="5%":page.locator("#zoom-out").click()
    page.locator("#canvas").focus();page.keyboard.press("Control+a");board.frame()
    for key, name in [("Delete","remove"),("Control+z","add")]:
        page.evaluate("paintTimes.length=costs.length=0")
        page.keyboard.press(key);page.wait_for_timeout(330)
        stamps,costs=page.evaluate("[paintTimes,costs]")
        assert len(stamps)>=2 and costs,(name,stamps,costs)
        intervals=[b-a for a,b in zip(stamps,stamps[1:])]
        print(f"5% / {len(rows)} {name}: {len(costs)} paints, CPU median {statistics.median(costs):.1f} ms, "
              f"max {max(costs):.1f} ms, frame interval median {statistics.median(intervals):.1f} ms.")
    board.hover(60,28,"roundRect",jitter=0)
    page.emulate_media(reduced_motion="reduce")
    page.keyboard.press("Delete");page.wait_for_timeout(75)
    n=page.evaluate("paintTimes.length");page.wait_for_timeout(280);assert page.evaluate("paintTimes.length")==n
    assert not board.errors, board.errors


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("preview",type=Path);parser.add_argument("--video",type=Path)
    args=parser.parse_args()
    with sync_playwright() as pw,pw.chromium.launch(channel="chrome",headless=True,chromium_sandbox=True) as browser:
        page=browser.new_page(viewport={"width":1200,"height":770},reduced_motion="no-preference")
        board=Board(page,args.preview)
        check_hover(board);record_motion(board,args.video);benchmark(board);benchmark(board,2048)
