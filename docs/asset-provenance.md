# Distributed assets and provenance

This inventory covers files tracked in the public Git repository. It records
technical provenance; it is not an independent determination of ownership,
employment rights, trademark clearance or patent rights.

| Assets | Recorded origin and scope |
| --- | --- |
| `fixtures/*.epub`, `fixtures/*.pdf`, fixture text and `diagram.svg` | Synthetic test documents produced by `scripts/fixtures.mjs`. The malicious-content EPUB is a security fixture, not a downloading or exfiltration feature. The URLs in that fixture use `example.invalid`. |
| `docs/images/library.png`, `docs/images/reading-notes.png` | Project demonstration screenshots using generated example books and notes. The visible sample titles/covers are demonstration content, not scanned commercial-book covers. Source generation and ownership are based on the project's development record, not third-party title clearance. |
| `desktop/assets/icon.svg` and generated launcher icons | Editable project SVG and derivatives rendered by `scripts/generate-icons.py`. The current SVG uses geometric paths. Similarity and trademark rights have not been independently searched worldwide. |
| Native splash screens and app scaffolding | Capacitor/native project scaffolding and generated project icons; upstream licenses remain applicable. |
| KaTeX fonts and PDF.js fonts/CMaps/WASM/color profiles in build output | Third-party assets. Retain their separate upstream licenses; the project's MIT license does not replace them. |
| System font family names in styles | References to fonts installed on the user's system, not distribution of those system-font files. |

Do not add commercial books, downloaded covers, publisher logos, proprietary
fonts, private reading screenshots or third-party AI examples without documenting
permission and any attribution conditions. Public availability alone is not a
redistribution license. A user-imported document is not automatically licensed
for redistribution through ORD export or synchronization.

The public tree and reachable public history were checked for the prior personal
library/deployment markers during the 2026-10-20 review. This does not prove that
every possible copied fragment or unpublished ownership claim has been excluded.
