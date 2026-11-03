import type { ReadingView } from "./pace";

type Clip = { left: number; top: number; right: number; bottom: number };
const ignored =
  "script,style,nav,noscript,template,rt,rp,[hidden],[aria-hidden=true],.katex-mathml,[data-no-text]";

// Index character offsets without copying/counting an entire TXT or chapter.
// Only the bounded visible excerpt is read and counted by ReadingMeter.
export function readingViewport(
  root: HTMLElement,
  clip: Clip,
  section: string,
  order: number,
  layout: string,
): ReadingView | null {
  if (clip.right - clip.left < 4 || clip.bottom - clip.top < 4) return null;
  const positions = new Map<Node, { start: number; end: number }>();
  const chunks: { start: number; text?: string; node?: Text; end: number }[] =
    [];
  let at = 0;
  const newline = () => {
    chunks.push({ start: at, end: ++at, text: "\n" });
  };
  const visit = (node: Node) => {
    const begin = at;
    if (node.nodeType === 3) {
      at += (node as Text).length;
      chunks.push({ start: begin, end: at, node: node as Text });
    } else if (node.nodeType === 1) {
      const el = node as HTMLElement;
      if (
        el.matches(ignored) ||
        /display\s*:\s*none|visibility\s*:\s*hidden/i.test(
          el.getAttribute("style") || "",
        )
      )
        return;
      const block =
        /^(p|div|section|article|h[1-6]|li|br|td|th|tr|pre|blockquote)$/i.test(
          el.localName,
        );
      if (block) newline();
      node.childNodes.forEach(visit);
      if (block) newline();
    }
    positions.set(node, { start: begin, end: at });
  };
  visit(root);
  const document = root.ownerDocument;
  const offsetAt = (x: number, y: number) => {
    const d = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    };
    let range = d.caretRangeFromPoint?.(x, y);
    if (!range && d.caretPositionFromPoint) {
      const caret = d.caretPositionFromPoint(x, y);
      if (caret) {
        range = d.createRange();
        range.setStart(caret.offsetNode, caret.offset);
        range.collapse(true);
      }
    }
    if (!range || !root.contains(range.startContainer)) return null;
    const node = range.startContainer;
    let offset = range.startOffset;
    let bounds = range.getBoundingClientRect();
    // Chromium returns a zero-sized caret on a pre-wrapped blank line.
    // Inspect the adjacent visible character so an ordinary TXT paragraph
    // break cannot make a small scroll look like a jump over unread text.
    if (!bounds.height && node.nodeType === 3) {
      const text = (node as Text).data;
      let at = offset;
      while (at < Math.min(text.length, offset + 64) && /\s/.test(text[at]))
        at++;
      if (at === text.length) at = Math.max(0, offset - 1);
      if (at < text.length) {
        const probe = document.createRange();
        probe.setStart(node, at);
        probe.setEnd(node, at + 1);
        const rect = probe.getBoundingClientRect();
        if (rect.height) {
          bounds = rect;
          offset = at;
        }
      }
    }
    if (
      bounds.bottom < clip.top ||
      bounds.top > clip.bottom ||
      bounds.right < clip.left ||
      bounds.left > clip.right
    )
      return null;
    if (node.nodeType === 3) return positions.get(node)?.start! + offset;
    const child = node.childNodes[offset];
    return child ? positions.get(child)?.start : positions.get(node)?.end;
  };
  const points: number[] = [];
  for (const y of [clip.top + 8, (clip.top + clip.bottom) / 2, clip.bottom - 8])
    for (const x of [
      clip.left + 8,
      (clip.left + clip.right) / 2,
      clip.right - 8,
    ]) {
      const offset = offsetAt(x, y);
      if (offset !== null && offset !== undefined && Number.isFinite(offset))
        points.push(offset);
    }
  if (!points.length) return null;
  const start = Math.min(...points),
    end = Math.max(...points);
  const text = chunks
    .filter((c) => c.end > start && c.start < end)
    .map((c) =>
      (c.text ?? c.node!.data).slice(
        Math.max(0, start - c.start),
        Math.min(c.end, end) - c.start,
      ),
    )
    .join("");
  return text.trim() ? { section, order, layout, start, end, text } : null;
}
