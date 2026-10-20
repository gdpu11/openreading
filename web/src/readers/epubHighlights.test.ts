import { expect, it, vi } from "vitest";
import { clearEpubHighlights } from "./epubHighlights";

it("removes duplicate injected marks after the EPUB registry has forgotten them", () => {
  const mark = (className: string) => ({
    element: {
      classList: { contains: (value: string) => value === className },
    },
  });
  const orphan = mark("epub-highlight"),
    tracked = mark("epub-highlight"),
    other = mark("search-result");
  const pane = {
    marks: [orphan, tracked, other],
    removeMark: vi.fn((item: any) => {
      pane.marks.splice(pane.marks.indexOf(item), 1);
    }),
  };
  const rendition = {
    annotations: { remove: vi.fn(() => pane.removeMark(tracked)) },
    views: () => ({
      forEach: (callback: any) => [{ pane }, {}].forEach(callback),
    }),
  };
  const previous = new Set(["cfi"]);
  clearEpubHighlights(rendition, previous);
  expect(rendition.annotations.remove).toHaveBeenCalledWith("cfi", "highlight");
  expect(pane.marks).toEqual([other]);
  expect(previous.size).toBe(0);
});
