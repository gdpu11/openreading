export const bookFormats = [
  ["epub", "EPUB"],
  ["pdf", "PDF"],
  ["mobi", "MOBI / AZW"],
  ["azw3", "AZW3 / KF8"],
  ["fb2", "FB2"],
  ["docx", "DOCX"],
  ["html", "HTML"],
  ["rtf", "RTF"],
  ["cbz", "CBZ"],
  ["cbr", "CBR"],
  ["txt", "TXT"],
  ["markdown", "Markdown"],
] as const;
export type BookFormat = (typeof bookFormats)[number][0];
export const bookFileAccept =
  ".epub,.kepub,.pdf,.mobi,.azw,.prc,.azw3,.kf8,.fb2,.fbz,.fb2.zip,.docx,.html,.htm,.xhtml,.rtf,.cbz,.cbr,.txt,.md,.markdown,.ord";
export function readingFormat(kind: string): string {
  return ["mobi", "azw3", "fb2", "docx", "html", "rtf", "cbz", "cbr"].includes(
    kind,
  )
    ? "epub"
    : kind;
}
export const isEpubFormat = (kind: string) => readingFormat(kind) === "epub";
