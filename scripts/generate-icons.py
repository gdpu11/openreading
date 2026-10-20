"""Compile the editable SVG mark for native launchers and browser tabs.

Requires rsvg-convert (brew install librsvg) and macOS iconutil, no Python packages.
"""
from pathlib import Path
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "desktop/assets"
SOURCE = ASSETS / "icon.svg"
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)
book = ET.parse(SOURCE).find(f".//{{{NS}}}g[@id='book']")
mark = ET.tostring(book, encoding="unicode")


def svg(body, width=1024, height=1024):
    return (f'<svg xmlns="{NS}" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}">{body}</svg>')


def render(source, size=None):
    command = ["rsvg-convert", "--format", "png"]
    if size:
        command += ["--width", str(size), "--height", str(size)]
    return subprocess.check_output(command, input=source.encode())


def save(path, source, size=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(render(source, size))


def png_size(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", path
    return struct.unpack(">II", data[16:24])


desktop = SOURCE.read_text()
save(ASSETS / "icon.png", desktop, 1024)
# Modern Windows ICO stores RGBA PNG images at each native launcher size.
sizes = [16, 24, 32, 48, 64, 128, 256]
images = [render(desktop, size) for size in sizes]
offset = 6 + 16 * len(sizes)
directory = bytearray(struct.pack("<HHH", 0, 1, len(sizes)))
for size, image in zip(sizes, images):
    directory.extend(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0,
                                 1, 32, len(image), offset))
    offset += len(image)
(ASSETS / "icon.ico").write_bytes(directory + b"".join(images))

# Explicit ICNS prevents stale conversions when repackaging an existing app.
with tempfile.TemporaryDirectory() as tmp:
    iconset = Path(tmp) / "OpenReading.iconset"
    iconset.mkdir()
    for size in [16, 32, 128, 256, 512]:
        for scale, suffix in [(1, ""), (2, "@2x")]:
            save(iconset / f"icon_{size}x{size}{suffix}.png", desktop, size * scale)
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(ASSETS / "icon.icns")], check=True)

res = ROOT / "native/android/app/src/main/res"
legacy = svg('<rect width="1024" height="1024" rx="224" fill="#fafafa"/>' + mark)
round_icon = svg('<circle cx="512" cy="512" r="512" fill="#fafafa"/>' + mark)
foreground = svg(mark)
for density, factor in [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)]:
    folder = res / ("mipmap-" + density)
    save(folder / "ic_launcher.png", legacy, int(48 * factor))
    save(folder / "ic_launcher_round.png", round_icon, int(48 * factor))
    # Adaptive foregrounds use a 108dp canvas, including the system mask margin.
    save(folder / "ic_launcher_foreground.png", foreground, int(108 * factor))

android = "http://schemas.android.com/apk/res/android"
ET.register_namespace("android", android)
vector = ET.Element("vector", {f"{{{android}}}" + key: value for key, value in {
    "width": "108dp", "height": "108dp", "viewportWidth": "1024", "viewportHeight": "1024"
}.items()})
group = ET.SubElement(vector, "group", {f"{{{android}}}translateY": "-8"})
for path in book:
    attributes = {"pathData": path.attrib["d"], "fillColor": path.get("fill", "#202024")}
    if attributes["fillColor"] == "none":
        attributes["fillColor"] = "#00000000"
    for source, target in [("stroke", "strokeColor"), ("stroke-width", "strokeWidth"),
                           ("stroke-linecap", "strokeLineCap"), ("opacity", "strokeAlpha")]:
        if source in path.attrib:
            attributes[target] = path.attrib[source]
    ET.SubElement(group, "path", {f"{{{android}}}" + key: value for key, value in attributes.items()})
(res / "drawable-v24/ic_launcher_foreground.xml").write_text(ET.tostring(vector, encoding="unicode") + "\n")
(res / "values/ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="ic_launcher_background">#fafafa</color></resources>\n')
for filename in ["ic_launcher.xml", "ic_launcher_round.xml"]:
    (res / "mipmap-anydpi-v26" / filename).write_text(
        f'<adaptive-icon xmlns:android="{android}"><background android:drawable="@color/ic_launcher_background"/>'
        '<foreground android:drawable="@drawable/ic_launcher_foreground"/></adaptive-icon>\n')

# iOS applies its own corner mask, so its input is an opaque, full square.
ios = ROOT / "native/ios/App/App/Assets.xcassets"
save(ios / "AppIcon.appiconset/AppIcon-512@2x.png", svg('<rect width="1024" height="1024" fill="#fafafa"/>' + mark), 1024)
for path in [*res.glob("drawable*/splash.png"), *(ios / "Splash.imageset").glob("*.png")]:
    width, height = png_size(path)
    side = min(width, height) // 2
    body = (f'<rect width="{width}" height="{height}" fill="#ffffff"/>'
            f'<svg x="{(width-side)//2}" y="{(height-side)//2}" width="{side}" height="{side}" viewBox="0 0 1024 1024">{mark}</svg>')
    save(path, svg(body, width, height))

public = ROOT / "public"
public.mkdir(exist_ok=True)
(public / "icon.svg").write_text(desktop)
print("Generated macOS, Windows, Android, iOS, splash and browser icons from desktop/assets/icon.svg")
