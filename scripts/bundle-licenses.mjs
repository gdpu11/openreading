// Keep the same offline notices in the Go-embedded UI and Capacitor clients.
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "internal/server/static/licenses");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "PRIVACY.md"])
  await cp(resolve(root, file), resolve(output, file));
await cp(resolve(root, "third-party"), resolve(output, "third-party"), {
  recursive: true,
});
// Asset-level notices are distinct from the PDF.js package's Apache license.
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const source = resolve(root, "node_modules/pdfjs-dist", directory);
  const target = resolve(output, "pdf-assets", directory);
  await mkdir(target, { recursive: true });
  for (const name of await readdir(source))
    if (/^(license|notice|copying)/i.test(name))
      await cp(resolve(source, name), resolve(target, name));
}
// pako's zlib port has an additional notice below its package root.
await cp(
  resolve(root, "node_modules/pako/lib/zlib/README"),
  resolve(output, "third-party/npm/pako/ZLIB-NOTICE.txt"),
);
await writeFile(
  resolve(output, "index.html"),
  '<!doctype html><meta charset="utf-8"><title>Open Reading licenses</title>' +
    '<h1>Open Reading — licenses and privacy</h1><ul>' +
    '<li><a href="LICENSE">Project MIT license</a></li>' +
    '<li><a href="THIRD_PARTY_NOTICES.md">Third-party notices</a></li>' +
    '<li><a href="PRIVACY.md">Privacy / 隐私说明</a></li>' +
    '<li><a href="third-party/SOURCE-OFFER.md">Source availability and license choices</a></li></ul>',
);
// Fail the build if the index points to absent primary documents.
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "PRIVACY.md", "third-party/SOURCE-OFFER.md"])
  await readFile(resolve(output, file));
