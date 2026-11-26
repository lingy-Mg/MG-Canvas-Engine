"""Compare the actual textarea, board and exported PNG on local Chrome or an attached Android test browser."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
SAMPLE = "画布字体 Canvas 2026，A9 测试（版本 3.5）中文换行。"
WIDTH = 219
INK = "#205840"
TRACE = """{
  window.qaRows=new Map();
  const create=URL.createObjectURL;
  URL.createObjectURL=function(blob){
    if(blob.type==='image/png')window.qaPNG=blob;
    if(blob.type==='application/json')window.qaProject=blob;
    return create.call(this,blob);
  };
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.download&&window.qaProject)return; // Capture the app's serialized file without invoking the OS download UI.
    return click.call(this);
  };
  const original=CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText=function(s,x,y,...args){
    const result=original.call(this,s,x,y,...args);
    if(['canvas','png-canvas'].includes(this.canvas.id)&&this.fillStyle==='#205840'){
      const m=this.getTransform();
      window.qaRows.set(y,{s,font:this.font,y,x,origin:[m.e,m.f],scale:[m.a,m.d],width:this.measureText(s).width});
    }
    return result;
  };
}"""


def tagged(template, project, options=None):
    def script(key, value):
        safe = json.dumps(value, ensure_ascii=True).replace("<","\\u003c")
        return f'<script type="application/json" id="{key}">{safe}</script>'
    tags = script("mgcanvas-project", project)
    if options is not None:
        tags += script("png-options", options)
    return template.replace("<!-- mgcanvas-input -->", tags)


def editor_data(cdp):
    cdp.send("DOM.enable")
    cdp.send("CSS.enable")
    root = cdp.send("DOM.getDocument")["root"]["nodeId"]
    node = cdp.send("DOM.querySelector", {"nodeId":root,"selector":".text-overlay textarea"})["nodeId"]
    tree = cdp.send("DOM.describeNode", {"nodeId":node,"depth":-1,"pierce":True})["node"]
    def descend(obj):
        yield obj
        for child in obj.get("children",[]) + obj.get("shadowRoots",[]):
            yield from descend(child)
    text = next(n for n in descend(tree) if n.get("nodeType")==3 and n["nodeValue"]==SAMPLE)
    remote = cdp.send("DOM.resolveNode",{"backendNodeId":text["backendNodeId"]})["object"]["objectId"]
    rows = cdp.send("Runtime.callFunctionOn",{"objectId":remote,"returnByValue":True,
        "functionDeclaration":"""function(){
          const rows=[],range=document.createRange();
          for(const {index,segment} of new Intl.Segmenter().segment(this.textContent)){
            range.setStart(this,index);range.setEnd(this,index+segment.length);
            const rect=range.getBoundingClientRect();
            if(!rows.length||Math.abs(rows.at(-1).top-rect.top)>10)rows.push({top:rect.top,s:''});
            rows.at(-1).s+=segment;
          }
          return rows;
        }"""})["result"]["value"]
    frontend = cdp.send("DOM.pushNodesByBackendIdsToFrontend",{"backendNodeIds":[text["backendNodeId"]]})["nodeIds"][0]
    fonts = cdp.send("CSS.getPlatformFontsForNode",{"nodeId":frontend})["fonts"]
    assert fonts
    return rows,fonts


def crop_png(data, origin, height, width=WIDTH):
    img = Image.open(io.BytesIO(data)).convert("RGB")
    x,y = (round(v) for v in origin)
    return img.crop((x,y,x+width,y+height))


def ink_bounds(im):
    # Same explicit green ink and white paper in the textarea, canvas and PNG.
    # Measure the visible ink in each row, excluding the one-pixel field outline.
    ys = []
    for y in range(1, im.height-1):
        if any(g-r>16 and g-b>8 and g<200 for r,g,b in (im.getpixel((x,y)) for x in range(1,im.width-1))):
            ys.append(y)
    bands = []
    for y in ys:
        if not bands or y!=bands[-1][1]+1:
            bands.append([y,y])
        else:
            bands[-1][1]=y
    return bands


def run(browser, opts):
    app = opts.preview.read_text(encoding="utf8")
    exporter = (ROOT/"dist/ai-render.html").read_text(encoding="utf8")
    ctx = browser.contexts[0] if opts.cdp else browser.new_context(
        viewport={"width":1100,"height":780},device_scale_factor=1,reduced_motion="reduce")
    p = ctx.pages[0] if opts.cdp and ctx.pages else ctx.new_page()
    p.set_default_timeout(12000)
    p.on("dialog",lambda d:d.accept())
    p.add_init_script(TRACE)
    origin = "http://127.0.0.1/mg-font-qa/"
    pages = {"dimensions":app}
    p.route(origin+"**",lambda r:r.fulfill(body=pages[r.request.url.removeprefix(origin)],content_type="text/html; charset=utf-8"))
    p.goto(origin+"dimensions")
    p.locator("#canvas").wait_for()
    vw,vh = p.locator("#canvas").evaluate("c=>[c.clientWidth,c.clientHeight]")
    padding = min(74,max(18,min(vw,vh)*.12))
    span = vw-2*padding
    report = {"browser":browser.version,"ua":p.evaluate("navigator.userAgent"),
              "viewport":[vw,vh],"devicePixelRatio":p.evaluate("devicePixelRatio"),"sample":SAMPLE,"cases":[]}
    assert report["devicePixelRatio"]==1,"For pixel comparisons run at the test device's mdpi density"
    cdp = ctx.new_cdp_session(p)
    for family in ("system","serif","pingfang"):
        marker = {"kind":"shape","id":"extent","at":{"x":-span/2,"y":-120},"width":span,"height":240,
                  "rotation":0,"shape":"rect","cornerRadius":0,"fill":"transparent","stroke":"#ffffff","strokeWidth":0,"label":""}
        item = {"kind":"text","id":"sample","at":{"x":-110,"y":-60},"width":WIDTH,"height":135,"rotation":0,
                "text":SAMPLE,"fontSize":22,"fontFamily":family,"fontWeight":500,"color":INK,"background":"#ffffff","align":"left"}
        doc = {"schemaVersion":1,"id":"font-"+family,"theme":"paper","order":["extent","sample"],
               "objects":{"extent":marker,"sample":item},"assets":{}}
        pages[family] = tagged(app,doc)
        p.goto(origin+family)
        p.wait_for_function("window.qaRows?.size>0")
        if p.locator("#layers-panel").is_visible():
            p.locator("#close-layers").click()
        p.evaluate("qaRows.clear()")
        p.locator("#fit").click()
        expect(p.locator("#zoom-read")).to_have_text("100%")
        p.wait_for_function("qaRows.size>0")
        live = p.evaluate("Array.from(qaRows.values())")
        assert all(max(abs(v-1) for v in r["scale"])<1e-5 for r in live), live
        height = round(22*1.4*len(live))
        canvas = p.locator("#canvas")
        raster = lambda c:base64.b64decode(c.evaluate("c=>c.toDataURL('image/png').split(',')[1]"))
        painted = crop_png(raster(canvas),live[0]["origin"],height)
        painted.save(opts.output/(family+"-canvas.png"))
        x,y = live[0]["origin"]
        canvas.dblclick(position={"x":x+35,"y":y+14})
        field = p.locator(".text-overlay textarea")
        expect(field).to_have_value(SAMPLE)
        field.evaluate("e=>{e.setSelectionRange(0,0);e.style.caretColor='transparent';}")
        actual,fonts = editor_data(cdp)
        font = field.evaluate("e=>{const s=getComputedStyle(e);return [s.fontFamily,s.fontWeight,s.fontSize,s.lineHeight]}")
        edit = Image.open(io.BytesIO(field.screenshot())).convert("RGB")
        edit.save(opts.output/(family+"-edit.png"))
        field.press("Escape")
        p.locator("#project-export").click()
        saved=p.evaluate("async()=>JSON.parse(await qaProject.text())")
        saved_item=saved["document"]["objects"]["sample"]
        assert saved_item["fontFamily"]==family and saved_item["text"]==SAMPLE
        pages["reopen-"+family] = tagged(app,saved)
        p.goto(origin+"reopen-"+family)
        p.wait_for_function("window.qaRows?.size>0")
        assert p.evaluate("Array.from(qaRows.values(),r=>r.s)")==[r["s"] for r in live]
        pages["export-"+family] = tagged(exporter,saved,{"id":"sample","scale":1})
        p.goto(origin+"export-"+family)
        p.locator("#status:not(:empty)").wait_for(state="attached")
        status = json.loads(p.locator("#status").text_content())
        assert status["ok"],status
        exported = p.evaluate("Array.from(qaRows.values())")
        assert [r["s"] for r in live]==[r["s"] for r in exported]
        assert live[0]["font"]==exported[0]["font"]
        data = p.evaluate("""async()=>{const blob=window.qaPNG;
            return await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result.split(',')[1]);f.readAsDataURL(blob);});}""")
        out = crop_png(base64.b64decode(data),exported[0]["origin"],height)
        out.save(opts.output/(family+"-export.png"))
        record = {"family":family,"savedFontFamily":saved_item["fontFamily"],"editorRows":[r["s"] for r in actual],"canvasRows":[r["s"] for r in live],
                  "exportRows":[r["s"] for r in exported],"platformFonts":fonts,"editorStyle":font,
                  "canvasFont":live[0]["font"],"exportFont":exported[0]["font"],
                  "linePitch":[round(r["top"]-actual[0]["top"],2) for r in actual],
                  "editorInkBands":ink_bounds(edit),"canvasInkBands":ink_bounds(painted),"exportInkBands":ink_bounds(out),
                  "canvasPixelsSHA256":hashlib.sha256(painted.tobytes()).hexdigest(),
                  "exportPixelsSHA256":hashlib.sha256(out.tobytes()).hexdigest()}
        report["cases"].append(record)
        (opts.output/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf8")
        print(family, ascii(record["editorRows"]), ascii(record["canvasRows"]), [f["familyName"] for f in fonts],flush=True)
        assert [s.rstrip(" ") for s in record["editorRows"]]==[s.rstrip(" ") for s in record["canvasRows"]]
        assert record["canvasPixelsSHA256"]==record["exportPixelsSHA256"]
        assert len(record["editorInkBands"])==len(record["canvasInkBands"])==len(actual)
        assert all(abs(a-b)<=2 for pair,ref in zip(record["editorInkBands"],record["canvasInkBands"]) for a,b in zip(pair,ref))
    cdp.detach()
    if not opts.cdp:
        ctx.close()


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview",type=Path)
    parser.add_argument("output",type=Path)
    parser.add_argument("--cdp",help="Loopback CDP port forwarded from the disposable Android browser")
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as pw:
        browser=pw.chromium.connect_over_cdp(args.cdp) if args.cdp else pw.chromium.launch(channel="chrome",chromium_sandbox=True)
        run(browser,args)
        if not args.cdp:
            browser.close()
