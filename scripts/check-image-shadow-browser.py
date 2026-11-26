"""Check the image frame against real canvas pixels with the image present and removed."""
import argparse
import base64
import json
import math
from io import BytesIO
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright


def png(image):
    out = BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def fixture(kind):
    if kind != "clear":
        return Image.new("RGBA", (128, 96), "#ffffff" if kind == "white" else "#1b1d23")
    im = Image.new("RGBA", (128, 96))
    im.paste((42, 133, 196, 255), (45, 33, 64, 63))
    im.paste((181, 82, 52, 128), (64, 33, 83, 63))
    return im


def frame(page):
    page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")


def board(page):
    with page.expect_download() as dl:
        page.locator("#project-export").click()
    return json.loads(Path(dl.value.path()).read_bytes())


def load(page, data):
    page.locator("#project-picker").set_input_files({
        "name": "frame.mgcanvas", "mimeType": "application/json", "buffer": json.dumps(data).encode()})
    expect(page.locator("#status")).to_contain_text("项目已打开")
    frame(page)


def picture(page):
    result = page.locator("#canvas").evaluate("c=>c.toDataURL('image/png').split(',')[1]")
    return Image.open(BytesIO(base64.b64decode(result))).convert("RGB")


def check_pixels(painted, base, draw, kind, ratio):
    a,b,c,d,e,f,w,h = draw
    def xy(u,v):
        return math.floor(e+a*w*u+c*h*v), math.floor(f+b*w*u+d*h*v)
    def diff(u,v):
        point = xy(u,v)
        return max(abs(l-r) for l,r in zip(painted.getpixel(point), base.getpixel(point)))
    # Distances from the transformed edge measured in CSS pixels.
    dx,dy = ratio/(math.hypot(a,b)*w),ratio/(math.hypot(c,d)*h)
    near,far = [],[]
    for distance,results in ((1.5,near),(16,far)):
        results.extend(diff(u,v) for u,v in ((-distance*dx,.43),(1+distance*dx,.57),(.33,-distance*dy),(.71,1+distance*dy)))
    assert min(near)>=5 and max(far)==0, (kind,draw,near,far)
    # The halo is outside the rotated box and fades, including at its corners.
    assert diff(-dx,-dy)>1 and diff(-8*dx,-8*dy)==0, (kind,draw)
    if kind=="clear":
        samples=[(.01,.48),(.98,.6),(.45,.02),(.65,.98),(.31,.5),(.68,.5),(.4,.29),(.4,.72)]
        assert all(diff(u,v)==0 for u,v in samples), (kind,draw)
        assert painted.getpixel(xy(.42,.5))==(42,133,196)
        pt=xy(.58,.51)
        expected=[round((s*128+t*127)/255) for s,t in zip((181,82,52),base.getpixel(pt))]
        assert max(abs(x-y) for x,y in zip(expected,painted.getpixel(pt)))<=1
    else:
        expected=(255,255,255) if kind=="white" else (27,29,35)
        for point in ((.04,.43),(.51,.5),(.94,.66)):
            assert painted.getpixel(xy(*point))==base.getpixel(xy(*point))==expected
    return near


def run(browser, preview, seed_clipboard=None, output=None, routes=((1,"file"),(2,"paste"))):
    cases=[]
    proto = json.loads((Path(__file__).resolve().parents[1]/"docs/fixtures/M5X-Flow-Groups.mgcanvas").read_bytes())["document"]
    template = next(x for x in proto["objects"].values() if x["kind"]=="shape" and x["shape"]=="rect")
    errors=[]
    for ratio,entry in routes:
        ctx=browser.new_context(viewport={"width":1180,"height":820},device_scale_factor=ratio,permissions=["clipboard-read","clipboard-write"])
        url="http://127.0.0.1/mg-image-frame"
        ctx.route(url,lambda r:r.fulfill(path=preview,content_type="text/html; charset=utf-8"))
        ctx.add_init_script("""{
          const draw=CanvasRenderingContext2D.prototype.drawImage;
          CanvasRenderingContext2D.prototype.drawImage=function(img,...args){
            const result=draw.call(this,img,...args);
            if(this.canvas.id==='canvas'&&img instanceof ImageBitmap&&img.width===128&&img.height===96){
              const m=this.getTransform();window.frameBox=[m.a,m.b,m.c,m.d,m.e,m.f,args[2],args[3]];
            }
            return result;
          };
          document.addEventListener('paste',e=>{
            if(!e.isTrusted)return;
            const f=Array.from(e.clipboardData.files).find(f=>f.type==='image/png');
            if(f)f.arrayBuffer().then(b=>window.received=btoa(String.fromCharCode(...new Uint8Array(b))));
          },true);
        }""")
        p=ctx.new_page();p.set_default_timeout(6500);p.on("dialog",lambda d:d.accept());p.on("pageerror",lambda err:errors.append(str(err)))
        p.goto(url);p.bring_to_front()
        canvas=p.locator("#canvas")
        for kind in ("white","dark","clear"):
            im=fixture(kind);data=png(im)
            load(p,{"schemaVersion":1,"id":kind,"theme":"paper","order":[],"objects":{},"assets":{}})
            expect(p.locator("#layers .layer")).to_have_count(0)
            if p.locator("#layers-panel").is_visible():p.locator("#close-layers").click()
            p.evaluate("window.received=window.frameBox=null")
            if entry=="file":
                with p.expect_file_chooser() as choose:p.locator("#tool-image").click()
                choose.value.set_files({"name":kind+".png","mimeType":"image/png","buffer":data})
                delivered=data
            else:
                if seed_clipboard:seed_clipboard(data,im)
                else:
                    p.evaluate("""async b=>navigator.clipboard.write([new ClipboardItem({'image/png':new Blob(
                      [Uint8Array.from(atob(b),c=>c.charCodeAt(0))],{type:'image/png'})})])""", base64.b64encode(data).decode())
                canvas.hover(position={"x":300,"y":220});canvas.focus();p.keyboard.press("Control+v")
                p.wait_for_function("window.received")
                delivered=base64.b64decode(p.evaluate("received"))
                assert Image.open(BytesIO(delivered)).convert("RGBA").tobytes()==im.tobytes()
            p.wait_for_function("window.frameBox")
            pkg=board(p);doc=pkg["document"];obj=next(iter(doc["objects"].values()));iid=obj["id"]
            assert base64.b64decode(pkg["assets"][obj["assetId"]])==delivered
            obj.update(at={"x":-64,"y":-48})
            fill={"white":"#ffffff","dark":"#1b1d23","clear":"transparent"}[kind]
            under=dict(template,id="paper",shape="rect",at={"x":-250,"y":-150},width=500,height=300,
                       rotation=0,cornerRadius=0,fill=fill,strokeWidth=0,label="")
            doc["objects"]["paper"]=under;doc["order"]=["paper",iid]
            if kind=="clear":
                stripe=dict(under,id="stripe",at={"x":0,"y":-110},width=150,height=220,fill="#537d94")
                doc["objects"]["stripe"]=stripe;doc["order"].insert(1,"stripe")
            load(p,pkg);expect(p.locator('#layers [data-id=paper]')).to_be_attached()
            p.locator("#fit").click()
            for phase in ("original","transformed"):
                if phase=="transformed":
                    a,b,c,d,e,f,w,h=p.evaluate("frameBox");area=canvas.bounding_box()
                    cx=area["x"]+(e+a*w/2+c*h/2)/ratio;cy=area["y"]+(f+b*w/2+d*h/2)/ratio
                    p.mouse.move(cx,cy);p.mouse.down();p.mouse.move(cx+28,cy+16,steps=5);p.mouse.up()
                    p.locator("#text-format-bar").get_by_role("button",name="变换",exact=True).click()
                    for key,value in (("rotation","32"),("width","165")):
                        field=p.locator(f'#inspector [name="{key}"]');field.fill(value);field.press("Enter")
                    p.keyboard.press("Escape");p.locator("#zoom-in").click();frame(p)
                    moved=board(p)["document"]["objects"][iid]
                    assert moved["at"]!=obj["at"] and moved["width"]==165 and abs(moved["rotation"]-math.radians(32))<1e-5
                for theme in (("dark","light") if kind=="clear" else (("light",) if kind=="white" else ("dark",))):
                    p.locator("#theme-"+theme).check()
                    canvas.click(position={"x":12,"y":135});frame(p)
                    expect(p.locator('#layers .layer[aria-pressed=true]')).to_have_count(0)
                    painted=picture(p);matrix=p.evaluate("frameBox")
                    a,b,c,d,e,f,w,h=matrix
                    canvas.click(position={"x":(e+a*w/2+c*h/2)/ratio,"y":(f+b*w/2+d*h/2)/ratio})
                    expect(p.locator(f'#layers [data-id="{iid}"]')).to_have_attribute("aria-pressed","true")
                    frame(p);selected=picture(p)
                    # Corner resize grip contains both its theme accent and its opaque handle fill.
                    accent,handle=((53,102,231),(255,255,255)) if theme=="light" else ((132,167,255),(37,41,56))
                    rx,ry=int(e),int(f);pad=7*ratio
                    detail=set(selected.crop((rx-pad,ry-pad,rx+pad,ry+pad)).getdata())
                    assert accent in detail and handle in detail,(theme,phase,detail)
                    shadow=p.locator("#text-format-bar").get_by_role("checkbox",name="图片阴影")
                    expect(shadow).to_be_checked();shadow.uncheck()
                    canvas.click(position={"x":12,"y":135});frame(p);without=picture(p)
                    canvas.click(position={"x":(e+a*w/2+c*h/2)/ratio,"y":(f+b*w/2+d*h/2)/ratio})
                    canvas.press("Delete");expect(p.locator(f'#layers [data-id="{iid}"]')).to_have_count(0);frame(p)
                    base=picture(p);near=check_pixels(painted,base,matrix,kind,ratio)
                    dx=2*ratio/(math.hypot(a,b)*w)
                    for u,v in [(-dx,.5),(1+dx,.5),(.11,.5),(.42,.5),(.58,.51),(.96,.4)]:
                        xy=math.floor(e+a*w*u+c*h*v),math.floor(f+b*w*u+d*h*v)
                        assert without.getpixel(xy)==(base if u<0 or u>1 else painted).getpixel(xy),(kind,entry,xy)
                    if output and phase=="original":
                        box=(int(e)-18*ratio,int(f)-18*ratio,int(e+a*w)+18*ratio,int(f+d*h)+18*ratio)
                        painted.crop(box).save(output/f"{kind}-{theme}-{entry}.png")
                    canvas.press("Control+z");expect(p.locator(f'#layers [data-id="{iid}"]')).to_be_attached();frame(p)
                    canvas.press("Control+z");frame(p)  # Restore the shadow for the next view.
                    cases.append((kind,entry,theme,phase,near))
            assert base64.b64decode(board(p)["assets"][obj["assetId"]])==delivered
        ctx.close()
    assert not errors,errors
    print("Validated",len(cases),"image frame cases",cases,flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview",type=Path)
    parser.add_argument("--channel",default="chrome")
    parser.add_argument("--screenshots",type=Path)
    args=parser.parse_args()
    if args.screenshots:args.screenshots.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as pw:
        browser=pw.chromium.launch(channel=args.channel,headless=True,chromium_sandbox=True)
        run(browser,args.preview.resolve(),output=args.screenshots)
        browser.close()
