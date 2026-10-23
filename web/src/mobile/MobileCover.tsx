import { useEffect, useRef, useState } from "react";
import { cachedBlob, coverCache } from "./storage";

let queue = Promise.resolve();
export function MobileCover({ book }: { book: any }) {
  const [src, setSrc] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const title = book.title.replace(/\.[^.]+$/, ""),
    hue =
      Array.from(title as string).reduce((n, c) => n + c.charCodeAt(0), 0) % 5;
  useEffect(() => {
    let disposed = false,
      url = "";
    setSrc("");
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        queue = queue
          .then(async () => {
            if (disposed || !book.version) return;
            const key = book.version.contentHash;
            let blob: Blob | null | undefined = await coverCache(key);
            if (!blob) {
              const raw = await cachedBlob(book.version.contentHash);
              if (!raw || disposed) return;
              if (book.format === "epub") {
                const { default: JSZip } = await import("jszip"),
                  zip = await JSZip.loadAsync(await raw.arrayBuffer()),
                  parse = (text: string) =>
                    new DOMParser().parseFromString(text, "application/xml");
                const container = zip.file("META-INF/container.xml");
                if (!container) return;
                const path = parse(await container.async("string"))
                  .querySelector("rootfile")
                  ?.getAttribute("full-path");
                if (!path || !zip.file(path)) return;
                const opf = parse(await zip.file(path)!.async("string")),
                  coverId = opf
                    .querySelector('meta[name="cover"]')
                    ?.getAttribute("content"),
                  items = Array.from(opf.querySelectorAll("manifest > item")),
                  item =
                    items.find((i) =>
                      (i.getAttribute("properties") || "")
                        .split(/\s+/)
                        .includes("cover-image"),
                    ) || items.find((i) => i.getAttribute("id") === coverId);
                if (item) {
                  const url = new URL(
                    item.getAttribute("href") || "",
                    "https://book.invalid/" + path,
                  );
                  if (url.origin !== "https://book.invalid") return;
                  const file = zip.file(
                    decodeURIComponent(url.pathname.slice(1)),
                  );
                  if (
                    file &&
                    /^image\/(jpeg|png|webp|gif)$/.test(
                      item.getAttribute("media-type") || "",
                    )
                  )
                    blob = new Blob([await file.async("arraybuffer")], {
                      type: item.getAttribute("media-type")!,
                    });
                }
              } else if (book.format === "pdf") {
                const pdfjs = await import("../readers/pdf"),
                  task = pdfjs.getDocument({
                    data: new Uint8Array(await raw.arrayBuffer()),
                    useSystemFonts: true,
                  });
                try {
                  const pdf = await task.promise,
                    page = await pdf.getPage(1),
                    natural = page.getViewport({ scale: 1 }),
                    viewport = page.getViewport({
                      scale: Math.min(
                        260 / natural.width,
                        360 / natural.height,
                      ),
                    }),
                    canvas = document.createElement("canvas");
                  canvas.width = Math.ceil(viewport.width);
                  canvas.height = Math.ceil(viewport.height);
                  await page.render({ canvas, viewport }).promise;
                  blob = await new Promise<Blob | null>((resolve) =>
                    canvas.toBlob(resolve, "image/jpeg", 0.8),
                  );
                  canvas.width = canvas.height = 0;
                } finally {
                  await task.destroy();
                }
              }
              if (blob) await coverCache(key, blob);
            }
            if (blob && !disposed) {
              url = URL.createObjectURL(blob);
              setSrc(url);
            }
          })
          .catch(() => {});
      },
      { rootMargin: "100px" },
    );
    if (host.current) observer.observe(host.current);
    return () => {
      disposed = true;
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [book.id, book.version?.contentHash]);
  return (
    <div ref={host} className={`mobile-cover cover-tone-${hue}`}>
      {src ? (
        <img src={src} alt={title} draggable={false} />
      ) : (
        <>
          <span className="cover-rule" />
          <strong>{title}</strong>
          <span className="cover-format">{book.format.toUpperCase()}</span>
          <span className="cover-imprint">OPEN READING</span>
        </>
      )}
    </div>
  );
}
