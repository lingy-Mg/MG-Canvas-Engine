"""Verify the installed-style Windows stdio server with the official MCP Python SDK."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

from mcp import ClientSession, McpError, StdioServerParameters
from mcp.client.stdio import stdio_client


FIXTURE = Path(__file__).resolve().parents[1] / "docs/fixtures/Meeting-Room-Mobile-QA.mgcanvas"
TOOL_NAMES = {"canvas_read", "canvas_edit", "canvas_draw_flow", "canvas_history", "canvas_view"}


async def verify(cli, gui, directory):
    environment = os.environ | {"MGCANVAS_INSTANCE": f"desktop-mcp-qa-{uuid.uuid4()}"}
    gui_environment = environment | {"WEBVIEW2_USER_DATA_FOLDER": str(directory / "webview")}
    project = directory / "会议室 MCP 验收.mgcanvas"
    shutil.copyfile(FIXTURE, project)
    original = json.loads(project.read_bytes())["document"]["objects"]["flow-submit"]["label"]
    parameters = StdioServerParameters(command=str(cli), args=["mcp"], env=environment, cwd=directory)
    workbench = None
    try:
        async with stdio_client(parameters) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                initialized = await session.initialize()
                assert initialized.serverInfo.name == "mgcanvas"
                assert initialized.capabilities.tools is not None
                await session.send_ping()
                try:
                    await session.list_tools()
                except McpError as error:
                    assert error.error.data["code"] == "NO_WINDOW", error
                else:
                    raise AssertionError("Tools unexpectedly available without a workbench")

                workbench = subprocess.Popen([gui, project], cwd=directory, env=gui_environment)
                async with asyncio.timeout(45):
                    while True:
                        try:
                            tools = await session.list_tools()
                            break
                        except McpError as error:
                            assert error.error.data["code"] in {"NO_WINDOW", "NOT_READY"}, error
                            assert workbench.poll() is None, workbench.returncode
                            await asyncio.sleep(0.15)
                assert {tool.name for tool in tools.tools} == TOOL_NAMES
                assert all(tool.inputSchema["type"] == "object" for tool in tools.tools)

                async def call(name, arguments, is_error=False):
                    reply = await session.call_tool(name, arguments)
                    assert reply.isError is is_error, reply
                    assert len(reply.content) == 1 and reply.content[0].type == "text", reply
                    payload = reply.structuredContent
                    assert payload == json.loads(reply.content[0].text) and payload["ok"] is (not is_error), reply
                    return payload

                async def read():
                    return await call("canvas_read", {"ids": ["flow-submit"]})

                async with asyncio.timeout(45):
                    while True:
                        board = await call("canvas_read", {})
                        if board["board"]["id"] == "meeting-room-mobile-qa":
                            break
                        assert workbench.poll() is None, workbench.returncode
                        await asyncio.sleep(0.15)
                before = await read()
                assert before["objects"][0]["label"] == original
                label = "通过 MCP 审批 📎"
                edit = {
                    "baseRevision": before["revision"],
                    "operationId": str(uuid.uuid4()),
                    "operations": [{"op": "update", "id": "flow-submit", "fields": {"label": label}}],
                }
                edited = await call("canvas_edit", edit)
                assert edited["revision"] != before["revision"]
                after = await read()
                assert after["objects"][0]["label"] == label and after["revision"] == edited["revision"]
                replay = await call("canvas_edit", edit)
                assert replay["replayed"] and replay["appliedRevision"] == edited["appliedRevision"]
                stale = await call("canvas_edit", edit | {"operationId": str(uuid.uuid4())}, is_error=True)
                assert stale["code"] == "STALE", stale
                undone = await call("canvas_history", {
                    "action": "undo", "baseRevision": after["revision"], "operationId": str(uuid.uuid4()),
                })
                restored = await read()
                assert restored["objects"][0]["label"] == original and restored["revision"] == undone["revision"]
                assert project.read_bytes() == FIXTURE.read_bytes()
        print("Official MCP SDK verified an isolated native workbench: discovery, read, edit, replay, stale rejection and undo.")
    finally:
        if workbench is not None and workbench.poll() is None:
            workbench.terminate()
            workbench.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path, help="Path to mgcanvas.exe")
    parser.add_argument("--gui", required=True, type=Path, help="Path to mg-canvas-desktop.exe")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="mgcanvas-mcp-qa-", ignore_cleanup_errors=True) as temporary:
        asyncio.run(verify(args.cli.resolve(strict=True), args.gui.resolve(strict=True), Path(temporary)))
