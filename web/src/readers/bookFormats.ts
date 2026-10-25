import JSZip from "jszip";
import DOMPurify from "dompurify";
import { isEpubFormat } from "../formats";
import type { EBookParser } from "@lingo-reader/shared";

const MAX_FILE = 64 * 1024 * 1024,
  MAX_TOTAL = 512 * 1024 * 1024,
  MAX_ENTRIES = 5000;
const imageTypes: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};
const imageType = (name: string) =>
  imageTypes[name.split(".").pop()!.toLowerCase()];
const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const safePath = (name: string) =>
  !name.includes("\\") &&
  !name.startsWith("/") &&
  !name.includes(":") &&
  !name.split("/").includes("..") &&
  name.split("/").length <= 20;

export async function bookZip(raw: ArrayBuffer) {
  const zip = await JSZip.loadAsync(raw);
  const files = Object.values(zip.files);
  if (files.length > MAX_ENTRIES) throw Error("压缩包条目过多");
  let total = 0;
  for (const file of files) {
    // JSZip retains the pre-normalization name, so path traversal cannot hide
    // behind its sanitized key. Sizes are checked before decompression.
    const entry = file as typeof file & {
      unsafeOriginalName?: string;
      _data?: { uncompressedSize: number; compressedSize: number };
    };
    const n = entry._data?.uncompressedSize || 0,
      packed = entry._data?.compressedSize || 0;
    total += n;
    if (
      !safePath(entry.unsafeOriginalName || file.name) ||
      (typeof file.unixPermissions === "number" &&
        (file.unixPermissions & 0xf000) === 0xa000)
    )
      throw Error("压缩包路径不安全");
    if (
      n > MAX_FILE ||
      total > MAX_TOTAL ||
      (n > 1024 * 1024 && n / (packed + 1) > 200)
    )
      throw Error("压缩包展开大小或压缩比超限");
  }
  return zip;
}

function decode(raw: ArrayBuffer, markup: "xml" | "html") {
  const bytes = new Uint8Array(raw);
  const start = new TextDecoder().decode(bytes.slice(0, 2048));
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : markup === "xml"
          ? start.match(/<\?xml[^>]+encoding=["']([^"']+)/i)?.[1]
          : start.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  return new TextDecoder(encoding || "utf-8").decode(raw);
}

type Section = { html: string; label: string; css?: string[] };
type Nav = { label: string; href: string; children?: Nav[] };

// Produce a deterministic EPUB layout; native CFIs survive reopening, sync and
// ORD export. Original bytes remain in the version store and are never replaced.
class EpubBuilder {
  zip = new JSZip();
  assets: { name: string; type: string }[] = [];
  total = 0;
  resources = new Map<string, Promise<string>>();
  constructor(private ownedBlobs = new Set<string>()) {
    this.zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  }
  async asset(raw: ArrayBuffer | Uint8Array, type: string) {
    this.total += raw.byteLength;
    if (
      raw.byteLength > MAX_FILE ||
      this.total > MAX_TOTAL ||
      this.assets.length >= MAX_ENTRIES
    )
      throw Error("书籍资源大小超限");
    const ext =
      (
        {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/gif": "gif",
          "image/webp": "webp",
          "image/bmp": "bmp",
          "image/svg+xml": "svg",
          "text/css": "css",
        } as Record<string, string>
      )[type] || "bin";
    const name = `assets/${this.assets.length}.${ext}`;
    this.assets.push({ name, type });
    this.zip.file(`EPUB/${name}`, raw);
    return name;
  }
  async resource(value: string): Promise<string> {
    if (
      !this.ownedBlobs.has(value) &&
      !/^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml)[;,]/i.test(value)
    )
      return "";
    if (value.length > MAX_FILE * 1.5) throw Error("图片过大");
    if (!this.resources.has(value))
      this.resources.set(
        value,
        (async () => {
          const response = await fetch(value),
            blob = await response.blob();
          if (
            !/^(image\/|font\/|text\/css$|application\/(?:font|vnd\.ms-fontobject|x-font))/.test(
              blob.type,
            )
          )
            return "";
          if (blob.type === "text/css") {
            const css = await this.styles(await blob.text());
            return this.asset(new TextEncoder().encode(css), blob.type);
          }
          if (blob.type === "image/svg+xml") {
            // KF8 SVG covers refer to separately allocated raster blob URLs.
            // Make the SVG self-contained before the parser revokes its URLs.
            const source = DOMPurify.sanitize(await blob.text(), {
              USE_PROFILES: { svg: true, svgFilters: true },
              ALLOW_UNKNOWN_PROTOCOLS: true,
              FORBID_TAGS: ["foreignObject", "script", "style"],
            });
            const svg = new DOMParser().parseFromString(
              source,
              "image/svg+xml",
            );
            for (const image of svg.querySelectorAll("image")) {
              for (const attr of ["href", "xlink:href"]) {
                const value = image.getAttribute(attr) || "";
                if (!this.ownedBlobs.has(value)) continue;
                const raster = await (await fetch(value)).blob();
                if (
                  !/^image\/(?:jpeg|png|gif|webp|bmp)$/.test(raster.type) ||
                  raster.size > MAX_FILE
                ) {
                  image.removeAttribute(attr);
                  continue;
                }
                const bytes = new Uint8Array(await raster.arrayBuffer());
                let binary = "";
                for (let i = 0; i < bytes.length; i += 8192)
                  binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                image.setAttribute(
                  attr,
                  `data:${raster.type};base64,${btoa(binary)}`,
                );
              }
            }
            return this.asset(
              new TextEncoder().encode(
                new XMLSerializer().serializeToString(svg),
              ),
              blob.type,
            );
          }
          return this.asset(await blob.arrayBuffer(), blob.type);
        })(),
      );
    return this.resources.get(value)!;
  }
  async styles(text: string) {
    text = text
      .replace(/@import[^;]*;?/gi, "")
      .replace(/expression\([^)]*\)/gi, "");
    for (const m of [
      ...text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi),
    ].reverse()) {
      const name = await this.resource(m[2]);
      // CSS lives in assets/, whereas chapter inline CSS lives in EPUB/.
      text =
        text.slice(0, m.index) +
        (name ? `url("${name.split("/").pop()}")` : "none") +
        text.slice(m.index! + m[0].length);
    }
    return text;
  }
  async build(
    sections: Section[],
    title: string,
    nav: Nav[] = [],
    resolve?: (href: string) => string,
    cover = "",
  ) {
    if (!sections.length || sections.length > MAX_ENTRIES)
      throw Error("书籍没有可阅读的章节，或章节过多");
    const coverName = cover ? await this.resource(cover) : "";
    const serializer = new XMLSerializer();
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      this.total += section.html.length * 2;
      if (this.total > MAX_TOTAL || section.html.length * 2 > MAX_FILE)
        throw Error("章节过大");
      // Sanitize before parsing into a live DOM. Remote images/styles, embedded
      // scripts, iframes and forms never get a network-capable document.
      const clean = DOMPurify.sanitize(section.html, {
        WHOLE_DOCUMENT: true,
        ALLOW_UNKNOWN_PROTOCOLS: true,
        ADD_TAGS: ["link"],
        FORBID_TAGS: [
          "script",
          "iframe",
          "object",
          "embed",
          "form",
          "base",
          "video",
          "audio",
        ],
        FORBID_ATTR: ["srcset"],
      });
      const doc = new DOMParser().parseFromString(clean, "text/html");
      for (const el of doc.querySelectorAll("*")) {
        for (const attr of ["src", "href", "xlink:href"]) {
          const value = el.getAttribute(attr);
          if (!value) continue;
          if (el.localName === "a" && attr === "href") {
            const link =
              resolve?.(value) || (value.startsWith("#") ? value : "");
            if (link) el.setAttribute(attr, link);
            else el.removeAttribute(attr);
          } else {
            const name =
              value.startsWith("assets/") &&
              this.assets.some((a) => a.name === value)
                ? value
                : await this.resource(value);
            if (name) el.setAttribute(attr, name);
            else el.removeAttribute(attr);
          }
        }
      }
      for (const el of doc.querySelectorAll("style,[style]")) {
        // Store cleaned CSS as a resource so relative image URLs have one base.
        const value =
          el.localName === "style"
            ? el.textContent || ""
            : `*[data-inline="${i}-${doc.querySelectorAll("[data-inline]").length}"] {${el.getAttribute("style")}}`;
        if (el.localName !== "style") {
          el.setAttribute(
            "data-inline",
            `${i}-${doc.querySelectorAll("[data-inline]").length}`,
          );
          el.removeAttribute("style");
        }
        const name = await this.asset(
          new TextEncoder().encode(await this.styles(value)),
          "text/css",
        );
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = name;
        doc.head.append(link);
        if (el.localName === "style") el.remove();
      }
      for (const href of section.css || []) {
        const name = await this.resource(href);
        if (!name) continue;
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = name;
        doc.head.append(link);
      }
      doc.querySelectorAll("meta").forEach((el) => el.remove());
      const css = doc.createElement("style");
      css.textContent =
        "body{overflow-wrap:anywhere}img,svg{max-width:100%;object-fit:contain}table{max-width:100%}pre{white-space:pre-wrap}.comic-page{margin:0;text-align:center}.comic-page img{max-height:none;width:auto}";
      doc.head.append(css);
      this.zip.file(
        `EPUB/section-${i}.xhtml`,
        serializer.serializeToString(doc.documentElement),
      );
    }
    const toc = nav.length
      ? nav
      : sections.map((s, i) => ({
          label: s.label || `${i + 1}`,
          href: `section-${i}.xhtml`,
        }));
    const navHTML = (items: Nav[]): string =>
      `<ol>${items.map((n) => `<li><a href="${xml(n.href)}">${xml(n.label || "章节")}</a>${n.children?.length ? navHTML(n.children) : ""}</li>`).join("")}</ol>`;
    this.zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    this.zip.file(
      "META-INF/container.xml",
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    );
    this.zip.file(
      "EPUB/nav.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc">${navHTML(toc)}</nav></body></html>`,
    );
    this.zip.file(
      "EPUB/book.opf",
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">openreading-normalized-v1</dc:identifier><dc:title>${xml(title || "Open Reading")}</dc:title><dc:language>und</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${sections.map((_, i) => `<item id="s${i}" href="section-${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}${this.assets.map((a, i) => `<item id="a${i}" href="${a.name}" media-type="${xml(a.type)}"${a.name === coverName ? ' properties="cover-image"' : ""}/>`).join("")}</manifest><spine>${sections.map((_, i) => `<itemref idref="s${i}"/>`).join("")}</spine></package>`,
    );
    return this.zip.generateAsync({
      type: "arraybuffer",
      compression: "STORE",
    });
  }
}

function kindleIsKf8(raw: ArrayBuffer) {
  const bytes = new Uint8Array(raw),
    view = new DataView(raw);
  if (
    bytes.length < 86 ||
    new TextDecoder().decode(bytes.slice(60, 68)) !== "BOOKMOBI"
  )
    throw Error("Kindle 文件损坏或不是受支持的 MOBI/AZW3 文件");
  const count = view.getUint16(76);
  if (!count || 78 + count * 8 > bytes.length) throw Error("Kindle 目录损坏");
  const inspect = (index: number) => {
    if (index >= count) throw Error("Kindle 记录越界");
    const p = view.getUint32(78 + index * 8),
      end = index + 1 < count ? view.getUint32(86 + index * 8) : bytes.length;
    if (p < 78 + count * 8 || end > bytes.length || end - p < 40)
      throw Error("Kindle 记录损坏");
    if (view.getUint16(p + 12))
      throw Error("这本 Kindle 书受 DRM 加密保护，请使用无 DRM 的文件");
    if (view.getUint32(p + 4) > MAX_TOTAL) throw Error("Kindle 书籍过大");
    if (new TextDecoder().decode(bytes.slice(p + 16, p + 20)) !== "MOBI")
      throw Error("暂不支持此 Palm 文档，请导出为 EPUB");
    return { p, end, version: view.getUint32(p + 36) };
  };
  const { p, end, version } = inspect(0);
  if (version >= 8) return true;
  let at = p + 16 + view.getUint32(p + 20);
  if (
    at + 12 <= end &&
    new TextDecoder().decode(bytes.slice(at, at + 4)) === "EXTH"
  ) {
    const records = view.getUint32(at + 8);
    at += 12;
    for (let i = 0; i < records && at + 8 <= end; i++) {
      const type = view.getUint32(at),
        size = view.getUint32(at + 4);
      if (size < 8 || at + size > end) throw Error("Kindle 元数据损坏");
      if (type === 121 && size >= 12 && view.getUint32(at + 8) !== 0xffffffff)
        return inspect(view.getUint32(at + 8)).version >= 8;
      at += size;
    }
  }
  return false;
}

function kindleInput(raw: ArrayBuffer) {
  const view = new DataView(raw),
    p = view.getUint32(78);
  if (view.getUint32(p + 128) & 64) return new Uint8Array(raw);
  // MOBI files may omit EXTH. The pinned parser assumes an EXTH object even
  // for legacy books; add an empty metadata record to its private input copy.
  const at = p + 16 + view.getUint32(p + 20);
  if (at > raw.byteLength) throw Error("Kindle 头部损坏");
  const bytes = new Uint8Array(raw.byteLength + 12),
    v = new DataView(bytes.buffer);
  bytes.set(new Uint8Array(raw).slice(0, at));
  bytes.set(new Uint8Array(raw).slice(at), at + 12);
  bytes.set(new TextEncoder().encode("EXTH"), at);
  v.setUint32(at + 4, 12);
  v.setUint32(p + 128, view.getUint32(p + 128) | 64);
  if (view.getUint32(p + 84) >= at - p)
    v.setUint32(p + 84, view.getUint32(p + 84) + 12);
  for (let i = 0; i < view.getUint16(76); i++) {
    const offset = view.getUint32(78 + i * 8);
    if (offset >= at) v.setUint32(78 + i * 8, offset + 12);
  }
  return bytes;
}

async function parsedBook(reader: EBookParser) {
  try {
    const spine = reader.getSpine(),
      ids = new Map(spine.map((s, i) => [s.id, i]));
    const sections: Section[] = [];
    for (const s of spine) {
      const chapter = await reader.loadChapter(s.id);
      if (!chapter) throw Error("书籍章节损坏");
      sections.push({
        html: chapter.html,
        css: chapter.css?.map((c) => c.href),
        label: "",
      });
    }
    const cover = reader.getCoverImage?.() || "";
    // These pinned parsers own and revoke their resourceCache blob URLs.
    const cache = (reader as unknown as { resourceCache: Map<string, string> })
      .resourceCache;
    const owned = new Set(cache.values());
    const resolve = (href: string) => {
      let target;
      try {
        target = reader.resolveHref(href);
      } catch {
        return "";
      }
      if (!target || !ids.has(target.id)) return "";
      const index = ids.get(target.id)!;
      let fragment = "";
      if (target.selector) {
        const doc = new DOMParser().parseFromString(
          sections[index].html,
          "text/html",
        );
        try {
          const id = doc.querySelector(target.selector)?.id;
          if (id) fragment = "#" + encodeURIComponent(id);
        } catch {
          /* Invalid selector in source. */
        }
      }
      return `section-${index}.xhtml${fragment}`;
    };
    const nav = (items: ReturnType<EBookParser["getToc"]>): Nav[] =>
      items.flatMap((n) => {
        const href = resolve(n.href);
        return href
          ? [
              {
                label: n.label,
                href,
                children: n.children ? nav(n.children) : undefined,
              },
            ]
          : [];
      });
    return await new EpubBuilder(owned).build(
      sections,
      reader.getMetadata().title || "Open Reading",
      nav(reader.getToc()),
      resolve,
      cover,
    );
  } finally {
    reader.destroy();
  }
}

async function fictionBook(text: string) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (
    doc.querySelector("parsererror") ||
    doc.documentElement.localName !== "FictionBook"
  )
    throw Error("FB2 XML 格式无效");
  const binary = new Map(
    Array.from(doc.querySelectorAll("binary"), (el) => [
      el.id,
      `data:${el.getAttribute("content-type")};base64,${(el.textContent || "").replace(/\s/g, "")}`,
    ]),
  );
  const tags: Record<string, string> = {
    section: "section",
    title: "h2",
    subtitle: "h3",
    p: "p",
    strong: "strong",
    emphasis: "em",
    strikethrough: "s",
    sub: "sub",
    sup: "sup",
    code: "code",
    a: "a",
    image: "img",
    "empty-line": "br",
    poem: "blockquote",
    stanza: "div",
    v: "p",
    cite: "blockquote",
    "text-author": "p",
    table: "table",
    tr: "tr",
    td: "td",
    th: "th",
    date: "p",
  };
  const convert = (node: Node): string => {
    if (
      node.nodeType === Node.TEXT_NODE ||
      node.nodeType === Node.CDATA_SECTION_NODE
    )
      return xml(node.textContent || "");
    if (!(node instanceof Element)) return "";
    const tag = tags[node.localName] || "div";
    let attrs = node.id ? ` id="${xml(node.id)}"` : "";
    const href =
      node.getAttributeNS("http://www.w3.org/1999/xlink", "href") ||
      node.getAttribute("href") ||
      "";
    if (tag === "img")
      attrs += ` src="${xml(binary.get(href.slice(1)) || "")}"`;
    if (tag === "a" && href.startsWith("#")) attrs += ` href="${xml(href)}"`;
    for (const attr of ["colspan", "rowspan"])
      if (/^\d{1,3}$/.test(node.getAttribute(attr) || ""))
        attrs += ` ${attr}="${node.getAttribute(attr)}"`;
    return `<${tag}${attrs}>${Array.from(node.childNodes, convert).join("")}${["img", "br"].includes(tag) ? "" : `</${tag}>`}`;
  };
  const sections: Section[] = [],
    destinations = new Map<string, number>();
  for (const body of doc.querySelectorAll("FictionBook > body")) {
    const children = Array.from(body.children);
    // Keep bodies with introductory paragraphs as one section; splitting only
    // their <section> children would silently discard that text.
    const parts =
      children.length && children.every((el) => el.localName === "section")
        ? children
        : [body];
    for (const part of parts) {
      for (const el of [part, ...part.querySelectorAll("[id]")])
        if (el.id) destinations.set(el.id, sections.length);
      sections.push({
        label:
          part.querySelector("title")?.textContent?.trim() ||
          body.getAttribute("name") ||
          `${sections.length + 1}`,
        html: convert(part),
      });
    }
  }
  const coverId = doc
    .querySelector("coverpage image")
    ?.getAttributeNS("http://www.w3.org/1999/xlink", "href")
    ?.slice(1);
  return new EpubBuilder().build(
    sections,
    doc.querySelector("title-info > book-title")?.textContent || "Open Reading",
    [],
    (href) => {
      const id = href.startsWith("#") ? href.slice(1) : "";
      return destinations.has(id)
        ? `section-${destinations.get(id)}.xhtml#${encodeURIComponent(id)}`
        : "";
    },
    coverId ? binary.get(coverId) || "" : "",
  );
}

let rarQueue: Promise<unknown> = Promise.resolve();
async function rarImages(raw: ArrayBuffer) {
  // unrar-js keeps its active extractor on one shared WASM module. Serialize
  // creation AND extraction; shelf thumbnails can otherwise mix two books.
  const work = rarQueue.then(async () => {
    const images: { name: string; data: () => Promise<Uint8Array> }[] = [];
    const { createExtractorFromData } =
      await import("node-unrar-js/esm/index.esm.js");
    const { default: wasmURL } =
      await import("node-unrar-js/esm/js/unrar.wasm?url");
    const extractor = await createExtractorFromData({
      data: raw,
      wasmBinary: await (await fetch(wasmURL)).arrayBuffer(),
    });
    try {
      const list = extractor.getFileList(),
        headers = [...list.fileHeaders];
      if (
        list.arcHeader.flags.volume ||
        list.arcHeader.flags.headerEncrypted ||
        headers.some((h) => h.flags.encrypted)
      )
        throw Error("暂不支持加密或分卷 CBR，请先解压为普通漫画文件");
      let total = 0;
      if (headers.length > MAX_ENTRIES) throw Error("漫画页数过多");
      for (const h of headers) {
        total += h.unpSize;
        if (
          !safePath(h.name) ||
          h.unpSize > MAX_FILE ||
          total > MAX_TOTAL ||
          (h.unpSize > 1024 * 1024 && h.unpSize / (h.packSize + 1) > 200)
        )
          throw Error("漫画压缩包不安全或展开大小超限");
      }
      // Drain the generator: unrar closes its archive at the end of iteration.
      for (const file of extractor.extract({
        files: (h) => !h.flags.directory && !!imageType(h.name),
      }).files) {
        const data = file.extraction;
        if (data)
          images.push({ name: file.fileHeader.name, data: async () => data });
      }
      return images;
    } finally {
      (
        extractor as unknown as { unrar: { extractor: unknown } }
      ).unrar.extractor = null;
    }
  });
  rarQueue = work.then(
    () => {},
    () => {},
  );
  return work;
}

async function comic(raw: ArrayBuffer, kind: string) {
  const builder = new EpubBuilder(),
    images: { name: string; data: () => Promise<Uint8Array> }[] = [];
  if (kind === "cbz") {
    const zip = await bookZip(raw);
    for (const file of Object.values(zip.files))
      if (
        !file.dir &&
        imageType(file.name) &&
        !file.name.startsWith("__MACOSX/") &&
        !file.name.split("/").some((p) => p.startsWith("."))
      )
        images.push({ name: file.name, data: () => file.async("uint8array") });
  } else images.push(...(await rarImages(raw)));
  images.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  if (!images.length)
    throw Error("漫画压缩包中没有支持的图片（JPEG、PNG、GIF、WebP、BMP）");
  const sections: Section[] = [];
  for (const image of images) {
    const name = await builder.asset(await image.data(), imageType(image.name));
    sections.push({
      label: `第 ${sections.length + 1} 页`,
      html: `<html><body class="comic-page"><img src="${name}" alt="${xml(image.name)}"/></body></html>`,
    });
  }
  return builder.build(sections, "Comic", [], undefined);
}

export async function normalizeBook(
  raw: ArrayBuffer,
  kind: string,
): Promise<ArrayBuffer> {
  if (kind === "epub") return raw;
  if (!isEpubFormat(kind)) throw Error("不支持此书籍格式");
  try {
    if (kind === "mobi" || kind === "azw3") {
      const kf8 = kindleIsKf8(raw);
      const { initMobiFile, initKf8File } =
        await import("@lingo-reader/mobi-parser");
      const reader = await (kf8 ? initKf8File : initMobiFile)(kindleInput(raw));
      if (kf8) {
        // Upstream 0.4.6 assumes every <link> has a Kindle resource URI. Real
        // Gutenberg KF8 books also contain non-resource links in their head.
        const adapter = reader as unknown as {
          replace: (html: string) => {
            html: string;
            css: { id: string; href: string }[];
          };
          replaceResources: (text: string) => string;
        };
        adapter.replace = (html) => {
          const doc = new DOMParser().parseFromString(html, "text/html");
          const css = Array.from(
            doc.querySelectorAll('link[rel="stylesheet"]'),
          ).flatMap((el, i) => {
            const href = el.getAttribute("href") || "";
            return /^kindle:flow:/i.test(href)
              ? [{ id: String(i), href: adapter.replaceResources(href) }]
              : [];
          });
          return {
            html: adapter.replaceResources(
              Array.from(
                doc.querySelectorAll("head > style"),
                (el) => el.outerHTML,
              ).join("") + doc.body.innerHTML,
            ),
            css,
          };
        };
      }
      return await parsedBook(reader);
    }
    if (kind === "fb2") {
      if (new Uint8Array(raw)[0] === 0x50 && new Uint8Array(raw)[1] === 0x4b) {
        const zip = await bookZip(raw),
          files = Object.values(zip.files).filter(
            (f) => !f.dir && /\.fb2$/i.test(f.name),
          );
        if (files.length !== 1) throw Error("FB2 压缩包需要恰好一本 .fb2 文件");
        raw = await files[0].async("arraybuffer");
      }
      const text = decode(raw, "xml");
      if (/<!DOCTYPE|<!ENTITY/i.test(text))
        throw Error("FB2 不允许外部实体声明");
      return await fictionBook(text);
    }
    if (kind === "cbz" || kind === "cbr") return await comic(raw, kind);
    let html: string;
    if (kind === "docx") {
      const zip = await bookZip(raw);
      if (!zip.file("word/document.xml") || !zip.file("[Content_Types].xml"))
        throw Error("DOCX 文件缺少正文，或已加密");
      const mammoth = await import("mammoth");
      html = (await mammoth.convertToHtml({ arrayBuffer: raw })).value;
    } else if (kind === "rtf") {
      if (
        !new TextDecoder()
          .decode(raw.slice(0, 16))
          .trimStart()
          .startsWith("{\\rtf")
      )
        throw Error("RTF 文件格式无效");
      const { RTFJS } = await import("rtf.js");
      RTFJS.loggingEnabled(false);
      const doc = new RTFJS.Document(raw, {});
      html = (await doc.render()).map((el) => el.outerHTML).join("");
    } else html = decode(raw, "html");
    const title =
      new DOMParser()
        .parseFromString(
          DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true }),
          "text/html",
        )
        .querySelector("title,h1")?.textContent || "Open Reading";
    return await new EpubBuilder().build([{ html, label: title }], title);
  } catch (error) {
    throw Error(
      `${kind.toUpperCase()} 无法打开：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function normalizedCover(
  raw: ArrayBuffer,
  kind: string,
): Promise<Blob | null> {
  const zip = await JSZip.loadAsync(await normalizeBook(raw, kind));
  const file = Object.values(zip.files).find(
    (f) => !f.dir && !!imageType(f.name),
  );
  return file
    ? new Blob([await file.async("arraybuffer")], {
        type: imageType(file.name),
      })
    : null;
}
