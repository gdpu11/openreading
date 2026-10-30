const cjkCount = (text: string) =>
  (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [])
    .length;
const headingOrList = (text: string) =>
  /^(?:第[一二三四五六七八九十百零〇\d]+[章节卷部篇]|[一二三四五六七八九十]+[、．.]|[（(]?\d+[）).、]|[-•●])/u.test(
    text,
  );

// OCR returns visual lines, not paragraphs. Join only clear CJK body-line
// continuations; keep short titles, lists and explicit boundaries separate.
export function ocrParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let previous = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      previous = "";
      continue;
    }
    const cjk = cjkCount(previous);
    const nextCjk = cjkCount(line);
    const continuation =
      previous &&
      cjk >= 16 &&
      cjk >= previous.length / 2 &&
      (nextCjk >= 4 ||
        (nextCjk > 0 && /[。！？!?][”’」』）)\]】]*$/u.test(line))) &&
      !/[。！？.!?；;：:][”’」』）)\]】]*$/u.test(previous) &&
      !headingOrList(previous) &&
      !headingOrList(line);
    if (continuation) {
      const space =
        /[a-z\d]$/i.test(previous) && /^[a-z\d]/i.test(line) ? " " : "";
      paragraphs[paragraphs.length - 1] += space + line;
    } else paragraphs.push(line);
    previous = line;
  }
  return paragraphs;
}
