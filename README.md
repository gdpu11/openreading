# Open Reading

**Video explanations (first version):** Generate an illustrated guide from the reader toolbar with local Chinese narration, captions, chapter navigation and links back to the original. Preview the source excerpts before sending them to your configured model. Completed scripts are cached locally. See [usage and limitations](docs/video-guides.md).

**Highlight a passage. Ask AI. Keep your thinking beside the text.**

Open Reading is a local-first reader for **EPUB, PDF, MOBI/AZW3, FB2, DOCX, HTML, RTF, CBZ/CBR, Markdown and TXT**. Ask questions about a selected passage, follow up beside the original text, convert between PDF and EPUB, and keep books and notes on your own computer.

**MIT licensed · Preview software · English / 简体中文**

[中文说明](README.zh-CN.md) · [Downloads](https://github.com/gdpu11/openreading/releases) · [Known limitations](docs/known-limitations.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md)

![Open Reading library](docs/images/library.png)

## What it does

- **Highlight to ask AI.** Select a passage and choose **Ask AI** to explain a concept, give an example, translate it or explore how to apply it. Continue the conversation beside the passage, with your notes and the source together. Choose your own compatible model service and preview the context before sending.
- **Convert PDF ↔ EPUB.** Turn a PDF into an EPUB using original-page images or extracted, reflowed text. On desktop, export EPUB to a newly paginated PDF. Conversion creates a separate file and retains the original book and notes; annotations are not transferred to the converted book.
- **Your computer is the library.** Local reading and notes work without a cloud account or your own server. Import files or connect a folder.
- **Read side by side.** Desktop books open in separate windows. EPUB supports chapter scrolling, single-page and two-page layouts; PDF supports continuous scrolling, two-page layouts and zoom shortcuts.
- **Keep notes with their source.** Highlight passages, write notes, revisit discussions and export a book with saved annotations in an `.ord` learning package.
- **Sync over your LAN.** After desktop approval, browse and search authorized computer workspaces from your phone and sync selected books. The desktop can also select books, folders or workspaces. Pairing and searching alone do not download books. Phone picks preserve existing desktop selections; offline notes and interrupted downloads can resume. Pairing, receiving and phone book selection live in Settings → Computer & sync.
- **See your reading activity.** See session and cumulative book reading time on desktop and phone. Offline time merges when your computer is reachable, independently of file downloads; retries and overlapping intervals do not inflate totals. A global calendar, streaks, word counts and configurable estimates are included.
- **Find and revisit ideas.** Search entire books and indexed library content; search and tag notes, review due notes, save named bookmarks and export notes with source links. See [reading improvements](docs/reading-improvements.md).
- **Organize your library.** Covers, search, sorting, format filters, favorites and finished status. Removing a book from a library keeps its file; original-file deletion requires a separate explicit choice.
- **Receive AI-written documents over MCP.** Connect Codex or Cursor from **Settings → MCP connections** to create and revise Markdown / TXT in your library. Updates keep previous snapshots and notes. See [MCP setup](docs/mcp.md).

## Try passage-based AI questions

1. Open **Settings → Models & privacy**. Add a compatible Chat Completions provider, enter its endpoint and API key, choose a model and enable it for the current workspace.
2. Open a book, select a passage and click **Ask AI** in the selection toolbar.
3. Write a question, or use a shortcut such as **Explain simply**, **Give an example**, **Translate** or **How to apply this**. Choose the selected passage alone or include nearby text, then use **Preview what will be sent** to inspect the context before sending.
4. Continue asking questions in the same discussion, and keep your own notes beside the original text.

For example: “What does this paragraph mean? Give me a concrete example.” Then follow up with “How would I apply this idea at work?”

AI is optional and requires your own configured model service; provider charges may apply. Selected context and relevant conversation history go to that provider. Ordinary reading, highlighting and notes work without a model.

![Highlights and notes beside the original text](docs/images/reading-notes.png)

To convert a book, right-click it in the library and choose **Convert to EPUB** or **Convert to PDF**. Desktop PDF → EPUB defaults to automatic text and illustration recognition: high-resolution local OCR reflows body text and attempts to crop illustrations into separate images in reading order. On macOS, it compares two passes and retries uncertain regions. It does not attach full-page scans or require manual confirmation. Page-image and existing-text-layer modes remain available. It uses macOS Vision or installed Tesseract with the relevant language data. Blurry characters, tables, columns and small figures may not be fully recovered; automatic recognition is not human proofreading. Engine errors stop conversion. EPUB → PDF requires the desktop app. All conversion runs locally.

## Platform status

| Platform | Status |
| --- | --- |
| macOS | Electron desktop; Apple Silicon and Intel build targets. Preview packages are unsigned and not notarized. |
| Windows | Electron desktop x64 build target; source and CI build support. |
| Android | Capacitor client; debug APK builds for testing local-network pairing. |
| iOS | Source and simulator build support. No App Store or TestFlight distribution is provided yet. |
| Browser / Linux | Local Go web service and browser reader; no Linux Electron installer is provided. |

See [native clients](docs/native-clients.md) for building and installing previews. A successful build is not a claim of physical-device testing on every platform.

## Build from source

Requirements: Node.js 24+, npm and Go as specified in `go.mod`. Native Android/iOS builds additionally need their platform SDKs.

```sh
git clone https://github.com/gdpu11/openreading.git
cd openreading
npm ci
npm run build
go build -o release/openreading ./cmd/openreading
./release/openreading --data-dir .data
```

Open the loopback URL printed in the terminal and enter its pairing code. On Windows use `release/openreading.exe`. The web service binds to loopback by default; it does not expose the administrative UI to your LAN.

Desktop development:

```sh
npm run desktop:dev
```

Package a desktop build on a compatible host:

```sh
npm run desktop:pack:mac:arm64
# Intel Mac:
npm run desktop:pack:mac:intel
# Run on Windows (Intel / AMD):
npm run desktop:pack:windows
```

For Android/iOS setup, see [native build instructions](docs/native-clients.md). GitHub Actions builds the native targets; download links appear in Releases when artifacts have been validated and published.

## Checks

```sh
npm test
npm run build
go vet ./...
go test ./... -count=1
go test ./internal/server -race -count=1
```

Browser tests need a built `release/openreading` binary and a supported browser. Set `CHROME_PATH` to your Chrome/Chromium executable when it differs from the default macOS path:

```sh
CHROME_PATH=/path/to/chrome npm run test:e2e -- tests/browser/system.spec.ts
```

Tests use generated fixtures and isolated temporary libraries. Live cloud tests are skipped unless you explicitly supply your own test origin and credentials. Do not run destructive tests against a library you use for reading.

## Privacy and boundaries

- Books and notes stay in your selected local data directory. LAN sync is opt-in, uses certificate-pinned TLS and requires desktop approval for each device.
- Optional AI requests go to the endpoint you configure. API keys stay in server-process memory by default and are excluded from backups. Desktop users can opt into OS-protected credential storage bound to the configured provider endpoint.
- No hosted service is configured in the public source. Self-hosting is optional; see [the architecture notes](docs/architecture.md).
- Desktop OCR recognizes individual pages using macOS Vision or an installed Tesseract engine and saves separate text; it does not rewrite the PDF. Fixed-layout, encrypted and unusually complex books may not render or convert faithfully. PDF text reflow may lose illustrations and complex layout.
- Back up your library before trying preview versions. Original-file deletion is permanent; removing a library entry is reversible.
- The public repository contains generated demonstration books only. Personal libraries, deployment records, credentials and local test screenshots are excluded.

## Contributing and license

Bug reports and small, focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

Open Reading source code is licensed under [MIT](LICENSE). Dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `third-party/`.

See the [compliance review and unresolved distribution items](docs/compliance-review.md) and [asset provenance](docs/asset-provenance.md). The Android scanner includes Google ML Kit with separate terms and metrics disclosures. Rebuilt clients include an offline `/licenses/index.html`; older release packages have not been retroactively updated by source changes.

Supported extensions and format limitations: [Book formats](docs/book-formats.md).
