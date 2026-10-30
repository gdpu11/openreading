import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { tr } from "../i18n";
import {
  conversionSource,
  pdfToEpub,
  epubToPdf,
  type PdfEpubMode,
} from "./convert";
export function ConversionDialog({
  book,
  workspaceId,
  close,
  done,
}: {
  book: any;
  workspaceId: string;
  close: () => void;
  done: () => Promise<void>;
}) {
  const target = book.format === "pdf" ? "epub" : "pdf";
  const title = (
    book.bindings[0]?.relativePath?.split("/").pop() || "Book"
  ).replace(
    /\.(pdf|epub|mobi|azw3|azw|prc|kf8|fb2|fbz|docx|html|htm|xhtml|rtf|cbz|cbr)$/i,
    "",
  );
  const [mode, setMode] = useState<PdfEpubMode>(
      window.openReadingDesktop?.recognizePageDetailed ? "ocr" : "images",
    ),
    [add, setAdd] = useState(true),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  return (
    <div className="modal-backdrop">
      <section
        className="modal book-operation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tr("转换书籍")}
      >
        <h2>
          {book.format.toUpperCase()} → {target.toUpperCase()}
        </h2>
        <p className="book-operation-title">{title}</p>
        <p>
          {tr(
            "生成独立的新文件，原书和原有笔记保留；笔记不会迁移到转换后的书籍。",
          )}
        </p>
        {target === "epub" && (
          <>
            <label>
              {tr("转换方式")}
              <select
                disabled={busy}
                aria-label={tr("转换方式")}
                value={mode}
                onChange={(e) => setMode(e.target.value as PdfEpubMode)}
              >
                <option value="images">{tr("保留原版页面（图片）")}</option>
                <option value="text">{tr("提取文字重排")}</option>
                <option
                  value="ocr"
                  disabled={!window.openReadingDesktop?.recognizePageDetailed}
                >
                  {tr("自动识别文字与插图（推荐）")}
                </option>
              </select>
            </label>
            <small>
              {tr(
                mode === "images"
                  ? "保留扫描页、插图和原始版式，文字不会转为可选择文本。"
                  : mode === "ocr"
                    ? "在本机高分辨率识别，自动复识别疑点；正文可调字号和重排，插图按位置提取，不附整页扫描图。复杂排版和模糊内容可能无法完整还原。"
                    : "提取 PDF 文字层，复杂排版和插图可能不保留；无文字页保留图片，不进行 OCR。",
              )}
            </small>
            {!window.openReadingDesktop?.recognizePageDetailed && (
              <small>
                {tr("扫描页文字识别需要桌面端，请使用带本地 OCR 的客户端。")}
              </small>
            )}
          </>
        )}
        {target === "pdf" && (
          <small>{tr("按 A4 纸张重新分页，保留可提取文字和书内图片。")}</small>
        )}
        <label className="operation-choice">
          <input
            type="checkbox"
            disabled={busy}
            checked={add}
            onChange={(e) => setAdd(e.target.checked)}
          />
          <span>{tr("完成后加入当前书库")}</span>
        </label>
        {status && <p role="status">{status}</p>}
        {error && (
          <p role="alert" className="error">
            {tr(error)}
          </p>
        )}
        <div className="modal-actions">
          <button
            onClick={() => {
              abort.current?.abort();
              close();
            }}
          >
            {tr(busy ? "取消转换" : "取消")}
          </button>
          <button
            className="primary"
            disabled={busy || (target === "pdf" && !window.openReadingDesktop)}
            onClick={async () => {
              const controller = new AbortController();
              abort.current = controller;
              setBusy(true);
              setError("");
              setStatus(tr("正在读取原书…"));
              try {
                const raw = await conversionSource(book, controller.signal);
                const progress = (done: number, total: number, stage?: "ocr") =>
                  setStatus(
                    tr(
                      stage === "ocr"
                        ? `正在识别第 ${done + 1} / ${total} 页…`
                        : `正在转换 ${done} / ${total}`,
                    ),
                  );
                const bytes = new Uint8Array(
                  target === "epub"
                    ? await pdfToEpub(
                        raw,
                        title,
                        mode,
                        controller.signal,
                        progress,
                      )
                    : await epubToPdf(
                        raw,
                        title,
                        controller.signal,
                        progress,
                        book.format,
                      ),
                );
                controller.signal.throwIfAborted();
                setStatus(tr("正在保存转换文件…"));
                if (window.openReadingDesktop) {
                  const result =
                    await window.openReadingDesktop.saveConvertedBook(
                      bytes,
                      target,
                      title,
                    );
                  if (!result.saved) {
                    setStatus(tr("已取消保存"));
                    return;
                  }
                } else {
                  const url = URL.createObjectURL(
                    new Blob([bytes], { type: "application/epub+zip" }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = title + ".epub";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 60000);
                }
                if (add) {
                  setStatus(tr("正在加入书库…"));
                  const form = new FormData();
                  form.append(
                    "files",
                    new File([bytes], title + "." + target, {
                      type:
                        target === "pdf"
                          ? "application/pdf"
                          : "application/epub+zip",
                    }),
                  );
                  await api(
                    `/workspaces/${workspaceId}/imports`,
                    "POST",
                    form,
                    { signal: controller.signal },
                  );
                }
                await done();
                close();
              } catch (e: any) {
                if (!controller.signal.aborted) setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {tr("开始转换")}
          </button>
        </div>
        {!window.openReadingDesktop && target === "pdf" && (
          <p>{tr("请在桌面端将 EPUB 转换为 PDF")}</p>
        )}
      </section>
    </div>
  );
}
