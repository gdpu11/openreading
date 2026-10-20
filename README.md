# Open Reading

A local-first reader for **EPUB, PDF, Markdown and TXT**. Read, annotate and organize your books on your own computer, then sync with your phone over your local network.

**MIT licensed · Preview software · English / 简体中文**

[中文说明](README.zh-CN.md) · [Downloads](https://github.com/gdpu11/openreading/releases) · [Known limitations](docs/known-limitations.md) · [Security](SECURITY.md)

![Open Reading library](docs/images/library.png)

## What it does

- **Your computer is the library.** Local reading and notes work without a cloud account or your own server. Import files or connect a folder.
- **Read side by side.** Desktop books open in separate windows. EPUB supports chapter scrolling, single-page and two-page layouts; PDF supports continuous scrolling, two-page layouts and zoom shortcuts.
- **Keep notes with their source.** Highlight passages, write notes, revisit discussions and export a book with saved annotations in an `.ord` learning package.
- **Sync over your LAN.** Pair your Android phone with the desktop, approve the device and sync selected workspaces. Offline notes are queued for later synchronization; conflicting edits retain drafts.
- **See your reading activity.** A foreground-only session timer, global calendar, streaks, word counts and configurable reading-time estimates.
- **Organize your library.** Covers, search, sorting, format filters, favorites and finished status. Removing a book from a library keeps its file; original-file deletion requires a separate explicit choice.
- **Convert books.** PDF → EPUB as original-page images or extracted, reflowed text. Desktop EPUB → PDF uses an isolated local A4 print pipeline. Originals and existing notes are retained; annotations are not transferred to converted books.
- **Optional reading assistance.** Connect your own compatible Chat Completions endpoint and API key. Ordinary reading and notes do not require a model. You can review the selected context before sending it to your chosen provider.

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
npm run desktop:pack -- --mac --arm64
# macOS Intel: --mac --x64
# Windows x64: --win --x64
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
- Optional AI requests go to the endpoint you configure. API keys remain in server-process memory and are excluded from backups; you must re-enter them after a restart.
- No hosted service is configured in the public source. Self-hosting is optional; see [the architecture notes](docs/architecture.md).
- Scanned pages are not OCRed. Fixed-layout, encrypted and unusually complex books may not render or convert faithfully. PDF text reflow may lose illustrations and complex layout.
- Back up your library before trying preview versions. Original-file deletion is permanent; removing a library entry is reversible.
- The public repository contains generated demonstration books only. Personal libraries, deployment records, credentials and local test screenshots are excluded.

## Contributing and license

Bug reports and small, focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

Open Reading source code is licensed under [MIT](LICENSE). Dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `third-party/`.
