#!/usr/bin/env python3
"""Build a self-contained OpenAI Platform submission ZIP."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))["version"]
OUTPUT = ROOT / "dist" / f"opendeploy-{VERSION}.zip"
FILES = [
    "plugin.json",
    "README.md",
    "assets/icon.svg",
    "skills/opendeploy/SKILL.md",
    "skills/opendeploy/references/agent-client.md",
    "client/bin/opendeploy.mjs",
    "client/package.json",
    "client/package-lock.json",
]
DEPENDENCIES = ("yazl", "buffer-crc32")


def main() -> None:
    paths = [ROOT / name for name in FILES]
    for package in DEPENDENCIES:
        folder = ROOT / "client" / "node_modules" / package
        if not folder.is_dir():
            raise SystemExit(
                f"Missing {folder}. Run npm ci --ignore-scripts --prefix client first."
            )
        paths.extend(path for path in folder.rglob("*") if path.is_file())

    if any(not path.is_file() or path.is_symlink() for path in paths):
        raise SystemExit("A required file is missing or is a symbolic link.")
    OUTPUT.parent.mkdir(exist_ok=True)
    with ZipFile(OUTPUT, "w", ZIP_DEFLATED) as archive:
        for path in sorted(paths):
            archive.write(path, path.relative_to(ROOT).as_posix())
    print(OUTPUT)


if __name__ == "__main__":
    main()
