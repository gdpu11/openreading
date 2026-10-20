export const NORMALIZATION = "unicode-codepoint-preserve-v1";
export type Quote = {
  visible: string;
  exact: string;
  prefix: string;
  suffix: string;
};
export type Selector =
  | { type: "text"; start: number; end: number; block: string }
  | { type: "pdf"; pageIndex: number; quads: number[][] }
  | { type: "epub"; cfi: string; href: string };
export type Anchor = {
  schemaVersion: 1;
  workspaceDocumentId: string;
  documentVersionId: string;
  extractionArtifactId: string;
  resourceManifestId?: string;
  targetKind: "text" | "page";
  quote: Quote;
  selectors: Selector[];
  displayLocation: { label: string; pageIndex?: number };
  normalizationVersion: string;
  parserVersion: string;
};
export type Resolution = {
  state: "resolved" | "ambiguous" | "missing" | "unsupported";
  start?: number;
  end?: number;
};
export const points = (s: string) => Array.from(s);
export const cpOffset = (s: string, utf16: number) =>
  points(s.slice(0, utf16)).length;
export const utf16Offset = (s: string, cp: number) =>
  points(s).slice(0, cp).join("").length;
export function quoteAt(text: string, start: number, end: number): Quote {
  const p = points(text);
  return {
    visible: p.slice(start, end).join(""),
    exact: p.slice(start, end).join(""),
    prefix: p.slice(Math.max(0, start - 32), start).join(""),
    suffix: p.slice(end, end + 32).join(""),
  };
}
export function resolveQuote(
  text: string,
  quote: Quote,
  position?: { start: number; end: number },
  sameVersion = false,
): Resolution {
  const p = points(text);
  if (!quote.exact) return { state: "unsupported" };
  if (
    sameVersion &&
    position &&
    p.slice(position.start, position.end).join("") === quote.exact
  )
    return { state: "resolved", ...position };
  const candidates: number[] = [];
  let at = 0;
  while (at <= text.length) {
    const i = text.indexOf(quote.exact, at);
    if (i < 0) break;
    const cp = cpOffset(text, i);
    const end = cp + points(quote.exact).length;
    if (
      (!quote.prefix ||
        p.slice(Math.max(0, cp - points(quote.prefix).length), cp).join("") ===
          quote.prefix) &&
      (!quote.suffix ||
        p.slice(end, end + points(quote.suffix).length).join("") ===
          quote.suffix)
    )
      candidates.push(cp);
    at = i + Math.max(1, quote.exact.length);
  }
  return candidates.length === 1
    ? {
        state: "resolved",
        start: candidates[0],
        end: candidates[0] + points(quote.exact).length,
      }
    : { state: candidates.length > 1 ? "ambiguous" : "missing" };
}
export function textMap(root: Node): { text: string; nodes: Text[] } {
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const e = node.parentElement;
      return e?.closest(
        'script,style,noscript,[data-no-text],.annotation-overlay,.katex-mathml,[aria-hidden="true"]',
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return { text: nodes.map((n) => n.data).join(""), nodes };
}
export function captureRange(root: Node, range: Range) {
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    throw new Error("请在同一页或章节内选择文字；跨页请分段批注");
  const { text, nodes } = textMap(root);
  let offset = 0;
  let start = -1,
    end = -1;
  for (const n of nodes) {
    if (n === range.startContainer) start = offset + range.startOffset;
    if (n === range.endContainer) end = offset + range.endOffset;
    offset += n.data.length;
  }
  // Element boundaries occur with keyboard and triple-click selections.
  if (start < 0 || end < 0) {
    const before = range.cloneRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    start = before.toString().length;
    end = start + range.toString().length;
  }
  return {
    text,
    start: cpOffset(text, start),
    end: cpOffset(text, end),
    quote: quoteAt(text, cpOffset(text, start), cpOffset(text, end)),
  };
}
export function rangeAt(root: Node, start: number, end: number): Range | null {
  const { text, nodes } = textMap(root);
  const a = utf16Offset(text, start),
    b = utf16Offset(text, end);
  let offset = 0;
  let begun = false;
  const range = (root.ownerDocument || document).createRange();
  for (const n of nodes) {
    if (!begun && a <= offset + n.length) {
      range.setStart(n, Math.max(0, a - offset));
      begun = true;
    }
    if (begun && b <= offset + n.length) {
      range.setEnd(n, Math.max(0, b - offset));
      return range;
    }
    offset += n.length;
  }
  return null;
}
export function pdfQuads(
  rects: DOMRect[],
  pageRect: DOMRect,
  viewport: { convertToPdfPoint: (x: number, y: number) => number[] },
): number[][] {
  return rects
    .filter((r) => r.width > 0.5 && r.height > 0.5)
    .map((r) => [
      ...viewport.convertToPdfPoint(
        r.left - pageRect.left,
        r.top - pageRect.top,
      ),
      ...viewport.convertToPdfPoint(
        r.right - pageRect.left,
        r.top - pageRect.top,
      ),
      ...viewport.convertToPdfPoint(
        r.right - pageRect.left,
        r.bottom - pageRect.top,
      ),
      ...viewport.convertToPdfPoint(
        r.left - pageRect.left,
        r.bottom - pageRect.top,
      ),
    ]);
}
export function projectQuad(
  quad: number[],
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] },
) {
  const p = [0, 2, 4, 6].map((i) =>
    viewport.convertToViewportPoint(quad[i], quad[i + 1]),
  );
  return {
    left: Math.min(...p.map((x) => x[0])),
    top: Math.min(...p.map((x) => x[1])),
    width: Math.max(...p.map((x) => x[0])) - Math.min(...p.map((x) => x[0])),
    height: Math.max(...p.map((x) => x[1])) - Math.min(...p.map((x) => x[1])),
  };
}
