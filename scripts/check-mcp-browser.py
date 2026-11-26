"""Exercise the stdio adapter against a visible, disposable Chrome canvas."""

import asyncio
import json
from pathlib import Path
import shutil
import tempfile

from mcp import ClientSession, StdioServerParameters, stdio_client
from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas"
IDS = ["flow-submit", "flow-review"]
EXPECTED_TOOLS = {
    "canvas_read", "canvas_edit", "canvas_draw_flow", "canvas_history", "canvas_view",
}


def labels(value):
    found = {}

    def visit(item):
        if isinstance(item, dict):
            if item.get("id") in IDS and "label" in item:
                found[item["id"]] = item["label"]
            for child in item.values():
                visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)

    visit(value)
    return [found.get(key) for key in IDS]


async def wait_for(page, expression, argument=None):
    # The bridge CSP forbids the injected string eval used by Playwright's wait_for_function.
    async with asyncio.timeout(10):
        while not await page.evaluate(expression, argument):
            await asyncio.sleep(0.05)


async def verify(session, page):
    initialized = await session.initialize()
    catalog = (await session.list_tools()).tools
    assert {tool.name for tool in catalog} == EXPECTED_TOOLS
    web_catalog = await page.evaluate("mgCanvasTools.listTools()")
    assert [tool.model_dump(by_alias=True, exclude_none=True) for tool in catalog] == web_catalog
    calls = 0

    async def call(name, args, *, error=False):
        nonlocal calls
        calls += 1
        reply = await session.call_tool(name, args)
        result = reply.model_dump(by_alias=True, exclude_none=True)
        data = result["structuredContent"]
        assert bool(result.get("isError")) is error and data["ok"] is (not error), (name, data)
        return data

    read = {"ids": IDS, "detail": "full"}
    before = await call("canvas_read", read)
    await page.get_by_role("button", name="回到内容", exact=True).click()
    located = await page.evaluate("async () => (await mgCanvasTools.callTool('canvas_read',{scope:'viewport',limit:1})).structuredContent")
    assert located["viewport"] == before["viewport"] and located["total"] == before["board"]["objectCount"]
    assert located["revision"] == before["revision"] and not located["canUndo"]
    original = labels(before)
    assert original == ["\u63d0\u4ea4\u9884\u7ea6", "\u5ba1\u6838"], before
    updated = ["MCP-A", "MCP-B"]
    await page.evaluate("window.qaPainted.clear()")
    edit = await call("canvas_edit", {
        "baseRevision": before["revision"], "operationId": "mcp-qa-batch",
        "operations": [{"op": "update", "id": key, "fields": {"label": label}}
                       for key, label in zip(IDS, updated, strict=True)],
    })
    assert edit["revision"] != before["revision"]
    await wait_for(page, "labels => labels.every(label => qaPainted.has(label))", updated)
    stale = await call("canvas_edit", {
        "baseRevision": before["revision"], "operationId": "mcp-qa-stale",
        "operations": [{"op": "update", "id": IDS[0], "fields": {"label": "stale"}}],
    }, error=True)
    assert stale["code"] == "STALE", stale
    after = await call("canvas_read", read)
    assert labels(after) == updated and after["revision"] == edit["revision"]
    await page.evaluate("window.qaPainted.clear()")
    undone = await call("canvas_history", {
        "baseRevision": after["revision"], "operationId": "mcp-qa-undo", "action": "undo",
    })
    restored = await call("canvas_read", read)
    assert labels(restored) == original and restored["revision"] == undone["revision"]
    await wait_for(page, "labels => labels.every(label => qaPainted.has(label))", original)
    drawing = await call("canvas_draw_flow", {
        "baseRevision": restored["revision"], "operationId": "mcp-qa-draw",
        "mermaid": "flowchart LR\nA[QA start] --> B[QA finish]",
    })
    node_ids, edge_ids = drawing["nodeIds"], drawing["edgeIds"]
    assert len(node_ids) == 2 and len(edge_ids) == 1
    await call("canvas_view", {"action": "fit", "ids": [*node_ids, *edge_ids]})
    drawn = await call("canvas_read", {"ids": [*node_ids, *edge_ids]})
    nodes, edge = drawn["objects"][:2], drawn["objects"][2]
    assert [node["label"] for node in nodes] == ["QA start", "QA finish"]
    assert [edge[end]["objectId"] for end in ("from", "to")] == node_ids
    await wait_for(page, "names => names.every(name => qaPainted.has(name))", ["QA start", "QA finish"])
    return {"protocol": initialized.model_dump(by_alias=True)["protocolVersion"], "tools": len(catalog), "calls": calls,
            "passed": calls - 1, "expectedErrors": 1, "staleCode": stale["code"],
            "drawnNodes": len(node_ids), "drawnEdges": len(edge_ids),
            "editedAndUndoneObjects": len(IDS), "localProjectStartedFitted": True}


async def main():
    with tempfile.TemporaryDirectory(prefix="mgcanvas-mcp-qa-") as directory:
        folder = Path(directory)
        project = folder / "board.mgcanvas"
        descriptor = folder / "session.json"
        data = FIXTURE.read_bytes()
        project.write_bytes(data)
        node = shutil.which("node")
        bridge = await asyncio.create_subprocess_exec(
            node, "scripts/mgcanvas.mjs", "serve", "--file", project, "--session", descriptor,
            cwd=ROOT, stdout=asyncio.subprocess.PIPE,
        )
        try:
            authorized = json.loads(await asyncio.wait_for(bridge.stdout.readline(), 15))["url"]
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(channel="chrome", headless=False)
                page = await browser.new_page(viewport={"width": 1280, "height": 900})
                async with page.expect_response("**/page/open") as open_response:
                    await page.goto(authorized)
                assert (await open_response.value).status == 200
                await wait_for(page, "typeof window.mgCanvasTools?.callTool === 'function' && !document.body.inert")

                other_page = await browser.new_page()
                async with other_page.expect_response("**/page/open") as rejected:
                    await other_page.goto(authorized)
                assert (await rejected.value).status == 409
                await other_page.close()
                await page.bring_to_front()

                await page.evaluate("""() => {
                    window.qaPainted = new Set();
                    const fillText = CanvasRenderingContext2D.prototype.fillText;
                    CanvasRenderingContext2D.prototype.fillText = function(text, ...rest) {
                        if (this.canvas.isConnected) qaPainted.add(text);
                        return fillText.call(this, text, ...rest);
                    };
                }""")

                parameters = StdioServerParameters(command=node, cwd=ROOT, args=[
                    str(ROOT / "scripts/mgcanvas-mcp.mjs"), "--session", str(descriptor),
                ])
                async with stdio_client(parameters) as (receive, send):
                    async with ClientSession(receive, send) as session:
                        result = await verify(session, page)
                await browser.close()
            assert project.read_bytes() == data
            print(json.dumps({**result, "secondTabStatus": 409, "fixtureUnchanged": True}))
        finally:
            if bridge.returncode is None:
                bridge.terminate()
                await bridge.wait()


if __name__ == "__main__":
    asyncio.run(main())
