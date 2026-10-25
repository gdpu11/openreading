import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error Build-only ESM plugin.
import { browserParsers } from "./scripts/browser-parsers.mjs";
export default defineConfig({
  plugins: [react(), browserParsers()],
  build: { outDir: "internal/server/static", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:7318" } },
});
