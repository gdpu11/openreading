import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("../readers/pdf", () => ({ getDocument }));
vi.mock("../readers/epub", () => ({ openEpub: vi.fn() }));
vi.mock("../api", () => ({ api: vi.fn(), readContent: vi.fn() }));
import { pdfToEpub, pdfToTxt } from "./convert";

describe("scanned PDF to reflowable EPUB", () => {
  let recognizePage: ReturnType<typeof vi.fn>;
  let pages: ReturnType<typeof page>[];
  let destroy: ReturnType<typeof vi.fn>;
  let canvases: any[];
  function page(text = "") {
    return {
      getTextContent: vi.fn(async () => ({
        items: text ? [{ str: text, transform: [1, 0, 0, 1, 0, 0] }] : [],
      })),
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      getOperatorList: vi.fn(async () => ({ fnArray: [1] })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn(),
    };
  }
  beforeEach(() => {
    recognizePage = vi.fn(async () => "扫描文字 <正文> & English\n第二行");
    vi.stubGlobal("window", { openReadingDesktop: { recognizePage } });
    canvases = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          toDataURL: () => "data:image/png;base64,test-page",
          toBlob: (callback: (blob: Blob) => void) =>
            callback(new Blob(["page-image"])),
        };
        canvases.push(canvas);
        return canvas;
      },
    });
    pages = [page("Original text"), page(), page("Final page")];
    destroy = vi.fn(async () => {});
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async (n: number) => pages[n - 1],
      }),
      destroy,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("recognizes every page in OCR mode even when a scan has an existing watermark text layer", async () => {
    recognizePage
      .mockResolvedValueOnce("识别的第一页正文")
      .mockResolvedValueOnce("扫描文字 <正文> & English\n第二行")
      .mockResolvedValueOnce("识别的末页正文");
    const progress = vi.fn();
    const zip = await JSZip.loadAsync(
      await pdfToEpub(
        new ArrayBuffer(0),
        "Test",
        "ocr",
        new AbortController().signal,
        progress,
      ),
    );
    expect(recognizePage).toHaveBeenCalledTimes(3);
    expect(await zip.file("EPUB/page-1.xhtml")!.async("string")).toContain(
      "识别的第一页正文",
    );
    expect(await zip.file("EPUB/page-2.xhtml")!.async("string")).toContain(
      '<p dir="auto">扫描文字 &lt;正文&gt; &amp; English</p>\n<p dir="auto">第二行</p>',
    );
    expect(await zip.file("EPUB/page-3.xhtml")!.async("string")).toContain(
      "识别的末页正文",
    );
    expect(zip.file(/\.jpg$/)).toHaveLength(0);
    expect(await zip.file("EPUB/book.opf")!.async("string")).toContain(
      '<itemref idref="page-1"/><itemref idref="page-2"/><itemref idref="page-3"/>',
    );
    expect(progress).toHaveBeenCalledWith(1, 3, "ocr");
    expect(canvases[0].width).toBe(0);
    expect(destroy).toHaveBeenCalled();
  });

  it("does not embed a full page scan when OCR finds no text", async () => {
    recognizePage.mockResolvedValue(" \n ");
    const zip = await JSZip.loadAsync(
      await pdfToEpub(
        new ArrayBuffer(0),
        "Test",
        "ocr",
        new AbortController().signal,
        () => {},
      ),
    );
    expect(zip.file("EPUB/images/page-2.jpg")).toBeNull();
    expect(await zip.file("EPUB/page-2.xhtml")!.async("string")).toContain(
      "<body></body>",
    );
  });

  it("writes continuous OCR body lines as a reflowable paragraph", async () => {
    const first = "为什么世间的管理者很多，而真能发挥他人长处者却不";
    const second = "多？以林肯为例，为什么他要学会用人所长的道理？";
    recognizePage.mockResolvedValue(first + "\n" + second);
    const zip = await JSZip.loadAsync(
      await pdfToEpub(
        new ArrayBuffer(0),
        "Test",
        "ocr",
        new AbortController().signal,
        () => {},
      ),
    );
    expect(await zip.file("EPUB/page-1.xhtml")!.async("string")).toContain(
      `<p dir="auto">${first}${second}</p>`,
    );
  });

  it("preserves existing text and image modes without calling OCR", async () => {
    for (const mode of ["text", "images"] as const) {
      const zip = await JSZip.loadAsync(
        await pdfToEpub(
          new ArrayBuffer(0),
          "Test",
          mode,
          new AbortController().signal,
          () => {},
        ),
      );
      expect(zip.file(/\.jpg$/)).toHaveLength(mode === "text" ? 1 : 3);
    }
    expect(recognizePage).not.toHaveBeenCalled();
  });

  it("rejects unavailable or failed OCR instead of reporting an image-only conversion as success", async () => {
    vi.stubGlobal("window", {});
    await expect(
      pdfToEpub(
        new ArrayBuffer(0),
        "Test",
        "ocr",
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(/desktop|桌面端/);
    expect(getDocument).not.toHaveBeenCalled();
    vi.stubGlobal("window", { openReadingDesktop: { recognizePage } });
    recognizePage.mockRejectedValue(Error("OCR engine failed"));
    await expect(
      pdfToEpub(
        new ArrayBuffer(0),
        "Test",
        "ocr",
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("OCR engine failed");
    expect(destroy).toHaveBeenCalled();
    expect(canvases[0].width).toBe(0);
  });

  it("does not process subsequent pages or produce an EPUB after cancellation during OCR", async () => {
    const controller = new AbortController();
    recognizePage.mockImplementation(async () => {
      controller.abort();
      return "recognized";
    });
    await expect(
      pdfToEpub(new ArrayBuffer(0), "Test", "ocr", controller.signal, () => {}),
    ).rejects.toThrow();
    expect(pages[2].getTextContent).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
    expect(canvases[0].width).toBe(0);
  });

  it("exports UTF-8 TXT in page order, extracting text and using OCR only for scans", async () => {
    const progress = vi.fn();
    const bytes = await pdfToTxt(
      new ArrayBuffer(0),
      "auto",
      new AbortController().signal,
      progress,
    );
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(
      "Original text\n\n扫描文字 <正文> & English\n\n第二行\n\nFinal page",
    );
    expect(recognizePage).toHaveBeenCalledTimes(1);
    expect(pages[0].render).not.toHaveBeenCalled();
    expect(pages[1].render).toHaveBeenCalledTimes(1);
    expect(pages[2].render).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(1, 3, "ocr");
    expect(progress).toHaveBeenLastCalledWith(3, 3);
    expect(canvases[0].width).toBe(0);
    for (const p of pages) expect(p.cleanup).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalled();
  });

  it("extracts text-only PDFs in the browser without requiring OCR", async () => {
    vi.stubGlobal("window", {});
    pages[1] = page("中文正文和 English");
    const bytes = await pdfToTxt(
      new ArrayBuffer(0),
      "auto",
      new AbortController().signal,
      () => {},
    );
    expect(new TextDecoder().decode(bytes)).toContain("中文正文和 English");
    expect(canvases).toHaveLength(0);
    expect(recognizePage).not.toHaveBeenCalled();
  });

  it("skips truly blank pages in text PDFs without requiring browser OCR", async () => {
    vi.stubGlobal("window", {});
    pages[1].getOperatorList.mockResolvedValue({ fnArray: [] });
    const progress = vi.fn();
    const bytes = await pdfToTxt(
      new ArrayBuffer(0),
      "auto",
      new AbortController().signal,
      progress,
    );
    expect(new TextDecoder().decode(bytes)).toBe("Original text\n\nFinal page");
    expect(progress).toHaveBeenLastCalledWith(3, 3);
    expect(pages[1].render).not.toHaveBeenCalled();
    expect(pages[1].cleanup).toHaveBeenCalled();
  });

  it("uses detailed OCR on every page when requested, ignoring incomplete watermark text layers", async () => {
    const recognizePageDetailed = vi.fn(async () => ({
      lines: [{ text: "识别出来的正文" }],
    }));
    vi.stubGlobal("window", { openReadingDesktop: { recognizePageDetailed } });
    const bytes = await pdfToTxt(
      new ArrayBuffer(0),
      "ocr",
      new AbortController().signal,
      () => {},
    );
    expect(new TextDecoder().decode(bytes)).toBe(
      "识别出来的正文\n\n识别出来的正文\n\n识别出来的正文",
    );
    expect(recognizePageDetailed).toHaveBeenCalledTimes(3);
    expect(pages[0].getTextContent).not.toHaveBeenCalled();
    for (const canvas of canvases) expect(canvas.width).toBe(0);
  });

  it("joins wrapped Chinese text into paragraphs without adding page labels or HTML", async () => {
    const first = "为什么世间的管理者很多，而真能发挥他人长处者却不";
    const second = "多？以林肯为例，为什么他要学会用人所长的道理？";
    recognizePage.mockResolvedValue(first + "\n" + second);
    const bytes = await pdfToTxt(
      new ArrayBuffer(0),
      "ocr",
      new AbortController().signal,
      () => {},
    );
    expect(new TextDecoder().decode(bytes).split("\n\n")).toEqual(
      Array(3).fill(first + second),
    );
  });

  it("fails rather than silently dropping scanned pages when OCR is unavailable or fails", async () => {
    vi.stubGlobal("window", {});
    await expect(
      pdfToTxt(
        new ArrayBuffer(0),
        "auto",
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(/Page 2|第 2 页/);
    expect(pages[2].getTextContent).not.toHaveBeenCalled();
    expect(pages[1].cleanup).toHaveBeenCalled();
    vi.stubGlobal("window", { openReadingDesktop: { recognizePage } });
    recognizePage.mockRejectedValue(Error("OCR engine failed"));
    await expect(
      pdfToTxt(
        new ArrayBuffer(0),
        "auto",
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("OCR engine failed");
    expect(canvases[0].width).toBe(0);
    expect(destroy).toHaveBeenCalled();
  });

  it("rejects empty recognition and cancellation without returning a partial TXT", async () => {
    recognizePage.mockResolvedValue(" \n");
    await expect(
      pdfToTxt(
        new ArrayBuffer(0),
        "ocr",
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(/No text|未识别到文字/);
    const controller = new AbortController();
    recognizePage.mockImplementation(async () => {
      controller.abort();
      return "must not be exported";
    });
    for (const p of pages) p.render.mockClear();
    await expect(
      pdfToTxt(new ArrayBuffer(0), "ocr", controller.signal, () => {}),
    ).rejects.toThrow();
    expect(pages[1].render).not.toHaveBeenCalled();
    for (const canvas of canvases) expect(canvas.width).toBe(0);
    expect(destroy).toHaveBeenCalled();
  });

  it("rejects encrypted PDFs and cleans up the loading task", async () => {
    const task = {
      promise: new Promise(() => {}),
      destroy,
      onPassword: () => {},
    };
    getDocument.mockImplementation(() => {
      queueMicrotask(() => task.onPassword());
      return task;
    });
    await expect(
      pdfToTxt(
        new ArrayBuffer(0),
        "auto",
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(/encrypted|加密/);
    expect(destroy).toHaveBeenCalled();
  });
});
