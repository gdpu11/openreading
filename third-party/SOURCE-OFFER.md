# License choices and corresponding source

Open Reading's MIT license applies to the project's own work. It does not
relicense dependencies, fonts, native SDKs, user-imported books or AI outputs.

For the unmodified, dual-licensed packages in this distribution, Open Reading
uses **Apache-2.0 for DOMPurify** and **MIT for JSZip**. pako requires both its
package MIT notice and the zlib port's notice; both are retained here.

The Go binary links `github.com/hashicorp/golang-lru/v2` v2.0.7 under MPL-2.0.
Its unmodified source is available at
<https://github.com/hashicorp/golang-lru/tree/v2.0.7> and through the Go module
proxy at <https://proxy.golang.org/github.com/hashicorp/golang-lru/v2/@v/v2.0.7.zip>.
The MPL license is in `go/github.com_hashicorp_golang-lru_v2/LICENSE`.
Open Reading does not change those covered source files. Modified redistributions
must make their covered modifications available under the applicable license.

PDF.js assets have additional font, CMap, color-profile and WASM component
licenses. Build output retains the upstream notices next to `pdf-assets/` and
also copies their notice files into the offline license bundle. System fonts
named in CSS are not copied into the project.

Electron distributions include their platform's Electron/Chromium notices;
distributors must retain the runtime's `LICENSE` and `LICENSES.chromium.html`.
The offline bundle here covers the application dependencies and Go service,
not an assertion that all platform SDKs have the same license.

Native dependencies need separate review. In particular, the Android barcode
scanner pulls in Google ML Kit, which has its own terms and privacy disclosures:
<https://developers.google.com/ml-kit/terms>. Do not describe every byte of a
native installer as MIT-licensed. Before distributing rebuilt native packages,
record their resolved Maven/Swift dependency versions and corresponding notices.
