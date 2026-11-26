"""Trace tagged PNGs through a real Windows clipboard, MG import, save, and display.

Run on Windows after npm run build. Requires Pillow with LittleCMS, playwright,
pywin32, and installed Chrome. A temporary desktop on a noninteractive window
station keeps all clipboard I/O separate from the user's interactive desktop.
"""
import argparse
import base64
import ctypes as C
import ctypes.util
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

from PIL import Image, ImageCms, ImageDraw


SIZE = (128, 96)
COLORS = [(190, 90, 70, 255), (70, 170, 125, 255), (60, 125, 195, 255), (225, 142, 45, 255),
          (255, 50, 15, 255), (10, 235, 72, 255), (120, 120, 120, 255), (240, 240, 240, 255),
          (190, 90, 70, 128), (60, 125, 195, 64), (199, 102, 49, 0), (32, 182, 108, 224)]
POINTS = [(i % 4 * 32 + 14, i // 4 * 32 + 17) for i in range(len(COLORS))]


def profile_bytes():
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    lib = C.CDLL(ctypes.util.find_library("lcms2"))
    class XY(C.Structure):
        _fields_ = [("x", C.c_double), ("y", C.c_double), ("Y", C.c_double)]
    class Primaries(C.Structure):
        _fields_ = [("red", XY), ("green", XY), ("blue", XY)]
    ptr, uint = C.c_void_p, C.c_uint32
    def api(name, ret, *args):
        fn = getattr(lib, name)
        fn.restype, fn.argtypes = ret, args
        return fn
    create_srgb = api("cmsCreate_sRGBProfile", ptr)
    tag = api("cmsReadTag", ptr, ptr, uint)
    create_rgb = api("cmsCreateRGBProfile", ptr, C.POINTER(XY), C.POINTER(Primaries), C.POINTER(ptr))
    save = api("cmsSaveProfileToMem", C.c_int, ptr, ptr, C.POINTER(uint))
    close = api("cmsCloseProfile", C.c_int, ptr)
    ref = create_srgb()
    curve = tag(ref, int.from_bytes(b"rTRC", "big"))
    p3 = create_rgb(C.byref(XY(.3127, .3290, 1)),
                    C.byref(Primaries(XY(.68, .32, 1), XY(.265, .69, 1), XY(.15, .06, 1))),
                    (ptr * 3)(curve, curve, curve))
    try:
        size = uint()
        assert p3 and save(p3, None, C.byref(size))
        buf = C.create_string_buffer(size.value)
        assert save(p3, buf, C.byref(size))
        return {"sRGB": srgb, "Display-P3": buf.raw}
    finally:
        close(p3)
        close(ref)


def chart(icc):
    im = Image.new("RGBA", SIZE)
    draw = ImageDraw.Draw(im)
    for i, color in enumerate(COLORS):
        x, y = i % 4 * 32, i // 4 * 32
        draw.rectangle((x, y, x + 31, y + 31), fill=color)
    out = io.BytesIO()
    im.save(out, "PNG", icc_profile=icc)
    return out.getvalue()


def inspect(data):
    im = Image.open(io.BytesIO(data))
    raw = im.convert("RGBA")
    icc = im.info.get("icc_profile")
    managed = raw.convert("RGB")
    if icc:
        managed = ImageCms.profileToProfile(managed, ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                                            ImageCms.createProfile("sRGB"), renderingIntent=1)
    return {"sha256": hashlib.sha256(data).hexdigest(),
            "iccSha256": hashlib.sha256(icc).hexdigest() if icc else None,
            "rgba": [raw.getpixel(p) for p in POINTS],
            "sRGB": [managed.getpixel(p) for p in POINTS]}


def user32():
    lib = C.WinDLL("user32", use_last_error=True)
    for name, ret, args in [
        ("CreateWindowStationW", C.c_void_p, [C.c_wchar_p, C.c_ulong, C.c_ulong, C.c_void_p]),
        ("GetProcessWindowStation", C.c_void_p, []),
        ("GetClipboardOwner", C.c_void_p, []),
        ("SetProcessWindowStation", C.c_bool, [C.c_void_p]),
        ("CreateDesktopW", C.c_void_p, [C.c_wchar_p, C.c_void_p, C.c_void_p, C.c_ulong, C.c_ulong, C.c_void_p]),
        ("GetUserObjectInformationW", C.c_bool, [C.c_void_p, C.c_int, C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong)]),
        ("CloseDesktop", C.c_bool, [C.c_void_p]), ("CloseWindowStation", C.c_bool, [C.c_void_p])
    ]:
        fn = getattr(lib, name)
        fn.argtypes, fn.restype = args, ret
    return lib


def station_name():
    lib = user32()
    buf = C.create_unicode_buffer(256)
    needed = C.c_ulong()
    if not lib.GetUserObjectInformationW(lib.GetProcessWindowStation(), 2, buf, C.sizeof(buf), C.byref(needed)):
        raise C.WinError(C.get_last_error())
    return buf.value


def private_station():
    lib = user32()
    desktop_name = "MGColorQA_" + uuid.uuid4().hex
    original = lib.GetProcessWindowStation()
    # Windows supplies the logon's noninteractive station. Allocate a new private desktop
    # there and require an empty clipboard before use, including on a reused station.
    station = lib.CreateWindowStationW(None, 0, 0x02000000, None)
    if not station:
        raise OSError(C.get_last_error(), "CreateWindowStationW")
    if not lib.SetProcessWindowStation(station):
        raise OSError(C.get_last_error(), "SetProcessWindowStation")
    try:
        name = station_name()
        if not (name.lower().startswith("service-") and name.endswith("$")):
            raise RuntimeError("Windows did not provide a noninteractive test station")
        desktop = lib.CreateDesktopW(desktop_name, None, None, 0, 0x02000000, None)
        if not desktop:
            raise C.WinError(C.get_last_error())
    finally:
        if not lib.SetProcessWindowStation(original):
            raise C.WinError(C.get_last_error())
    try:
        import win32event, win32process
        start = win32process.STARTUPINFO()
        start.lpDesktop = name + "\\" + desktop_name
        command = [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--station", name]
        proc, thread, _, _ = win32process.CreateProcess(sys.executable, subprocess.list2cmdline(command),
            None, None, True, 0, None, None, start)
        try:
            win32event.WaitForSingleObject(proc, win32event.INFINITE)
            if win32process.GetExitCodeProcess(proc):
                raise RuntimeError("Test worker failed on the noninteractive desktop")
        finally:
            proc.Close()
            thread.Close()
    finally:
        lib.CloseDesktop(desktop)
        lib.CloseWindowStation(station)


def seed_clipboard(name, owner, data, first, dib_only=False):
    import win32clipboard as cb
    import win32con
    # Fail closed before accessing the clipboard. Never replace the interactive desktop's clipboard.
    if not (name.lower().startswith("service-") and name.endswith("$") and station_name()==name):
        raise RuntimeError("Refusing to write a clipboard outside the noninteractive test station")
    cf = cb.RegisterClipboardFormat("PNG")
    cb.OpenClipboard(owner)
    try:
        if first:
            lib = user32()
            C.set_last_error(0)
            if lib.CountClipboardFormats() or C.get_last_error():
                raise RuntimeError("Test station clipboard already occupied")
        elif user32().GetClipboardOwner()!=owner:
            raise RuntimeError("Another process used the test station")
        cb.EmptyClipboard()
        im = Image.open(io.BytesIO(data)).convert("RGBA")
        flat = Image.new("RGB", im.size, "white")
        flat.paste(im, mask=im.getchannel("A"))
        buf = io.BytesIO()
        flat.save(buf, "BMP")
        dib = buf.getvalue()[14:]
        cb.SetClipboardData(win32con.CF_DIB, dib)
        assert cb.GetClipboardData(win32con.CF_DIB) == dib
        if dib_only:
            return {"format": "CF_DIB (24-bit, white matte, profile absent)",
                    "sha256": hashlib.sha256(dib).hexdigest(), "rgb": [flat.getpixel(p) for p in POINTS]}
        cb.SetClipboardData(cf, data)
        assert cb.GetClipboardData(cf) == data
        return {"format": "PNG + CF_DIB", "sha256": hashlib.sha256(data).hexdigest(),
                "fallbackDibSha256": hashlib.sha256(dib).hexdigest()}
    finally:
        cb.CloseClipboard()


PROBE = """{
  const original=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(img,...args){
    const result=original.call(this,img,...args);
    if(this.canvas.id==='canvas'&&img.width===128&&img.height===96&&args.length===4){
      const m=this.getTransform();window.box=[m.a,m.b,m.c,m.d,m.e,m.f,...args];
    }
    return result;
  };
  window.bytes64=async blob=>{const bytes=new Uint8Array(await blob.arrayBuffer());
    return btoa(Array.from(bytes,c=>String.fromCharCode(c)).join(''));};
  document.addEventListener('paste',async e=>{
    window.pasteInfo={trusted:e.isTrusted,types:e.clipboardData.types,target:e.target.id};
    const f=Array.from(e.clipboardData.files).find(f=>f.type==='image/png')||
      Array.from(e.clipboardData.items).find(i=>i.type==='image/png')?.getAsFile();
    if(e.isTrusted&&f)window.delivered=await bytes64(f);
  },true);
}"""


def run(opts):
    from playwright.sync_api import sync_playwright, expect
    import win32api, win32clipboard, win32gui, win32service
    actual = station_name()
    if not(actual==opts.station and actual.lower().startswith("service-") and actual.endswith("$")):
        raise RuntimeError("Test worker did not start in a noninteractive station")
    profiles = profile_bytes()
    report = {"cases": []}
    points = lambda page, xy: page.locator("#canvas").evaluate(
        "(c,pts)=>pts.map(([x,y])=>Array.from(c.getContext('2d').getImageData(x,y,1,1).data).slice(0,3))", xy)
    with tempfile.TemporaryDirectory(prefix="mg-color-chrome-") as profile, sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(profile,channel=opts.channel,headless=False,chromium_sandbox=True,
            args=["--disable-background-networking", "--force-color-profile=srgb"],
            viewport={"width":1100,"height":780},device_scale_factor=1,reduced_motion="reduce",
            accept_downloads=True,permissions=["clipboard-read","clipboard-write"])
        report["browser"] = ctx.browser.version
        url = "http://127.0.0.1/image-color-test"
        ctx.route(url, lambda r: r.fulfill(path=opts.preview, content_type="text/html; charset=utf-8"))
        ctx.add_init_script(PROBE)
        p = ctx.new_page()
        first = True
        owner = win32gui.CreateWindowEx(0,"Static","MG sample clipboard",0,0,0,0,0,0,0,0,None)
        try:
            p.set_default_timeout(9000)
            p.on("dialog", lambda d: d.accept())
            p.goto(url)
            p.bring_to_front()
            ctx.new_cdp_session(p).send("Emulation.setFocusEmulationEnabled", {"enabled":True})
            desktop = win32service.GetThreadDesktop(win32api.GetCurrentThreadId())
            windows = desktop.EnumDesktopWindows()
            if not any(win32gui.GetClassName(w).startswith("Chrome_WidgetWin") for w in windows):
                raise RuntimeError("Browser outside test desktop")
            canvas = p.locator("#canvas")
            samples = {label:chart(icc) for label,icc in profiles.items()}
            shot = ctx.new_page()
            shot.set_content('<style>*{box-sizing:border-box}body{margin:0;display:grid;grid-template-columns:repeat(4,32px)}'
                'b{width:32px;height:32px;border-radius:7px;font:8px system-ui;color:white}</style>' +
                ''.join(f'<b style="background:rgba({r},{g},{b},{a/255})">{i+1}</b>' for i,(r,g,b,a) in enumerate(COLORS)))
            samples["transparent-screenshot"] = shot.screenshot(omit_background=True,clip={"x":0,"y":0,"width":128,"height":96})
            shot.close()
            p.bring_to_front()
            for label,data in samples.items():
                if opts.samples:
                    opts.samples.mkdir(parents=True,exist_ok=True)
                    (opts.samples/(label+".png")).write_bytes(data)
                for route in ("file", "png", "dib"):
                    doc = {"schemaVersion":1, "id":"test-" + route, "theme":"paper", "assets":{}, "order":[], "objects":{}}
                    def load(pkg):
                        p.locator("#project-picker").set_input_files({"name":"qa.mgcanvas", "mimeType":"application/json",
                                                                    "buffer":json.dumps(pkg).encode()})
                        expect(p.locator("#status")).to_contain_text("项目已打开")
                    def save():
                        with p.expect_download() as dl:
                            p.locator("#project-export").click()
                        return json.loads(Path(dl.value.path()).read_bytes())
                    def settle():
                        p.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")
                    load(doc)
                    expect(p.locator("#layers .layer")).to_have_count(0)
                    if p.locator("#layers-panel").is_visible():
                        p.locator("#close-layers").click()
                    p.locator("#fit").click()
                    expect(p.locator("#zoom-read")).to_have_text("100%")
                    p.evaluate("window.delivered=window.box=null")
                    native = None
                    if route == "file":
                        p.locator("#image-picker").set_input_files({"name":"chart.png", "mimeType":"image/png", "buffer":data})
                        delivered = data
                    else:
                        native = seed_clipboard(opts.station, owner, data, first, route == "dib")
                        first = False
                        canvas.focus()
                        canvas.hover(position={"x":file_origin[0],"y":file_origin[1]})
                        p.keyboard.press("Control+v")
                        try:
                            p.wait_for_function("window.delivered")
                        except Exception:
                            print("Clipboard diagnostics",p.evaluate("""async()=>[document.hasFocus(),document.activeElement.id,
                              window.pasteInfo, await navigator.clipboard.read().then(a=>a.map(i=>i.types)).catch(e=>String(e))]"""),flush=True)
                            raise
                        delivered = base64.b64decode(p.evaluate("window.delivered"))
                    p.wait_for_function("window.box")
                    canvas.click(position={"x":18, "y":145})
                    p.mouse.move(0,0)
                    settle()
                    expect(p.locator('#layers .layer[aria-pressed=true]')).to_have_count(0)
                    pkg = save()
                    item = next(iter(pkg["document"]["objects"].values()))
                    embedded = base64.b64decode(pkg["assets"][item["assetId"]])
                    assert delivered == embedded
                    src, got = inspect(data), inspect(delivered)
                    if route == "png":
                        assert delivered == data, "Registered PNG was discarded in favor of its untagged bitmap fallback"
                    if route == "dib":
                        assert [list(c[:3]) for c in got["rgba"]]==[list(c) for c in native["rgb"]]
                        assert all(c[3]==255 for c in got["rgba"])
                    row = {"profile":label, "route":route, "source":src, "clipboard":native, "received":got,
                           "projectSha256":hashlib.sha256(embedded).hexdigest(), "themes":{}}
                    a,b,c,d,tx,ty,x,y,w,h = p.evaluate("window.box")
                    assert (a,b,c,d,x,y,w,h)==(1,0,0,1,0,0,*SIZE), (route, p.evaluate("window.box"))
                    if route=="file":
                        file_origin=[tx,ty]
                    assert [tx,ty]==file_origin, (route,[tx,ty],file_origin)
                    row["deviceOrigin"]=[tx,ty]
                    xy = [[math.floor(tx+px), math.floor(ty+py)] for px,py in POINTS]
                    for theme in ("light","dark"):
                        p.locator("#theme-"+theme).check()
                        settle()
                        rgb = points(p,xy)
                        image = Image.open(io.BytesIO(canvas.screenshot())).convert("RGB")
                        screen = [list(image.getpixel(tuple(pt))) for pt in xy]
                        assert screen == rgb, (theme, rgb, screen)
                        row["themes"][theme] = {"canvas":rgb, "screenshot":screen}
                    p.locator("#theme-light").check()
                    settle()
                    row["lightAfterThemeRoundTrip"]=points(p,xy)
                    load(doc)
                    expect(p.locator("#layers .layer")).to_have_count(0)
                    for theme, values in row["themes"].items():
                        p.locator("#theme-"+theme).check()
                        settle()
                        bg = points(p,xy)
                        expected = [[round((ch*rgba[3]+back*(255-rgba[3]))/255) for ch,back in zip(rgb,bgp)]
                                    for rgb,rgba,bgp in zip(got["sRGB"],got["rgba"],bg)]
                        delta = [max(abs(a-b) for a,b in zip(pixel,ref)) for pixel,ref in zip(values["canvas"],expected)]
                        assert max(delta)<=2, (label,route,theme,delta)
                        values.update({"backdrop":bg,"reference":expected,"maxChannelErrors":delta})
                    if route=="file":
                        file_themes=row["themes"]
                    if route=="png":
                        for theme,values in row["themes"].items():
                            pairwise=[max(abs(a-b) for a,b in zip(pixel,ref)) for pixel,ref in zip(
                                values["canvas"],file_themes[theme]["canvas"])]
                            values["differenceFromFile"]=pairwise
                            assert all(v==0 if rgba[3]==255 else v<=1 for rgba,v in zip(got["rgba"],pairwise)), (label,theme,pairwise)
                    load(pkg)
                    expect(p.locator("#layers .layer")).to_have_count(1)
                    assert base64.b64decode(save()["assets"][item["assetId"]]) == embedded
                    report["cases"].append(row)
                    opts.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
                    print(label, route, "source/event/project", src["sha256"][:12],got["sha256"][:12],
                          row["projectSha256"][:12], "max display delta per theme",
                          [max(v["maxChannelErrors"]) for v in row["themes"].values()],flush=True)
        finally:
            win32clipboard.OpenClipboard()
            try:
                if user32().GetClipboardOwner() == owner:
                    win32clipboard.EmptyClipboard()
            finally:
                win32clipboard.CloseClipboard()
            win32gui.DestroyWindow(owner)
            ctx.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--channel", default="chrome")
    parser.add_argument("--samples", type=Path, help="Save the exact test PNGs alongside the trace")
    parser.add_argument("--station", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.station:
        run(args)
    else:
        private_station()
