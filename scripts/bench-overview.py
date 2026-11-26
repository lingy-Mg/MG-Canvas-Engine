"""Measure low-zoom wheel interactions in isolated Chromium contexts."""
import argparse
import hashlib
import json
import re
import statistics
import subprocess
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


FIXTURE = r"""
import {readFileSync} from "node:fs";
import {largeBoard} from "./tests/fixtures/large-board.ts";
import {newCard} from "./features/card-content.ts";
import {createTable} from "./features/table.ts";
import {AssetVault} from "./features/image-assets.ts";
import {decodeProject,encodeProject} from "./platform/project.ts";
const {document:board}=largeBoard(1920);
const fixture=decodeProject(readFileSync("docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas","utf8"));
const asset=fixture.assets[0];
board.schemaVersion=6;
board.assets={[asset.meta.id]:asset.meta};
const samples=Array.from({length:640},(_,i)=>[Math.round(i/2),Math.round(22*Math.sin(i/19)),.5+.25*Math.sin(i/17)]);
const note="# 会议安排\n- **审批**和访客权限\n- 查看时间表与设备\n\n> 同步到门口屏幕\n\n\x60\x60\x60js\nconst ok = true;\n\x60\x60\x60";
function put(item){board.objects[item.id]=item;board.order.push(item.id);}
for(let i=0;i<192;i++){
  const {at:{x,y}}=board.objects["s-"+i*10];
  const at=(dx,dy)=>({x:x+dx,y:y+dy});
  put({...newCard("markdown",at(350,90),note),id:"doc-"+i});
  put({...newCard("sticky",at(10,100),"中文便签\nNotes\n回顾议程"),id:"note-"+i});
  const table=createTable(at(160,240));
  put({...table,id:"table-"+i,cells:Array.from({length:6},(_,r)=>Array.from({length:6},(_,c)=>({text:"单元 "+r+c})))});
  put({id:"image-"+i,kind:"image",assetId:asset.meta.id,at:at(120,72),width:210,height:145,rotation:0});
  put({id:"ink-"+i,kind:"ink",at:at(33,185),baseWidth:4,color:"#263655",brushVersion:1,samples});
}
for(const [index,fill] of ["#d40ad4","#a60eb8"].entries()){
  put({id:"drag-probe-"+index,kind:"shape",shape:"rect",at:{x:-1850+830*index,y:-300},width:710,height:550,
    rotation:0,cornerRadius:4,fill,stroke:fill,label:""});
}
console.log(encodeProject(board,new AssetVault([asset])));
"""

GESTURE = """async ({kind,count,stall,stallAt}) => {
    const canvas=document.querySelector("#canvas"), box=canvas.getBoundingClientRect();
    const intervals=[], frame=()=>new Promise(requestAnimationFrame);
    const probe=window.probes?.["#d40ad4"];
    let prior=await frame();
    for(let i=0;i<count;i++){
      const phase=i%24<12?1:-1, zoom=kind==="zoom";
      if(kind.startsWith("drag")){
        const [x,y]=probe;
        canvas.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,pointerType:"mouse",pointerId:1,buttons:1,
          clientX:box.left+x+8+Math.sin(i/7)*60,clientY:box.top+y+Math.cos(i/7)*38}));
      }else canvas.dispatchEvent(new WheelEvent("wheel",{
        bubbles:true,cancelable:true,ctrlKey:zoom,
        clientX:box.left+box.width/2,clientY:box.top+box.height/2,
        deltaX:zoom?0:phase*3,deltaY:zoom?(i%2===0?-24:24):phase*2
      }));
      if(stall && i===stallAt){
        const resume=performance.now()+stall;
        while(performance.now()<resume){}
      }
      const next=await frame();intervals.push(next-prior);prior=next;
    }
    return intervals;
}"""

TRACE = """() => {
    window.paints=[];window.probes={};let timestamp;
    const raf=window.requestAnimationFrame;
    window.requestAnimationFrame=callback=>raf.call(window,at=>{
      timestamp=at;
      if(!window.overviewTrace||callback.name!=="displayFrame"){callback(at);return;}
      const start=performance.now(),builds=window.cacheBuilds,strips=window.cacheStrips;
      window.traceReadbacks=0;window.traceReadbackMs=0;
      callback(at);
      const frame=window.paints.at(-1);
      if(frame?.at===at)window.overviewTrace.push({...frame,started:start,work:performance.now()-start,
        builds:window.cacheBuilds-builds,strips:window.cacheStrips-strips,
        reads:window.traceReadbacks,readMs:window.traceReadbackMs});
    });
    const proto=CanvasRenderingContext2D.prototype, off=globalThis.OffscreenCanvasRenderingContext2D?.prototype;
    const mark=(kind)=>{if(window.paints.at(-1)?.at!==timestamp)window.paints.push({at:timestamp,kind});};
    const fillRect=proto.fillRect, drawImage=proto.drawImage, fill=proto.fill;
    proto.fillRect=function(x,y,w,h){
      if(window.paints.at(-1)?.at!==timestamp&&this.canvas.id==="canvas"&&this.getTransform().a===1&&this.getTransform().e===0&&this.getTransform().f===0)
        mark(x===0&&y===0&&w===this.canvas.clientWidth&&h===this.canvas.clientHeight?"full":"damage");
      return fillRect.apply(this,arguments);
    };
    proto.drawImage=function(image){
      if(this.canvas.id==="canvas"&&image instanceof OffscreenCanvas)mark("bitmap");
      return drawImage.apply(this,arguments);
    };
    proto.fill=function(){
      if(this.canvas.id==="canvas"&&(this.fillStyle==="#d40ad4"||this.fillStyle==="#a60eb8")){
        const p=this.getTransform().transformPoint({x:355,y:275});window.probes[this.fillStyle]=[p.x,p.y];
      }
      return fill.apply(this,arguments);
    };
    if(off){
      const clear=off.fillRect;
      off.fillRect=function(x,y,w,h){
        if(this.getTransform().a===1&&this.getTransform().e===0&&this.getTransform().f===0&&
          x===0&&y===0&&w===this.canvas.width&&h===this.canvas.height)window.cacheBuilds++;
        else if(this.getTransform().a===1&&this.getTransform().e===0&&this.getTransform().f===0&&
          (w===this.canvas.width||h===this.canvas.height))window.cacheStrips++;
        return clear.apply(this,arguments);
      };
    }
    window.cacheBuilds=0;window.cacheStrips=0;
    for(const context of [proto,off])if(context){
      const read=context.getImageData;
      context.getImageData=function(){
        if(!window.overviewTrace)return read.apply(this,arguments);
        const start=performance.now(),pixel=read.apply(this,arguments);
        window.traceReadbacks++;window.traceReadbackMs+=performance.now()-start;
        return pixel;
      };
    }
}"""
MINIMUM = re.compile(r"(\d+\.\d) FPS · (\d+\.\d) ms")


def check_stall(page, screenshot, check_trace=False):
    state = page.locator("#frame-meter-state")
    marker = page.locator("#frame-meter-low")
    line = page.locator("#frame-meter-line")
    minimum = page.locator("#frame-meter-min")
    expect(state).to_have_text("空闲")
    intervals = page.evaluate(GESTURE, {"kind": "pan", "count": 300, "stall": 760, "stallAt": 270})
    expect(state).to_have_text("实时")
    expect(marker).to_have_attribute("visibility", "visible")
    expect(minimum).to_have_text(MINIMUM)
    fps, milliseconds = map(float, MINIMUM.fullmatch(minimum.inner_text()).groups())
    expected = max(intervals)
    assert expected >= 745 and abs(milliseconds - expected) <= .2, (expected, milliseconds)
    assert abs(fps - 1000 / milliseconds) < .06
    x = float(marker.get_attribute("cx"))
    y = float(marker.get_attribute("cy"))
    points = re.findall(r"[ML]([\d.]+) ([\d.]+)", line.get_attribute("d"))
    assert points and (x, y) in [(float(a), float(b)) for a, b in points]
    assert y == max(float(b) for _, b in points)
    if check_trace:
        entry = page.evaluate("""expected => performance.getEntriesByType("measure")
            .filter(entry=>entry.name.startsWith("MG Canvas long frame "))
            .find(entry=>Math.abs((entry.detail.gapMs??0)-expected)<.2)?.detail""", milliseconds)
        assert entry and entry["current"]["phase"] == "pan" and entry["queuedMs"] >= 745, entry
        print(json.dumps({"recorded_stall": entry}), flush=True)
    if screenshot:
        page.screenshot(path=screenshot)
    page.evaluate(GESTURE, {"kind": "pan", "count": 24})
    page.wait_for_function("(x) => +document.querySelector('#frame-meter-low').getAttribute('cx') < x", arg=x)
    expect(minimum).to_have_text(f"{fps:.1f} FPS · {milliseconds:.1f} ms")
    expect(state).to_have_text("空闲")
    expect(minimum).to_have_text(f"{fps:.1f} FPS · {milliseconds:.1f} ms")
    page.evaluate("""() => {
        Object.defineProperty(document,"hidden",{configurable:true,value:true});
        document.dispatchEvent(new Event("visibilitychange"));
    }""")
    expect(state).to_have_text("后台暂停")
    page.wait_for_timeout(800)
    page.evaluate("""() => {
        delete document.hidden;
        document.dispatchEvent(new Event("visibilitychange"));
    }""")
    expect(state).to_have_text("空闲")
    page.evaluate(GESTURE, {"kind": "pan", "count": 24})
    expect(state).to_have_text("实时")
    recovered = float(MINIMUM.fullmatch(minimum.inner_text()).group(2))
    assert recovered < 650, recovered
    print(json.dumps({"single_stall_ms": milliseconds, "minimum_fps": fps, "recovered_ms": recovered}), flush=True)

def check_cap(page):
    control = page.locator("#frame-rate")
    assert control.locator("option").evaluate_all("nodes => nodes.map(n => n.value)") == [
        "30", "60", "120", "140", "170", "unlimited"
    ]
    expect(control).to_have_value("unlimited")
    for value in ("30", "60", "120", "140", "170", "unlimited"):
        control.select_option(value)
        assert page.evaluate("localStorage.getItem('mg-canvas:workspace-frame-rate')") == value
        page.evaluate(GESTURE, {"kind": "pan", "count": 16})
        page.evaluate("() => window.paints=[]")
        page.evaluate(GESTURE, {"kind": "pan", "count": 210})
        paints = page.evaluate("window.paints")
        fps = (len(paints)-1)*1000/(paints[-1]["at"]-paints[0]["at"])
        if value != "unlimited":
            assert fps <= int(value)*1.03, (value, fps)
            expect(page.locator("#frame-meter-budget")).to_have_attribute("visibility", "visible")
        else:
            expect(page.locator("#frame-meter-budget")).to_have_attribute("visibility", "hidden")
        print(json.dumps({"cap": value, "presented_updates_per_second": round(fps, 1)}), flush=True)
    control.select_option("30")
    page.evaluate(GESTURE, {"kind": "pan", "count": 45})
    page.wait_for_timeout(440)
    page.evaluate(GESTURE, {"kind": "pan", "count": 45})
    minimum = page.locator("#frame-meter-min")
    expect(minimum).to_have_text(MINIMUM)
    assert float(MINIMUM.fullmatch(minimum.inner_text()).group(2)) < 250
    page.evaluate(GESTURE, {"kind": "pan", "count": 82, "stall": 441, "stallAt": 60})
    expect(page.locator("#frame-meter-low")).to_have_attribute("data-late", "true")
    gap = float(MINIMUM.fullmatch(minimum.inner_text()).group(2))
    assert gap >= 430
    print(json.dumps({"cap": "30", "injected_pause_ms": 441, "longest_queued_frame_ms": gap}), flush=True)
    control.select_option("140")
    page.reload()
    expect(control).to_have_value("140")

def check_camera(page):
    board = page.locator("#canvas")
    page.wait_for_timeout(200)
    exact = board.evaluate("c => c.toDataURL()")
    page.evaluate("""async () => {
        window.paints=[];window.cacheStrips=0;window.cacheBuilds=0;
        const canvas=document.querySelector("#canvas"),box=canvas.getBoundingClientRect();
        const fire=(x,y,zoom)=>canvas.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,
          deltaX:x,deltaY:y,ctrlKey:zoom,clientX:box.x+box.width/2,clientY:box.y+box.height/2}));
        for(const direction of [1,-1]) for(let i=0;i<12;i++){
          fire(direction*95.25,direction*30.25,false);await new Promise(requestAnimationFrame);
        }
    }""")
    strips = page.evaluate("window.cacheStrips")
    assert strips > 0, strips
    page.wait_for_timeout(200)
    assert exact == board.evaluate("c => c.toDataURL()"), "exact paint after reversed fast pan changed pixels"
    page.evaluate("""async () => {
        window.cacheBuilds=0;
        const canvas=document.querySelector("#canvas"),box=canvas.getBoundingClientRect();
        for(const direction of [-1,1]) for(let i=0;i<12;i++){
          canvas.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:true,
            deltaY:direction*76,clientX:box.x+box.width/2,clientY:box.y+box.height/2}));
          await new Promise(requestAnimationFrame);
        }
    }""")
    rebuilds = page.evaluate("window.cacheBuilds")
    assert 1 < rebuilds < 18, rebuilds
    expect(page.locator("#zoom-read")).to_have_text("5%")
    expect(page.locator("#undo")).to_be_disabled()
    expect(page.locator("#status")).to_have_attribute("data-workspace", "saved")
    print(json.dumps({"fast_pan_uncovered_strips": strips,"zoom_cache_rebuilds": rebuilds}), flush=True)


def sequence(page, label, profiler=None):
    result = []
    # Force a cold camera cache once without changing the board or its final appearance.
    page.locator("#theme-dark").check()
    page.wait_for_timeout(60)
    page.locator("#theme-light").check()
    for action in ("pan", "zoom", "drag-single", "drag-multi"):
        page.wait_for_timeout(720)
        page.evaluate("""() => {
            window.paints=[];window.overviewTrace=[];
            for(const entry of performance.getEntriesByType("measure")){
                if(entry.name.startsWith("MG Canvas long frame "))performance.clearMeasures(entry.name);
            }
        }""")
        if action.startswith("drag"):
            origin = page.locator("#canvas").bounding_box()
            probes = page.evaluate("window.probes")
            first, second = [[origin["x"] + p[0], origin["y"] + p[1]] for p in
                             [probes["#d40ad4"], probes["#a60eb8"]]]
            page.mouse.click(*first)
            if action == "drag-multi":
                page.keyboard.down("Shift")
                page.mouse.click(*second)
                page.keyboard.up("Shift")
            page.wait_for_timeout(180)
            page.mouse.move(*first)
            page.mouse.down()
            page.evaluate("() => {window.paints=[];window.overviewTrace=[];}")
            page.evaluate(GESTURE, {"kind": action, "count": 80})
            assert page.evaluate("window.probes")["#d40ad4"] != probes["#d40ad4"], action
            frames = page.evaluate("window.overviewTrace")
            page.keyboard.press("Escape")
            page.mouse.up()
            page.mouse.click(20, 300)
        else:
            if profiler and action == "zoom":
                profiler.send("Profiler.start")
            page.evaluate("""async kind => {
                const canvas=document.querySelector("#canvas"),b=canvas.getBoundingClientRect();
                const step=()=>new Promise(requestAnimationFrame);
                for(let i=0;i<4;i++)await step();
                for(let j=0;j<4;j++)for(const sign of [1,-1])for(let i=0;i<10;i++){
                    canvas.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:kind==="zoom",
                      clientX:b.left+b.width*.48,clientY:b.top+b.height*.43,
                      deltaX:kind==="pan"?sign*96.25:0,deltaY:kind==="zoom"?-sign*88:sign*27.75}));
                    await step();
                }
            }""", action)
            if profiler and action == "zoom":
                profile = profiler.send("Profiler.stop")["profile"]
                nodes = sorted(profile["nodes"], key=lambda n: n.get("hitCount", 0), reverse=True)
                print(json.dumps({"zoom_cpu_samples": [(n["callFrame"]["functionName"], n["hitCount"])
                                                       for n in nodes[:18] if n.get("hitCount")]}), flush=True)
            frames = page.evaluate("window.overviewTrace")
        page.wait_for_timeout(240)
        settled = page.evaluate("window.overviewTrace.slice(" + str(len(frames)) + ")")
        timeline = page.evaluate("""() => performance.getEntriesByType("measure")
            .filter(entry=>entry.name.startsWith("MG Canvas long frame "))
            .map(entry=>({...entry.toJSON(),detail:entry.detail}))""")
        assert len(frames) >= 60, (action, len(frames))
        gap_index = max(range(1, len(frames)), key=lambda i: frames[i]["at"] - frames[i-1]["at"])
        gap = frames[gap_index]["at"] - frames[gap_index-1]["at"]
        record = {"build": label, "phase": action, "max_ms": round(gap, 1), "lowest_fps": round(1000/gap, 1),
                  "full_view_paints": sum(f["kind"] == "full" for f in frames),
                  "first": frames[0], "before_slowest_gap": frames[gap_index-1], "after_slowest_gap": frames[gap_index],
                  "slowest_callback": max(frames, key=lambda f:f["work"]),
                  "settled_callbacks": settled, "meter": page.locator("#frame-meter-min").inner_text(),
                  "frame_timing": timeline, "frames": frames}
        result.append(record)
        print(json.dumps({k: v for k, v in record.items() if k not in ("frames", "frame_timing")}), flush=True)
    return result


def ink_at_full_detail(page):
    page.evaluate("""async () => {
        const canvas=document.querySelector("#canvas"),r=canvas.getBoundingClientRect();
        for(let i=0;i<3;i++){
            canvas.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-400,
                clientX:r.left+r.width*.48,clientY:r.top+r.height*.43}));
            await new Promise(requestAnimationFrame);
        }
    }""")
    expect(page.locator("#zoom-read")).to_have_text("100%")
    page.wait_for_timeout(240)
    data = page.locator("#canvas").evaluate("canvas => canvas.toDataURL()")
    return hashlib.sha256(data.encode()).hexdigest()


def observe_refresh(page):
    timing = page.evaluate("""async () => {
        const next=()=>new Promise(requestAnimationFrame),intervals=[];
        let previous=await next();
        for(let i=0;i<90;i++){const at=await next();intervals.push(at-previous);previous=at;}
        return {intervals,screen:[screen.width,screen.height],window:[window.screenX,window.screenY],
                visibility:document.visibilityState};
    }""")
    periods = timing.pop("intervals")
    print(json.dumps({"browser_display": timing, "idle_raf_hz": round(1000/statistics.median(periods), 1),
                      "idle_raf_mean_hz": round(1000*len(periods)/sum(periods), 1)}), flush=True)


def measure(page, label, action, count):
    drag = action.startswith("drag")
    if drag:
        page.wait_for_timeout(200)
        page.wait_for_function("() => probes['#d40ad4'] && probes['#a60eb8']")
        origin = page.locator("#canvas").bounding_box()
        probes = page.evaluate("window.probes")
        first, second = [[origin["x"] + p[0], origin["y"] + p[1]] for p in
                         [probes["#d40ad4"], probes["#a60eb8"]]]
        page.mouse.click(*first)
        if action == "drag-multi":
            page.keyboard.down("Shift")
            page.mouse.click(*second)
            page.keyboard.up("Shift")
        page.wait_for_timeout(180)
        page.mouse.move(*first)
        page.mouse.down()
    else:
        page.evaluate(GESTURE, {"kind": action, "count": 16})
    page.evaluate("() => { window.paints=[];window.cacheBuilds=0; }")
    page.evaluate(GESTURE, {"kind": action, "count": count})
    paints, builds = page.evaluate("() => [window.paints,window.cacheBuilds]")
    if drag:
        assert page.evaluate("window.probes")["#d40ad4"] != probes["#d40ad4"], action
    if drag:
        page.keyboard.press("Escape")
        page.mouse.up()
        page.mouse.click(20, 300)
    assert len(paints) >= count // 2, (action, len(paints)) if not drag else (action, paints)
    intervals = [b["at"] - a["at"] for a, b in zip(paints, paints[1:])]
    ordered = sorted(intervals)
    return {
        "build": label, "gesture": action, "samples": len(ordered),
        "fps": round(len(ordered) * 1000 / sum(ordered), 1),
        "p95_ms": round(ordered[(95 * len(ordered) + 99) // 100 - 1], 1),
        "p99_ms": round(ordered[(99 * len(ordered) + 99) // 100 - 1], 1),
        "max_ms": round(max(ordered), 1),
        "lowest_fps": round(1000 / max(ordered), 1),
        "slow_over_25ms": sum(ms > 25 for ms in ordered),
        "full_view_paints": sum(p["kind"] == "full" for p in paints),
        "damage_paints": sum(p["kind"] == "damage" for p in paints),
        "bitmap_frames": sum(p["kind"] == "bitmap" for p in paints),
        "overscan_builds": builds,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("previews", type=Path, nargs="+")
    parser.add_argument("--frames", type=int, default=96)
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--profile", action="store_true")
    parser.add_argument("--hide-meter", action="store_true")
    parser.add_argument("--check-stall", action="store_true")
    parser.add_argument("--check-trace", action="store_true")
    parser.add_argument("--compare-ink-pixels", action="store_true")
    parser.add_argument("--screenshot", type=Path)
    parser.add_argument("--drag", action="store_true")
    parser.add_argument("--check-cap", action="store_true")
    parser.add_argument("--check-camera", action="store_true")
    parser.add_argument("--sequence", type=Path, help="Record naturally timed gestures and settle frames as JSON.")
    parser.add_argument("--headed", action="store_true", help="Use a visible Chrome window on the primary display.")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    board = subprocess.check_output(["node", "--input-type=module", "-e", FIXTURE], cwd=root)
    document = json.loads(board)["document"]
    print(json.dumps({"objects": len(document["order"]), "viewport": [1280, 800], "dpr": 1}), flush=True)
    launch_args = ["--window-position=60,70", "--window-size=1450,990"] if args.headed else []
    with sync_playwright() as pw, pw.chromium.launch(channel="chrome", headless=not args.headed, args=launch_args) as browser:
        timelines = []
        pixel_hashes = set()
        for run in range(args.runs):
            for preview in args.previews[::1 if run % 2 == 0 else -1]:
                with browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=1) as context:
                    page = context.new_page()
                    page.add_init_script("(" + TRACE + ")()")
                    page.goto(preview.resolve().as_uri())
                    expect(page.locator("#layers .layer").first).to_be_attached()
                    page.locator("#project-picker").set_input_files({
                        "name": "overview-benchmark.mgcanvas", "mimeType": "application/json", "buffer": board
                    })
                    expect(page.locator("#status")).to_contain_text("项目已打开", timeout=30000)
                    expect(page.locator("#status")).to_have_attribute("data-workspace", "saved", timeout=30000)
                    page.locator("#fit").click()
                    page.evaluate("""async () => {
                        const c=document.querySelector("#canvas"),r=c.getBoundingClientRect();
                        for(let i=0;i<7;i++) c.dispatchEvent(new WheelEvent("wheel",{
                          bubbles:true,cancelable:true,ctrlKey:true,deltaY:500,
                          clientX:r.left+r.width/2,clientY:r.top+r.height/2
                        }));
                        for(let i=0;i<12;i++) await new Promise(requestAnimationFrame);
                    }""")
                    expect(page.locator("#zoom-read")).to_have_text("5%")
                    if args.headed:
                        page.bring_to_front()
                        page.wait_for_timeout(720)
                        observe_refresh(page)
                    if args.hide_meter:
                        page.locator("#frame-meter").evaluate("meter => meter.hidden = true")
                    if args.compare_ink_pixels:
                        digest = ink_at_full_detail(page)
                        pixel_hashes.add(digest)
                        print(json.dumps({"build": preview.name, "full_detail_canvas_sha256": digest}), flush=True)
                        continue
                    if args.sequence:
                        profiler = context.new_cdp_session(page) if args.profile else None
                        if profiler:
                            profiler.send("Profiler.enable")
                        timelines.extend(sequence(page, preview.name, profiler))
                        continue
                    profiler = context.new_cdp_session(page) if args.profile else None
                    if profiler:
                        profiler.send("Profiler.enable")
                        profiler.send("Profiler.start")
                    for kind in ("pan", "zoom", "drag-single", "drag-multi") if args.drag else ("pan", "zoom"):
                        print(json.dumps({"run": run + 1, "meter_hidden": args.hide_meter,
                                          **measure(page, preview.name, kind, args.frames)}), flush=True)
                    if profiler:
                        profile = profiler.send("Profiler.stop")["profile"]
                        frames = sorted(profile["nodes"], key=lambda n: n.get("hitCount", 0), reverse=True)
                        print(json.dumps({"samples": [(n["callFrame"]["functionName"], n["hitCount"])
                                                     for n in frames[:15] if n.get("hitCount")]}), flush=True)
                    meter = page.locator("#frame-meter")
                    if meter.count() and not args.hide_meter:
                        assert meter.evaluate("meter => getComputedStyle(meter).pointerEvents") == "none"
                        if page.locator("#frame-meter-min").count():
                            expect(page.locator("#frame-meter-min")).to_have_text(MINIMUM)
                            expect(page.locator("#frame-meter-state")).to_have_text("空闲")
                    if args.check_stall:
                        check_stall(page, args.screenshot, args.check_trace)
                    if args.check_camera:
                        check_camera(page)
                    if args.check_cap:
                        check_cap(page)
        if args.sequence:
            args.sequence.write_text(json.dumps(timelines, ensure_ascii=False, indent=2), encoding="utf8")
        if args.compare_ink_pixels:
            assert len(pixel_hashes) == 1, pixel_hashes


if __name__ == "__main__":
    main()
