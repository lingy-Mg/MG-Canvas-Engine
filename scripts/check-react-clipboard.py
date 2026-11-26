"""Exercise the editor's clipboard handler without using the host clipboard."""

import json
import math
from pathlib import Path
import subprocess

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas"
HOOK = r"""(() => {
  const listen = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, handler, options) {
    if (type === 'paste' && this.id === 'canvas') {
      window.qaPaste = ({plain, image, mime, target, trusted=true}) => {
        let handled = false;
        const file = image && new File([Uint8Array.from(atob(image), ch=>ch.charCodeAt(0))], 'paste', {type:mime});
        handler.call(this, {
          target: target ? document.querySelector(target) : this,
          isTrusted: trusted, cancelable: true, defaultPrevented: false,
          clipboardData: {items: file ? [{kind:'file', type:mime, getAsFile:()=>file}] : [], files: [],
            getData(format) {if (format !== 'text/plain') throw new Error('Unexpected clipboard format'); return plain; }},
          preventDefault() {handled = true;}, stopPropagation() {},
        });
        return handled;
      };
      EventTarget.prototype.addEventListener = listen;
    }
    return listen.call(this, type, handler, options);
  };
  window.qaHoldImage = () => {
    const decode = window.createImageBitmap;
    window.createImageBitmap = (...args) => {
      window.createImageBitmap = decode;
      return new Promise(resolve => { window.qaResumeImage = () => resolve(decode(...args)); });
    };
  };
})();"""


def verify(page):
    versioned = subprocess.check_output(["node", "--input-type=module", "-e",
        "import {previewFile} from './scripts/release.mjs'; console.log(previewFile)"], cwd=ROOT, text=True).strip()
    page.add_init_script(HOOK)
    page.on("dialog", lambda dialog: dialog.accept())
    page.goto((ROOT / "dist" / versioned).as_uri())
    page.wait_for_function("typeof window.mgCanvasTools?.callTool === 'function'")
    page.locator("#project-picker").set_input_files(FIXTURE)
    status = page.locator("#status")
    expect(status).to_contain_text("项目已打开")

    def state():
        return page.evaluate("async () => (await mgCanvasTools.callTool('canvas_read',{detail:'full',limit:10})).structuredContent")

    def paste(plain, **options):
        return page.evaluate("qaPaste", {"plain": plain, **options})

    def world(view, screen):
        return {axis: math.floor((screen[axis] - view["offset"][axis]) / view["zoom"] + .5) for axis in ("x", "y")}

    def new_item():
        return next(row["object"] for row in state()["objects"] if row["id"] not in ids)

    def undo():
        page.locator("#undo").click()
        assert {row["id"] for row in state()["objects"]} == ids
        canvas.focus()

    before = state()
    ids = {row["id"] for row in before["objects"]}
    view = before["viewport"]
    canvas = page.locator("#canvas")
    page.evaluate("""() => { const input=document.createElement('textarea'); input.id='clipboard-test-focus';
      document.body.append(input); input.focus(); }""")
    assert not paste("仍由输入框处理", target="#clipboard-test-focus")
    assert not state()["canUndo"]
    canvas.focus()
    assert not paste("untrusted", trusted=False)
    exact = "  中文\n\n  第二行  \n"
    assert paste(exact)
    item = new_item()
    assert item["text"] == exact
    assert item["at"] == world(view, {"x": view["width"] / 2, "y": view["height"] / 2})
    undo()
    assert paste("x" * 12001)
    expect(status).to_contain_text("文字过长")
    assert not state()["canUndo"]

    fixture = json.loads(FIXTURE.read_bytes())
    encoded = fixture["assets"]["asset-1"]
    bounds = canvas.bounding_box()
    page.mouse.move(bounds["x"] + 358, bounds["y"] + 224)
    assert paste("不要建立第二对象", image=encoded, mime="image/png")
    expect(status).to_contain_text("图片已嵌入")
    item = new_item()
    assert state()["board"]["objectCount"] == len(ids) + 1 and item["kind"] == "image"
    assert item["at"] == world(view, {"x": 358, "y": 224})
    with page.expect_download() as downloaded:
        page.locator("#project-export").click()
    assert json.loads(downloaded.value.path().read_bytes())["assets"][item["assetId"]] == encoded
    undo()
    assert paste("must not import fallback", image="PHN2Zy8+", mime="image/svg+xml")
    expect(status).to_contain_text("导入失败")
    assert not state()["canUndo"] and not paste("")

    page.evaluate("qaHoldImage()")
    assert paste("", image=encoded, mime="image/png")
    page.wait_for_function("typeof window.qaResumeImage === 'function'")
    empty = {"format": "mg-canvas.project", "version": 1, "assets": {},
             "document": {"schemaVersion": 1, "id": "new-generation", "theme": "paper", "order": [], "objects": {}, "assets": {}}}
    page.locator("#project-picker").set_input_files({"name": "other.mgcanvas", "mimeType": "application/json",
                                                     "buffer": json.dumps(empty).encode()})
    page.wait_for_function("async () => (await mgCanvasTools.callTool('canvas_read')).structuredContent.board.id === 'new-generation'")
    assert "IMPORTING" in state()["blockingReasons"]
    page.evaluate("qaResumeImage()")
    page.wait_for_function("async () => !(await mgCanvasTools.callTool('canvas_read')).structuredContent.blockingReasons.includes('IMPORTING')")
    assert state()["board"]["id"] == "new-generation" and state()["board"]["objectCount"] == 0
    print("React clipboard verified focus, trust, exact text, image bytes, undo and generation isolation.")


if __name__ == "__main__":
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        try:
            verify(browser.new_page(accept_downloads=True))
        finally:
            browser.close()
