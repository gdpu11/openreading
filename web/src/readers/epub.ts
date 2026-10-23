import ePub from "epubjs";
import { repairEpubEntities } from "./epubXml";
import { bodyText, countTextWords, yieldWordCount } from "./wordCount";
import JSZip from "jszip";
import DOMPurify from "dompurify";

const origin = "https://epub.invalid";
export const epubCSP =
  "default-src 'none'; img-src blob: data:; font-src blob: data:; style-src 'unsafe-inline' blob:; script-src 'none'; connect-src 'none'; form-action 'none'";
const parser = new DOMParser();
const serializer = new XMLSerializer();
const parse = (
  source: string,
  type: DOMParserSupportedType = "application/xml",
) => {
  let doc = parser.parseFromString(source, type);
  if (doc.querySelector("parsererror")) {
    const repaired = repairEpubEntities(source);
    if (repaired !== source) doc = parser.parseFromString(repaired, type);
  }
  if (doc.querySelector("parsererror")) throw Error("EPUB 章节 XML 格式无效");
  return doc;
};
const localPath = (value: string, base: string) => {
  const url = new URL(value, base);
  if (url.origin !== origin) throw Error("书内外部链接已阻断");
  return decodeURIComponent(url.pathname.slice(1));
};

// Keep the ZIP open once. Only sanitize requested chapters and decode resources
// for a displayed chapter; full-book text indexing never decompresses its images.
export async function openEpub(raw: ArrayBuffer) {
  const zip = await JSZip.loadAsync(raw);
  let disposed = false;
  const urls = new Set<string>();
  const resourceBlobs = new Map<string, Blob>();
  const resources = new Map<string, Promise<string>>();
  const chapters = new Map<string, string>();
  const container = zip.file("META-INF/container.xml");
  if (!container) throw Error("EPUB 缺少书籍目录");
  const packagePath = parse(await container.async("string"))
    .querySelector("rootfile")
    ?.getAttribute("full-path");
  if (!packagePath || !zip.file(packagePath)) throw Error("EPUB 缺少书籍目录");
  const opf = parse(await zip.file(packagePath)!.async("string"));
  const packageURL = origin + "/" + packagePath;
  const mediaTypes = new Map<string, string>();
  for (const item of opf.querySelectorAll("manifest > item")) {
    try {
      mediaTypes.set(
        localPath(item.getAttribute("href") || "", packageURL),
        item.getAttribute("media-type") || "",
      );
    } catch {
      item.remove();
    }
  }
  const safeChapter = (source: string) => {
    const xml = parse(source, "application/xhtml+xml");
    // XHTML permits <script/>. Feeding it directly to an HTML sanitizer makes
    // the HTML parser consume the rest of the book as script text (blank body).
    xml.querySelectorAll("script").forEach((el) => el.remove());
    const cleaned = DOMPurify.sanitize(serializer.serializeToString(xml), {
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ["link"],
      ADD_ATTR: ["epub:type", "xmlns:epub"],
      FORBID_TAGS: [
        "script",
        "iframe",
        "object",
        "embed",
        "form",
        "base",
        "video",
        "audio",
        "foreignObject",
      ],
      FORBID_ATTR: ["srcset", "formaction"],
    });
    const safe = parser.parseFromString(cleaned, "text/html");
    safe.querySelectorAll("[src],[href],[xlink\\:href]").forEach((el) => {
      for (const attr of ["src", "href", "xlink:href"]) {
        const value = el.getAttribute(attr) || "";
        if (
          /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value) &&
          !/^data:image\//i.test(value)
        )
          el.removeAttribute(attr);
      }
    });
    const meta = safe.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = epubCSP;
    safe.head.prepend(meta);
    // Some reflowable books reuse a Japanese fixed-cover stylesheet. Its
    // vertical writing mode measures an SVG-only body as zero columns in epub.js.
    if (
      safe.body.querySelector(
        ":scope > svg:only-child, :scope > img:only-child, :scope > div:only-child > svg:only-child, :scope > div:only-child > img:only-child",
      )
    ) {
      for (const el of [safe.documentElement, safe.body]) {
        for (const prop of [
          "writing-mode",
          "-webkit-writing-mode",
          "-epub-writing-mode",
        ])
          el.style.setProperty(prop, "horizontal-tb", "important");
      }
    }
    return serializer.serializeToString(safe.documentElement);
  };
  const css = async (
    source: string,
    base: string,
    ancestors = new Set<string>(),
  ): Promise<string> => {
    // Expand local imports before inlining a cleaned stylesheet. Never resolve a
    // URL through the network, including imports and escaped CSS URLs.
    let result = "",
      end = 0;
    const imports =
      /@import\s+(?:url\(\s*["']?([^\s"')]+)["']?\s*\)|["']([^"']+)["'])\s*([^;]*);/gi;
    for (const m of source.matchAll(imports)) {
      result += source.slice(end, m.index);
      try {
        const name = localPath(m[1] || m[2], base);
        if (!ancestors.has(name) && zip.file(name)) {
          const nested = await css(
            await zip.file(name)!.async("string"),
            origin + "/" + name,
            new Set([...ancestors, name]),
          );
          result += m[3].trim() ? `@media ${m[3]} {${nested}}` : nested;
        }
      } catch {
        /* External or invalid import: omit. */
      }
      end = m.index! + m[0].length;
    }
    result += source.slice(end);
    result = result
      .replace(/@import[^;]*;?/gi, "")
      .replace(/expression\([^)]*\)/gi, "");
    const matches = [...result.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)];
    for (const m of matches.reverse()) {
      const value = m[2].trim();
      const url =
        value.startsWith("#") || /^data:image\//i.test(value) || urls.has(value)
          ? value
          : value.includes("\\")
            ? ""
            : await resource(value, base);
      result =
        result.slice(0, m.index) +
        (url ? `url("${url}")` : "none") +
        result.slice(m.index! + m[0].length);
    }
    return result;
  };
  const resource = async (value: string, base: string): Promise<string> => {
    if (!value || value.startsWith("#") || /^data:image\//i.test(value))
      return value;
    let name: string;
    try {
      name = localPath(value, base);
    } catch {
      return "";
    }
    const type = mediaTypes.get(name) || "";
    if (
      type === "text/css" ||
      !zip.file(name) ||
      !/^(image\/|font\/|application\/(?:font|vnd\.ms-fontobject|x-font))/.test(
        type,
      )
    )
      return "";
    if (!resources.has(name))
      resources.set(
        name,
        (async () => {
          const file = zip.file(name)!;
          let blob: Blob;
          if (type === "image/svg+xml") {
            const safe = DOMPurify.sanitize(await file.async("string"), {
              USE_PROFILES: { svg: true, svgFilters: true },
              FORBID_TAGS: ["foreignObject", "script", "style"],
            });
            const svg = parse(safe);
            svg
              .querySelectorAll("[href],[xlink\\:href],[style]")
              .forEach((el) => {
                el.removeAttribute("style");
                for (const attr of ["href", "xlink:href"])
                  if (!(el.getAttribute(attr) || "#").startsWith("#"))
                    el.removeAttribute(attr);
              });
            blob = new Blob([serializer.serializeToString(svg)], { type });
          } else blob = new Blob([await file.async("arraybuffer")], { type });
          if (disposed) return "";
          const url = URL.createObjectURL(blob);
          urls.add(url);
          resourceBlobs.set(url, blob);
          return url;
        })(),
      );
    return resources.get(name)!;
  };
  const request = async (url: string, type?: string) => {
    if (disposed) throw new DOMException("Book closed", "AbortError");
    const name = localPath(url, packageURL);
    const file = zip.file(name);
    if (!file) throw Error("EPUB 资源不存在：" + name);
    if (name === packagePath) return opf.cloneNode(true);
    const html =
      /\.(xhtml|html|htm)$/i.test(name) ||
      mediaTypes.get(name) === "application/xhtml+xml";
    if (html) {
      if (!chapters.has(name))
        chapters.set(name, safeChapter(await file.async("string")));
      return parse(chapters.get(name)!, "application/xhtml+xml");
    }
    const source = await file.async("string");
    return type === "json" ? JSON.parse(source) : parse(source);
  };
  const book: any = ePub("", { requestMethod: request, replacements: "none" });
  // loadNavigation in epub.js has no rejection handler of its own.
  const loadNavigation = book.loadNavigation.bind(book);
  book.loadNavigation = (packaging: any) =>
    // The no-navigation branch creates BOTH Navigation and PageList. Passing
    // {toc: []} leaves pageList undefined and crashes every relocated event.
    loadNavigation(packaging).catch(() => loadNavigation({}));
  book.spine.hooks.serialize.register(async (output: string, section: any) => {
    const doc = parse(output, "application/xhtml+xml");
    const base = section.url;
    await Promise.all(
      Array.from(doc.querySelectorAll("*")).map(async (el) => {
        if (
          el.localName === "link" &&
          el.getAttribute("rel") === "stylesheet"
        ) {
          const style = doc.createElementNS(
            "http://www.w3.org/1999/xhtml",
            "style",
          );
          try {
            const name = localPath(el.getAttribute("href") || "", base);
            if (zip.file(name))
              style.textContent = await css(
                await zip.file(name)!.async("string"),
                origin + "/" + name,
                new Set([name]),
              );
          } catch {
            /* Invalid or external stylesheet: omit it. */
          }
          el.replaceWith(style);
          return;
        }
        for (const attr of ["src", "href", "xlink:href"]) {
          const value = el.getAttribute(attr);
          if (
            !value ||
            el.localName === "a" ||
            el.localName === "base" ||
            el.getAttribute("rel") === "canonical"
          )
            continue;
          const url = urls.has(value) ? value : await resource(value, base);
          if (url) el.setAttribute(attr, url);
          else el.removeAttribute(attr);
        }
      }),
    );
    await Promise.all(
      Array.from(doc.querySelectorAll("style,[style]")).map(async (el) => {
        if (el.localName === "style")
          el.textContent = await css(el.textContent || "", base);
        if (el.hasAttribute("style"))
          el.setAttribute("style", await css(el.getAttribute("style")!, base));
      }),
    );
    section.output = serializer.serializeToString(doc.documentElement);
  });
  const dispose = () => {
    disposed = true;
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls.clear();
    resourceBlobs.clear();
    resources.clear();
    chapters.clear();
  };
  try {
    await book.open(packageURL, "opf");
  } catch (e) {
    dispose();
    book.destroy();
    throw e;
  }
  const wordCount = async (signal: AbortSignal) => {
    let count = 0;
    const seen = new Set<string>();
    const items = new Map(
      Array.from(opf.querySelectorAll("manifest > item"), (el) => [
        el.getAttribute("id"),
        el,
      ]),
    );
    for (const ref of opf.querySelectorAll("spine > itemref")) {
      await yieldWordCount(signal);
      if (ref.getAttribute("linear") === "no") continue;
      const item = items.get(ref.getAttribute("idref"));
      if (!item) throw Error("Missing EPUB chapter");
      if ((item.getAttribute("properties") || "").split(/\s+/).includes("nav"))
        continue;
      const name = localPath(item.getAttribute("href") || "", packageURL);
      if (seen.has(name)) continue;
      seen.add(name);
      const file = zip.file(name);
      if (!file) throw Error("Missing EPUB chapter");
      const chapter = parse(
        await file.async("string"),
        "application/xhtml+xml",
      );
      const body = chapter.querySelector("body");
      if (!body) throw Error("Missing EPUB body");
      count += await countTextWords(bodyText(body), signal);
    }
    return { count };
  };
  const indexLocations = async (signal: AbortSignal) => {
    const locations: string[] = [];
    for (const section of book.spine.spineItems) {
      if (!section.linear) continue;
      await yieldWordCount(signal);
      // Use an independent chapter document. Indexing must not unload a spine
      // section that the reader is displaying or is about to turn to.
      const chapter = await request(section.url);
      signal.throwIfAborted();
      locations.push(
        ...book.locations.parse(chapter.documentElement, section.cfiBase, 256),
      );
    }
    signal.throwIfAborted();
    book.locations.load(JSON.stringify(locations));
    return locations;
  };
  const printHTML = async (
    title: string,
    signal: AbortSignal,
    progress: (done: number, total: number) => void,
  ) => {
    const sections = book.spine.spineItems.filter(
      (section: any) => section.linear,
    );
    const parts: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      signal.throwIfAborted();
      progress(i, sections.length);
      // Validate before epub.js render(), whose error path can leave a deferred pending.
      await request(sections[i].url);
      const chapter = parse(
        await sections[i].render(request),
        "application/xhtml+xml",
      );
      const body = chapter.querySelector("body");
      if (!body) throw Error("EPUB 缺少正文");
      chapter
        .querySelectorAll("base,script,iframe,object,embed,form")
        .forEach((el) => el.remove());
      const styles = Array.from(
        chapter.querySelectorAll("style"),
        (el) => el.textContent || "",
      )
        .join("\n")
        .replace(/</g, "\\3c ");
      parts.push(
        `<section class="print-chapter" id="print-chapter-${i}"><style>@scope (#print-chapter-${i}) {${styles}}</style>${Array.from(body.childNodes, (node) => serializer.serializeToString(node)).join("")}</section>`,
      );
      progress(i + 1, sections.length);
      await yieldWordCount(signal);
    }
    let html = parts.join("\n");
    for (const url of urls) {
      signal.throwIfAborted();
      const blob = resourceBlobs.get(url)!;
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      html = html.split(url).join(data);
    }
    const safeTitle = title.replace(
      /[&<>"]/g,
      (char) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
    );
    return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'"><style>@page{size:A4;margin:16mm}body{font:12pt/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;color:#111;background:#fff}.print-chapter{break-before:page;overflow-wrap:anywhere}.print-chapter:first-child{break-before:auto}img,svg{max-width:100%;max-height:250mm;object-fit:contain}table{max-width:100%;border-collapse:collapse}pre{white-space:pre-wrap}h1,h2,h3{break-after:avoid}</style></head><body>${html}</body></html>`;
  };
  const textSections = async (signal: AbortSignal, progress: (text: string) => void) => {
    const sections = book.spine.spineItems.filter((s: any) => s.linear);
    const results = [];
    for (let i = 0; i < sections.length; i++) {
      await yieldWordCount(signal); progress(`${i + 1} / ${sections.length}`);
      const chapter = await request(sections[i].url);
      const body = chapter.querySelector("body");
      results.push({position:i,label:body?.querySelector("h1,h2,h3")?.textContent || `${i + 1}`,locator:{href:sections[i].href},text:body ? bodyText(body) : ""});
    }
    return results;
  };
  return { book, dispose, wordCount, indexLocations, printHTML, textSections };
}
