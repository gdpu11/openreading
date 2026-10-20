import { api } from "../api";
import type { Prepared } from "./types";

export type BookWordCount = {
  count: number;
  textPages?: number;
  pages?: number;
};
// Invalidate generated caches whenever extraction or counting rules change.
export const WORD_COUNT_RULE = "body-mixed-v1";
const cjk =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const words = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’][\p{L}\p{M}\p{N}]+)*/gu;

// A Chinese character is one unit; alphabetic words (including combining marks)
// are one unit. Whitespace, punctuation and emoji do not contribute.
export function countWords(text: string): number {
  let count = 0;
  const rest = text.replace(cjk, () => {
    count++;
    return " ";
  });
  for (const _ of rest.matchAll(words)) count++;
  return count;
}

// Yield between bounded text slices so a large TXT/chapter cannot freeze page turns.
export async function countTextWords(
  text: string,
  signal: AbortSignal,
): Promise<number> {
  let count = 0,
    start = 0;
  while (start < text.length) {
    await yieldWordCount(signal);
    let end = Math.min(start + 32768, text.length);
    // Never split a surrogate pair or an alphabetic word across slices.
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    while (end < text.length) {
      const character = String.fromCodePoint(text.codePointAt(end)!);
      if (
        !/[\p{L}\p{N}\p{M}'’]/u.test(character) ||
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
          character,
        )
      )
        break;
      end += character.length;
    }
    count += countWords(text.slice(start, end));
    start = end;
  }
  signal.throwIfAborted();
  return count;
}

export function bodyText(root: Node): string {
  const parts: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent || "");
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (
      el.matches(
        "script,style,nav,noscript,template,rt,rp,[hidden],[aria-hidden=true],.katex-mathml",
      )
    )
      return;
    if (
      /display\s*:\s*none|visibility\s*:\s*hidden/i.test(
        el.getAttribute("style") || "",
      )
    )
      return;
    const block =
      /^(p|div|section|article|h[1-6]|li|br|td|th|tr|pre|blockquote)$/i.test(
        el.localName,
      );
    if (block) parts.push("\n");
    node.childNodes.forEach(visit);
    if (block) parts.push("\n");
  };
  visit(root);
  return parts.join("");
}

export function yieldWordCount(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    }, 0);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

// The server cache belongs to the immutable content hash and decoding rules,
// rather than a window, current chapter, filename, or ephemeral local origin.
export async function bookWordCount(
  doc: Prepared,
  encoding: string,
  signal: AbortSignal,
  calculate: () => Promise<BookWordCount>,
): Promise<BookWordCount> {
  const query = new URLSearchParams({
    workspaceDocumentId: doc.workspaceDocumentId,
    rule: WORD_COUNT_RULE,
    encoding: doc.format === "txt" ? encoding : "utf-8",
  });
  const endpoint = `/versions/${doc.version.id}/word-count?${query}`;
  try {
    const cached = await api(endpoint, "GET", undefined, { signal });
    if (cached.statistics) return cached.statistics;
  } catch {
    signal.throwIfAborted(); /* Offline/mobile transport may lack this regenerable cache. */
  }
  await yieldWordCount(signal);
  const result = await calculate();
  signal.throwIfAborted();
  try {
    await api(endpoint, "PUT", result, { signal });
  } catch {
    signal.throwIfAborted(); /* Still show a successful local calculation if caching failed. */
  }
  return result;
}

export async function pdfWordCount(
  pdf: any,
  signal: AbortSignal,
): Promise<BookWordCount> {
  let count = 0,
    textPages = 0;
  for (let index = 1; index <= pdf.numPages; index++) {
    await yieldWordCount(signal);
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    signal.throwIfAborted();
    const text = content.items.map((item: any) => item.str || "").join(" ");
    const n = await countTextWords(text, signal);
    if (n) textPages++;
    count += n;
  }
  return { count, textPages, pages: pdf.numPages };
}
