import { mkdir, cp, writeFile } from "node:fs/promises";
await mkdir("internal/server/static/pdf-assets", { recursive: true });
await writeFile("internal/server/static/BUILD_REQUIRED.txt", "Run npm run build before starting Open Reading.\n");
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"])
  await cp(
    "node_modules/pdfjs-dist/" + dir,
    "internal/server/static/pdf-assets/" + dir,
    { recursive: true },
  );
await import("./bundle-licenses.mjs");
