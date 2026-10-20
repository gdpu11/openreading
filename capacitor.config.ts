import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = {
  appId: "cn.ixiaoshi.openreading",
  appName: "Open Reading",
  webDir: "internal/server/static",
  android: { path: "native/android", allowMixedContent: false },
  ios: { path: "native/ios", contentInset: "automatic" },
  server: { androidScheme: "https" },
  plugins: { CapacitorHttp: { enabled: false } },
};
export default config;
