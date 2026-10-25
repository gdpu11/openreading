// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import JSZip from "jszip";
import { normalizeBook, bookZip } from "./bookFormats";

const raw = (text: string) => new TextEncoder().encode(text).buffer;
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfWQAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
const fb2 = `<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><genre>science</genre><author><first-name>Test</first-name><last-name>Author</last-name></author><book-title>测试书</book-title><lang>zh</lang></title-info><document-info><author><nickname>Test</nickname></author><id>test</id><version>1</version></document-info></description><body><section id="one"><title><p>第一章</p></title><p>幂等接口必须处理重复请求。</p><p><a l:href="#two">下一章</a></p></section><section id="two"><title><p>第二章</p></title><p>重试与去重。</p></section></body></FictionBook>`;

async function chapters(bytes: ArrayBuffer) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) =>
    /section-\d+.xhtml$/.test(n),
  );
  const texts = await Promise.all(
    names.map((n) => zip.file(n)!.async("string")),
  );
  for (const text of texts)
    expect(
      new DOMParser()
        .parseFromString(text, "application/xhtml+xml")
        .querySelector("parsererror"),
    ).toBeNull();
  return { zip, texts };
}

function mobi(encrypted = false) {
  const text = new TextEncoder().encode(
    "<html><head></head><body><h1>第一章</h1><p>幂等接口与重试。</p><mbp:pagebreak/><h1>第二章</h1><p>去重保证。</p></body></html>",
  );
  const first = 94,
    header = 265,
    result = new Uint8Array(first + header + text.length),
    v = new DataView(result.buffer);
  result.set(new TextEncoder().encode("BOOKMOBI"), 60);
  v.setUint16(76, 2);
  v.setUint32(78, first);
  v.setUint32(86, first + header);
  v.setUint16(first, 1);
  v.setUint32(first + 4, text.length);
  v.setUint16(first + 8, 1);
  v.setUint16(first + 10, 4096);
  v.setUint16(first + 12, encrypted ? 2 : 0);
  result.set(new TextEncoder().encode("MOBI"), first + 16);
  v.setUint32(first + 20, 232);
  v.setUint32(first + 24, 2);
  v.setUint32(first + 28, 65001);
  v.setUint32(first + 36, 6);
  v.setUint32(first + 84, 260);
  v.setUint32(first + 88, 5);
  v.setUint32(first + 108, 2);
  v.setUint32(first + 128, 64);
  v.setUint32(first + 244, 0xffffffff);
  result.set(new TextEncoder().encode("EXTH"), first + 248);
  v.setUint32(first + 252, 12);
  result.set(new TextEncoder().encode("Tests"), first + 260);
  result.set(text, first + header);
  return result.buffer;
}

function rar() {
  const crc32 = (b: Uint8Array) => {
    let n = -1;
    for (const v of b) {
      n ^= v;
      for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    }
    return (n ^ -1) >>> 0;
  };
  const block = (type: number, flags: number, body: Uint8Array) => {
    const h = new Uint8Array(7 + body.length),
      d = new DataView(h.buffer);
    h[2] = type;
    d.setUint16(3, flags, true);
    d.setUint16(5, h.length, true);
    h.set(body, 7);
    d.setUint16(0, crc32(h.slice(2)) & 0xffff, true);
    return h;
  };
  const name = new TextEncoder().encode("page1.png"),
    body = new Uint8Array(25 + name.length),
    d = new DataView(body.buffer);
  d.setUint32(0, png.length, true);
  d.setUint32(4, png.length, true);
  body[8] = 3;
  d.setUint32(9, crc32(png), true);
  body[17] = 20;
  body[18] = 0x30;
  d.setUint16(19, name.length, true);
  body.set(name, 25);
  const parts = [
    Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0),
    block(0x73, 0, new Uint8Array(6)),
    block(0x74, 0x8000, body),
    png,
    block(0x7b, 0, new Uint8Array()),
  ];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes.buffer;
}

beforeEach(() => {
  const blobs = new Map<string, Blob>();
  let id = 0;
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL(blob: Blob) {
        const url = `blob:format-test/${++id}`;
        blobs.set(url, blob);
        return url;
      }
      static revokeObjectURL(url: string) {
        blobs.delete(url);
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (value: string) => {
      if (blobs.has(value)) return { blob: async () => blobs.get(value)! };
      if (value.includes("unrar.wasm"))
        return {
          arrayBuffer: async () => {
            const b = readFileSync(
              "node_modules/node-unrar-js/esm/js/unrar.wasm",
            );
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          },
        };
      if (value.startsWith("data:image/")) {
        const [header, data] = value.split(",");
        const body = header.endsWith(";base64")
          ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(decodeURIComponent(data));
        return {
          blob: async () =>
            new Blob([body], { type: header.slice(5).split(";")[0] }),
        };
      }
      throw Error("Unexpected external request: " + value);
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("additional book formats", () => {
  it.skipIf(!process.env.OPENREADING_KINDLE_FIXTURES)(
    "reads Gutenberg MOBI and AZW3 books",
    async () => {
      for (const kind of ["mobi", "azw3"]) {
        const bytes = readFileSync(
          `${process.env.OPENREADING_KINDLE_FIXTURES}/alice.${kind}`,
        );
        const { zip, texts } = await chapters(
          await normalizeBook(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
            kind,
          ),
        );
        if (kind === "azw3") {
          const svg = Object.values(zip.files).find((f) =>
            f.name.endsWith(".svg"),
          );
          expect(svg).toBeDefined();
          const source = await svg!.async("string");
          expect(source).toContain("data:image/jpeg;base64,");
          expect(source).not.toContain("blob:format-test");
        }
        expect(texts.join("")).toContain("Alice");
        expect(texts.join("")).not.toContain("blob:format-test");
        expect(texts.length).toBeGreaterThan(5);
      }
    },
  );
  it("preserves EPUB bytes unchanged", async () => {
    const b = raw("epub");
    expect(await normalizeBook(b, "epub")).toBe(b);
  });
  it("reads HTML text, internal links and embedded images without fetching remote assets", async () => {
    const { zip, texts } = await chapters(
      await normalizeBook(
        raw(
          `<html><head><title>HTML 测试</title><style>p{background:url(https://tracker.invalid/x)}</style></head><body><h1 id="one">幂等接口</h1><a href="#one">返回</a><script>window.pwned=1</script><img src="https://tracker.invalid/pixel"/><img src="data:image/png;base64,${btoa(String.fromCharCode(...png))}"/></body></html>`,
        ),
        "html",
      ),
    );
    expect(texts[0]).toContain("幂等接口");
    expect(texts[0]).toContain('href="#one"');
    expect(texts[0]).not.toContain("<script");
    expect(texts[0]).not.toContain("tracker.invalid");
    expect(Object.keys(zip.files).some((n) => n.endsWith(".png"))).toBe(true);
  });
  it("reads FB2 and zipped FB2 with chapters and cross references", async () => {
    for (const bytes of [
      raw(fb2),
      await new JSZip()
        .file("book.fb2", fb2)
        .generateAsync({ type: "arraybuffer" }),
    ]) {
      const { texts } = await chapters(await normalizeBook(bytes, "fb2"));
      expect(texts).toHaveLength(2);
      expect(texts.join("")).toContain("幂等接口");
      expect(texts[0]).toContain("section-1.xhtml");
    }
  });
  it("reads more than 5000 formatted paragraphs without exhausting the resource limit", async () => {
    const html = Array.from(
      { length: 5001 },
      (_, i) => `<p style="color: #234">Paragraph ${i}</p>`,
    ).join("");
    const { texts } = await chapters(await normalizeBook(raw(html), "html"));
    const doc = new DOMParser().parseFromString(
      texts[0],
      "application/xhtml+xml",
    );
    expect(doc.querySelectorAll("p")).toHaveLength(5001);
    expect(doc.querySelector("p:last-child")?.textContent).toBe(
      "Paragraph 5000",
    );
    expect(texts[0]).toContain("color: #234");
  });
  it("keeps inline CSS image URLs relative to the chapter and blocks remote styles", async () => {
    const data = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;
    const { zip, texts } = await chapters(
      await normalizeBook(
        raw(
          `<html><head><style>p{background-image:url('${data}')}@import 'https://tracker.invalid/a.css';</style></head><body><p style="background-image:url('${data}');color:red">Styled text</p></body></html>`,
        ),
        "html",
      ),
    );
    const image = Object.keys(zip.files).find((name) => name.endsWith(".png"))!;
    expect(image).toBeDefined();
    expect(texts[0]).toContain(
      `url(&quot;${image.slice("EPUB/".length)}&quot;)`,
    );
    expect(texts[0]).not.toContain("tracker.invalid");
  });
  it("reads MOBI chapters and rejects DRM before parsing", async () => {
    const noMetadata = mobi();
    new DataView(noMetadata).setUint32(94 + 128, 0);
    expect(
      (await chapters(await normalizeBook(noMetadata, "mobi"))).texts.join(""),
    ).toContain("幂等接口");
    const { texts } = await chapters(await normalizeBook(mobi(), "mobi"));
    expect(texts).toHaveLength(2);
    expect(texts.join("")).toContain("去重保证");
    await expect(normalizeBook(mobi(true), "mobi")).rejects.toThrow("DRM");
  });
  it("reads DOCX headings, paragraphs and tables", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    );
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX 幂等接口</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    );
    const { texts } = await chapters(
      await normalizeBook(
        await zip.generateAsync({ type: "arraybuffer" }),
        "docx",
      ),
    );
    expect(texts[0]).toContain("DOCX 幂等接口");
    expect(texts[0]).toContain("<table");
  });
  it("reads RTF Unicode and paragraphs", async () => {
    const { texts } = await chapters(
      await normalizeBook(
        raw("{\\rtf1\\ansi Hello\\par \\u20013?\\u25991?}"),
        "rtf",
      ),
    );
    expect(texts[0]).toContain("Hello");
    expect(texts[0]).toContain("中文");
  });
  it("sorts CBZ pages naturally and retains images", async () => {
    const zip = new JSZip();
    zip.file("page10.png", png);
    zip.file("page2.png", png);
    zip.file("page1.png", png);
    const { texts } = await chapters(
      await normalizeBook(
        await zip.generateAsync({ type: "arraybuffer" }),
        "cbz",
      ),
    );
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("page1.png");
    expect(texts[1]).toContain("page2.png");
    expect(texts[2]).toContain("page10.png");
  });
  it("opens a real stored RAR comic through unrar WASM", async () => {
    const outputs = await Promise.all([
      normalizeBook(rar(), "cbr"),
      normalizeBook(rar(), "cbr"),
    ]);
    const { texts } = await chapters(outputs[0]);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("page1.png");
  });
  it("rejects archive traversal and XML entities", async () => {
    await expect(
      bookZip(
        await new JSZip()
          .file("../escape.png", png)
          .generateAsync({ type: "arraybuffer" }),
      ),
    ).rejects.toThrow("路径");
    await expect(
      normalizeBook(
        raw('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]>' + fb2),
        "fb2",
      ),
    ).rejects.toThrow("实体");
  });
});
