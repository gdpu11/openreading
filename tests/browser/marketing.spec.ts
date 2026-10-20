import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { execFileSync } from "node:child_process";
test.use({ trace: "off", screenshot: "off" });
test("Capture demonstration-only launch screenshots", async () => {
  test.skip(!process.env.OR_MARKETING || process.platform !== "darwin");
  test.setTimeout(120000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-demo-"));
  const materials = join(dir, "books");
  await mkdir(materials);
  await mkdir("docs/images", { recursive: true });
  const books = [
    ["深度阅读手册", "A READER'S GUIDE", "#192f35", "#f6dfb5"],
    ["把笔记写在页边", "NOTES IN THE MARGINS", "#f3e6ce", "#394433"],
    ["构建你的阅读系统", "BUILD YOUR OWN LIBRARY", "#a65543", "#fff4db"],
    ["慢读的力量", "THE ART OF SLOW READING", "#c7d0b9", "#23392e"],
    ["读懂每一页", "ONE PAGE AT A TIME", "#d9e3ea", "#273b4b"],
    ["思考的路径", "PATHS TO UNDERSTANDING", "#2d303c", "#e8c575"],
    ["专注与留白", "SPACE TO FOCUS", "#ede8e0", "#574642"],
    ["书与生活", "BOOKS AND EVERYDAY LIFE", "#8f3947", "#f4e5cd"],
  ];
  for (const [title, subtitle, bg, fg] of books) {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file(
      "META-INF/container.xml",
      '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    );
    zip.file(
      "book.opf",
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${crypto.randomUUID()}</dc:identifier><dc:title>${title}</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="cover"/><itemref idref="chapter"/></spine></package>`,
    );
    zip.file(
      "cover.svg",
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900"><rect width="600" height="900" fill="${bg}"/><rect x="32" y="32" width="536" height="836" fill="none" stroke="${fg}" opacity=".35"/><text x="64" y="104" fill="${fg}" font-family="sans-serif" font-size="16" letter-spacing="5">OPEN READING</text><path d="M90 480 Q300 370 510 480 M90 510 Q300 400 510 510 M90 540 Q300 430 510 540 M300 405 V615" fill="none" stroke="${fg}" stroke-width="4"/><text x="60" y="258" fill="${fg}" font-family="sans-serif" font-size="47" font-weight="600">${title}</text><text x="64" y="308" fill="${fg}" font-family="sans-serif" font-size="15" letter-spacing="2">${subtitle}</text><text x="64" y="794" fill="${fg}" font-family="sans-serif" font-size="17">原创示例 · DEMO EDITION</text></svg>`,
    );
    zip.file(
      "cover.png",
      execFileSync("rsvg-convert", ["--format", "png"], {
        input: await zip.file("cover.svg")!.async("string"),
      }),
    );
    zip.file(
      "cover.xhtml",
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body><img src="cover.png" alt="原创示例封面"/></body></html>',
    );
    zip.file(
      "nav.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章 从阅读到理解</a></li></ol></nav></body></html>`,
    );
    zip.file(
      "chapter.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>从阅读到理解</title><style>body{line-height:2}p{margin:1.3em 0}h1{margin-bottom:1.4em}</style></head><body><h1>第一章 从阅读到理解</h1><p>阅读不是收集更多文字，而是建立属于自己的理解。</p><p>当我们读到一句打动自己的话，不必急着翻过下一页。停下来，做一个标注，写下它与自己经历的联系。这样的笔记，才会在下次需要时重新发光。</p><h2>让笔记和原文待在一起</h2><p>一个好的阅读工具，应该帮你留住思考发生的那个位置。回到书页时，原句、问题和自己的理解仍然在一起。</p><p>同一本书可以慢慢读，不同的书也可以同时打开，对照着看。把知识放进自己的框架，比把所有内容都记下来更有价值。</p><h2>书库在自己的电脑上</h2><p>用自己的文件，按自己的节奏阅读。无需先搭建服务器，电脑就可以成为书库；同一局域网中的手机，经确认授权后也能带走这些阅读资料。</p><p>这里的文字与封面均为 Open Reading 原创演示内容，不包含个人书籍、笔记或真实阅读数据。</p></body></html>`,
    );
    await writeFile(
      join(materials, title + ".epub"),
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
  }
  let app: any;
  try {
    app = await electron.launch({
      args: [resolve("desktop/main.cjs")],
      env: {
        ...process.env,
        OR_DESKTOP_SMOKE: "1",
        OR_DESKTOP_DATA: join(dir, "data"),
      },
      executablePath: resolve(
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
    });
    const library = await app.firstWindow();
    await library.waitForURL(/127.0.0.1/);
    await expect(
      library.getByRole("heading", { name: "Welcome to Open Reading." }),
    ).toBeVisible();
    await library.evaluate(async (path: string) => {
      const me = await (await fetch("/api/me")).json();
      const put = async (url: string, method: string, data: any) => {
        const r = await fetch("/api" + url, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": me.csrf,
          },
          body: JSON.stringify(data),
        });
        if (!r.ok) throw Error(await r.text());
        return r.json();
      };
      const w = await put("/workspaces", "POST", { name: "示例书库" });
      await put("/preferences", "PUT", {
        language: "zh",
        documentSort: "name",
        fontSize: 20,
      });
      localStorage.setItem("open-reading-language", "zh");
      const s = await put(`/workspaces/${w.id}/sources`, "POST", {
        path,
        label: "原创示例",
      });
      for (let i = 0; i < 150; i++) {
        const scan = await (await fetch(`/api/scans/${s.scan.id}`)).json();
        if (scan.state === "completed") return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error("scan timed out");
    }, materials);
    await library.reload();
    await expect(library.locator(".library-book")).toHaveCount(8);
    await expect(library.locator(".library-book img")).toHaveCount(8);
    await expect
      .poll(() =>
        library
          .locator(".library-book img")
          .evaluateAll((imgs: any) =>
            imgs.every((img: any) => img.complete && img.naturalWidth > 0),
          ),
      )
      .toBe(true);
    await library.screenshot({ path: "docs/images/library.png" });
    const opened = app.waitForEvent("window");
    await library
      .locator(".library-book")
      .filter({ hasText: "深度阅读手册" })
      .click();
    const book = await opened;
    await expect(book.locator(".reader-status")).toHaveCount(0);
    await book.getByRole("button", { name: "下一节", exact: true }).click();
    const body = book.frameLocator(".epub-container iframe").locator("body");
    await expect(body).toContainText("阅读不是收集更多文字");
    await body.evaluate((el: any) => {
      const quote = "阅读不是收集更多文字，而是建立属于自己的理解。";
      const doc = el.ownerDocument;
      const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.textContent.includes(quote)) {
          const at = n.textContent.indexOf(quote);
          const range = doc.createRange();
          range.setStart(n, at);
          range.setEnd(n, at + quote.length);
          const sel = doc.defaultView.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return;
        }
      }
      throw Error("selection missing");
    });
    await book
      .locator(".selection-toolbar")
      .getByRole("button", { name: "评论", exact: true })
      .click();
    await book
      .getByLabel("评论输入")
      .fill(
        "读完并不等于理解。下次读到这里，试着用自己的话解释，并补上一个实际例子。",
      );
    await book.getByLabel("发送评论").click();
    await expect(book.locator(".note-body")).toContainText("读完并不等于理解");
    await book.screenshot({ path: "docs/images/reading-notes.png" });
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
