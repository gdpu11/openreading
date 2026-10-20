import { describe, it, expect, vi } from "vitest";
import { countWords, countTextWords, pdfWordCount } from "./wordCount";

describe("whole-book counting rules", () => {
  it("counts Unicode Chinese characters, combining marks and English words without emoji/punctuation", () => {
    expect(countWords("中文𠮷 Hello world! 👩‍💻 e\u0301")).toBe(6);
    expect(countWords("don't it’s café Καλημέρα 123")).toBe(5);
    expect(countWords(" \n -- 🐱…，。\t")).toBe(0);
    expect(countWords("你好hello世界world")).toBe(6);
  });
  it("keeps words and supplementary characters intact at background chunk boundaries", async () => {
    const text =
      " ".repeat(32766) + "e\u0301clair 中文𠮷 don't" + " 好read".repeat(20000);
    expect(await countTextWords(text, new AbortController().signal)).toBe(
      countWords(text),
    );
  });
  it("reads every PDF text layer without rasterizing and reports pages without text", async () => {
    const pdf = {
      numPages: 3,
      getPage: vi.fn(async (n: number) => ({
        getTextContent: async () => ({
          items: n === 2 ? [] : [{ str: n === 1 ? "First page" : "最后一页" }],
        }),
      })),
    };
    expect(await pdfWordCount(pdf, new AbortController().signal)).toEqual({
      count: 6,
      pages: 3,
      textPages: 2,
    });
    expect(pdf.getPage.mock.calls.map((call) => call[0])).toEqual([1, 2, 3]);
  });
  it("stops extracting when the book is closed", async () => {
    const abort = new AbortController();
    const getTextContent = vi.fn(async () => {
      abort.abort();
      return { items: [{ str: "First page" }] };
    });
    const pdf = {
      numPages: 500,
      getPage: vi.fn(async () => ({ getTextContent })),
    };
    await expect(pdfWordCount(pdf, abort.signal)).rejects.toThrow();
    expect(pdf.getPage).toHaveBeenCalledTimes(1);
  });
});
