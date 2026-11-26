"""Exercise the built table tool in a fresh Chromium profile with isolated storage."""
import argparse
import json
from io import BytesIO
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect, sync_playwright
from ai.render_png import local_browser


def check_placement(page, canvas, controls, export, empty, shots):
    tool, ghost = page.locator("#tool-table"), page.locator("#placement-preview")
    undo, redo = page.locator("#undo"), page.locator("#redo")
    expect(page.locator("#status")).to_have_attribute("data-workspace", "saved")
    page.evaluate("""() => {
      window.tablePlacementWrites = 0;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        if (this.transaction.db.name === 'mg-canvas-workspaces') window.tablePlacementWrites++;
        return put.apply(this, args);
      };
    }""")
    origin = canvas.bounding_box()
    x, y = origin["x"] + 250, origin["y"] + 220
    tool.click()
    expect(ghost).to_be_hidden()
    page.mouse.move(x, y)
    expect(ghost).to_be_visible()
    expect(ghost).to_have_attribute("data-kind", "table")
    first = ghost.bounding_box()
    assert (first["width"], first["height"]) == (288, 96)
    x, y = x + 85, y + 40
    page.mouse.move(x, y)
    followed = ghost.bounding_box()
    assert abs(followed["x"] - x) <= .51 and abs(followed["y"] - y) <= .51
    # Each interior divider must be discernible from the adjacent empty cell fill.
    pixels = Image.open(BytesIO(ghost.screenshot())).convert("RGB")
    w, h = pixels.size
    for x1, y1, dx, dy in [(w // 2, h // 4, 1, 0), (w // 4, h // 2, 0, 1)]:
        fill = pixels.getpixel((x1 + 5 * dx, y1 + 5 * dy))
        line = [pixels.getpixel((x1 + i * dx, y1 + i * dy)) for i in (-1, 0, 1)]
        assert any(max(abs(a - b) for a, b in zip(color, fill)) > 40 for color in line)
    if shots:
        page.screenshot(path=shots / "table-placement.png")
    canvas.press("Escape")
    expect(ghost).to_be_hidden()
    expect(tool).to_have_attribute("aria-pressed", "false")
    # Keyboard activation also uses the pointer already resting on the canvas.
    tool.press("Enter")
    expect(ghost).to_be_visible()
    page.locator("#tool-hand").click()
    page.mouse.move(x, y)
    expect(ghost).to_be_hidden()

    tool.click()
    page.mouse.move(x, y)
    page.keyboard.down("Control")
    page.mouse.wheel(0, -95)
    page.keyboard.up("Control")
    page.wait_for_function("w=>document.querySelector('#placement-preview').getBoundingClientRect().width>w+10",
                           arg=first["width"])
    page.mouse.down(button="middle")
    x, y = x + 47, y - 23
    page.mouse.move(x, y, steps=4)
    expect(ghost).to_be_hidden()
    page.mouse.up(button="middle")
    expect(ghost).to_be_visible()
    assert export()["document"] == empty
    expect(undo).to_be_disabled()
    expect(redo).to_be_disabled()
    page.mouse.move(x, y)
    expect(ghost).to_be_visible()
    page.wait_for_timeout(450)  # Longer than the workspace save debounce.
    assert page.evaluate("tablePlacementWrites") == 0
    expected = ghost.bounding_box()
    assert abs(expected["x"] - x) < 1 and abs(expected["y"] - y) < 1
    page.mouse.click(x, y)
    expect(ghost).to_be_hidden()
    expect(controls).to_be_visible()
    actual = controls.bounding_box()
    assert all(abs(actual[key] - expected[key]) < .1 for key in expected), (expected, actual)
    objects = list(export()["document"]["objects"].values())
    assert len(objects) == 1 and objects[0]["kind"] == "table"
    assert (objects[0]["width"], objects[0]["height"]) == (288, 96)
    expect(page.locator("#status")).to_have_attribute("data-workspace", "saved")
    assert page.evaluate("tablePlacementWrites") > 0
    undo.click()
    expect(undo).to_be_disabled()
    assert export()["document"] == empty


def select_table_layer(page):
    page.locator("#toggle-layers").click()
    page.locator("#layers .layer").click()
    page.locator("#close-layers").click()
    expect(page.locator(".table-controls")).to_be_visible()


def check_compact_format(bar):
    strip = bar.locator(".format-strip")
    expect(bar).to_have_attribute("data-layout", "table")
    assert strip.evaluate("el => el.scrollWidth <= el.clientWidth + 1"), strip.bounding_box()
    assert strip.locator('[data-format-group="size"] button[aria-pressed]').all_text_contents() == ["14", "18", "24"]
    assert strip.locator('[data-format-group="ink"] [data-paint-value]').count() == 3
    expect(strip.locator('[data-format-group="background"],[data-menu="background"],[data-menu="paper"]')).to_have_count(0)
    expect(strip.get_by_role("spinbutton")).to_have_count(0)
    for name in ["粗体", "斜体", "居左", "居中", "居右"]:
        expect(strip.get_by_role("button", name=name, exact=True)).to_be_visible()


def check_dividers(page, canvas, chrome, bar, open_bytes, export, shots):
    values = [["123", "123", "123"], ["123", "123", ""], ["", "", "651321"], ["", "", "123123123"]]
    cells = [[{"text": value} for value in row] for row in values]
    cells[1][1]["style"] = {"background": "#cbe2f7"}
    table = dict(kind="table", id="table-reference", at={"x": 0, "y": 0}, width=324, height=184,
                 rotation=0, cells=cells, style={"background": "#fcf2d8"})
    doc = dict(schemaVersion=6, id="axis-check", theme="paper", objects={table["id"]: table}, order=[table["id"]], assets={})
    open_bytes(json.dumps(doc).encode())
    field = page.get_by_role("textbox", name="表格单元格内容")
    undo, redo = page.locator("#undo"), page.locator("#redo")

    def near_box(actual, expected):
        assert actual and all(abs(actual[k] - v) <= 1 for k, v in expected.items()), (actual, expected)

    def bands(axis):
        return heights if axis == "row" else widths

    def frame():
        box = chrome.bounding_box()
        return box, box["width"] / sum(widths)

    def point(axis, index):
        box, z = frame()
        right = sum(widths[:index + 1]) if axis == "col" else widths[0] * .42
        bottom = sum(heights[:index + 1]) if axis == "row" else heights[0] * .42
        x, y = round(box["x"] + right * z), round(box["y"] + bottom * z)
        if index == len(bands(axis)) - 1:
            # Include the outside half of the trailing stroke's hit area.
            if axis == "row":
                y += 2
            else:
                x += 2
        return x, y

    def resize(axis, index, change, unselected=False):
        before = export()
        box, zoom = frame()
        x, y = point(axis, index)
        travel = round(change * zoom)
        dx, dy = (travel, 0) if axis == "col" else (0, travel)
        cursor = "row-resize" if axis == "row" else "col-resize"
        if unselected:
            page.mouse.click(box["x"] - 44, box["y"] + box["height"] + 40)
            expect(chrome).to_be_hidden()
        expect(page.locator("#status")).to_have_attribute("data-workspace", "saved")
        writes = page.evaluate("tablePlacementWrites")
        page.mouse.move(x, y)
        expect(canvas).to_have_css("cursor", cursor)
        page.mouse.down()
        page.mouse.move(x + dx / 2, y + dy / 2, steps=3)
        key = "height" if axis == "row" else "width"
        page.wait_for_function("""([key, old]) =>
          Math.abs(document.querySelector('.table-controls').getBoundingClientRect()[key] - old) > 2""", arg=[key, box[key]])
        expect(canvas).to_have_css("cursor", cursor)
        near_box(chrome.bounding_box(), {key: box[key] + travel / 2})
        if unselected:
            page.wait_for_timeout(450)
            assert page.evaluate("tablePlacementWrites") == writes
        page.mouse.move(x + dx, y + dy, steps=4)
        page.mouse.up()
        after = export()
        now = after["document"]["objects"][table["id"]]
        bands(axis)[index] += round(travel / zoom)
        assert now["width"] == sum(widths) and now["height"] == sum(heights), (widths, heights, now)
        assert now.get("rowWeights", heights) == heights and now.get("columnWeights", widths) == widths
        assert now["cells"] == cells and now["at"] == table["at"] and now["style"] == table["style"]
        undo.click()
        assert export() == before
        redo.click()
        assert export() == after

    def cell_box(r, c):
        box, z = frame()
        return dict(x=box["x"] + sum(widths[:c]) * z, y=box["y"] + sum(heights[:r]) * z,
                    width=widths[c] * z, height=heights[r] * z)

    def check_cells():
        for r, row in enumerate(values):
            for c, value in enumerate(row):
                want = cell_box(r, c)
                page.mouse.click(want["x"] + want["width"] / 2, want["y"] + want["height"] / 2)
                expect(chrome).to_have_accessible_name(f"表格操作，单元格，第 {r + 1} 行第 {c + 1} 列")
                near_box(chrome.locator(".table-selection").bounding_box(), want)
                canvas.press("F2")
                expect(field).to_have_value(value)
                near_box(page.locator(".table-cell-editor").bounding_box(), want)
                field.press("Escape")

    def check_pixels():
        # Sample the actual painted grid and glyphs, independent of DOM selection and editing overlays.
        for r, c in [(1, 1), (2, 2), (3, 2)]:
            box = cell_box(r, c)
            result = canvas.evaluate("""(canvas, b) => {
              const rect=canvas.getBoundingClientRect(), d=canvas.width/rect.width;
              const read=(x,y,w,h)=>canvas.getContext('2d').getImageData(Math.round(x*d),Math.round(y*d),
                Math.max(1,Math.round(w*d)),Math.max(1,Math.round(h*d))).data;
              const x=b.x-rect.left,y=b.y-rect.top;
              const bg=Array.from(read(x+b.width*.8,y+b.height*.84,1,1)).slice(0,3);
              const ink=read(x+3,y+3,b.width-6,b.height-6);
              let count=0;for(let i=0;i<ink.length;i+=4)if(Math.max(...bg.map((v,j)=>Math.abs(v-ink[i+j])))>60)count++;
              const border=read(x-1,y+b.height*.8,3,1);
              const edge=Array.from({length:border.length/4},(_,i)=>Math.max(...bg.map((v,j)=>Math.abs(v-border[4*i+j]))));
              return {bg,count,edge:Math.max(...edge)};
            }""", box)
            assert result["bg"] == ([203, 226, 247] if (r, c) == (1, 1) else [252, 242, 216]), result
            assert result["count"] > 15 and result["edge"] > 12, (r, c, result)

    widths, heights = [108] * 3, [46] * 4
    select_table_layer(page)
    check_compact_format(bar)
    page.locator("#zoom-out").click()
    page.locator("#zoom-out").click()
    zoom_before = frame()[1]
    resize("row", 1, 28, unselected=True)
    resize("col", 1, 52)
    check_cells()
    page.locator("#zoom-in").click()
    page.locator("#zoom-in").click()
    page.wait_for_function("w=>document.querySelector('.table-controls').getBoundingClientRect().width > w",
                           arg=sum(widths) * zoom_before + 1)
    zoom_after = frame()[1]
    resize("row", 3, 20)
    resize("col", 2, -12)
    # The corner continues to scale every row and column together.
    saved = export()
    box, zoom = frame()
    right, bottom = box["x"] + box["width"], box["y"] + box["height"]
    page.mouse.move(right, bottom)
    expect(canvas).to_have_css("cursor", "nwse-resize")
    page.mouse.down()
    page.mouse.move(right + 36 * zoom, bottom + 18 * zoom, steps=4)
    page.mouse.up()
    scaled = export()["document"]["objects"][table["id"]]
    assert scaled["width"] == sum(widths) + 36 and scaled["height"] == sum(heights) + 18
    assert scaled["rowWeights"] == heights and scaled["columnWeights"] == widths
    undo.click()
    assert export() == saved
    # Cancel returns from preview without replacing the pending redo step.
    x, y = point("col", 1)
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 48, y, steps=3)
    page.keyboard.press("Escape")
    page.mouse.up()
    expect(redo).to_be_enabled()
    assert export() == saved
    # Use the same downloaded project to re-enter through the ordinary file picker.
    open_bytes(json.dumps(saved).encode())
    select_table_layer(page)
    assert export() == saved
    check_cells()
    check_pixels()
    expect(page.locator("#status")).to_have_attribute("data-workspace", "saved")
    page.reload()
    expect(page.locator("#layers .layer")).to_have_count(1)
    assert export() == saved
    select_table_layer(page)
    if shots:
        want = cell_box(1, 1)
        page.mouse.click(want["x"] + want["width"] / 2, want["y"] + want["height"] / 2)
        page.screenshot(path=shots / "table-dividers.png")
    print(f"Verified middle and last dividers at {zoom_before:.0%} and {zoom_after:.0%}, live layout, undo/redo and project round trip.")


def check(page, context, preview, shots):
    page.set_default_timeout(6000)
    # A unique test origin serves the offline bundle without touching any open editor.
    url = "http://127.0.0.1/table-regression.html"
    context.route(url, lambda route: route.fulfill(path=preview, content_type="text/html; charset=utf-8"))
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    page.goto(url)
    canvas, chrome = page.locator("#canvas"), page.locator(".table-controls")
    bar = page.locator("#text-format-bar")
    field = page.get_by_role("textbox", name="表格单元格内容")
    expect(page.locator("#tool-select")).to_have_attribute("aria-pressed", "true")
    for expanded in page.locator('.panel-toggle[aria-expanded="true"]').all():
        expanded.click()

    def open_bytes(data, name="table-test.mgcanvas"):
        page.locator("#project-picker").set_input_files(
            {"name": name, "mimeType": "application/json", "buffer": data})
        expect(page.locator("#status")).to_contain_text("项目已打开")

    def export():
        with page.expect_download() as pending:
            page.locator("#project-export").click()
        return json.loads(Path(pending.value.path()).read_text(encoding="utf-8"))

    def tables():
        return [item for item in export()["document"]["objects"].values() if item["kind"] == "table"]

    def position(row=0, col=0, rows=2, cols=2):
        rect = chrome.bounding_box()
        return rect["x"] + (col + .5) * rect["width"] / cols, rect["y"] + (row + .5) * rect["height"] / rows

    def cell(row=0, col=0, rows=2, cols=2):
        page.mouse.click(*position(row, col, rows, cols))

    def action(key):
        chrome.locator(f'[data-table-action="{key}"]').click()

    def format_choice(key, name=None):
        if name:
            bar.locator(f'[data-format-group="{key}"]').get_by_role("button", name=name, exact=True).click()
        else:
            bar.locator(f'button[data-format="{key}"]').click()

    fixture = Path(__file__).resolve().parents[1] / "docs/fixtures/M5X-Flow-Groups.mgcanvas"
    old = json.loads(fixture.read_bytes())
    open_bytes(fixture.read_bytes())
    assert export()["document"] == old["document"]
    empty = dict(schemaVersion=1, id="grid-check", theme="paper", objects={}, order=[], assets={})
    open_bytes(json.dumps(empty).encode())
    check_placement(page, canvas, chrome, export, empty, shots)
    check_dividers(page, canvas, chrome, bar, open_bytes, export, shots)
    open_bytes(json.dumps(empty).encode())
    page.locator("#tool-table").click()
    canvas.click(position={"x": 250, "y": 220})
    expect(chrome).to_be_visible()
    expect(bar).to_be_visible()
    assert [[c["text"] for c in r] for r in tables()[0]["cells"]] == [["", ""], ["", ""]]

    initial_table = tables()[0]
    whole_handle = chrome.get_by_role("button", name="选择整张表格")
    expect(whole_handle).to_have_attribute("aria-pressed", "true")
    expect(chrome).to_have_accessible_name("表格操作，整表")
    page.set_viewport_size({"width": 1024, "height": 768})
    check_compact_format(bar)
    page.set_viewport_size({"width": 1280, "height": 820})
    canvas.press("Alt+F10")
    assert bar.evaluate("el=>el.contains(document.activeElement)")
    page.keyboard.press("Escape")
    expect(canvas).to_be_focused()
    cell(0, 1)
    page.keyboard.down("Shift")
    cell(0, 0)
    page.keyboard.up("Shift")
    expect(whole_handle).to_have_attribute("aria-pressed", "false")
    expect(chrome).to_have_accessible_name("表格操作，单元格区域，第 1 行第 1 列至第 1 行第 2 列")
    check_compact_format(bar)
    format_choice("ink", "字色 · 红色")
    colored = tables()[0]
    assert [c["style"]["color"] for c in colored["cells"][0]] == ["#be384c"] * 2
    assert colored["cells"][1] == initial_table["cells"][1] and colored.get("style") == initial_table.get("style")
    page.locator("#undo").click()
    # Keep the right half of the selected row visible while its focused cell is offscreen.
    original = chrome.bounding_box()
    viewport = canvas.bounding_box()
    pan = round(original["x"] - viewport["x"] + original["width"] * .75)
    page.mouse.move(viewport["x"] + 700, viewport["y"] + 430)
    page.mouse.wheel(pan, 0)
    page.wait_for_function("""() => {const r=document.querySelector('.table-controls').getBoundingClientRect();
      const x=document.querySelector('#canvas').getBoundingClientRect().left;
      return r.left+r.width/2 < x && r.right > x;}""")
    expect(bar).to_be_visible()
    assert bar.bounding_box()["y"] + bar.bounding_box()["height"] < original["y"]
    bar.get_by_role("button", name="更多字号").click()
    size = bar.get_by_role("spinbutton", name="自定义字号")
    size.fill("21")
    size.fill("28")
    expect(size).to_be_focused()
    formatted = tables()[0]
    assert all(c["style"]["fontSize"] == 28 for c in formatted["cells"][0])
    assert formatted["cells"][1] == initial_table["cells"][1] and formatted.get("style") == initial_table.get("style")
    page.locator("#undo").click()
    assert tables()[0] == initial_table
    page.locator("#redo").click()
    assert tables()[0] == formatted
    page.locator("#undo").click()
    page.mouse.move(viewport["x"] + 700, viewport["y"] + 430)
    page.mouse.wheel(-pan, 0)
    page.wait_for_function("x=>Math.abs(document.querySelector('.table-controls').getBoundingClientRect().left-x)<1",
                           arg=original["x"])
    action("whole")
    expect(bar.locator('[data-format-group="background"]')).to_have_count(0)
    format_choice("size", "18 像素")
    expect(bar.locator('[data-menu="size"]')).to_have_text("⋯")
    format_choice("ink","字色 · 蓝色")
    assert tables()[0]["style"]["color"]=="#3567bd"
    page.locator("#undo").click()
    bar.get_by_role("button",name="更多字色").click()
    expect(bar.get_by_role("button",name="透明背景")).to_have_count(0)
    control = bar.get_by_role("textbox", name="自定义字色", exact=True)
    control.fill("#734165")
    control.press("Enter")
    defaults=tables()[0]
    assert defaults["style"]=={"color":"#734165","fontSize":18}
    assert defaults["cells"] == initial_table["cells"]
    cell(1, 1)
    expect(chrome).to_have_accessible_name("表格操作，单元格，第 2 行第 2 列")
    check_compact_format(bar)
    format_choice("ink", "自动字色")
    format_choice("size", "14 像素")
    override = tables()[0]
    assert override["cells"][1][1]["style"] == {"color": "auto", "fontSize": 14}
    assert override["style"] == defaults["style"]
    assert override["cells"][0] == defaults["cells"][0] and override["cells"][1][0] == defaults["cells"][1][0]
    action("row")
    chrome.get_by_role("button", name="选择整行").click()
    expect(chrome).to_have_accessible_name("表格操作，单元格区域，第 2 行第 1 列至第 2 行第 2 列")
    action("col")
    chrome.get_by_role("button", name="选择整列").click()
    expect(chrome).to_have_accessible_name("表格操作，单元格区域，第 1 行第 2 列至第 2 行第 2 列")
    canvas.press("Escape")
    expect(whole_handle).to_have_attribute("aria-pressed", "true")
    for _ in range(4):
        page.locator("#undo").click()
    assert tables()[0] == initial_table
    canvas.press("F2")
    expect(field).to_be_focused()
    field.fill("取消本次编辑")
    format_choice("bold")
    page.keyboard.press("Escape")
    assert tables()[0] == initial_table
    action("whole")

    cell()
    page.keyboard.press("p")
    expect(field).to_have_value("p")
    page.keyboard.press("Escape")
    driver = context.new_cdp_session(page)
    driver.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "Process", "windowsVirtualKeyCode": 229})
    expect(field).to_be_focused()
    native_field = field.element_handle()
    field.evaluate("el=>el.addEventListener('compositionend',()=>el.dataset.imeEnded='true',{once:true})")
    driver.send("Input.imeSetComposition", {"text": "项目", "selectionStart": 2, "selectionEnd": 2})
    format_choice("italic")
    expect(field).to_be_focused()
    assert field.evaluate("(el, original) => el === original && el.isConnected", native_field)
    expect(field).to_have_value("项目")
    assert field.get_attribute("data-ime-ended") is None
    page.keyboard.press("Enter")
    expect(field).to_be_visible()
    driver.send("Input.insertText", {"text": "项目计划"})
    expect(field).to_have_value("项目计划")
    # Wait for the editor's candidate-confirmation key suppression window before Tab.
    page.wait_for_timeout(65)
    page.keyboard.press("Tab")
    expect(field).to_have_count(0)
    page.keyboard.press("F2")
    field.fill("第二列")
    field.evaluate("el=>el.setSelectionRange(0,2)")
    format_choice("italic")
    assert field.evaluate("el=>[el.selectionStart,el.selectionEnd,el===document.activeElement]") == [0, 2, True]
    page.keyboard.press("Enter")
    expect(field).to_have_count(0)

    cell()
    bar.get_by_role("button",name="选择字体").click()
    bar.get_by_role("button",name="宋体（中易）",exact=True).click()
    format_choice("size", "24 像素")
    format_choice("bold")
    format_choice("strike")
    format_choice("align", "居中")
    action("addCol")
    action("addRow")
    table = tables()[0]
    text = lambda grid: [[v["text"] for v in row] for row in grid["cells"]]
    assert text(table) == [["项目计划", "第二列", ""], ["", "", ""], ["", "", ""]]
    style = table["cells"][0][0]["style"]
    assert style == dict(fontFamily="simsun", fontSize=24, fontWeight=700, italic=True, strike=True, align="center"), style
    assert table["cells"][0][1]["style"]["italic"]
    assert table["cells"][1][1].get("style") is None

    # Use the real browser's native copy/paste events for a rectangular range.
    canvas.focus()
    page.keyboard.down("Shift")
    cell(0, 1, 3, 3)
    page.keyboard.up("Shift")
    page.keyboard.press("Control+c")
    cell(1, 0, 3, 3)
    page.keyboard.press("Control+v")
    duplicated = tables()[0]
    assert text(duplicated)[1][:2] == ["项目计划", "第二列"]
    assert duplicated["cells"][1][0]["style"]["fontFamily"] == "simsun"
    page.locator("#undo").click()
    assert tables()[0] == table
    page.locator("#redo").click()
    assert tables()[0] == duplicated

    # A native plain-text control represents a spreadsheet offering only TSV.
    external = page.evaluate_handle("""()=>{const el=document.createElement('textarea');
      document.body.append(el);el.focus();return el;}""")
    page.keyboard.press("Control+v")
    page.wait_for_function("([el,expected])=>el.value===expected", arg=[external, "项目计划\t第二列"])
    external.evaluate("(el,value)=>{el.value=value;el.select();}", "编号\t金额\n甲\t120")
    page.keyboard.press("Control+c")
    external.evaluate("el=>el.remove()")
    cell(2, 2, 3, 3)
    page.keyboard.press("Control+v")
    expanded = text(tables()[0])
    assert expanded[2][2:] == ["编号", "金额"] and expanded[3][2:] == ["甲", "120"]
    page.locator("#undo").click()
    assert tables()[0] == duplicated

    # A cell can contain a literal string that resembles a whole-object clipboard envelope.
    cell(2, 2, 3, 3)
    page.keyboard.press("F2")
    literal = "MG-CANVAS-CLIPBOARD/单元格原文"
    field.fill(literal)
    page.keyboard.press("Enter")
    page.keyboard.press("Control+c")
    cell(2, 1, 3, 3)
    page.keyboard.press("Control+v")
    assert text(tables()[0])[2][1] == literal
    page.locator("#undo").click()
    page.locator("#undo").click()
    assert tables()[0] == duplicated

    cell(0, 0, 3, 3)
    page.keyboard.press("Control+x")
    expect(page.locator("#status")).to_contain_text("已剪切单元格")
    assert text(tables()[0])[0][0] == ""
    cell(2, 2, 3, 3)
    page.keyboard.press("Control+v")
    cut = tables()[0]["cells"][2][2]
    assert cut["text"] == "项目计划" and cut["style"]["fontFamily"] == "simsun" and cut["style"]["strike"]
    page.locator("#undo").click()
    page.locator("#undo").click()
    assert tables()[0] == duplicated
    cell(1, 0, 3, 3)

    action("row")
    page.get_by_role("button", name="在上方插入行").click()
    assert text(tables()[0])[2][:2] == ["项目计划", "第二列"]
    page.locator("#undo").click()
    action("col")
    page.get_by_role("button", name="删除此列").click()
    assert len(tables()[0]["cells"][0]) == 2
    page.locator("#undo").click()
    assert tables()[0] == duplicated
    action("whole")
    format_choice("align", "居右")
    whole = tables()[0]
    assert whole["style"]["align"] == "right"
    assert all("align" not in c.get("style", {}) for row in whole["cells"] for c in row)

    def drag(start, end):
        page.mouse.move(*start)
        page.mouse.down()
        page.mouse.move(*end, steps=5)
        page.mouse.up()
        page.evaluate("()=>new Promise(requestAnimationFrame)")

    start = position(1, 1, 3, 3)
    drag(start, (start[0] + 34, start[1] + 19))
    moved = tables()[0]
    assert moved["at"] == {"x": whole["at"]["x"] + 34, "y": whole["at"]["y"] + 19}
    rect = chrome.bounding_box()
    end = rect["x"] + rect["width"], rect["y"] + rect["height"]
    drag(end, (end[0] + 48, end[1] + 27))
    resized = tables()[0]
    assert resized["width"] == moved["width"] + 48 and resized["height"] == moved["height"] + 27
    assert resized["cells"] == whole["cells"]

    # Read painted glyphs and cell fill from the canvas in both themes.
    fills = {}
    for theme in ("dark", "light"):
        page.locator(f'label:has(#theme-{theme})').click()
        page.evaluate("()=>new Promise(requestAnimationFrame)")
        area = chrome.bounding_box()
        pixels = canvas.evaluate("""(canvas,b)=>{
          const rect=canvas.getBoundingClientRect(), d=canvas.width/rect.width;
          const c=canvas.getContext('2d'),x=Math.ceil((b.x-rect.x+8)*d),y=Math.ceil((b.y-rect.y+8)*d);
          const data=c.getImageData(x,y,Math.floor((b.width/3-16)*d),Math.floor((b.height/3-16)*d)).data;
          const lum=(r,g,b)=>[r,g,b].map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4})
            .reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
          const bg=lum(...data.slice(0,3));let readable=0;
          for(let i=0;i<data.length;i+=4){const ink=lum(data[i],data[i+1],data[i+2]);
            if((Math.max(bg,ink)+.05)/(Math.min(bg,ink)+.05)>=4.5)readable++;}
          return {fill:Array.from(data.slice(0,3)),readable};
        }""", area)
        assert pixels["readable"] > 20, (theme, pixels)
        fills[theme] = pixels["fill"]
        if shots:
            page.screenshot(path=shots / ("table-" + theme + ".png"))
    assert fills["dark"] != fills["light"]

    # Whole object paste uses the normal object fragment with a fresh ID.
    action("whole")
    page.keyboard.press("Control+c")
    page.keyboard.press("Control+v")
    copies = tables()
    assert len(copies) == 2 and copies[0]["id"] != copies[1]["id"] and copies[0]["cells"] == copies[1]["cells"]
    page.locator("#undo").click()
    # Persist explicit row and column dimensions through the normal local save slot as well.
    select_table_layer(page)
    rect = chrome.bounding_box()
    for axis in ("row", "col"):
        x = rect["x"] + rect["width"] * (.22 if axis == "row" else 2/3)
        y = rect["y"] + rect["height"] * (2/3 if axis == "row" else .22)
        drag((x, y), (x + (18 if axis == "col" else 0), y + (12 if axis == "row" else 0)))
    saved = export()
    assert saved["document"]["schemaVersion"] == 6
    persisted = next(iter(saved["document"]["objects"].values()))
    assert len(set(persisted["rowWeights"])) > 1 and len(set(persisted["columnWeights"])) > 1
    page.locator("#save").click()
    page.wait_for_function("""expected=>new Promise(resolve=>{
      const request=indexedDB.open('mg-canvas-previews',1);
      request.onsuccess=()=>{
        const db=request.result,read=db.transaction('boards').objectStore('boards').get('mg-canvas-engine:m1:board:protected-table-v6');
        read.onsuccess=()=>{db.close();resolve(read.result===expected);};
      };
    })""", arg=json.dumps(saved, ensure_ascii=False, separators=(",", ":")))
    open_bytes(fixture.read_bytes())
    page.locator("#file-history summary").click()
    page.locator("#open").click()
    expect(page.locator("#layers .layer")).to_have_count(1)
    assert export() == saved
    open_bytes(json.dumps(saved, ensure_ascii=False).encode())
    assert export() == saved
    page.reload()
    expect(page.locator("#layers .layer")).to_have_count(1)
    assert export() == saved
    select_table_layer(page)
    cell(0, 0, 3, 3)
    page.keyboard.press("F2")
    field.fill("刷新前的单元格草稿")
    format_choice("underline")
    expect(page.locator("#status")).to_have_attribute("data-workspace", "saved")
    page.reload()
    expect(field).to_have_value("刷新前的单元格草稿")
    expect(bar.locator('button[data-format="underline"]')).to_have_attribute("aria-pressed", "true")
    page.keyboard.press("Escape")
    assert export() == saved

    page.set_viewport_size({"width": 390, "height": 740})
    open_bytes(json.dumps(empty).encode())
    driver.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 2})

    def contact(kind, *points):
        driver.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [
            {"x": x, "y": y, "id": i + 1} for i, (x, y) in enumerate(points)]})

    page.locator("#tool-table").click()
    bounds = canvas.bounding_box()
    x, y = bounds["x"] + 46, bounds["y"] + 220
    contact("touchStart", (x, y))
    contact("touchStart", (x, y), (x + 90, y))
    contact("touchMove", (x, y), (x + 104, y + 4))
    contact("touchEnd")
    assert tables() == []
    contact("touchStart", (x, y))
    contact("touchEnd")
    expect(chrome).to_be_visible()
    expect(bar).to_be_visible()
    bar_box = bar.bounding_box()
    assert bar_box["x"] >= 0 and bar_box["x"] + bar_box["width"] <= 391
    pos = position()
    for _ in range(2):
        contact("touchStart", pos)
        contact("touchEnd")
    expect(field).to_be_focused()
    field.fill("触屏单元格")
    page.keyboard.press("Enter")
    assert text(tables()[0])[0][0] == "触屏单元格"
    assert not errors, errors
    print("Verified Chromium hover placement, grid lines, cancellation, zoom/pan, zero preview writes, "
          "table-top formatting of whole tables, single cells and partially visible ranges, grid controls, "
          "in-composition formatting, keyboard navigation, native clipboard, "
          "move/resize, glyph contrast in both themes, undo/redo, legacy/v6 save/reopen, draft restoration, "
          "narrow layout and touch/pinch input.", fills)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview", type=Path)
    parser.add_argument("--screenshots", type=Path)
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=str(local_browser(pw.chromium)), headless=True, chromium_sandbox=True,
                                     args=["--disable-background-networking"], timeout=15000)
        try:
            context = browser.new_context(viewport={"width": 1280, "height": 820}, device_scale_factor=1, accept_downloads=True)
            check(context.new_page(), context, args.preview.resolve(), args.screenshots)
        finally:
            browser.close()
