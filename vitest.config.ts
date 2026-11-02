import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { browserParsers } from "./scripts/browser-parsers.mjs";
export default defineConfig({
  plugins: [browserParsers()],
  resolve: {
    alias: {
      mammoth: fileURLToPath(
        new URL("./node_modules/mammoth/mammoth.browser.js", import.meta.url),
      ),
      ...Object.fromEntries(
        ["mobi-parser", "shared"].map((name) => [
          `@lingo-reader/${name}`,
          fileURLToPath(
            new URL(
              `./node_modules/@lingo-reader/${name}/dist/index.browser.mjs`,
              import.meta.url,
            ),
          ),
        ]),
      ),
    },
  },
  test: { include: ["web/src/**/*.test.ts"] },
});
