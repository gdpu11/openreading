import { mkdir, cp } from "node:fs/promises";
await mkdir("internal/server/static/pdf-assets", { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"])
  await cp(
    "node_modules/pdfjs-dist/" + dir,
    "internal/server/static/pdf-assets/" + dir,
    { recursive: true },
  );
