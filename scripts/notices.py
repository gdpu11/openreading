#!/usr/bin/env python3
"""Collect installed production dependency notices; no network access."""
import json
import pathlib
import re
import shutil
import subprocess
import struct

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "third-party"
out.mkdir(exist_ok=True)
entries = []
missing = []


def collect(name, version, folder, ecosystem):
    folder = pathlib.Path(folder)
    dest = out / ecosystem / re.sub(r"[^A-Za-z0-9._-]", "_", name)
    files = []
    for p in folder.iterdir():
        if p.is_file() and p.suffix != ".go" and re.match(r"^(licen[sc]e|copying|notice|patents|copyright)([._-].*)?$", p.name, re.I):
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dest / p.name)
            files.append(str((dest / p.name).relative_to(root)))
    for p in dest.glob("LICENSE*.upstream"):
        files.append(str(p.relative_to(root)))
    if ecosystem == "npm" and name == "katex":
        records = []
        for font in sorted((folder / "dist/fonts").glob("*.ttf")):
            data = font.read_bytes()
            for i in range(struct.unpack_from(">H", data, 4)[0]):
                tag, _, offset, _ = struct.unpack_from(">4sIII", data, 12 + i * 16)
                if tag != b"name":
                    continue
                _, count, strings = struct.unpack_from(">HHH", data, offset)
                notices = set()
                for j in range(count):
                    platform, _, _, name_id, size, location = struct.unpack_from(">HHHHHH", data, offset + 6 + j * 12)
                    if name_id not in {0, 13, 14}:
                        continue
                    raw = data[offset + strings + location:offset + strings + location + size]
                    notices.add(raw.decode("utf-16be" if platform in {0, 3} else "mac_roman"))
                if not notices:
                    raise SystemExit("No embedded font notice: " + str(font))
                records.append(font.name + "\n" + "\n\n".join(sorted(notices)))
        if not records:
            raise SystemExit("KaTeX font inventory is empty")
        target = dest / "FONT-NOTICE.txt"
        target.write_text("Exact copyright/license strings extracted from the shipped TTF name tables.\n\n" + "\n\n---\n\n".join(records) + "\n")
        files.append(str(target.relative_to(root)))
    if ecosystem == "npm" and name == "pako":
        source = folder / "lib/zlib/README"
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest / "ZLIB-NOTICE.txt")
        files.append(str((dest / "ZLIB-NOTICE.txt").relative_to(root)))
    if ecosystem == "npm" and name == "node-unrar-js":
        # The npm package omits the engine's license. Retain the exact text from
        # upstream v2.0.2/UnRarDLL_Doc/license.txt, checked into our notice bundle.
        notice = dest / "UNRAR-LICENSE.txt"
        if not notice.exists():
            raise SystemExit("Missing vendored UnRAR engine license")
        files.append(str(notice.relative_to(root)))
    if ecosystem == "npm" and name == "pdfjs-dist":
        for subdir in ["cmaps", "standard_fonts", "wasm", "iccs"]:
            for p in (folder / subdir).iterdir():
                if p.is_file() and re.match(r"^(license|notice|copying)", p.name, re.I):
                    target = dest / subdir / p.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(p, target)
                    files.append(str(target.relative_to(root)))
    if not files:
        missing.append(name)
        dest.mkdir(parents=True, exist_ok=True)
        for p in folder.iterdir():
            if p.is_file() and (p.name == "package.json" or p.name.lower() == "readme.md"):
                shutil.copyfile(p, dest / p.name)
                files.append(str((dest / p.name).relative_to(root)))
    entries.append({"name": name, "version": version, "ecosystem": ecosystem, "notices": files})


lock = json.loads((root / "package-lock.json").read_text())
for path, info in lock["packages"].items():
    if not path or info.get("dev"):
        continue
    folder = root / path
    if not (folder / "package.json").exists() and info.get("optional"):
        continue
    package = json.loads((folder / "package.json").read_text())
    collect(package["name"], package["version"], folder, "npm")
    entries[-1]["license"] = package.get("license", "See notices")
    if package["name"] == "node-unrar-js":
        entries[-1]["license"] = "MIT (wrapper); UnRAR license (WASM engine)"

env = dict(__import__("os").environ)
env.pop("GOROOT", None)
env["GOSUMDB"] = "sum.golang.org"
raw = subprocess.check_output(["go", "list", "-m", "-json", "all"], cwd=root, env=env, text=True)
decoder = json.JSONDecoder()
while raw.strip():
    obj, end = decoder.raw_decode(raw.lstrip())
    raw = raw.lstrip()[end:]
    if not obj.get("Main"):
        collect(obj["Path"], obj["Version"], obj["Dir"], "go")
goroot = subprocess.check_output(["go", "env", "GOROOT"], cwd=root, env=env, text=True).strip()
collect("Go runtime and standard library", subprocess.check_output(["go", "version"], cwd=root, env=env, text=True).strip(), goroot, "go")
(out / "manifest.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n")
lines = ["# Third-party notices", "", "Production dependency versions and copied upstream notices are listed below. Source project licensing is not changed by this file.", "", "Some upstream packages ship only license declarations in package metadata or README; those exact files are retained without inventing copyright statements. Optional platform packages absent from this installation are not redistributed.", ""]
for item in entries:
    links = ", ".join(f"[{pathlib.Path(p).name}]({p})" for p in item["notices"])
    lines.append(f"- {item['ecosystem']} {item['name']} {item['version']}: {links or 'No root notice found; see package metadata.'}")
(root / "THIRD_PARTY_NOTICES.md").write_text("\n".join(lines) + "\n")
print(json.dumps({"packages": len(entries), "missingRootNotices": missing}, ensure_ascii=False))
