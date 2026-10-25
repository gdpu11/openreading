import { isEpubFormat } from "../formats";
import { useEffect, useRef, useState } from "react";
import { BookOpen } from "lucide-react";
import { api, localDraft } from "../api";
import { tr } from "../i18n";

// A small queue bounds PDF workers and image decoding while scrolling a shelf.
let active = 0;
const waiting: (() => void)[] = [];
async function thumbnail(work: () => Promise<Blob | null>) {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await work();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
async function renderCover(
  url: string,
  format: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  let cleanup: () => void = () => {};
  try {
    if (format === "pdf") {
      const pdfjs = await import("../readers/pdf");
      const task = pdfjs.getDocument({
        url,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: 65536,
        maxImageSize: 16000000,
        useSystemFonts: true,
      });
      cleanup = () => {
        void task.destroy().catch(() => {});
      };
      signal.addEventListener("abort", cleanup, { once: true });
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(320 / natural.width, 440 / natural.height),
      });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok) return null;
      const blob = format !== "epub" && isEpubFormat(format) ? await (await import("../readers/bookFormats")).normalizedCover(await response.arrayBuffer(), format) : await response.blob();
      if (!blob) return null;
      const bitmap = await createImageBitmap(blob);
      try {
        const scale = Math.min(1, 320 / bitmap.width, 440 / bitmap.height);
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      } finally {
        bitmap.close();
      }
    }
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82),
    );
  } finally {
    signal.removeEventListener("abort", cleanup);
    cleanup();
    canvas.width = canvas.height = 0;
  }
}
export function BookCover({ book, title }: { book: any; title: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState("");
  const signature = JSON.stringify(
    book.bindings.map((b: any) => [
      b.id,
      b.size,
      b.mtime,
      b.state,
      b.bindingState,
    ]),
  );
  useEffect(() => {
    setSrc("");
    const controller = new AbortController();
    let imageURL = "";
    const show = (blob: Blob) => {
      if (controller.signal.aborted) return;
      imageURL = URL.createObjectURL(blob);
      setSrc(imageURL);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void (async () => {
          const key = "library-cover:" + book.id;
          const cached = await localDraft(key).catch(() => null);
          if (controller.signal.aborted) return;
          if (cached?.signature === signature) {
            if (cached.blob) show(cached.blob);
            return;
          }
          if (!isEpubFormat(book.format) && book.format !== "pdf") return;
          await thumbnail(async () => {
            if (controller.signal.aborted) return null;
            const cachePath =
              "/documents/" +
              encodeURIComponent(book.id) +
              "/thumbnail?revision=" +
              encodeURIComponent(signature);
            const saved = await fetch("/api" + cachePath, {
              signal: controller.signal,
            });
            const tag = saved.headers.get("ETag");
            if (saved.ok) {
              const blob = await saved.blob();
              show(blob);
              await localDraft(key, { signature, blob }).catch(() => {});
              return blob;
            }
            const blob = await renderCover(
              "/api/documents/" +
                encodeURIComponent(book.id) +
                "/cover?revision=" +
                encodeURIComponent(signature),
              book.format,
              controller.signal,
            );
            if (!controller.signal.aborted) {
              if (blob) {
                show(blob);
                if (tag)
                  await api(cachePath, "PUT", blob, {
                    signal: controller.signal,
                    headers: { "If-Match": tag },
                  }).catch(() => {});
              }
              await localDraft(key, { signature, blob }).catch(() => {});
            }
            return blob;
          });
        })().catch(() => {
          /* An unavailable or encrypted preview keeps its title card. */
        });
      },
      { rootMargin: "150px" },
    );
    if (host.current) observer.observe(host.current);
    return () => {
      controller.abort();
      observer.disconnect();
      if (imageURL) URL.revokeObjectURL(imageURL);
    };
  }, [book.id, book.format, signature]);
  return (
    <div
      ref={host}
      className={"library-book-cover" + (src ? " has-cover" : "")}
    >
      {src ? (
        <img src={src} alt={tr("书籍封面")} draggable={false} />
      ) : (
        <>
          <BookOpen size={26} strokeWidth={1.25} />
          <p>{title.replace(/\.(epub|kepub|pdf|md|txt|markdown|mobi|azw|prc|azw3|kf8|fb2|fbz|docx|html|htm|xhtml|rtf|cbz|cbr)$/i, "")}</p>
          <span>{book.format.toUpperCase()}</span>
        </>
      )}
    </div>
  );
}
