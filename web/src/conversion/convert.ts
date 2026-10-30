import JSZip from "jszip";
import * as pdfjs from "../readers/pdf";
import { api, readContent } from "../api";
import { openEpub } from "../readers/epub";
import { tr } from "../i18n";
import { ocrParagraphs } from "./ocrText";
import {
  detectIllustrations,
  lineInsideFigure,
  type DetailedOCR,
} from "./pdfIllustrations";
export type PdfEpubMode = "images" | "text" | "ocr";
const escape = (s: string) =>
  s
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c]!,
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
export async function conversionSource(book: any, signal: AbortSignal) {
  const current = await api(`/documents/${book.id}`, "GET", undefined, {
    signal,
  });
  const binding = current.bindings.find(
    (b: any) =>
      b.state === "active" &&
      b.bindingState === "active" &&
      b.sourceState === "active",
  );
  let version: string;
  if (binding) {
    const prepared = await api(
      `/documents/${current.documentId}/prepare`,
      "POST",
      {
        workspaceDocumentId: book.id,
        sourceEntryId: binding.id,
        purpose: "conversion",
      },
      { signal },
    );
    version = prepared.version.id;
  } else {
    const versions = await api(
      `/documents/${current.documentId}/versions?workspaceDocumentId=${book.id}`,
      "GET",
      undefined,
      { signal },
    );
    if (!versions.length) throw Error(tr("原文件和历史快照均不可用，无法转换"));
    version = versions[0].id;
  }
  return readContent(version, book.id, signal);
}
export async function pdfToEpub(
  raw: ArrayBuffer,
  title: string,
  mode: PdfEpubMode,
  signal: AbortSignal,
  progress: (done: number, total: number, stage?: "ocr") => void,
): Promise<Uint8Array> {
  const recognizePage = window.openReadingDesktop?.recognizePage;
  const recognizeDetailed = window.openReadingDesktop?.recognizePageDetailed;
  if (mode === "ocr" && !recognizePage)
    throw Error(tr("扫描页文字识别需要桌面端，请使用带本地 OCR 的客户端。"));
  signal.throwIfAborted();
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const task = pdfjs.getDocument({
    data: new Uint8Array(raw),
    cMapUrl: "/pdf-assets/cmaps/",
    standardFontDataUrl: "/pdf-assets/standard_fonts/",
    wasmUrl: "/pdf-assets/wasm/",
    enableXfa: false,
  });
  let rejectPassword: (error: Error) => void = () => {};
  const password = new Promise<never>((_, reject) => {
    rejectPassword = reject;
  });
  task.onPassword = () => {
    rejectPassword(Error(tr("PDF 已加密，请先解锁后转换")));
    void task.destroy();
  };
  const cancel = () => {
    void task.destroy();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const pdf = await Promise.race([task.promise, password]);
    signal.throwIfAborted();
    const manifest: string[] = [],
      spine: string[] = [],
      links: string[] = [];
    let imageBytes = 0;
    const ocrReport: {
      page: number;
      engine: string;
      lines: number;
      uncertainLines: number;
      illustrations: number;
    }[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      signal.throwIfAborted();
      progress(n - 1, pdf.numPages);
      const page = await pdf.getPage(n);
      let body = "";
      // A scan can contain a watermark or an incomplete hidden text layer.
      // Explicit OCR must recognize the rendered page instead of accepting it
      // as complete book text. The text-only mode still uses the PDF layer.
      if (mode === "text") {
        const content = await page.getTextContent();
        let previous: any = null,
          lines: string[] = [],
          line = "";
        for (const item of content.items) {
          if (!("str" in item)) continue;
          if (
            previous &&
            (previous.hasEOL ||
              Math.abs(item.transform[5] - previous.transform[5]) > 3)
          ) {
            if (line.trim()) lines.push(line.trim());
            line = "";
          }
          const spacer =
            line &&
            !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(
              line,
            ) &&
            !/^\s/.test(item.str)
              ? " "
              : "";
          line += spacer + item.str;
          previous = item;
        }
        if (line.trim()) lines.push(line.trim());
        if (lines.length)
          body = lines
            .map((line) => `<p dir="auto">${escape(line)}</p>`)
            .join("\n");
      }
      if (!body) {
        const base = page.getViewport({ scale: 1 }),
          viewport = page.getViewport({
            scale:
              mode === "ocr"
                ? Math.min(4, 2400 / base.width, 3400 / base.height)
                : Math.min(2, 1600 / base.width, 2200 / base.height),
          });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const render = page.render({ canvas, viewport, background: "#ffffff" });
        const stop = () => render.cancel();
        signal.addEventListener("abort", stop, { once: true });
        try {
          try {
            await render.promise;
          } finally {
            signal.removeEventListener("abort", stop);
          }
          signal.throwIfAborted();
          if (mode === "ocr") {
            progress(n - 1, pdf.numPages, "ocr");
            const image = canvas.toDataURL("image/png");
            if (recognizeDetailed) {
              const result: DetailedOCR = await recognizeDetailed(image);
              signal.throwIfAborted();
              const analysis = document.createElement("canvas");
              analysis.width = Math.min(600, canvas.width);
              analysis.height = Math.max(
                1,
                Math.round((canvas.height * analysis.width) / canvas.width),
              );
              const context = analysis.getContext("2d", {
                willReadFrequently: true,
              });
              if (!context) throw Error(tr("无法分析书页插图"));
              let figures;
              try {
                context.drawImage(
                  canvas,
                  0,
                  0,
                  analysis.width,
                  analysis.height,
                );
                figures = detectIllustrations(
                  context.getImageData(0, 0, analysis.width, analysis.height),
                  result.lines,
                );
              } finally {
                analysis.width = analysis.height = 0;
              }
              const pictureBlocks: { at: number; html: string }[] = [];
              for (let f = 0; f < figures.length; f++) {
                signal.throwIfAborted();
                const figure = figures[f],
                  crop = document.createElement("canvas");
                crop.width = Math.max(
                  1,
                  Math.ceil(figure.width * canvas.width),
                );
                crop.height = Math.max(
                  1,
                  Math.ceil(figure.height * canvas.height),
                );
                try {
                  const context = crop.getContext("2d");
                  if (!context) throw Error(tr("无法提取书页插图"));
                  context.drawImage(
                    canvas,
                    figure.left * canvas.width,
                    figure.top * canvas.height,
                    figure.width * canvas.width,
                    figure.height * canvas.height,
                    0,
                    0,
                    crop.width,
                    crop.height,
                  );
                  const blob = await new Promise<Blob>((resolve, reject) =>
                    crop.toBlob(
                      (blob) =>
                        blob
                          ? resolve(blob)
                          : reject(Error("Canvas export failed")),
                      "image/png",
                    ),
                  );
                  imageBytes += blob.size;
                  if (imageBytes > 180 * 1024 * 1024)
                    throw Error(tr("转换结果超过大小上限，请拆分 PDF 后重试"));
                  const id = `figure-${n}-${f + 1}`,
                    href = `images/${id}.png`;
                  zip.file(`EPUB/${href}`, await blob.arrayBuffer(), {
                    compression: "STORE",
                  });
                  manifest.push(
                    `<item id="${id}" href="${href}" media-type="image/png"/>`,
                  );
                  const after = result.lines.findIndex(
                    (line) => 1 - line.box.y - line.box.height > figure.top,
                  );
                  pictureBlocks.push({
                    at: after < 0 ? result.lines.length : after,
                    html: `<figure><img src="${href}" alt="${escape(tr(`第 ${n} 页`))} · ${f + 1}" style="max-width:100%;height:auto;display:block;margin:auto"/></figure>`,
                  });
                } finally {
                  crop.width = crop.height = 0;
                }
              }
              const blocks: string[] = [],
                textLines: string[] = [];
              const flush = () => {
                blocks.push(
                  ...ocrParagraphs(textLines.join("\n")).map(
                    (text) => `<p dir="auto">${escape(text)}</p>`,
                  ),
                );
                textLines.length = 0;
              };
              for (let l = 0; l <= result.lines.length; l++) {
                const pictures = pictureBlocks.filter((p) => p.at === l);
                if (pictures.length) {
                  flush();
                  blocks.push(...pictures.map((p) => p.html));
                }
                const line = result.lines[l];
                if (
                  line &&
                  !figures.some((figure) => lineInsideFigure(line, figure))
                )
                  textLines.push(line.text);
              }
              flush();
              body = blocks.join("\n");
              ocrReport.push({
                page: n,
                engine: result.engine,
                lines: result.lines.length,
                uncertainLines: result.lines.filter(
                  (line) => line.uncertain || line.confidence < 0.9,
                ).length,
                illustrations: figures.length,
              });
            } else {
              const text = await recognizePage!(image);
              body = ocrParagraphs(text)
                .map((line) => `<p dir="auto">${escape(line)}</p>`)
                .join("\n");
              ocrReport.push({
                page: n,
                engine: "local-ocr",
                lines: text.split(/\n/).filter((line) => line.trim()).length,
                uncertainLines: 0,
                illustrations: 0,
              });
            }
            signal.throwIfAborted();
          }
          if (!body && mode !== "ocr") {
            const blob = await new Promise<Blob>((resolve, reject) =>
              canvas.toBlob(
                (blob) =>
                  blob ? resolve(blob) : reject(Error("Canvas export failed")),
                "image/jpeg",
                0.88,
              ),
            );
            imageBytes += blob.size;
            if (imageBytes > 180 * 1024 * 1024)
              throw Error(tr("转换结果超过大小上限，请拆分 PDF 后重试"));
            zip.file(`EPUB/images/page-${n}.jpg`, await blob.arrayBuffer(), {
              compression: "STORE",
            });
            manifest.push(
              `<item id="image-${n}" href="images/page-${n}.jpg" media-type="image/jpeg"${n === 1 ? ' properties="cover-image"' : ""}/>`,
            );
            body = `<img src="images/page-${n}.jpg" alt="${escape(tr(`第 ${n} 页`))}" style="max-width:100%;height:auto;display:block;margin:auto"/>`;
          }
        } finally {
          canvas.width = canvas.height = 0;
        }
      }
      zip.file(
        `EPUB/page-${n}.xhtml`,
        `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escape(tr(`第 ${n} 页`))}</title><meta charset="utf-8"/><style>body{margin:0;padding:1em;font-size:1em;line-height:1.8}p{margin:0 0 .8em}figure{margin:1em 0}</style></head><body>${body}</body></html>`,
      );
      manifest.push(
        `<item id="page-${n}" href="page-${n}.xhtml" media-type="application/xhtml+xml"/>`,
      );
      spine.push(`<itemref idref="page-${n}"/>`);
      links.push(
        `<li><a href="page-${n}.xhtml">${escape(tr(`第 ${n} 页`))}</a></li>`,
      );
      page.cleanup();
      progress(n, pdf.numPages);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (mode === "ocr")
      zip.file(
        "META-INF/openreading-ocr.json",
        JSON.stringify({
          mode: "automatic-text-and-illustrations",
          pages: ocrReport,
        }),
      );
    zip.file(
      "EPUB/nav.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${links.join("")}</ol></nav></body></html>`,
    );
    zip.file(
      "EPUB/book.opf",
      `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:${crypto.randomUUID()}</dc:identifier><dc:title>${escape(title)}</dc:title><dc:language>und</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`,
    );
    signal.throwIfAborted();
    return await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    });
  } finally {
    signal.removeEventListener("abort", cancel);
    await task.destroy();
  }
}
export async function epubToPdf(
  raw: ArrayBuffer,
  title: string,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
  sourceFormat = "epub",
) {
  if (!window.openReadingDesktop)
    throw Error(tr("请在桌面端将 EPUB 转换为 PDF"));
  const opened = await openEpub(raw, sourceFormat);
  try {
    const html = await opened.printHTML(title, signal, progress);
    signal.throwIfAborted();
    return await window.openReadingDesktop.renderBookPDF(html);
  } finally {
    opened.dispose();
    opened.book.destroy();
  }
}
