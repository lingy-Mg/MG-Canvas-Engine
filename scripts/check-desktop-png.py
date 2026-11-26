"""Exercise the native Windows PNG CLI against a local file and inspect decoded pixels."""
import argparse
import base64
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageChops


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "docs" / "fixtures"
COLORS = [(242, 48, 66), (53, 173, 93), (47, 96, 220), (249, 203, 57)]


def cli(command, project, output, *options, error=None):
    run = subprocess.run(
        [*command, "png", "--file", str(project), "--out", str(output), *options],
        cwd=ROOT, capture_output=True, encoding="utf-8", timeout=100,
    )
    result = json.loads(run.stdout)
    if error:
        assert run.returncode and result["code"] == error and not output.exists(), result
        return
    assert run.returncode == 0 and result["ok"] is True, (result, run.stderr)
    with Image.open(output) as png:
        assert png.format == "PNG" and png.size == (result["width"], result["height"])
        pixels = png.convert("RGB")
    assert hashlib.sha256(output.read_bytes()).hexdigest() == result["sha256"]
    return result, pixels


def write(path, board):
    path.write_text(json.dumps(board, ensure_ascii=False), encoding="utf-8")
    return path


def verify(exe, work, compare):
    command = [str(exe)]
    seed = json.loads((FIXTURES / "M5AF-Layer-Search.mgcanvas").read_bytes())
    board = seed["document"]
    shape = board["objects"]["s-0"]
    board.update(objects={"s-0": shape}, order=["s-0"])
    shape["label"] = "中文"
    picture_fixture = json.loads((FIXTURES / "M5AE-Image-Cache.mgcanvas").read_bytes())
    picture = picture_fixture["document"]["objects"]["home-0"]
    picture["at"] = {"x": 135, "y": 0}
    board["objects"][picture["id"]] = picture
    board["order"].append(picture["id"])
    asset_id = picture["assetId"]
    asset = Image.new("RGB", (32, 16))
    for i, color in enumerate(COLORS):
        x, y = (i % 2) * 16, (i // 2) * 8
        asset.paste(color, (x, y, x + 16, y + 8))
    data = BytesIO()
    asset.save(data, format="PNG")
    seed["assets"] = {asset_id: base64.b64encode(data.getvalue()).decode("ascii")}
    board["assets"] = {
        asset_id: dict(id=asset_id, mime="image/png", pixelWidth=32, pixelHeight=16)
    }
    project = write(work / "画板.mgcanvas", seed)
    native, pixels = cli(command, project, work / "完整.png", "--scale", "2")
    assert pixels.size == (446, 152) and native["objectCount"] == 2 and native["imageCount"] == 1
    for i, color in enumerate(COLORS):
        x = 135 + (16 if i % 2 == 0 else 48)
        y = 11 if i < 2 else 33
        assert pixels.getpixel((round(native["offset"]["x"] + x * 2),
                                round(native["offset"]["y"] + y * 2))) == color

    label, label_pixels = cli(command, project, work / "label.png", "--id", "s-0", "--scale", "2")
    assert label["scope"] == {"kind": "object", "id": "s-0"} and label["imageCount"] == 0
    crop = (65, 42, 205, 112)
    mask = label_pixels.crop(crop).convert("L").point(lambda v: 255 if v < 120 else 0)
    assert sum(mask.histogram()[1:]) > 80
    same_ratio = None
    if compare:
        dev = ["node", "scripts/mgcanvas.mjs"]
        legacy, reference = cli(dev, project, work / "chromium.png", "--scale", "2")
        for key in ("width", "height", "offset", "bounds", "scope", "objectCount", "imageCount"):
            assert native[key] == legacy[key], key
        # Allow small differences in text antialiasing across Chromium versions.
        r, g, b = ImageChops.difference(pixels, reference).split()
        same = ImageChops.lighter(ImageChops.lighter(r, g), b).histogram()[0]
        same_ratio = same / (pixels.width * pixels.height)
        assert same_ratio > .97

    rejected = work / "rejected.png"
    cli(command, project, rejected, "--id", "missing", error="NOT_FOUND")
    cli(command, project, rejected, "--scale", "0", error="INVALID")
    shape.update(width=2181)
    wide = write(work / "wide.mgcanvas", seed)
    cli(command, wide, rejected, "--id", "s-0", "--scale", "2", error="TOO_LARGE")
    fitted, _ = cli(command, wide, work / "fitted.png", "--id", "s-0")
    assert fitted["width"] == 1600 and 0 < fitted["scale"] < 1
    cli(command, FIXTURES / "M5AE-Image-Cache.mgcanvas", rejected, error="TOO_LARGE")
    board.update(objects={}, order=[], assets={})
    seed["assets"] = {}
    empty = write(work / "empty.mgcanvas", seed)
    metadata, blank = cli(command, empty, work / "empty.png")
    assert metadata["objectCount"] == 0 and metadata["bounds"] is None
    assert blank.size == (256, 192) and blank.getpixel((0, 0)) == (243, 245, 249)
    return {"imageSize": pixels.size, "imageQuadrants": COLORS,
            "chineseGlyphPixels": sum(mask.histogram()[1:]), "emptySize": blank.size,
            "chromiumSamePixelRatio": same_ratio}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("exe", type=Path, help="absolute path to the native mgcanvas.exe")
    parser.add_argument("--compare", action="store_true", help="compare with the development Chromium worker")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="mgcanvas-native-png-") as directory:
        # Native rendering should still run with an invalid development-worker browser setting.
        if not args.compare:
            os.environ["MGCANVAS_BROWSER"] = str(Path(directory) / "missing" / "chrome.exe")
        print(json.dumps(verify(args.exe.resolve(strict=True), Path(directory), args.compare)))


if __name__ == "__main__":
    main()
