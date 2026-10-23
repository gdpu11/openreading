import { readContent, api } from "../api";
import type { Prepared } from "./types";
import { yieldWordCount } from "./wordCount";
export type TextSection = {
  position: number;
  label: string;
  locator: any;
  text: string;
};
export type SearchHit = TextSection & {
  snippet: string;
  match: string;
  offset: number;
};

export function findInSections(
  sections: TextSection[],
  query: string,
): SearchHit[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [];
  const results: SearchHit[] = [];
  for (const section of sections) {
    const lower = section.text.toLocaleLowerCase();
    let offset = 0,
      occurrence = 0;
    while ((offset = lower.indexOf(term, offset)) >= 0) {
      results.push({
        ...section,
        text: "",
        offset,
        match: section.text.slice(offset, offset + term.length),
        snippet: section.text.slice(
          Math.max(0, offset - 60),
          offset + term.length + 110,
        ),
        locator: {
          ...section.locator,
          search: section.text.slice(offset, offset + term.length),
          occurrence: occurrence++,
        },
      });
      offset += term.length;
      if (results.length >= 1000) return results;
    }
  }
  return results;
}
export async function extractBookText(
  doc: Prepared,
  encoding: string,
  signal: AbortSignal,
  progress: (text: string) => void = () => {},
): Promise<TextSection[]> {
  const raw = await readContent(
    doc.version.id,
    doc.workspaceDocumentId,
    signal,
  );
  signal.throwIfAborted();
  if (doc.format === "pdf") {
    const recognized: any[] = await api(
      `/documents/${doc.workspaceDocumentId}/recognized-pages?version=${doc.version.id}`,
      "GET",
      undefined,
      { signal },
    );
    const pdfjs = await import("./pdf");
    const task = pdfjs.getDocument({
      data: new Uint8Array(raw),
      useSystemFonts: true,
    });
    const abort = () => void task.destroy();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const pdf = await task.promise,
        sections: TextSection[] = [];
      for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
        await yieldWordCount(signal);
        progress(`${pageIndex + 1} / ${pdf.numPages}`);
        const page = await pdf.getPage(pageIndex + 1),
          content = await page.getTextContent();
        const original = content.items
          .map((v: any) => (v.str || "") + (v.hasEOL ? "\n" : " "))
          .join("");
        const ocr = recognized.find(
          (p: any) => p.pageIndex === pageIndex,
        )?.text;
        sections.push({
          position: pageIndex,
          label: (!original.trim() && ocr ? "OCR · " : "") + `${pageIndex + 1}`,
          locator: { pageIndex },
          text: original.trim() ? original : ocr || "",
        });
        page.cleanup();
      }
      return sections;
    } finally {
      signal.removeEventListener("abort", abort);
      await task.destroy();
    }
  }
  if (doc.format === "epub") {
    const { openEpub } = await import("./epub");
    const epub = await openEpub(raw);
    try {
      return await epub.textSections(signal, progress);
    } finally {
      epub.book.destroy();
      epub.dispose();
    }
  }
  return [
    {
      position: 0,
      label: doc.title,
      locator: { scrollTop: 0 },
      text: new TextDecoder(doc.format === "txt" ? encoding : "utf-8").decode(
        raw,
      ),
    },
  ];
}
export async function cacheSearchIndex(
  doc: Prepared,
  sections: TextSection[],
  signal: AbortSignal,
) {
  // Bound requests while retaining all pages. The immutable version is the key.
  let batch: TextSection[] = [],
    bytes = 0,
    replace = true;
  for (const section of sections) {
    const size = new TextEncoder().encode(JSON.stringify(section)).length;
    if (size > 5 * 1024 * 1024) throw Error("章节过大，无法建立搜索索引");
    if (batch.length && bytes + size > 4 * 1024 * 1024) {
      await api(
        `/documents/${doc.workspaceDocumentId}/search-index`,
        "PUT",
        { versionId: doc.version.id, sections: batch, replace },
        { signal },
      );
      replace = false;
      batch = [];
      bytes = 0;
    }
    batch.push(section);
    bytes += size;
  }
  if (batch.length)
    await api(
      `/documents/${doc.workspaceDocumentId}/search-index`,
      "PUT",
      { versionId: doc.version.id, sections: batch, replace, complete: true },
      { signal },
    );
}
