"""Create the reproducible source ZIP for a built standalone preview."""
from pathlib import Path
import argparse
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("preview", type=Path, help="Built Canvas-M…-Preview.html")
parser.add_argument("destination", type=Path, help="New ZIP path")
args = parser.parse_args()
preview = args.preview.resolve(strict=True)
if not preview.is_file() or not preview.match("Canvas-M*-Preview.html"):
    parser.error("provide a built standalone preview")
destination = args.destination.resolve()
folders = ("app", "core", "docs", "features", "platform", "preview", "renderers", "scene",
           "scripts", "session", "src-tauri", "tests")
root_files = (".gitattributes", ".gitignore", "AGENTS.md", "README.md", "package.json", "package-lock.json")
files = {name: root / name for name in root_files}
ignored_dirs = {"__pycache__", ".pytest_cache", "target", "node_modules"}
for folder in folders:
    if destination.is_relative_to(root / folder):
        parser.error("choose a ZIP destination outside the source directories")
    for source in (root / folder).rglob("*"):
        relative = source.relative_to(root)
        if ignored_dirs.intersection(relative.parts) or relative.is_relative_to("src-tauri/gen/schemas"):
            continue
        if source.is_file() and source.suffix not in {".pyc", ".pyo"}:
            files[relative.as_posix()] = source

files["preview/" + preview.name] = preview
with zipfile.ZipFile(destination, "x") as archive:
    for name, source in sorted(files.items()):
        entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
print(destination, len(files), "files")
