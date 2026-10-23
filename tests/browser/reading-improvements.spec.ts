import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import JSZip from "jszip";

let child: ChildProcess, origin: string, code: string, directory: string;
const evidence =
  process.env.OR_FEATURE_EVIDENCE ||
  "/private/tmp/openreading-feature-evidence";
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openreading-features-"));
  await mkdir(evidence, { recursive: true });
  child = spawn(
    process.env.OR_TEST_BINARY || "/private/tmp/openreading-feature-server",
    [
      "--data-dir",
      directory,
      "--port",
      "0",
      "--machine-readable",
      "--allow-mock",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((done, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(Error("startup timed out: " + out)),
      15000,
    );
    child.stdout!.on("data", (chunk) => {
      out += chunk;
      for (const line of out.split("\n")) {
        try {
          const ready = JSON.parse(line);
          if (ready.type === "ready") {
            origin = ready.url;
            code = ready.code;
            clearTimeout(timer);
            done();
          }
        } catch {}
      }
    });
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(Error("server exited"));
    });
  });
});
test.afterAll(async () => {
  if (child?.exitCode === null) {
    const exited = new Promise<void>((done) =>
      child.once("exit", () => done()),
    );
    child.kill("SIGINT");
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
});
async function login(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("open-reading-language", "zh"),
  );
  await page.goto(origin);
  await page.getByLabel("本机配对码").fill(code);
  await page.getByRole("button", { name: "进入阅读空间", exact: true }).click();
  await expect(page.locator(".topbar")).toBeVisible();
}
async function setupBooks(page: Page) {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of [
    "The first page has no target",
    "The second page contains UNIQUE_SEARCH_TARGET",
  ]) {
    const p = pdf.addPage([450, 600]);
    p.drawText(text, { x: 30, y: 500, size: 12, font });
  }
  const pdfBytes = await pdf.save();
  return page.evaluate(
    async ({ pdf }) => {
      const me = await (await fetch("/api/me")).json();
      const json = async (path: string, method = "GET", body?: any) => {
        const r = await fetch("/api" + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": me.csrf,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!r.ok) throw Error(await r.text());
        return r.json();
      };
      const workspace = await json("/workspaces", "POST", { name: "功能验收" });
      const form = new FormData();
      form.append(
        "files",
        new File(
          [
            "# 阅读与思考\n\n理解需要不断回到原文验证。\n\n这里记录自己的理解。",
          ],
          "阅读与思考.md",
        ),
      );
      form.append("files", new File([new Uint8Array(pdf)], "两页测试.pdf"));
      const response = await fetch(`/api/workspaces/${workspace.id}/imports`, {
        method: "POST",
        headers: { "X-CSRF-Token": me.csrf },
        body: form,
      });
      if (!response.ok) throw Error(await response.text());
      const imported = await response.json();
      if (imported.scan?.id) {
        let complete = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          const scan = await json(`/scans/${imported.scan.id}`);
          if (scan.state === "completed") {
            complete = true;
            break;
          }
          if (scan.state === "failed")
            throw Error("fixture import scan failed");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!complete) throw Error("fixture import scan timed out");
      }
      const documents = (await json(`/workspaces/${workspace.id}/documents`))
        .items;
      const book = documents.find((d: any) => d.format === "markdown");
      const prepared = await json(
        `/documents/${book.documentId}/prepare`,
        "POST",
        { workspaceDocumentId: book.id, sourceEntryId: book.bindings[0].id },
      );
      const text = "理解需要不断回到原文验证。",
        artifact = await json("/artifacts", "POST", {
          workspaceDocumentId: book.id,
          versionId: prepared.version.id,
          parserVersion: "react-markdown-10-map-v1",
          normalizationVersion: "unicode-codepoint-preserve-v1",
          blocks: [{ id: "body", text, locator: { label: "正文" } }],
        });
      const anchor = {
        schemaVersion: 1,
        workspaceDocumentId: book.id,
        documentVersionId: prepared.version.id,
        extractionArtifactId: artifact.id,
        resourceManifestId: prepared.resourceManifestId,
        targetKind: "text",
        quote: { visible: text, exact: text, prefix: "", suffix: "" },
        selectors: [
          {
            type: "text",
            start: 0,
            end: Array.from(text).length,
            block: "body",
          },
        ],
        displayLocation: { label: "正文" },
        normalizationVersion: "unicode-codepoint-preserve-v1",
        parserVersion: "react-markdown-10-map-v1",
      };
      const note = await json("/threads", "POST", {
        workspaceDocumentId: book.id,
        documentVersionId: prepared.version.id,
        selectionSnapshot: anchor,
        message: {
          body: "我的关键理解是证据比猜测更重要。",
          recipient: "note",
        },
        clientRequestId: crypto.randomUUID(),
      });
      await json("/preferences", "PUT", { activeWorkspaceId: workspace.id });
      return { workspace, documents, note };
    },
    { pdf: Array.from(pdfBytes) },
  );
}
test("desktop searches all PDF pages and restores book settings; notes ignore library filters", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  const data = await setupBooks(page);
  await page.reload();
  await page.locator(".file-item").filter({ hasText: "两页测试.pdf" }).click();
  await expect(page.locator(".pdf-page").first()).toBeVisible();
  await page.getByRole("button", { name: "全书搜索", exact: true }).click();
  await page.getByLabel("全书关键词").fill("UNIQUE_SEARCH_TARGET");
  await page.getByRole("button", { name: "搜索整本书", exact: true }).click();
  await expect(page.locator(".search-hit")).toHaveCount(1);
  await expect(page.locator(".search-hit")).toContainText("second page");
  await page.locator(".search-hit").click();
  await page.getByLabel("关闭阅读工具").click();
  await page.getByRole("button", { name: "书签", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept("第二页关键结论"));
  await page.getByRole("button", { name: "收藏当前位置", exact: true }).click();
  await expect(page.locator(".book-tools-panel")).toContainText(
    "第二页关键结论",
  );
  await page.getByLabel("关闭阅读工具").click();
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByLabel("阅读字体", { exact: true }).selectOption("serif");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".file-item").filter({ hasText: "阅读与思考.md" }).click();
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await expect(page.getByLabel("阅读字体", { exact: true })).toHaveValue(
    "system-ui",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".file-item").filter({ hasText: "两页测试.pdf" }).click();
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await expect(page.getByLabel("阅读字体", { exact: true })).toHaveValue(
    "serif",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".searchbox input").fill("两页测试");
  await page.getByRole("button", { name: "笔记与复习", exact: true }).click();
  await page.getByLabel("搜索笔记与讨论").fill("证据");
  await expect(page.locator(".learning-card")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept("技术, 思考"));
  await page.getByRole("button", { name: "标签", exact: true }).click();
  await expect(page.locator(".learning-tags")).toContainText("技术");
  await page.getByRole("button", { name: "加入复习", exact: true }).click();
  await page.getByRole("button", { name: /今日复习/ }).click();
  await expect(
    page.getByRole("button", { name: "先回想一下，再查看理解" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "先回想一下，再查看理解" }).click();
  await expect(page.locator(".learning-messages")).toContainText("证据比猜测");
  await page.screenshot({
    path: join(evidence, "desktop-notes.png"),
    fullPage: true,
  });
  await page.locator(".learning-quote").click();
  await expect(page.locator(".document-breadcrumb strong")).toHaveText(
    /阅读与思考\.md$/,
  );
  expect(errors).toEqual([]);
});

async function sampleEPUB() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    "OEBPS/content.opf",
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test</dc:identifier><dc:title>阅读的意义</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2026-10-23T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
  );
  zip.file(
    "OEBPS/nav.xhtml",
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="a.xhtml">第一章 留下思考</a></li><li><a href="b.xhtml">第二章 回到原文</a></li></ol></nav></body></html>',
  );
  for (const [name, title, text] of [
    [
      "a",
      "第一章 留下思考",
      "阅读让我们与不同的思想相遇。把自己的理解留下来，让每一次翻页都有意义。",
    ],
    [
      "b",
      "第二章 回到原文",
      "不要急着给出答案，回到原文寻找证据。这里有跨章搜索词：独特的思考。",
    ],
  ])
    zip.file(
      `OEBPS/${name}.xhtml`,
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p>${text}</p></body></html>`,
    );
  return zip.generateAsync({ type: "nodebuffer" });
}
test("mobile bookshelf, offline chapter navigation and settings-only sync", async ({
  browser,
}) => {
  test.setTimeout(90000);
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    }),
    page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await page.goto(origin + "/mobile");
    await expect(
      page.getByRole("heading", { name: "书架", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("同步文件与笔记")).toHaveCount(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "扫描电脑二维码", exact: true }),
    ).toBeVisible();
    const epub = await sampleEPUB(),
      text = Buffer.from("每读一本书，留下一个新的问题。"),
      hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    await page.evaluate(
      async ({ epub, text, epubHash, textHash }) => {
        const docs = [
          "阅读的意义.epub",
          "思考，快与慢.txt",
          "系统设计札记.txt",
          "深入理解并发.txt",
          "阅读与生活.txt",
          "技术的本质.txt",
        ].map((title, i) => ({
          id: `mobile-book-${i}`,
          workspaceDocumentId: `mobile-book-${i}`,
          documentId: `document-${i}`,
          title,
          format: i === 0 ? "epub" : "txt",
          version: { id: `v-${i}`, contentHash: i === 0 ? epubHash : textHash },
          versions: [
            { id: `v-${i}`, contentHash: i === 0 ? epubHash : textHash },
          ],
          manifests: [],
          threads: [],
          bookmarks: [],
          readingState:
            i === 0
              ? { locator: { href: "a.xhtml", percentage: 28 } }
              : undefined,
        }));
        const state = {
          library: {
            deviceId: "test-device",
            workspaces: [
              { id: "test-workspace", name: "我的书库", documents: docs },
            ],
            syncedAt: new Date().toISOString(),
          },
          lastBook: docs[0].id,
          outbox: [],
          drafts: {},
        };
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const r = indexedDB.open("open-reading-mobile", 1);
          r.onupgradeneeded = () => r.result.createObjectStore("data");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("data", "readwrite"),
            store = tx.objectStore("data");
          store.put(state, "state");
          store.put(
            JSON.stringify({
              origin: "https://offline.example",
              deviceId: "test-device",
              name: "我的电脑",
              token: "a".repeat(64),
            }),
            "connection",
          );
          store.put(new Blob([new Uint8Array(epub)]), "blob:" + epubHash);
          store.put(new Blob([new Uint8Array(text)]), "blob:" + textHash);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      },
      {
        epub: Array.from(epub),
        text: Array.from(text),
        epubHash: hash(epub),
        textHash: hash(text),
      },
    );
    await page.route("https://offline.example/**", (route) =>
      route.abort("failed"),
    );
    await page.reload();
    await expect(page.locator(".mobile-document")).toHaveCount(6);
    await expect(page.getByLabel("同步文件与笔记")).toHaveCount(0);
    await page.screenshot({
      path: join(evidence, "mobile-bookshelf-light.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByLabel("同步文件与笔记")).toBeVisible();
    await page.screenshot({
      path: join(evidence, "mobile-settings-light.png"),
      fullPage: true,
    });
    await page.getByLabel("深色模式", { exact: true }).check();
    await page.getByRole("button", { name: "书架", exact: true }).click();
    await page.screenshot({
      path: join(evidence, "mobile-bookshelf-dark.png"),
      fullPage: true,
    });
    await page.locator(".mobile-continue").click();
    await expect(page.locator(".epub-container iframe")).toBeVisible();
    await page.getByRole("button", { name: "目录", exact: true }).click();
    await page
      .getByRole("button", { name: "第二章 回到原文", exact: true })
      .click();
    await expect(
      page.frameLocator(".epub-container iframe").locator("body"),
    ).toContainText("不要急着给出答案");
    await page.getByRole("button", { name: "目录", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "第二章 回到原文", exact: true }),
    ).toHaveAttribute("aria-current", "location");
    await page.getByLabel("关闭阅读工具").click();
    await page.getByRole("button", { name: "全书搜索", exact: true }).click();
    await page.getByLabel("全书关键词").fill("思想相遇");
    await page.getByRole("button", { name: "搜索整本书", exact: true }).click();
    await expect(page.locator(".search-hit")).toHaveCount(1);
    await page.locator(".search-hit").click();
    await page.getByLabel("关闭阅读工具").click();
    await expect(
      page.frameLocator(".epub-container iframe").locator("body"),
    ).toContainText("阅读让我们");
    await page.screenshot({
      path: join(evidence, "mobile-reader-dark.png"),
      fullPage: true,
    });
    await page.getByLabel("返回书库").click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("article import, filtered export, selected-note AI context and automatic backup settings", async ({
  page,
}) => {
  test.setTimeout(90000);
  await login(page);
  const data = await setupBooks(page);
  const provider = await page.evaluate(
    async ({ workspace }) => {
      const me = await (await fetch("/api/me")).json(),
        headers = {
          "Content-Type": "application/json",
          "X-CSRF-Token": me.csrf,
        };
      const response = await fetch("/api/providers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "验收模拟模型",
          protocol: "mock",
          baseUrl: "https://example.invalid",
          modelId: "mock-reading",
        }),
      });
      if (!response.ok) throw Error(await response.text());
      const p = await response.json();
      await fetch(`/api/workspaces/${workspace}/providers/${p.id}/enable`, {
        method: "POST",
        headers,
        body: "{}",
      });
      return p;
    },
    { workspace: data.workspace.id },
  );
  await page.reload();
  await page.getByRole("button", { name: "网页文章", exact: true }).click();
  await page.route("**/api/articles/preview", (route) =>
    route.fulfill({
      json: {
        url: "https://example.org/article",
        html: "<html><head><title>网页导入示例</title></head><body><nav>不应保留导航</nav><article><h1>可信的正文</h1><p>把网页文章保存在本机阅读。</p><script>window.__unsafe=1</script></article></body></html>",
      },
    }),
  );
  await page
    .getByLabel("网页地址", { exact: true })
    .fill("https://example.org/article");
  await page.getByRole("button", { name: "预览正文", exact: true }).click();
  await expect(page.getByLabel("文章正文")).toHaveValue(/可信的正文/);
  await expect(page.getByLabel("文章正文")).not.toHaveValue(
    /不应保留导航|window.__unsafe/,
  );
  await page.getByRole("button", { name: "保存到书库", exact: true }).click();
  await expect(
    page.locator(".file-item").filter({ hasText: "网页导入示例.md" }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).__unsafe)).toBeUndefined();
  await page.getByRole("button", { name: "笔记与复习", exact: true }).click();
  await page.getByLabel("搜索笔记与讨论").fill("证据");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前结果", exact: true }).click();
  const download = await downloading,
    content = await readFile((await download.path())!, "utf8");
  expect(content).toContain("openreading:" + data.note.threadId);
  expect(content).toContain("book=");
  expect(content).toContain("证据比猜测");
  await page
    .getByRole("checkbox", {
      name: "选择笔记 " + data.note.threadId,
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: /用所选笔记问小阅/ }).click();
  await expect(page.getByLabel("评论输入", { exact: true })).toHaveValue(
    /请比较这些笔记/,
  );
  await page.getByLabel("选择模型", { exact: true }).selectOption(provider.id);
  await page.getByRole("button", { name: "预览发送内容", exact: true }).click();
  await expect(
    page
      .locator(".context-preview")
      .filter({ hasText: "个人笔记：我的关键理解" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByRole("button", { name: "备份与恢复", exact: true }).click();
  await page.getByLabel("开启自动备份", { exact: true }).check();
  await page.getByLabel("保留份数", { exact: true }).fill("3");
  await page.getByRole("button", { name: "保存备份设置", exact: true }).click();
  await expect(page.locator(".backup-policy")).toContainText("已保存");
});

test("macOS OCR recognizes a generated page locally", async ({ page }) => {
  test.skip(process.platform !== "darwin", "macOS Vision integration");
  await page.goto(origin);
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1100;
    canvas.height = 280;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 1100, 280);
    ctx.fillStyle = "black";
    ctx.font = "56px Arial";
    ctx.fillText("LOCAL READING OCR CHECK", 40, 130);
    return canvas.toDataURL("image/png");
  });
  const { default: tools } = await import("../../desktop/reading-tools.cjs");
  const text = await tools.recognizePage(
    image,
    tmpdir(),
    resolve("desktop/runtime"),
  );
  expect(text).toContain("LOCAL READING");
});
