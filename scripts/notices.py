#!/usr/bin/env python3
"""Collect installed production dependency notices; no network access."""
import json
import pathlib
import re
import shutil
import subprocess

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
        if p.is_file() and re.match(r"^(licen[sc]e|copying|notice|patents|copyright)([._-].*)?$", p.name, re.I):
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dest / p.name)
            files.append(str((dest / p.name).relative_to(root)))
    for p in dest.glob("LICENSE.upstream"):
        files.append(str(p.relative_to(root)))
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
