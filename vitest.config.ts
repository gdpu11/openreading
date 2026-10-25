import { defineConfig } from "vitest/config";
import { browserParsers } from "./scripts/browser-parsers.mjs";
export default defineConfig({
  plugins: [browserParsers()],
  resolve: {
    alias: {
      mammoth: new URL(
        "./node_modules/mammoth/mammoth.browser.js",
        import.meta.url,
      ).pathname,
      ...Object.fromEntries(
        ["mobi-parser", "shared"].map((name) => [
          `@lingo-reader/${name}`,
          new URL(
            `./node_modules/@lingo-reader/${name}/dist/index.browser.mjs`,
            import.meta.url,
          ).pathname,
        ]),
      ),
    },
  },
  test: { include: ["web/src/**/*.test.ts"] },
});
