import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
const goos =
  process.env.GOOS ||
  { win32: "windows" }[process.platform] ||
  process.platform;
const goarch =
  process.env.GOARCH || { x64: "amd64", arm64: "arm64" }[process.arch];
if (
  !["windows", "darwin", "linux"].includes(goos) ||
  !["amd64", "arm64"].includes(goarch)
)
  throw Error("Unsupported desktop target");
rmSync("desktop/runtime", { recursive: true, force: true });
mkdirSync("desktop/runtime", { recursive: true });
const env = {
  ...process.env,
  GOOS: goos,
  GOARCH: goarch,
  CGO_ENABLED: "0",
  GOSUMDB: "sum.golang.org",
};
delete env.GOROOT;
execFileSync(
  "go",
  [
    "build",
    "-trimpath",
    "-ldflags=-s -w",
    "-o",
    join(
      "desktop/runtime",
      goos === "windows" ? "openreading.exe" : "openreading",
    ),
    "./cmd/openreading",
  ],
  { env, stdio: "inherit" },
);

if (goos === "darwin" && process.platform === "darwin") {
  execFileSync("xcrun", ["swiftc", "-O", "-target", `${goarch === "amd64" ? "x86_64" : "arm64"}-apple-macosx12.0`, "desktop/ocr.swift", "-o", "desktop/runtime/openreading-ocr"], {stdio:"inherit"});
}
