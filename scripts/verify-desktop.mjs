import { open, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Arch } from "electron-builder";

export async function binaryTarget(path) {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead === 64 && header.readUInt32LE(0) === 0xfeedfacf) {
      const arch = { [0x1000007]: "x64", [0x100000c]: "arm64" }[
        header.readUInt32LE(4)
      ];
      if (arch) return { platform: "darwin", arch };
    }
    if (bytesRead === 64 && header.toString("ascii", 0, 2) === "MZ") {
      const pe = Buffer.alloc(6);
      const result = await file.read(
        pe,
        0,
        pe.length,
        header.readUInt32LE(0x3c),
      );
      const arch = { [0x8664]: "x64", [0xaa64]: "arm64" }[pe.readUInt16LE(4)];
      if (result.bytesRead === 6 && pe.readUInt32LE(0) === 0x4550 && arch)
        return { platform: "win32", arch };
    }
    throw Error("Unsupported desktop executable: " + path);
  } finally {
    await file.close();
  }
}

export async function verifyBinary(path, platform, arch) {
  const actual = await binaryTarget(path);
  if (actual.platform !== platform || actual.arch !== arch)
    throw Error(
      `${path}: expected ${platform}/${arch}, found ${actual.platform}/${actual.arch}`,
    );
}

async function smokeService(binary) {
  const data = await mkdtemp(join(tmpdir(), "openreading-package-check-"));
  const child = spawn(
    binary,
    ["--port", "0", "--data-dir", data, "--machine-readable"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  let timer;
  try {
    const ready = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error("Packaged service startup timed out")),
        30000,
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(Error("Packaged service exited: " + code)),
      );
      lines.once("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type !== "ready")
            throw Error("Missing service ready event");
          resolve(event);
        } catch (e) {
          reject(e);
        }
      });
    });
    clearTimeout(timer);
    const response = await fetch(ready.url + "/api/health", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (await response.json()).status !== "ok")
      throw Error("Packaged service health check failed");
    const page = await fetch(ready.url, { signal: AbortSignal.timeout(5000) });
    if (!page.ok || !(await page.text()).includes("Open Reading"))
      throw Error("Packaged web assets missing");
  } finally {
    clearTimeout(timer);
    lines.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.kill();
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    }
    await rm(data, { recursive: true, force: true });
  }
}

export default async function verifyDesktop(context) {
  const platform = context.electronPlatformName,
    arch = Arch[context.arch];
  const product = context.packager.appInfo.productFilename;
  const contents = join(context.appOutDir, product + ".app", "Contents");
  const resources =
    platform === "darwin"
      ? join(contents, "Resources")
      : join(context.appOutDir, "resources");
  const electron =
    platform === "darwin"
      ? join(contents, "MacOS", product)
      : join(context.appOutDir, product + ".exe");
  const service = join(
    resources,
    "runtime",
    platform === "win32" ? "openreading.exe" : "openreading",
  );
  await verifyBinary(electron, platform, arch);
  await verifyBinary(service, platform, arch);
  if (platform === process.platform && arch === process.arch) {
    await smokeService(service);
    console.log(
      `Verified desktop package and service startup: ${platform}/${arch}`,
    );
  } else
    console.log(
      `Verified desktop binary architecture: ${platform}/${arch}; startup requires the matching host`,
    );
}
