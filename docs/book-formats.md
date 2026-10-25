# 书籍格式 / Book formats

| 类型 | 扩展名 | 阅读方式 |
| --- | --- | --- |
| EPUB / Kobo | `.epub`, `.kepub`, `.kepub.epub` | 原有 EPUB 阅读器 |
| PDF | `.pdf` | 原有 PDF 阅读器，保留页面布局 |
| Kindle | `.mobi`, `.azw`, `.prc`, `.azw3`, `.kf8` | 无 DRM 的 MOBI / KF8，保留章节、图片和书内链接 |
| FictionBook | `.fb2`, `.fbz`, `.fb2.zip` | 章节、正文、脚注链接与内嵌图片 |
| Word | `.docx` | 正文、标题、表格、脚注与内嵌图片 |
| 网页 | `.html`, `.htm`, `.xhtml` | 正文与内嵌图片；按文件声明解码 |
| Rich Text | `.rtf` | 正文、Unicode、基本排版与受支持的内嵌图片 |
| 漫画 | `.cbz`, `.cbr` | 图片文件名自然排序，例如 1、2、10；每张图片一节 |
| 文本 | `.txt`, `.md`, `.markdown` | 原有文本 / Markdown 阅读器 |

连接文件夹或通过“导入阅读资料”导入。新增格式在本机解析，复用 EPUB 的目录、阅读进度、书签、搜索、划线和笔记功能。阅读工具栏的“本节笔记”也可为无文字的漫画页记录想法。漫画图片不会自动 OCR，因此图片内文字暂不能用于全文搜索或 AI 解说。

原文件、版本哈希与来源格式保持不变；本机生成的阅读结构不会覆盖原文。同步和 ORD 学习包保留原始文件与笔记，接收设备需更新到支持相应格式的版本。桌面端也可把这些新增格式转换为 PDF。

HTML 的相对图片、远程图片、远程样式和脚本不自动加载；需要自包含 HTML，或先导出为 EPUB / PDF。DOCX、RTF 采用适合阅读的重排布局，不保证与 Word 分页完全一致。PDF 的固定页面保持原样。

不支持带 DRM 的 Kindle 文件、KFX、加密/分卷漫画、旧版 `.doc` 或 `.djvu`。这些文件请先通过有权使用的工具导出为无 DRM 的 EPUB / PDF；修改扩展名不能转换格式。CBR 解压只在内存中进行。单文件上限 200 MB；压缩包至多 5000 个条目、展开总大小 512 MiB、单条目 64 MiB，并检查路径和压缩比。

## Implementation and validation

Pinned browser parser adapters live in `scripts/browser-parsers.mjs`: DOCX uses the native XML parser, and UnRAR uses static Embind wrappers compatible with the existing `script-src` policy. Parser upgrades must retain the real-browser checks, including nested raster images in Kindle SVG covers.

Additional formats are normalized locally into a stable EPUB spine. The backend retains source bytes and source format; EPUB CFIs remain usable after reopening, synchronization and ORD export. Parsers are loaded on demand and do not send books to a conversion service. Scripts and external resources are blocked by the existing sanitized EPUB renderer.

Tests cover text extraction, chapters, internal links, images, natural comic order, RAR WASM extraction, concurrent CBR decoding, DRM rejection, archive traversal and XML entity rejection. Backend tests cover original-byte preservation, format filters, native anchors and ORD round trips.

Real-world Kindle validation uses Project Gutenberg's public-domain [Alice's Adventures in Wonderland](https://www.gutenberg.org/ebooks/11), downloaded through that page's MOBI and KF8 links. These external fixtures are not shipped with the app. To repeat that extra check, place them at `alice.mobi` and `alice.azw3` in a local fixture directory and run:

```sh
OPENREADING_KINDLE_FIXTURES=/absolute/path/to/fixtures npm test -- web/src/readers/bookFormats.test.ts
```
