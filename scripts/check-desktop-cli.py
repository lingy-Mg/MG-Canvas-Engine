"""Exercise the Windows console and workbench binaries in a private instance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import tomllib
import uuid

ROOT = Path(__file__).resolve().parent.parent


def verify(cli, gui, directory, check_png):
    env = os.environ | {"MGCANVAS_INSTANCE": f"desktop-cli-test-{uuid.uuid4()}"}
    gui_env = env | {"WEBVIEW2_USER_DATA_FOLDER": str(directory / "webview")}
    processes = []

    def command(*args, status=0, payload=None, allow_other_status=False):
        result = subprocess.run(
            [cli, *args], cwd=directory, env=env,
            input=json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else b"",
            capture_output=True, timeout=160,
        )
        if not allow_other_status:
            assert result.returncode == status, (args, result.returncode, result.stdout, result.stderr)
        assert result.stdout.isascii(), result.stdout
        response = json.loads(result.stdout)
        assert (result.returncode == 0) == response["ok"], response
        return response

    def launch(*args):
        process = subprocess.Popen([gui, *args], cwd=directory, env=gui_env)
        processes.append(process)
        return process

    def stdio_tools():
        requests = [
            {"id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "desktop-cli-smoke", "version": "1"},
            }},
            {"method": "notifications/initialized"},
            {"id": 2, "method": "tools/list"},
            {"id": 3, "method": "tools/call", "params": {
                "name": "canvas_read", "arguments": {"ids": ["flow-submit"]},
            }},
        ]
        lines = "".join(json.dumps({"jsonrpc": "2.0"} | request) + "\n" for request in requests)
        result = subprocess.run(
            [cli, "mcp", "--stdio"], cwd=directory, env=env, input=lines.encode("utf-8"),
            capture_output=True, timeout=60,
        )
        assert result.returncode == 0, (result.stdout, result.stderr)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        assert [reply["id"] for reply in replies] == [1, 2, 3], replies
        assert replies[0]["result"]["protocolVersion"] == "2025-06-18"
        return replies[1]["result"]["tools"], replies[2]["result"]["structuredContent"]

    def check_output(response, path):
        data = path.read_bytes()
        assert response["bytes"] == len(data)
        assert response["sha256"] == hashlib.sha256(data).hexdigest()
        return data

    try:
        fixtures = ROOT / "docs" / "fixtures"
        first = directory / "首次打开.mgcanvas"
        meeting = directory / "会议室 画板.mgcanvas"
        shutil.copyfile(fixtures / "M5AG-Layer-Locks.mgcanvas", first)
        shutil.copyfile(fixtures / "Meeting-Room-Mobile-QA.mgcanvas", meeting)
        cargo = tomllib.loads((ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8"))
        assert command("--version")["version"] == cargo["package"]["version"]
        assert command("tools", status=4)["code"] == "NO_WINDOW"
        assert command("call", "canvas_read", "--stdin", status=2, payload=[])["code"] == "INVALID"

        startup = [launch(first), launch()]
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            board = command("read", allow_other_status=True)
            if board.get("board", {}).get("id") == "m5ag-layer-locks":
                break
            if not board["ok"]:
                assert board["code"] in ("NO_WINDOW", "NOT_READY", "BUSY"), board
            time.sleep(0.15)
        else:
            raise AssertionError(f"Workbench did not load the cold-start project: {board}")

        while time.monotonic() < deadline and all(p.poll() is None for p in startup):
            time.sleep(0.1)
        assert sum(p.poll() is None for p in startup) == 1, [p.poll() for p in startup]
        tools = command("tools")["tools"]
        assert {tool["name"] for tool in tools} == {
            "canvas_read", "canvas_edit", "canvas_history", "canvas_view", "canvas_draw_flow",
        }
        assert launch(meeting).wait(timeout=45) == 0
        assert command("read")["board"]["id"] == "meeting-room-mobile-qa"
        mcp_tools, mcp_result = stdio_tools()
        assert mcp_tools == tools
        assert mcp_result["ok"] and mcp_result["objects"][0]["id"] == "flow-submit"

        invalid = directory / "错误工程.mgcanvas"
        invalid.write_bytes(b"\xff")
        assert command("open", invalid, status=2)["code"] == "INVALID"
        assert command("read")["board"]["id"] == "meeting-room-mobile-qa"
        assert command("open", first)["ok"]
        assert command("open", meeting)["ok"]

        original = command("read", "--stdin", payload={"ids": ["flow-submit"]})
        edit = {
            "baseRevision": original["revision"],
            "operationId": str(uuid.uuid4()),
            "operations": [{"op": "update", "id": "flow-submit", "fields": {"label": "已批准申请 📎"}}],
        }
        arguments = directory / "编辑参数.json"
        arguments.write_text(json.dumps(edit, ensure_ascii=False), encoding="utf-8-sig")
        edited = command("call", "canvas_edit", "--args-file", arguments)
        replayed = command("call", "canvas_edit", "--stdin", payload=edit)
        assert replayed["replayed"] and replayed["appliedRevision"] == edited["revision"], replayed
        rejected = command(
            "call", "canvas_edit", "--stdin", status=3,
            payload=edit | {"operationId": str(uuid.uuid4())},
        )
        assert rejected["code"] == "STALE", rejected
        current = command("read", "--args-file", "-", payload={"query": "已批准申请"})
        assert current["objects"][0]["label"] == "已批准申请 📎"
        fit = command("call", "canvas_view", "--stdin", payload={"action": "fit", "ids": ["flow-submit"]})
        assert fit["viewport"]["zoom"] > 0
        assert fit["screenText"][0]["id"] == "flow-submit"
        undone = command("call", "canvas_history", "--stdin", payload={
            "action": "undo", "baseRevision": current["revision"], "operationId": str(uuid.uuid4()),
        })
        after = command("read", "--stdin", payload={"ids": ["flow-submit"]})
        assert after["objects"][0]["label"] == original["objects"][0]["label"]
        assert after["revision"] == undone["revision"]

        exported = directory / "导出工程.mgcanvas"
        snapshot = command("export", "--out", exported)
        export_data = check_output(snapshot, exported)
        assert snapshot["revision"] == after["revision"]
        assert json.loads(export_data)["assets"] == json.loads(meeting.read_bytes())["assets"]
        assert command("export", "--out", exported, status=3)["code"] == "EXISTS"
        assert exported.read_bytes() == export_data

        if check_png:
            active_png = directory / "当前项目.png"
            from_window = command("png", "--active", "--out", active_png, "--id", "flow-submit", "--scale", "2")
            assert from_window["revision"] == snapshot["revision"]
            png_bytes = check_output(from_window, active_png)
            assert png_bytes.startswith(b"\x89PNG\r\n\x1a\n"), from_window
            assert from_window["width"] > 0 and from_window["height"] > 0

        for process in startup:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        assert command("tools", status=4)["code"] == "NO_WINDOW"

        if check_png:
            disk_png = directory / "磁盘项目.png"
            from_file = command("png", "--file", exported, "--out", disk_png, "--id", "flow-submit", "--scale", "2")
            assert check_output(from_file, disk_png) == png_bytes
            assert command("png", "--file", exported, "--out", disk_png, status=3)["code"] == "EXISTS"
            assert disk_png.read_bytes() == png_bytes

        print("Verified isolated Windows startup, forwarding, CLI and MCP tools, edits, history and export"
              + (", plus active and offline PNG." if check_png else "."))
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path, help="Path to mgcanvas.exe")
    parser.add_argument("--gui", required=True, type=Path, help="Path to mg-canvas-desktop.exe")
    parser.add_argument("--skip-png", action="store_true", help="Only exercise the desktop bridge")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="mgcanvas-cli-test-", ignore_cleanup_errors=True) as directory:
        verify(args.cli.resolve(strict=True), args.gui.resolve(strict=True), Path(directory), not args.skip_png)
