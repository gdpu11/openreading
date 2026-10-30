import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("../readers/pdf", () => ({ getDocument }));
vi.mock("../readers/epub", () => ({ openEpub: vi.fn() }));
vi.mock("../api", () => ({ api: vi.fn(), readContent: vi.fn() }));
import { pdfToEpub } from "./convert";

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
      '<body></body>',
    );
  });

  it("writes continuous OCR body lines as a reflowable paragraph", async () => {
    const first = "为什么世间的管理者很多，而真能发挥他人长处者却不";
    const second = "多？以林肯为例，为什么他要学会用人所长的道理？";
    recognizePage.mockResolvedValue(first + "\n" + second);
    const zip = await JSZip.loadAsync(await pdfToEpub(new ArrayBuffer(0), "Test", "ocr", new AbortController().signal, () => {}));
    expect(await zip.file("EPUB/page-1.xhtml")!.async("string")).toContain(`<p dir="auto">${first}${second}</p>`);
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
});
