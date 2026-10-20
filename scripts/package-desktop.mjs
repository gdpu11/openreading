import { execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { desktopTarget } from "./desktop-target.mjs";
function cli(pkg, name) {
  const metadata = resolve("node_modules", pkg, "package.json");
  const info = JSON.parse(readFileSync(metadata, "utf8"));
  return resolve(
    dirname(metadata),
    typeof info.bin === "string" ? info.bin : info.bin[name],
  );
}
const args = process.argv.slice(2);
const target = desktopTarget(args);
const env = { ...process.env, GOOS: target.goos, GOARCH: target.goarch };
// Bundle the APK so private previews can be installed without a GitHub login.
mkdirSync("desktop/mobile", { recursive: true });
const androidAPK =
  process.env.OPENREADING_ANDROID_APK ||
  "native/android/app/build/outputs/apk/debug/app-debug.apk";
const bundledAPK = "desktop/mobile/Open-Reading-android.apk";
rmSync(bundledAPK, { force: true });
if (existsSync(androidAPK)) copyFileSync(androidAPK, bundledAPK);
else if (process.env.OPENREADING_ANDROID_APK)
  throw Error("Android APK not found: " + androidAPK);
execFileSync(process.execPath, [cli("typescript", "tsc"), "--noEmit"], {
  env,
  stdio: "inherit",
});
execFileSync(process.execPath, [cli("vite", "vite"), "build"], {
  env,
  stdio: "inherit",
});
execFileSync(process.execPath, ["scripts/copy-assets.mjs"], {
  env,
  stdio: "inherit",
});
execFileSync(process.execPath, ["scripts/build-desktop.mjs"], {
  env,
  stdio: "inherit",
});
execFileSync(
  process.execPath,
  [
    cli("electron-builder", "electron-builder"),
    "--config",
    "desktop/builder.json",
    ...target.builderArgs,
    "--publish",
    "never",
  ],
  { env, stdio: "inherit" },
);
