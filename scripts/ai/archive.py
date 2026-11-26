"""Build or inspect a project-only offline ZIP. All members are held to fixed names and sizes."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

NAMES = ("board.mgcanvas", "index.html")
LIMITS = {"board.mgcanvas": 288 << 20, "index.html": 512 << 20, "manifest.json": 4096}


def hashes(files):
    return {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in files.items()}


def verify(path):
    with zipfile.ZipFile(path, "r") as archive:
        if sorted(archive.namelist()) != sorted(LIMITS):
            raise ValueError("unexpected ZIP members")
        if any(m.file_size > LIMITS[m.filename] for m in archive.infolist()):
            raise ValueError("oversized ZIP member")
        files = {name: archive.read(name) for name in NAMES}
        manifest = json.loads(archive.read("manifest.json"))
        if manifest != {"format": "mgcanvas-offline/1", "files": hashes(files)}:
            raise ValueError("manifest mismatch")
        project = json.loads(files["board.mgcanvas"])
        start = b'<script id="mgcanvas-project" type="application/json">'
        before, marker, tail = files["index.html"].partition(start)
        embedded, end, _ = tail.partition(b"</script>")
        if not marker or not end or json.loads(embedded) != project:
            raise ValueError("preview and project differ")
        return files["board.mgcanvas"]


def main():
    command, path, *rest = sys.argv[1:]
    if command == "create":
        directory = Path(rest[0])
        files = {name: (directory / name).read_bytes() for name in NAMES}
        manifest = {"format": "mgcanvas-offline/1", "files": hashes(files)}
        with zipfile.ZipFile(path, "x") as archive:
            for name, data in {**files, "manifest.json": json.dumps(manifest).encode()}.items():
                entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                archive.writestr(entry, data, compress_type=zipfile.ZIP_DEFLATED)
        verify(path)
    elif command == "verify":
        sys.stdout.buffer.write(verify(path))
    else:
        raise ValueError("unknown command")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, zipfile.BadZipFile, RuntimeError, KeyError) as error:
        sys.exit(str(error))
