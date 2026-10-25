// Mammoth's Node XML adapter omits the required MIME argument in xmldom 0.9.
// Use the browser's XML parser for DOCX, with external entities disabled.
export const Node = globalThis.Node;
export function parseFromString(text: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error("DOCX 不允许外部实体声明");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw Error("DOCX XML 格式无效");
  return doc;
}
