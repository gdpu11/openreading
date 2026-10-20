import { defineConfig } from "@playwright/test";
const browserName = (process.env.OR_BROWSER || "chromium") as
  "chromium" | "firefox" | "webkit";
export default defineConfig({
  testDir: "tests/browser",
  outputDir: process.env.OR_TEST_OUTPUT_DIR || "test-results",
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          process.env.OR_REPORT_FILE ||
          `docs/evidence/browser-results-${browserName}.json`,
      },
    ],
  ],
  use: {
    browserName,
    baseURL: "http://127.0.0.1:7318",
    viewport: { width: 1480, height: 1000 },
    launchOptions:
      browserName === "chromium"
        ? {
            executablePath:
              process.env.CHROME_PATH ||
              (process.platform === "darwin"
                ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                : undefined),
          }
        : {},
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
