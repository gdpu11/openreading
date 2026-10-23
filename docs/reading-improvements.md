# Reading improvements

Scope: improve the existing desktop/browser reader and redesign the mobile client around a calm bookshelf, notes, and settings. Pairing and synchronization belong in Settings. Preserve existing uncommitted work and personal libraries. No commit, publication, or installation is part of this change.

## Implementation checklist

- [x] Open notes by document ID independently of library pagination and filters.
- [x] Whole-book search with snippets and navigable results; searchable workspace content.
- [x] Search notes and conversations, lightweight tags, filtered Markdown export and stable source links.
- [x] Review queue with due dates, reveal and explicit review outcomes.
- [x] Named bookmarks and navigation history.
- [x] Explicit section/selected-note AI context with source preview and citations.
- [x] Automatic verified backups with bounded retention and visible status.
- [x] Optional OS-protected desktop credential storage, excluded from library backups.
- [x] Per-book reading preferences.
- [x] Mobile bookshelf/notes/settings navigation, chapter directory with current chapter highlighting and reader controls.
- [x] Local OCR integration, web article import, and read aloud with honest capability errors.
- [x] Backend/frontend checks, isolated browser verification and mobile visual QA.

## Verification

Implementation and local preview builds completed on 2026-10-23. All checks use isolated test data; existing `.data` and installed apps were preserved.

| Check | Result |
| --- | --- |
| Go 1.26.9 | Full test suite, server race detection and `go vet ./...` passed |
| Frontend | 65 tests passed; TypeScript and production build passed |
| Node | Five credential/packaging tests passed |
| Feature/browser/native flows | Nine passed, including offline phone navigation, current chapter highlighting, resumable transfers, actual Electron conversion and local OCR |
| Existing reader regression flows | Seven passed: Markdown selection, Unicode offsets, PDF highlights across 12 viewports, EPUB CFI reprojection, assistant citations, malicious EPUB isolation, backup/restore |
| Android debug APK | Offline Gradle build passed; all 554 bundled web resources match the final production build |
| macOS ARM preview | Packaged service startup and binary architecture passed; packaged main/preload/tools, service, OCR helper and Android APK match their built inputs |
| Visual QA | Inspected 390×844 light/dark bookshelf, settings and dark reader screenshots |

EPUB locations are read from recorded relocation events, so chapter highlighting cannot query the layout before EPUB initialization completes. The phone and desktop EPUB opening regression checks cover this case.

Local artifacts:

- Android: `release/reading-improvements-preview/Open-Reading-android-preview.apk`
- macOS ARM: `release/desktop/mac-arm64/Open Reading.app`
- Verification manifest and screenshots: `release/reading-improvements-preview/verification.json` and `docs/evidence/reading-improvements/`

## Use the new features

- Desktop/browser: use **全书搜索** in the reader for page/chapter results and previous/next navigation. **全文搜索** in the top bar can build/update the workspace index and search indexed books. TXT indexing uses the book's saved encoding.
- **笔记与复习** searches highlights, personal notes and saved AI answers, filters by tags or learning state, and exports only the current results. Select up to ten notes to ask AI with an explicit, previewable source package. **问本节** captures the current PDF page or EPUB chapter as an ordinary verifiable selection (existing selection/context limits still apply).
- Add a note to review, recall before revealing it, then choose 再想想 / 记住了 / 很熟悉. Reviews store due dates and revisions; phone changes use the existing durable, idempotent sync queue.
- Reader tools offer named bookmarks, position history and local-voice read aloud. Bookmarks retain their snapshot identity; historical bookmarks require opening that version. Per-book font, layout and text decoding preferences no longer leak to other books.
- Mobile uses **书架 / 笔记 / 设置** navigation, cover grids, continue-reading cards, chapter navigation and bottom reading tools. Pairing, synchronization, connection errors, device removal and ORD import live in Settings. Removing a connection clears the mobile cover cache along with its downloaded files.
- Desktop OCR uses macOS Vision, or an installed Tesseract with matching language data. Recognized text is saved separately by immutable version and page, participates in search, backups, LAN sync and ORD, and never rewrites the PDF. OCR does not add a selectable text layer to the image itself.
- Web article import accepts public HTML, previews editable extracted text, and imports a new local Markdown copy. Requests pin validated public DNS results and recheck redirects; credentials, private addresses and nonstandard ports are rejected.
- Settings → backup and restore: enable automatic backups, choose an interval and retention count. Only a successful new backup permits pruning automatic copies; manual copies remain. The app must be running.
- Model settings can explicitly remember a key with OS protection. Stored keys bind to the provider ID, protocol and endpoint and stay outside library/ORD exports. If system storage cannot be unlocked, reading remains available and the key can be re-entered.
- Markdown exports contain stable thread identifiers and source links. Packaged desktop clients register `openreading://read` for links from other apps; browser exports link to their local service origin.

## Delivery boundaries

Desktop and Android artifacts are local previews. iOS uses the shared updated UI source; no iOS physical-device or App Store verification is claimed. Read aloud needs a matching installed local voice and browser/WebView speech support. Real external AI quality is not established by mock/protocol tests.
