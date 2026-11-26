"""Open the shipped React editor in an isolated Chrome profile."""

import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas"


def verify(context, url):
    page = context.new_page()
    errors = []

    def page_error(error):
        message = str(error)
        errors.append(message)
        print(message, file=sys.stderr)

    page.on("pageerror", page_error)
    page.goto(url)
    expect(page.locator("#root #canvas")).to_be_visible()
    expect(page.locator("#project-open")).to_be_enabled()
    page.locator("#project-picker").set_input_files(FIXTURE)
    expect(page.locator("#status")).to_contain_text("项目已打开")
    expected = json.loads(FIXTURE.read_bytes())
    actual = page.evaluate("mgCanvasTools.callTool('canvas_read')")
    assert actual["structuredContent"]["board"]["id"] == expected["document"]["id"]
    page.locator("#fit").click()
    layer = page.locator('#layers [data-id="flow-submit"]')
    if not layer.is_visible():
        page.locator("#toggle-layers").click()
    search = page.get_by_role("searchbox", name="按名称搜索图层")
    search.fill("提交预约")
    expect(page.locator("#layers .layer")).to_have_count(1)
    page.get_by_role("button", name="清空图层搜索").click()
    expect(page.locator("#layers .layer")).to_have_count(len(expected["document"]["objects"]))
    layer.click()
    page.locator("#text-format-bar").get_by_role("button", name="节点文字", exact=True).click()
    label = page.get_by_role("textbox", name="节点文字", exact=True)
    label.fill("React QA")
    label.press("Enter")
    expect(layer).to_contain_text("React QA")
    page.locator("#undo").click()
    expect(layer).to_contain_text(expected["document"]["objects"]["flow-submit"]["label"])
    with page.expect_download() as downloaded:
        page.locator("#project-export").click()
    saved = json.loads(downloaded.value.path().read_bytes())
    assert saved["document"] == expected["document"] and saved["assets"] == expected["assets"]
    assert not errors, errors
    page.close()


def preview_file():
    name = subprocess.check_output(["node", "--input-type=module", "-e",
        "import {previewFile} from './scripts/release.mjs'; console.log(previewFile)"],
        cwd=ROOT, text=True).strip()
    return ROOT / "dist" / name


def verify_desktop_bridge(context, url):
    # Exercise the official Tauri JS wrapper against a queue in this isolated context.
    context.add_init_script("""{
      const state = {next: null, serial: 0, jobs: [], replies: new Map()};
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = {invoke: (command, args) => {
        if (command === "desktop_next") {
          if (state.next) throw Error("Overlapping desktop polls");
          return state.jobs.length ? state.jobs.shift() : new Promise(resolve => { state.next = resolve; });
        }
        if (command !== "desktop_complete") throw Error(command);
        const reply = state.replies.get(args.id);
        if (!reply) throw Error("Unexpected completion: " + args.id);
        state.replies.delete(args.id);
        reply(args.result);
      }};
      window.desktopTest = ([action, args]) => new Promise(resolve => {
        const id = String(++state.serial);
        const job = {id, action, args};
        state.replies.set(id, resolve);
        if (state.next) {
          const next = state.next;
          state.next = null;
          next(job);
        } else state.jobs.push(job);
      });
      const startup = sessionStorage.getItem("desktop-test-startup");
      if (startup) {
        sessionStorage.removeItem("desktop-test-startup");
        window.startupOpen = window.desktopTest(["open", JSON.parse(startup)]);
      }
    }""")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)

    def invoke(action, **args):
        return page.evaluate("""request => Promise.race([
          window.desktopTest(request),
          new Promise((_, reject) => setTimeout(() => reject(Error("Desktop request timed out: " + request[0])), 10000))
        ])""", [action, args])

    encoded = FIXTURE.read_text(encoding="utf-8")
    expected = json.loads(encoded)
    original = expected["document"]["objects"]["flow-submit"]["label"]
    opened = invoke("open", fileName=FIXTURE.name, encoded="\ufeff" + encoded)
    assert opened["ok"], opened
    expect(page.locator("#status")).to_contain_text("项目已打开")
    expect(page.locator("#canvas")).to_be_focused()
    expect(page.locator("#project-title")).to_have_text(expected.get("title", FIXTURE.stem))
    assert {tool["name"] for tool in invoke("tools")["tools"]} == {
        "canvas_read", "canvas_edit", "canvas_draw_flow", "canvas_history", "canvas_view"}

    def snapshot():
        reply = invoke("snapshot")
        assert reply["ok"] and reply["fileName"] == FIXTURE.name, reply
        return reply["revision"], json.loads(reply["encoded"])

    def read():
        return invoke("call", name="canvas_read", arguments={"ids": ["flow-submit", "flow-first", "mind-booking", "qa-picture"]})

    revision, project = snapshot()
    assert revision == opened["revision"] == read()["revision"]
    assert project["document"] == expected["document"] and project["assets"] == expected["assets"]
    assert {item["kind"] for item in read()["objects"]} == {"shape", "connector", "mindmap", "image"}
    assert invoke("open", fileName="invalid.mgcanvas", encoded="{}")["code"] == "INVALID"
    # Preserve PNG container framing but corrupt its compressed image payload.
    corrupt = json.loads(encoded)
    asset_id, image = next(iter(corrupt["assets"].items()))
    damaged = bytearray(base64.b64decode(image))
    start = damaged.index(b"IDAT") + 4
    damaged[start:start+2] = b"\x00\x00"
    corrupt["assets"][asset_id] = base64.b64encode(damaged).decode()
    assert invoke("open", fileName="invalid-image.mgcanvas", encoded=json.dumps(corrupt))["code"] == "INVALID"
    assert snapshot() == (revision, project)

    layer = page.locator('#layers [data-id="flow-submit"]')
    if not layer.is_visible():
        page.locator("#toggle-layers").click()
    ops = [{"op": "update", "id": "flow-submit", "fields": {"label": "桌面 API 修改"}}]
    batch = {"baseRevision": revision, "operationId": "desktop-edit", "operations": ops}
    remote = invoke("call", name="canvas_edit", arguments=batch)
    assert remote["ok"] and not remote["replayed"], remote
    expect(layer).to_contain_text("桌面 API 修改")
    stale = invoke("call", name="canvas_edit", arguments={**batch, "operationId": "desktop-stale"})
    assert stale["code"] == "STALE", stale

    layer.click()
    page.locator("#text-format-bar").get_by_role("button", name="节点文字", exact=True).click()
    label = page.get_by_role("textbox", name="节点文字", exact=True)
    label.focus()
    label.dispatch_event("compositionstart")
    label.fill("桌面手动草稿")
    busy = invoke("open", fileName="other.mgcanvas", encoded=encoded)
    assert busy["code"] == "BUSY" and "INSPECTOR_DRAFT" in busy["blockingReasons"], busy
    assert snapshot()[1]["document"]["objects"]["flow-submit"]["label"] == "桌面 API 修改"
    label.dispatch_event("compositionend")
    label.press("Enter")
    expect(layer).to_contain_text("桌面手动草稿")
    current = read()["revision"]
    replay = invoke("call", name="canvas_edit", arguments=batch)
    assert replay["replayed"] and replay["revision"] == current and replay["appliedRevision"] == remote["appliedRevision"]
    page.locator("#canvas").focus()
    assert read()["objects"][0]["label"] == "桌面手动草稿"
    history = invoke("call", name="canvas_history", arguments={
        "baseRevision": current, "operationId": "desktop-undo", "action": "undo"})
    assert history["ok"], history
    expect(layer).to_contain_text("桌面 API 修改")
    page.locator("#undo").click()
    expect(layer).to_contain_text(original)
    page.locator("#redo").click()
    expect(layer).to_contain_text("桌面 API 修改")
    page.once("dialog", lambda dialog: dialog.dismiss())
    cancelled = invoke("open", fileName="other.mgcanvas", encoded=encoded)
    assert cancelled["code"] == "CANCELLED" and read()["objects"][0]["label"] == "桌面 API 修改", cancelled
    with page.expect_download() as downloaded:
        page.locator("#project-export").click()
    saved = json.loads(downloaded.value.path().read_bytes())
    latest_revision, latest = snapshot()
    assert latest_revision == read()["revision"]
    assert latest["document"] == saved["document"]
    assert latest["assets"] == saved["assets"] == expected["assets"]
    expect(page.locator("#status")).to_have_attribute("data-workspace", "saved")

    # The next navigation queues a request before the workbench bundle runs.
    page.evaluate("args => sessionStorage.setItem('desktop-test-startup', JSON.stringify(args))",
                  {"fileName": "next.mgcanvas", "encoded": encoded})
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.reload()
    assert page.evaluate("""() => Promise.race([
      window.startupOpen,
      new Promise((_, reject) => setTimeout(() => reject(Error("Startup open timed out")), 10000))
    ])""")["code"] == "CANCELLED"
    restored = read()
    assert restored["objects"][0]["label"] == "桌面 API 修改" and restored["revision"] != latest_revision
    assert snapshot()[1]["assets"] == expected["assets"]
    page.once("dialog", lambda dialog: dialog.accept())
    replaced = invoke("open", fileName="next.mgcanvas", encoded=encoded)
    assert replaced["ok"] and replaced["fileName"] == "next.mgcanvas", replaced
    assert read()["objects"][0]["label"] == original and read()["revision"] == replaced["revision"]
    assert invoke("call", name="canvas_edit", arguments=batch)["code"] == "STALE"
    assert not errors, errors
    page.close()


def verify_desktop(browser):
    config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_bytes())
    csp = config["app"]["security"]["csp"]
    assets = ROOT / "dist/desktop"
    origin = "http://127.0.0.1:45199"
    content_types = {"/index.html": "text/html", "/app/main.js": "text/javascript", "/app/style.css": "text/css"}

    def request(route):
        path = route.request.url.removeprefix(origin)
        if path in content_types:
            route.fulfill(path=assets / path[1:], content_type=content_types[path],
                          headers={"Content-Security-Policy": csp})
        else:
            route.abort()

    with browser.new_context(accept_downloads=True) as context:
        context.route("**/*", request)
        verify(context, f"{origin}/index.html")
    with browser.new_context(accept_downloads=True) as context:
        context.route("**/*", request)
        verify_desktop_bridge(context, f"{origin}/index.html")
    print("React desktop assets opened, edited, undid and round-tripped a project in Chrome with the Tauri CSP.")


def verify_web(browser):
    with subprocess.Popen(["node", "scripts/serve.mjs"], cwd=ROOT, text=True,
                          stdout=subprocess.PIPE, env={**os.environ, "PORT": "0"}) as server:
        try:
            address = server.stdout.readline().strip().removeprefix("Local preview ")
            assert address.startswith("http://127.0.0.1:")
            with browser.new_context(accept_downloads=True) as context:
                verify(context, address)
        finally:
            server.terminate()
    with browser.new_context(offline=True, accept_downloads=True) as context:
        verify(context, preview_file().as_uri())
    print("React HTTP preview and offline HTML opened, edited, undid and round-tripped a project.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--desktop", action="store_true", help="verify the staged Tauri frontend in Chrome")
    modes.add_argument("--storage", action="store_true", help="run storage recovery against the built offline app")
    args = parser.parse_args()
    if args.storage:
        subprocess.run([sys.executable, "scripts/check-recovery-browser.py", str(preview_file())], cwd=ROOT, check=True)
    else:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            try:
                (verify_desktop if args.desktop else verify_web)(browser)
            finally:
                browser.close()
