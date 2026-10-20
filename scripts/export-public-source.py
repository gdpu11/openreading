#!/usr/bin/env python3
"""Export a reviewable source tree without private history or runtime evidence."""
from pathlib import Path
import hashlib
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
DEST = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "release/public-source"
if DEST.exists():
    raise SystemExit("Destination already exists; choose a new empty directory")
SKIP = {".git", "node_modules", ".gradle", ".idea", "build", "DerivedData", "xcuserdata", "__pycache__", "capacitor-cordova-android-plugins", "capacitor-cordova-ios-plugins"}
ROOT_FILES = ["README.md", "README.zh-CN.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md", "go.mod", "go.sum", "package.json", "package-lock.json", "index.html", "m0.html", "tsconfig.json", "vite.config.ts", "vitest.config.ts", "playwright.config.ts", "capacitor.config.ts", "start.command", ".gitattributes"]
DOCS = ["architecture.md", "decisions.md", "known-limitations.md", "ord-format.md", "lan-sync.md", "native-clients.md", "fixtures.md", "release-review.md"]
SCRIPTS = ["build.sh", "build-desktop.mjs", "copy-assets.mjs", "fixtures.mjs", "generate-icons.py", "notices.py", "openapi.py", "package-desktop.mjs", "verify.sh", "export-public-source.py"]

def copy(file):
    if file.is_symlink() or not file.is_file():
        return
    rel = file.relative_to(ROOT)
    if any(part in SKIP for part in rel.parts):
        return
    if file.name == "local.properties" or file.name.startswith(".env") or file.suffix.lower() in {".pem", ".key", ".jks", ".keystore", ".p12", ".pfx", ".sqlite", ".log"}:
        raise SystemExit("Private-looking file encountered: " + rel.as_posix())
    target = DEST / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(file, target)

for name in ROOT_FILES:
    copy(ROOT / name)
for name in ["cmd", "config", "web", "tests", "fixtures", "public", "third-party", ".github"]:
    for file in (ROOT / name).rglob("*"):
        copy(file)
for file in (ROOT / "internal").rglob("*"):
    if "static" not in file.relative_to(ROOT / "internal").parts:
        copy(file)
for file in (ROOT / "desktop").rglob("*"):
    if not {"runtime", "mobile"}.intersection(file.relative_to(ROOT / "desktop").parts):
        copy(file)
for file in (ROOT / "native").rglob("*"):
    rel = file.relative_to(ROOT / "native")
    if "public" in rel.parts or file.name in {"local.properties", "capacitor.config.json", "capacitor.plugins.json", "config.xml"}:
        continue
    copy(file)
for name in DOCS:
    if (ROOT / "docs" / name).exists():
        copy(ROOT / "docs" / name)
for file in (ROOT / "docs/images").glob("*"):
    copy(file)
for name in SCRIPTS:
    copy(ROOT / "scripts" / name)
# Embedding needs one placeholder before the first frontend build. Bundles and
# PDF worker/font assets are rebuilt by npm run build, never copied from a workstation.
static = DEST / "internal/server/static"
static.mkdir(parents=True, exist_ok=True)
(static / "BUILD_REQUIRED.txt").write_text("Run npm run build before starting Open Reading.\n")
ignore = (ROOT / ".gitignore").read_text().replace("# Keep the completed verification logs with the source\n!docs/evidence/*.log\n", "")
ignore += "\n# Private evidence and generated frontend output\ndocs/evidence/\ninternal/server/static/*\n!internal/server/static/BUILD_REQUIRED.txt\n*.bundle\n"
(DEST / ".gitignore").write_text(ignore)
files = sorted(p for p in DEST.rglob("*") if p.is_file())
sums = [hashlib.sha256(p.read_bytes()).hexdigest() + "  " + p.relative_to(DEST).as_posix() for p in files]
(DEST / "SOURCE_SHA256SUMS").write_text("\n".join(sums) + "\n")
print(f"Exported {len(files)} source files to {DEST}")
