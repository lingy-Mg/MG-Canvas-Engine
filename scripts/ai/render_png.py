"""Paint one generated, local, offline document with an installed Chromium browser."""
import json
import os
from pathlib import Path
import shutil
import sys


def local_browser(chromium):
    explicit = os.environ.get("MGCANVAS_BROWSER")
    if explicit:
        path = Path(explicit)
        if (not path.is_absolute() or str(path).startswith(("//", "\\\\")) or not path.is_file()
                or path.name.lower() not in {"chrome.exe", "msedge.exe", "chromium.exe", "chrome", "chromium",
                                            "google-chrome", "microsoft-edge", "google chrome", "microsoft edge"}):
            return None
        return path
    candidates = []
    for base in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        if os.environ.get(base):
            for app in ("Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"):
                candidates.append(Path(os.environ[base]) / app)
    for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))
    candidates.append(Path(chromium.executable_path))
    return next((p for p in candidates if p.is_file()), None)


def render(html, target):
    try:
        from playwright.sync_api import Error, sync_playwright
    except ImportError:
        return {"ok": False, "code": "RENDER_DEPENDENCY", "message": "Python package playwright is unavailable in this interpreter."}
    with sync_playwright() as driver:
        exe = local_browser(driver.chromium)
        if not exe:
            return {"ok": False, "code": "BROWSER_UNAVAILABLE", "message":
                    "Local Chrome/Edge/Chromium was not found. Set MGCANVAS_BROWSER to its absolute local executable path."}
        try:
            browser = driver.chromium.launch(executable_path=str(exe), headless=True, chromium_sandbox=True,
                                             args=["--disable-background-networking"])
        except Error:
            return {"ok": False, "code": "BROWSER_UNAVAILABLE", "message": "Unable to launch the selected local Chromium executable."}
        try:
            ctx = browser.new_context(offline=True, accept_downloads=True, service_workers="block", device_scale_factor=1, color_scheme="light")
            external = []
            page = ctx.new_page()
            page.on("request", lambda req: external.append(True) if req.url.startswith(("http:", "https:")) else None)
            page.on("websocket", lambda _: external.append(True))
            page.goto(html.resolve().as_uri(), wait_until="load", timeout=30000)
            page.locator("#status:not(:empty)").wait_for(state="attached", timeout=30000)
            result = json.loads(page.locator("#status").text_content())
            if result["ok"]:
                with page.expect_download(timeout=30000) as download:
                    page.locator("#png-download").click()
                download.value.save_as(target)
                if external:
                    return {"ok": False, "code": "RENDER_FAILED", "message": "Offline renderer attempted a network request."}
                result["networkRequests"] = len(external)
            return result
        finally:
            browser.close()


if __name__ == "__main__":
    try:
        result = render(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as error:
        result = {"ok": False, "code": "RENDER_FAILED", "message": "Local PNG render failed: " + str(error)}
    print(json.dumps(result, ensure_ascii=True))
