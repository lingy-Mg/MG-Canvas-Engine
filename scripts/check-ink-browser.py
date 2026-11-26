"""Replay the ink renderer and mouse chords in local Chromium. Requires Playwright."""
import argparse
import posixpath
import base64
import hashlib
import json
import re
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOOK = """(() => {
  const qa=window.inkQA={writes:0, errors:[], track:false};
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){
    if(this.transaction.db.name==='mg-canvas-workspaces'){
      qa.writes++;
      const [value,key]=args;
      if(key[1]==='document')qa.savedCount=value.order.length;
      if(key[1]==='head')qa.savedCamera=value.camera;
    }
    return put.apply(this,args);
  };
  const proto=CanvasRenderingContext2D.prototype;
  for(const name of ['beginPath','lineTo','arc','stroke','fill']){
    const original=proto[name];
    proto[name]=function(...args){
      if(this.canvas.id==='canvas'){
        if(name==='beginPath'){this.qaLine=undefined;this.qaArc=undefined;}
        if(name==='lineTo')this.qaLine=args;
        if(name==='arc')this.qaArc=args;
        if(name==='stroke'||name==='fill'){
          const line=name==='stroke',p=line?this.qaLine:this.qaArc,color=line?this.strokeStyle:this.fillStyle;
          if(p&&(color==='#116677'||color==='#445566')){
            const t=this.getTransform(),r=this.canvas.getBoundingClientRect(),d=devicePixelRatio;
            qa[color]=[(t.a*p[0]+t.c*p[1]+t.e)/d+r.left,(t.b*p[0]+t.d*p[1]+t.f)/d+r.top];
            if(color==='#445566')qa.zoom=t.a/d;
          }
        }
      }
      return original.apply(this,args);
    };
  }
  function afterInput(e){
    if(!qa.track||e.target.id!=='canvas'||e.buttons!==1)return;
    const last=e.getCoalescedEvents?.().at(-1)??e;
    qa.latest=[last.clientX,last.clientY];
    if(!qa.pending)qa.pending=requestAnimationFrame(()=>{
      qa.pending=0;
      const tip=qa['#116677'];
      qa.errors.push(tip?Math.hypot(tip[0]-qa.latest[0],tip[1]-qa.latest[1]):Infinity);
    });
  }
  document.addEventListener('pointermove',afterInput);
  document.addEventListener('pointerrawupdate',afterInput);
})();"""


def units(file):
    match = re.search(r"^const units=(.*);$", file.read_text(encoding="utf-8"), re.M)
    needed = {"features/ink.js", "features/ink-input.js", "renderers/canvas2d/canvas.js", "scene/board.js", "platform/project.js", "features/image-assets.js"}
    if not match:
        # The current React HTML embeds a single bundle. The renderer checks use
        # the matching engine modules generated alongside it in dist/.
        graph = {}

        def visit(path):
            if path in graph:
                return
            code = (file.parent / path).read_text(encoding="utf-8")
            imports = re.findall(r"\bfrom\s+[\"'](\.[^\"'\n]+)[\"']", code)
            deps = {name: posixpath.normpath(posixpath.join(posixpath.dirname(path), name)) for name in imports}
            for dep in deps.values():
                visit(dep)
            graph[path] = {"path": path, "code": code, "deps": deps}

        for path in sorted(needed):
            visit(path)
        return list(graph.values())

    graph = json.loads(match[1])
    for item in reversed(graph):
        if item["path"] in needed:
            needed.update(item["deps"].values())
    return [item for item in graph if item["path"] in needed]


def mouse_pan(page, paced=False):
    session = page.context.new_cdp_session(page)
    reference = {"kind":"ink", "id":"guide", "at":{"x":0,"y":0}, "samples":[[0,0,.5],[24,0,.5]],
                 "brushVersion":1, "baseWidth":2, "color":"#445566"}
    doc = {"schemaVersion":2, "id":"ink-browser-test", "theme":"paper", "order":["guide"], "objects":{"guide":reference}, "assets":{}}
    if paced:
        for i in range(120):
            key=f"dot-{i}"
            doc["objects"][key]={**reference,"id":key,"at":{"x":i%20*30-240,"y":i//20*55-130},
                                 "samples":[[0,0,.5]],"color":"#8899aa"}
            doc["order"].append(key)
    board = {"format":"mg-canvas.project", "version":1, "document":doc, "assets":{}}

    def open_board(data):
        page.locator("#project-picker").set_input_files({"name":"ink.mgcanvas", "mimeType":"application/json", "buffer":data})
        page.wait_for_timeout(650)

    def export():
        with page.expect_download() as download:
            page.locator("#project-export").click()
        return download.value.path().read_bytes()

    def frame():
        page.evaluate("() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")
        if paced:
            page.wait_for_timeout(120)

    def mouse(kind, x, y, button, buttons):
        session.send("Input.dispatchMouseEvent", {"type":kind,"x":x,"y":y,"button":button,"buttons":buttons,
                     "pointerType":"mouse","clickCount":0 if kind=="mouseMoved" else 1})

    open_board(json.dumps(board).encode())
    original = export()
    page.locator("#tool-ink").click()
    page.locator("#ink-color").evaluate("(c)=>{c.value='#116677';c.dispatchEvent(new Event('input'))}")
    frame()
    before, writes = page.evaluate("[inkQA['#445566'],inkQA.writes]")
    if before is None:
        state=page.evaluate("({status:document.querySelector('#status')?.textContent,zoom:document.querySelector('#zoom-read')?.textContent,qa:inkQA})")
        raise AssertionError(("missing painted guide",json.loads(original)["document"]["order"],state))
    mouse("mousePressed",250,230,"middle",4)
    mouse("mouseMoved",251,230,"middle",4)
    frame()
    after = page.evaluate("inkQA['#445566']")
    assert abs(after[0]-before[0]-1)<.001 and abs(after[1]-before[1])<.001, (before,after)
    mouse("mouseMoved",308,265,"middle",4)
    mouse("mouseReleased",308,265,"middle",0)
    page.wait_for_timeout(650)
    assert export()==original and page.evaluate("inkQA.writes")==writes
    assert page.locator("#tool-ink").get_attribute("aria-pressed")=="true"

    page.locator("#ink-highlighter").click()
    mouse("mousePressed",310,315,"left",1)
    mouse("mouseMoved",380,315,"left",1)
    mouse("mousePressed",380,315,"middle",5)
    mouse("mouseMoved",510,373,"middle",5)
    page.wait_for_timeout(650)
    assert page.evaluate("inkQA.writes")==writes and page.locator("#undo").is_disabled()
    mouse("mouseReleased",510,373,"middle",1)
    mouse("mouseMoved",552,373,"left",1)
    mouse("mouseReleased",552,373,"left",0)
    mixed=export()
    edited=json.loads(mixed)["document"]
    strokes=[edited["objects"][k] for k in edited["order"][len(doc["order"]):]]
    assert len(strokes)==1
    zoom=page.evaluate("inkQA.zoom")
    mark=strokes[0]
    assert mark["brushVersion"]==2 and mark["subpixel"] and all(s[2]==.5 for s in mark["samples"])
    first,last=mark["samples"][0],mark["samples"][-1]
    assert abs((last[0]-first[0])*zoom-112)<.001 and all(abs(s[1]-first[1])<.001 for s in mark["samples"])
    page.locator("#undo").click()
    assert export()==original
    page.locator("#redo").click()
    assert export()==mixed
    page.wait_for_function("baseline=>inkQA.writes>baseline",arg=writes)
    open_board(mixed)
    assert export()==mixed

    if page.locator("#ink-tools").is_hidden():
        page.locator("#tool-ink").click()
    page.locator("#ink-pen").click()
    frame()
    zoom=page.evaluate("inkQA.zoom")
    def pen(kind,x,y,pressure):
        page.locator("#canvas").evaluate("""(canvas,[kind,x,y,p])=>canvas.dispatchEvent(new PointerEvent(kind,{
          pointerId:81,pointerType:'pen',isPrimary:true,clientX:x,clientY:y,pressure:p,button:kind==='pointermove'?-1:0,
          buttons:kind==='pointerup'?0:1,bubbles:true,cancelable:true}))""",[kind,x,y,pressure])

    writes=page.evaluate("inkQA.writes")
    pen("pointerdown",300,295,.2)
    pen("pointermove",365,295,.8)
    mouse("mousePressed",420,370,"middle",4)
    mouse("mouseMoved",480,400,"middle",4)
    pen("pointermove",710,305,.3)
    page.wait_for_timeout(650)
    assert page.evaluate("inkQA.writes")==writes
    mouse("mouseReleased",480,400,"middle",0)
    pen("pointermove",744,307,.9)
    pen("pointerup",744,307,0)
    split=json.loads(export())["document"]
    assert len(split["order"])==len(edited["order"])+2
    a,b=(split["objects"][k] for k in split["order"][-2:])
    def ends(item):
        return [(item["at"]["x"]+s[0],item["at"]["y"]+s[1]) for s in [item["samples"][0],item["samples"][-1]]]
    (a0,a1),(b0,b1)=ends(a),ends(b)
    assert abs((a1[0]-a0[0])*zoom-65)<.001 and abs((b1[0]-b0[0])*zoom-34)<.001
    assert (b0[0]-a1[0])*zoom>200 and abs(b["samples"][0][2]-.3)<1e-5
    page.locator("#undo").click()
    assert export()==mixed

    # Release the writing button first. Only the pre-pan piece is published.
    mouse("mousePressed",310,360,"left",1)
    mouse("mouseMoved",355,360,"left",1)
    mouse("mousePressed",355,360,"middle",5)
    mouse("mouseMoved",423,375,"middle",5)
    mouse("mouseReleased",423,375,"left",4)
    mouse("mouseMoved",495,399,"middle",4)
    mouse("mouseReleased",495,399,"middle",0)
    early=json.loads(export())["document"]
    assert len(early["order"])==len(edited["order"])+1
    begin,end=ends(early["objects"][early["order"][-1]])
    assert abs((end[0]-begin[0])*zoom-45)<.001 and end[1]==begin[1]
    if paced:
        page.wait_for_function("n=>inkQA.savedCount===n",arg=len(early["order"]))
        return {"panOnlyWrites":0,"middleMovedFirstPixel":True,"penResumeParts":2,"mouseMarkerParts":1,
                "undoRedoReopen":True}
    page.evaluate("inkQA.track=true")
    mouse("mousePressed",320,430,"left",1)
    for i in range(1,89):
        mouse("mouseMoved",320+i*4.75,430+(i%28)*.81,"left",1)
        if i%8==0:
            frame()
    frame()
    page.evaluate("inkQA.track=false")
    mouse("mouseReleased",738,430+(88%28)*.81,"left",0)
    errors=page.evaluate("inkQA.errors")
    assert len(errors)>=10 and max(errors)<.02, (len(errors),max(errors))
    return {"nextFrameChecks":len(errors),"maxPaintedTipErrorCss":round(max(errors),6),"panOnlyWrites":0}


def module_url(name, imports=()):
    code=(ROOT/"scripts"/name).read_text(encoding="utf-8")
    for dep in imports:
        code=code.replace('"./'+dep+'"','"'+module_url(dep)+'"')
    return "data:text/javascript;base64,"+base64.b64encode(code.encode()).decode()


def capture_zooms(page, url):
    page.set_viewport_size({"width":2600,"height":1220})
    if page.locator("#ink-tools").is_hidden():
        page.locator("#tool-ink").click()
    page.locator("#ink-pen").click()
    for key,value in [("ink-width","3"),("ink-color","#116677")]:
        page.locator("#"+key).evaluate("(e,v)=>{e.value=v;e.dispatchEvent(new Event('input'))}",value)
    run=page.evaluate("async url=>(await import(url)).editorZoom()",url)

    def export():
        with page.expect_download() as waiting:
            page.locator("#project-export").click()
        return waiting.value.path().read_bytes()

    saved=export()
    doc=json.loads(saved)["document"]
    strokes=[doc["objects"][k] for k in doc["order"][-len(run["ends"]):]]
    for s,(dx,dy) in zip(strokes,run["ends"],strict=True):
        assert s["kind"]=="ink" and s["baseWidth"]==3 and s["color"]=="#116677" and all(p[2]==.5 for p in s["samples"])
        a,b=s["samples"][0],s["samples"][-1]
        assert abs((b[0]-a[0])-dx)<1e-6 and abs((b[1]-a[1])-dy)<1e-6,(a,b,dx,dy)
    page.locator("#project-picker").set_input_files({"name":"zoom.mgcanvas","mimeType":"application/json","buffer":saved})
    page.wait_for_timeout(650)
    assert export()==saved
    return run["frames"]

PACE_HOOK="""(() => {
  const q=window.pacedInk={paints:0,transfers:0,gap:0,observations:[]};
  const ctx=CanvasRenderingContext2D.prototype,fill=ctx.fillRect,draw=ctx.drawImage,raf=window.requestAnimationFrame;
  let drawing=false,admitted=false,last=-Infinity;
  ctx.fillRect=function(...args){
    if(drawing&&this.canvas.id==='canvas')admitted=true;
    return fill.apply(this,args);
  };
  ctx.drawImage=function(...args){
    if(drawing&&this.canvas.id==='canvas'&&args[0] instanceof OffscreenCanvas){q.transfers++;admitted=true;}
    return draw.apply(this,args);
  };
  window.requestAnimationFrame=function(callback){
    if(callback.name!=='displayFrame')return raf.call(window,callback);
    return raf.call(window,function tick(t){
      if(t-last+.35<q.gap){raf.call(window,tick);return;}
      last=t;admitted=false;drawing=true;const start=performance.now();
      try{callback(t);}finally{drawing=false;}
      if(admitted){
        q.paints++;
        if(q.tip){
          const xy=window.inkQA['#116677'];
          q.observations.push({time:t,batch:q.batch,cost:performance.now()-start,error:xy?Math.hypot(xy[0]-q.tip.x,xy[1]-q.tip.y):Infinity});
        }
      }
    });
  };
})();"""


def editor_page(context, file, paced=False):
    page=context.new_page()
    page.add_init_script(HOOK)
    if paced:
        page.add_init_script(PACE_HOOK)
    page.on("dialog",lambda dialog:dialog.accept())
    page.goto(file.resolve().as_uri())
    page.locator("#ink-swatch-223344").wait_for(state="attached")
    page.wait_for_function("!document.querySelector('#status').textContent.includes('正在检查')")
    return page


def frame_pace(browser, file):
    reports=[]
    url=module_url("replay-ink-pace.mjs",["replay-ink.mjs"])
    graph=units(file)
    for rate,gap in [("unlimited",0),("30",0),("30",80)]:
        context=browser.new_context(viewport={"width":1280,"height":820},device_scale_factor=1.5)
        page=editor_page(context,file,True)
        page.locator("#frame-rate").select_option(rate)
        page.evaluate("ms=>pacedInk.gap=ms",gap)
        pan=mouse_pan(page,True)
        page.locator("#ink-pen").click()
        if page.locator("#ink-finger").get_attribute("aria-pressed")!="true":
            page.locator("#ink-finger").click()
        for key,value in [("ink-width","6"),("ink-color","#116677")]:
            page.locator("#"+key).evaluate("(e,v)=>{e.value=v;e.dispatchEvent(new Event('input'))}",value)
        drawing=page.evaluate("async u=>(await import(u)).runPacedInk()",url)
        def export():
            with page.expect_download() as waiting:
                page.locator("#project-export").click()
            return waiting.value.path().read_bytes()
        saved=export()
        doc=json.loads(saved)["document"]
        strokes=[doc["objects"][k] for k in doc["order"][-len(drawing):]]
        oracle=page.evaluate("async ([u,g,s])=>(await import(u)).verifyPacedInk(g,s)",[url,graph,strokes])
        for entry,detail in zip(drawing,oracle,strict=True):
            entry.update(detail)
        digest="async u=>(await import(u)).boardDigest()"
        before=page.evaluate(digest,url)
        page.reload()
        page.wait_for_function("Math.abs(inkQA.zoom-.05)<1e-6 && !document.querySelector('#status').textContent.includes('正在检查')")
        assert export()==saved
        reopened_pixels=page.evaluate(digest,url)==before
        page.locator("#project-picker").set_input_files({"name":"paced.mgcanvas","mimeType":"application/json","buffer":saved})
        page.wait_for_timeout(650)
        assert export()==saved
        reports.append({"rate":rate,"minCallbackGapMs":gap,"pan":pan,"workspacePixelsReopened":reopened_pixels,"projectReopened":True,"strokes":drawing})
        context.close()
    return reports


def paced_build(browser, file):
    # The offline entry is self-contained. Keep all three runs on identical
    # bytes even if another build replaces dist during the replay.
    contents=file.read_bytes()
    with tempfile.TemporaryDirectory() as folder:
        snapshot=Path(folder)/file.name
        snapshot.write_bytes(contents)
        return {"build":file.name,"sha256":hashlib.sha256(contents).hexdigest(),"cases":frame_pace(browser,snapshot)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline",type=Path)
    version=re.search(r'previewVersion="([^"]+)"',(ROOT/"scripts"/"release.mjs").read_text(encoding="utf-8"))[1]
    parser.add_argument("--current",type=Path,default=ROOT/"dist"/f"Canvas-{version}-Preview.html")
    parser.add_argument("--image",type=Path,help="Write the two-scale PNG comparison")
    parser.add_argument("--capture-zoom",action="store_true",help="Capture at 5, 25, 100 and 400 percent and compare at a common viewing zoom")
    parser.add_argument("--frame-pace",action="store_true",help="Measure actual admitted editor paints, complete contact packets and camera-cache transitions")
    parser.add_argument("--detail-image",type=Path,help="Write the maximum-zoom centerline and edge comparison")
    parser.add_argument("--report",type=Path,help="Write numerical measurements as UTF-8 JSON")
    parser.add_argument("--chrome",help="Chromium executable (default: installed Google Chrome)")
    args=parser.parse_args()
    baseline=args.baseline or ROOT/"preview"/("Canvas-M5AZ-Preview.html" if args.capture_zoom else "Canvas-M5AX-Preview.html")
    with sync_playwright() as pw:
        browser=pw.chromium.launch(channel=None if args.chrome else "chrome",executable_path=args.chrome,headless=True)
        if args.frame_pace:
            report={"browser":browser.version,"input":"simulated","viewportCss":[1280,820],"devicePixelRatio":1.5,
                    **paced_build(browser,args.current)}
            if args.baseline:
                report["baseline"]=paced_build(browser,args.baseline)
            cases=report["cases"]
            if args.report:
                args.report.write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
            for case in cases:
                for stroke in case["strokes"]:
                    print(case["rate"],case["minCallbackGapMs"],stroke,flush=True)
            browser.close()
            for case in cases:
                assert case["workspacePixelsReopened"],case["rate"]
                for s in case["strokes"]:
                    assert s["matchesAllSamples"] and s["cacheTransfersBefore"]>0 and s["cacheInStroke"]==0,s
                    if s["name"] in ("slowMouse","plainPen","finger"):
                        assert s["width"]==[6,6],s
                    else:
                        assert s["width"][0]<6<s["width"][1],s
                    if s["name"]=="betweenPaints":
                        assert s["draftPaints"]==0,s
                    else:
                        assert s["draftPaints"]>=2 and s["maxTipCss"]<.002 and s["liftChangedPixels"]==0,s
            return
        context=browser.new_context(viewport={"width":1280,"height":820},device_scale_factor=1.5)
        page=editor_page(context,args.current)
        ui=mouse_pan(page)
        if args.capture_zoom:
            url=module_url("replay-ink-zoom.mjs",["replay-ink.mjs","ink-zoom-traces.mjs"])
            ui["captureZoom"]=capture_zooms(page,url)
        else:
            url=module_url("replay-ink.mjs")
        # An uninstrumented page keeps the timing probes out of Canvas calls.
        bench=context.new_page()
        results=bench.evaluate("""async ([url,method,groups])=>{
          try{return await (await import(url))[method](groups)}catch(error){return {error:error.message}}
        }""",[url,"replayInkZoom" if args.capture_zoom else "replayInk",[units(baseline),units(args.current)]])
        if "error" in results:
            raise RuntimeError(results["error"])
        image=base64.b64decode(results.pop("png"))
        if args.image:
            args.image.write_bytes(image)
        if "detail" in results:
            detail=base64.b64decode(results.pop("detail"))
            if args.detail_image:
                args.detail_image.write_bytes(detail)
        report={"browser":browser.version,"baseline":baseline.name,"build":args.current.name,"editor":ui,**results}
        if args.report:
            args.report.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
        print(json.dumps(report,indent=2))
        browser.close()


if __name__=="__main__":
    main()
