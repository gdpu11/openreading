import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Arch } from "electron-builder";
import { desktopTarget } from "./desktop-target.mjs";
import verifyDesktop, {
  binaryTarget,
  verifyBinary,
} from "./verify-desktop.mjs";

test("Intel Mac and Windows build matching Go and Electron architectures on an ARM host", () => {
  const mac = desktopTarget(["--mac", "--x64", "--dir"], "darwin", "arm64");
  assert.equal(mac.goos, "darwin");
  assert.equal(mac.goarch, "amd64");
  assert.deepEqual(mac.builderArgs, ["--mac", "--x64", "--dir"]);
  const win = desktopTarget(["--win"], "darwin", "arm64");
  assert.equal(win.goos, "windows");
  assert.equal(win.goarch, "amd64");
  assert.deepEqual(win.builderArgs, ["--win", "--x64"]);
  assert.deepEqual(desktopTarget([], "win32", "x64").builderArgs, [
    "--win",
    "--x64",
  ]);
  assert.equal(desktopTarget([], "darwin", "arm64").goarch, "arm64");
});

test("ambiguous or unsupported platform and architecture flags fail before packaging", () => {
  for (const args of [
    ["--mac", "--win"],
    ["--x64", "--arm64"],
    ["--universal"],
    ["--ia32"],
    ["--arch=x64"],
    ["--platform=win32"],
    ["--linux"],
    ["--mac=x64"],
  ])
    assert.throws(() => desktopTarget(args, "darwin", "arm64"));
  assert.throws(() => desktopTarget([], "linux", "x64"));
});

function executable(platform, arch) {
  const header = Buffer.alloc(128);
  if (platform === "darwin") {
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(arch === "x64" ? 0x1000007 : 0x100000c, 4);
  } else {
    header.write("MZ");
    header.writeUInt32LE(64, 0x3c);
    header.writeUInt32LE(0x4550, 64);
    header.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 68);
  }
  return header;
}

test("package checks inspect Mach-O and PE headers and reject the wrong service architecture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openreading-binary-test-"));
  try {
    const path = join(dir, "binary");
    for (const platform of ["darwin", "win32"]) {
      for (const arch of ["x64", "arm64"]) {
        await writeFile(path, executable(platform, arch));
        assert.deepEqual(await binaryTarget(path), { platform, arch });
        await verifyBinary(path, platform, arch);
        await assert.rejects(
          verifyBinary(path, platform, arch === "x64" ? "arm64" : "x64"),
          /expected/,
        );
      }
    }
    await writeFile(path, "not an executable");
    await assert.rejects(binaryTarget(path), /Unsupported/);
    await writeFile(path, executable("win32", "x64").subarray(0, 65));
    await assert.rejects(binaryTarget(path), /Unsupported/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("afterPack blocks an Intel installer containing an Apple Silicon service", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openreading-package-test-"));
  try {
    const contents = join(dir, "Open Reading.app", "Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await mkdir(join(contents, "Resources", "runtime"), { recursive: true });
    await writeFile(
      join(contents, "MacOS", "Open Reading"),
      executable("darwin", "x64"),
    );
    await writeFile(
      join(contents, "Resources", "runtime", "openreading"),
      executable("darwin", "arm64"),
    );
    await assert.rejects(
      verifyDesktop({
        appOutDir: dir,
        electronPlatformName: "darwin",
        arch: Arch.x64,
        packager: { appInfo: { productFilename: "Open Reading" } },
      }),
      /expected darwin\/x64, found darwin\/arm64/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
