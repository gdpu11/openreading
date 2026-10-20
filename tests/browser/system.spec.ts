import {
  test,
  expect,
  request as requestFactory,
  type Page,
  type Locator,
} from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  readFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
let processHandle: ChildProcess,
  base = "http://127.0.0.1:7319",
  storage: any,
  csrf = "",
  client: any,
  workspace: any,
  docs: any[],
  provider: any,
  dataDir = "";
const evidence = path.resolve(
  process.env.OR_EVIDENCE_DIR || "docs/evidence",
  process.env.OR_BROWSER || ".",
);
async function post(route: string, body: any) {
  const response = await client.post(base + "/api" + route, {
    data: body,
    headers: { "X-CSRF-Token": csrf },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function get(route: string) {
  const response = await client.get(base + "/api" + route);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function startServer() {
  let out = "";
  return new Promise<string>((resolve, reject) => {
    processHandle = spawn(
      path.resolve("release/openreading"),
      [
        "--data-dir",
        dataDir,
        "--port",
        "7319",
        "--allow-mock",
        ...(process.env.OR_ANDROID_APK
          ? ["--android-apk", process.env.OR_ANDROID_APK]
          : []),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    processHandle.stdout!.on("data", (b) => {
      out += b.toString();
      const match = out.match(/配对码：([a-f0-9]+)/);
      if (match) resolve(match[1]);
    });
    processHandle.stderr!.on("data", (b) => {
      out += b.toString();
    });
    processHandle.on("exit", (code) => {
      if (code) reject(Error(out));
    });
    setTimeout(() => reject(Error("server startup timeout " + out)), 10000);
  });
}
async function openFile(page: Page, name: string) {
  await page.locator(".file-item").filter({ hasText: name }).click();
  await expect(page.locator(".document-breadcrumb strong")).toHaveText(name);
  await expect(page.locator(".reader-status")).toHaveCount(0);
}
async function selectText(locator: Locator, quote: string) {
  await locator.click({ position: { x: 5, y: 5 } });
  const selectionState = await locator.evaluate((el, quote) => {
    const doc = el.ownerDocument;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (n.data.includes(quote)) {
        node = n;
        break;
      }
    }
    if (!node) throw Error("selection fixture not found: " + quote);
    const range = doc.createRange();
    const at = node.data.indexOf(quote);
    range.setStart(node, at);
    range.setEnd(node, at + quote.length);
    const selection = doc.defaultView!.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return {
      text: selection.toString(),
      count: selection.rangeCount,
      collapsed: selection.isCollapsed,
      ready: doc.readyState,
    };
  }, quote);
  if (process.env.OR_DEBUG) console.log("selection diagnostic", selectionState);
}
test.beforeAll(async ({ browser }) => {
  await mkdir(evidence, { recursive: true });
  dataDir = await mkdtemp(path.join(tmpdir(), "openreading-e2e-"));
  const code = await startServer();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() =>
    localStorage.setItem("open-reading-language", "zh"),
  );
  await page.goto(base);
  await page.getByLabel("本机配对码").fill(code);
  await page.getByRole("button", { name: /进入阅读空间/ }).click();
  await expect(page.locator(".workspace-rail")).toBeVisible();
  client = context.request;
  csrf = (await get("/me")).csrf;
  workspace = await post("/workspaces", { name: "后端技术" });
  await post("/workspaces", { name: "论文阅读" });
  const source = await post("/workspaces/" + workspace.id + "/sources", {
    path: path.resolve("fixtures"),
    label: "阅读实验室",
  });
  for (let i = 0; i < 100; i++) {
    const s = await get("/scans/" + source.scan.id);
    if (s.state === "completed") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (process.env.OR_REAL_PDF) {
    const material = await mkdtemp(
      path.join(tmpdir(), "openreading-public-paper-"),
    );
    await copyFile(
      process.env.OR_REAL_PDF,
      path.join(material, "真实双栏论文.pdf"),
    );
    const src = await post("/workspaces/" + workspace.id + "/sources", {
      path: material,
      label: "官方公开验证样本",
    });
    for (let i = 0; i < 200; i++) {
      const job = await get("/scans/" + src.scan.id);
      if (job.state === "completed") break;
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  if (process.env.OR_REAL_EPUB) {
    const material = await mkdtemp(
      path.join(tmpdir(), "openreading-private-epub-"),
    );
    await copyFile(
      process.env.OR_REAL_EPUB,
      path.join(material, "用户EPUB验证.epub"),
    );
    const src = await post("/workspaces/" + workspace.id + "/sources", {
      path: material,
      label: "本机格式验证",
    });
    for (let i = 0; i < 100; i++) {
      if ((await get("/scans/" + src.scan.id)).state === "completed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  docs = (await get("/workspaces/" + workspace.id + "/documents")).items;
  provider = await post("/providers", {
    name: "验收模拟服务",
    protocol: "mock",
    baseUrl: "https://example.invalid",
    modelId: "mock-reading",
    mockScenario: "citation",
    timeout: 10,
  });
  await post(
    "/workspaces/" + workspace.id + "/providers/" + provider.id + "/enable",
    {},
  );
  storage = await context.storageState();
  await page.reload();
  await expect(page.locator(".file-item")).toHaveCount(docs.length);
  await page.screenshot({ path: path.join(evidence, "01-library.png") });
  await writeFile(
    path.join(evidence, "browser-environment.json"),
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        browserName: browser.browserType().name(),
        browserVersion: browser.version(),
        date: new Date().toISOString(),
        fixtures: docs.length,
        api: "simulation and local HTTP contract only",
      },
      null,
      2,
    ),
  );
});
test.beforeEach(async ({ context, page }) => {
  if (process.env.OR_DEBUG) {
    page.on("pageerror", (e) => console.log("page error", e.message));
    page.on("console", (e) =>
      console.log("browser console", e.type(), e.text()),
    );
    page.on("request", (r) => {
      if (r.url().includes("/artifacts"))
        console.log("artifact request", r.url());
    });
  }
  await context.addCookies(storage.cookies);
  const language = await client.put(base + "/api/preferences", {
    headers: { "X-CSRF-Token": csrf },
    data: { language: "zh" },
  });
  expect(language.ok(), await language.text()).toBeTruthy();
  await page.addInitScript(() =>
    localStorage.setItem("open-reading-language", "zh"),
  );
  await page.goto(base);
  await expect(page.locator(".file-item")).toHaveCount(docs.length);
});
test.afterAll(async () => {
  processHandle?.kill("SIGINT");
});
test.afterEach(async ({ page }) => {
  expect(await page.pageErrors()).toEqual([]);
});
test("Legacy EPUB entities and broken navigation keep text, progress and reopening functional", async ({
  page,
}) => {
  const { default: JSZip } = await import("jszip");
  const material = await mkdtemp(
    path.join(tmpdir(), "openreading-epub-entities-"),
  );
  for (const [name, navigation, badChapter] of [
    [
      "旧版实体与目录.epub",
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="one" playOrder="1"><navLabel><text>A&P 阅读</text></navLabel><content src="one.xhtml"/></navPoint></navMap></ncx>',
      false,
    ],
    ["目录损坏正文完好.epub", "<ncx><navMap><broken>", false],
    ["章节损坏测试.epub", "<ncx><navMap><broken>", true],
  ] as const) {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file(
      "META-INF/container.xml",
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    );
    zip.file(
      "OPS/book.opf",
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">entity-test</dc:identifier><dc:title>Entity test</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="one"/><itemref idref="two"/></spine></package>',
    );
    zip.file("OPS/toc.ncx", navigation);
    zip.file(
      "OPS/one.xhtml",
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>First</title></head><body><h1>第一章</h1><p>兼容旧书 &nbsp; A&P &copy; &lt;script&gt;plain text&lt;/script&gt;</p>' +
        "<p>正文用于验证分页及进度，切换章节后应继续正常阅读。</p>".repeat(30) +
        "</body></html>",
    );
    zip.file(
      "OPS/two.xhtml",
      badChapter
        ? '<html xmlns="http://www.w3.org/1999/xhtml"><body>&undefined;</body></html>'
        : '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章</h1>' +
            "<p>第二章应保留完整阅读进度及原文定位，不能一直停留在零。</p>".repeat(
              30,
            ) +
            "</body></html>",
    );
    await writeFile(
      path.join(material, name),
      await zip.generateAsync({ type: "nodebuffer" }),
    );
  }
  const source = await post(`/workspaces/${workspace.id}/sources`, {
    path: material,
    label: "EPUB 兼容测试",
  });
  await expect
    .poll(async () => (await get(`/scans/${source.scan.id}`)).state)
    .toBe("completed");
  docs = (await get(`/workspaces/${workspace.id}/documents`)).items;
  await page.reload();
  for (const name of ["旧版实体与目录.epub", "目录损坏正文完好.epub"]) {
    await openFile(page, name);
    await page.getByLabel("页面布局").selectOption("double");
    const body = () =>
      page.frameLocator(".epub-container iframe").locator("body");
    await expect(body()).toContainText("A&P © <script>plain text</script>");
    await expect(body().locator("script")).toHaveCount(0);
    const slider = page.getByRole("slider", { name: "整本阅读进度" });
    await expect(slider).toBeEnabled();
    await expect(page.getByLabel("阅读进度百分比")).toHaveText(/^[\d.]+%$/);
    const rect = (await slider.boundingBox())!;
    await slider.click({
      position: { x: rect.width * 0.65, y: rect.height / 2 },
    });
    await expect(slider).toHaveAttribute("aria-busy", "false");
    await expect
      .poll(async () =>
        parseFloat((await page.getByLabel("阅读进度百分比").textContent())!),
      )
      .toBeGreaterThan(50);
    await expect(body()).toContainText("第二章");
    const member = docs.find((d) =>
      d.bindings.some((b: any) => b.relativePath === name),
    );
    await expect
      .poll(async () => {
        const current = (
          await get(`/workspaces/${workspace.id}/documents`)
        ).items.find((d: any) => d.id === member.id);
        return current.readingState?.locator?.spineIndex;
      })
      .toBe(1);
    await page.reload();
    await expect(
      page.getByRole("slider", { name: "整本阅读进度" }),
    ).toBeEnabled();
    await expect
      .poll(async () =>
        parseFloat((await page.getByLabel("阅读进度百分比").textContent())!),
      )
      .toBeGreaterThan(50);
  }
  await openFile(page, "章节损坏测试.epub");
  await expect(
    page.frameLocator(".epub-container iframe").locator("body"),
  ).toContainText("第一章");
  await expect(page.getByLabel("阅读进度百分比")).toHaveText("进度暂不可用");
  await openFile(page, "中文与Unicode.txt");
  await expect(page.locator(".plain-text")).toContainText("中文𠮷");
});

test("Actual legacy EPUB restores navigation, live page turns, seek and saved progress", async ({
  page,
}) => {
  test.skip(!process.env.OR_REAL_EPUB, "Requires an authorized local EPUB");
  await openFile(page, "用户EPUB验证.epub");
  await page.getByLabel("页面布局").selectOption("double");
  const body = () =>
    page.frameLocator(".epub-container iframe").locator("body");
  await expect(body()).toContainText("从优秀到卓越");
  const slider = page.getByRole("slider", { name: "整本阅读进度" });
  await expect(slider).toBeEnabled();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect
    .poll(async () =>
      parseFloat((await page.getByLabel("阅读进度百分比").textContent())!),
    )
    .toBeGreaterThan(0);
  const rect = (await slider.boundingBox())!;
  await slider.click({
    position: { x: rect.width * 0.55, y: rect.height / 2 },
  });
  await expect(slider).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(async () =>
      parseFloat((await page.getByLabel("阅读进度百分比").textContent())!),
    )
    .toBeGreaterThan(50);
  const before = parseFloat(
    (await page.getByLabel("阅读进度百分比").textContent())!,
  );
  expect(before).toBeLessThan(60);
  await expect(body()).toContainText(/\S[\s\S]{100}/);
  const member = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath.includes("用户EPUB验证.epub")),
  );
  await expect
    .poll(async () => {
      const current = (
        await get(`/workspaces/${workspace.id}/documents`)
      ).items.find((d: any) => d.id === member.id);
      return current.readingState?.locator?.spineIndex || 0;
    })
    .toBeGreaterThan(10);
  await page.reload();
  await expect(
    page.getByRole("slider", { name: "整本阅读进度" }),
  ).toBeEnabled();
  await expect
    .poll(async () =>
      parseFloat((await page.getByLabel("阅读进度百分比").textContent())!),
    )
    .toBeGreaterThan(50);
  await expect(page.locator(".reading-footer .book-word-count")).toHaveText(
    /全书字数 [1-9][\d,]* 字\/词/,
  );
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await expect(page.locator(".outline button").first()).toBeVisible();
  await writeFile(
    path.join(evidence, "legacy-real-book.json"),
    JSON.stringify(
      {
        archiveHash:
          "378941b622be3002b92590dc768d738b36e1b43b484faf357894ef1cdc598af1",
        navigation: true,
        pageTurn: true,
        seek: before,
        reopened: true,
        bookRedistributed: false,
      },
      null,
      2,
    ),
  );
});

test("Book context menus persist favorites and finished flags, remove missing books and restore them", async ({
  page,
}) => {
  const material = await mkdtemp(
    path.join(tmpdir(), "openreading-book-actions-"),
  );
  const file = path.join(material, "可清理的书籍.txt");
  await writeFile(file, "正文和学习笔记保留，原始文件不由删除菜单修改。");
  const source = await post(`/workspaces/${workspace.id}/sources`, {
    path: material,
    label: "管理测试",
  });
  await expect
    .poll(async () => (await get(`/scans/${source.scan.id}`)).state)
    .toBe("completed");
  docs = (await get(`/workspaces/${workspace.id}/documents`)).items;
  await page.reload();
  const book = () =>
    page.locator(".file-item").filter({ hasText: "可清理的书籍.txt" });
  const menu = () => page.getByRole("menu", { name: "书籍操作" });
  await book().click({ button: "right" });
  await expect(menu()).toBeVisible();
  expect(
    await page.locator(".document-breadcrumb strong").allTextContents(),
  ).not.toContain("可清理的书籍.txt");
  await menu()
    .getByRole("menuitemcheckbox", { name: "收藏", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText("已收藏");
  await book().focus();
  await book().press("Shift+F10");
  await expect(
    menu().getByRole("menuitemcheckbox", { name: "取消收藏" }),
  ).toHaveAttribute("aria-checked", "true");
  await menu().getByRole("menuitemcheckbox", { name: "标记为已读完" }).click();
  await expect(page.locator(".toast")).toContainText("已标记为已读完");
  await page.getByLabel("书库筛选").selectOption("favorites");
  await expect(page.locator(".file-item")).toHaveCount(1);
  await page.getByLabel("书库筛选").selectOption("finished");
  await expect(book()).toBeVisible();
  await page.reload();
  await book().click({ button: "right" });
  await expect(
    menu().getByRole("menuitemcheckbox", { name: "标记为未读" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu()).toHaveCount(0);
  // Simulate an unavailable source; metadata actions must not open/capture it.
  await (await import("node:fs/promises")).unlink(file);
  const scan = await post(`/sources/${source.id}/scan`, {});
  await expect
    .poll(async () => (await get(`/scans/${scan.id}`)).state)
    .toBe("completed");
  await book().click({ button: "right" });
  await menu().getByRole("menuitem", { name: "删除…" }).click();
  await page.getByRole("button", { name: "移出当前书库", exact: true }).click();
  await expect(book()).toHaveCount(0);
  await page.reload();
  await expect(book()).toHaveCount(0);
  await page.getByLabel("书库筛选").selectOption("removed");
  await expect(book()).toBeVisible();
  await book().click({ button: "right" });
  await menu().getByRole("menuitem", { name: "恢复到书库" }).click();
  await expect(book()).toHaveCount(0);
  await page.getByLabel("书库筛选").selectOption("all");
  await expect(book()).toBeVisible();
  await book().click({ button: "right" });
  await menu().getByRole("menuitemcheckbox", { name: "取消收藏" }).click();
  await book().click({ button: "right" });
  await menu().getByRole("menuitemcheckbox", { name: "标记为未读" }).click();
  await page.getByLabel("书库筛选").selectOption("favorites");
  await expect(page.locator(".file-item")).toHaveCount(0);
});
test("Whole-book counts cover all chapters, exclude markup, survive reopening and distinguish scanned PDF pages", async ({
  page,
}) => {
  const { default: JSZip } = await import("jszip");
  const material = await mkdtemp(
    path.join(tmpdir(), "openreading-word-count-"),
  );
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
  );
  zip.file(
    "OPS/book.opf",
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">count-fixture</dc:identifier><dc:title>Count fixture</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/><item id="extra" href="extra.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="nav"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="extra" linear="no"/></spine></package>',
  );
  const chapter = (body: string) =>
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ignore this title</title><style>p {color: black}</style></head><body>${body}</body></html>`;
  zip.file(
    "OPS/nav.xhtml",
    chapter(
      '<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><a href="one.xhtml">Ignore navigation text</a></nav>',
    ),
  );
  zip.file(
    "OPS/one.xhtml",
    chapter(
      '<h1>第一章</h1><p>中文𠮷 <em>Hello</em> world! 👩‍💻</p><script>Ignored script words</script><p hidden="hidden">Ignored hidden words</p><p style="display: none">Ignored inline hidden words</p>',
    ),
  );
  zip.file(
    "OPS/two.xhtml",
    chapter("<h1>第二章</h1><p>测试 Three more words.</p>"),
  );
  zip.file("OPS/extra.xhtml", chapter("<p>Ignore non-linear appendix</p>"));
  await writeFile(
    path.join(material, "精确字数.epub"),
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  await writeFile(
    path.join(material, "精确字数.txt"),
    "中文𠮷 Hello world! 👩‍💻 e\u0301",
  );
  await writeFile(
    path.join(material, "精确字数.md"),
    "# 标题\n\n[Hello world](https://example.invalid)\n\n**正文**\n\n<!-- Ignore this comment -->",
  );
  const source = await post(`/workspaces/${workspace.id}/sources`, {
    path: material,
    label: "字数验收",
  });
  await expect
    .poll(async () => (await get("/scans/" + source.scan.id)).state)
    .toBe("completed");
  docs = (await get(`/workspaces/${workspace.id}/documents`)).items;
  await page.reload();
  const count = page.locator(".reading-footer .book-word-count");
  await openFile(page, "精确字数.epub");
  await expect(count).toHaveText("全书字数 16 字/词");
  await expect(count).toHaveAttribute("title", /全书正文/);
  const puts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("/word-count?"))
      puts.push(r.url());
  });
  await page.reload();
  await expect(count).toHaveText("全书字数 16 字/词");
  expect(puts).toEqual([]);
  await page.screenshot({ path: path.join(evidence, "whole-book-count.png") });
  for (const name of ["精确字数.txt", "精确字数.md"]) {
    await openFile(page, name);
    await expect(count).toHaveText("全书字数 6 字/词");
  }
  await openFile(page, "双栏与扫描混合.pdf");
  await expect(count).toHaveText(/可提取文字 [1-9][\d,]* 字\/词/);
  await expect(count).toHaveAttribute("title", /有文字 2 \/ 3 页/);
  await page.screenshot({ path: path.join(evidence, "pdf-text-count.png") });
});
test("Reading activity combines every workspace in a global page and preserves the reader", async ({
  page,
}) => {
  const other = await post("/workspaces", { name: "全局统计验证" });
  const source = await post(`/workspaces/${other.id}/sources`, {
    path: path.resolve("fixtures"),
    label: "另一工作区",
  });
  await expect
    .poll(async () => (await get(`/scans/${source.scan.id}`)).state)
    .toBe("completed");
  const otherDocs = (await get(`/workspaces/${other.id}/documents`)).items;
  const first = docs.find((d: any) =>
    d.bindings.some((b: any) => b.relativePath.endsWith("幂等性.md")),
  );
  const second = otherDocs.find((d: any) =>
    d.bindings.some((b: any) => b.relativePath.endsWith("中文与Unicode.txt")),
  );
  const at = Date.now() - 600000;
  const yesterday = new Date(at);
  yesterday.setDate(yesterday.getDate() - 1);
  await post("/reading/events", {
    events: [
      [first.id, yesterday.getTime()],
      [first.id, at],
      [second.id, at + 60000],
    ].map(([member, startedAt]) => ({
      id: crypto.randomUUID(),
      member,
      startedAt,
      endedAt: Number(startedAt) + 60000,
    })),
  });
  await page.reload();
  await openFile(page, "可靠接口.epub");
  // Let EPUB finish rendering before freezing its animation timers.
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const readerFrame = await page
    .locator(".epub-container iframe")
    .elementHandle();
  const showGlobal = async () => {
    await page.getByRole("button", { name: "阅读数据", exact: true }).click();
    await expect(page.locator(".workspace-title")).toHaveText("全部工作区");
    await expect(page.locator(".workspace-icon.active")).toHaveCount(0);
    await expect(page.locator(".navigator")).toBeHidden();
    await expect(page.locator(".reading-main")).toBeHidden();
    await expect(page.locator(".reading-stats-heading")).toContainText(
      "汇总所有工作区的阅读记录",
    );
    // Rendering the book before pausing the clock can record real foreground
    // seconds. The two injected minutes must be present in the global total.
    await expect(page.getByTestId("today-reading")).toHaveText(/^2 分 \d+ 秒$/);
    await expect(page.locator(".reading-metrics")).toContainText("0.05");
    await expect(
      page.locator(".reading-metrics article").first(),
    ).toContainText("2天");
    await expect(page.locator(".calendar-day.today")).toContainText("2 分");
    await expect(page.locator(".reading-day-details")).toContainText(
      "幂等性.md",
    );
    await expect(page.locator(".reading-day-details")).toContainText(
      "中文与Unicode.txt",
    );
  };
  await showGlobal();
  await page.screenshot({ path: path.join(evidence, "all-workspaces.png") });
  await page.getByRole("button", { name: "关闭阅读数据", exact: true }).click();
  await expect(page.locator(".reader-epub")).toBeVisible();
  expect(await readerFrame!.evaluate((el) => el.isConnected)).toBe(true);
  await expect(page.locator(".document-breadcrumb strong")).toHaveText(
    "可靠接口.epub",
  );
  await page.getByLabel("切换工作区 全局统计验证", { exact: true }).click();
  await showGlobal();
  // Selecting even the current workspace leaves the global page.
  await page.getByLabel("切换工作区 全局统计验证", { exact: true }).click();
  await expect(page.locator(".reading-stats")).toHaveCount(0);
  await expect(page.locator(".workspace-title")).toHaveText("全局统计验证");
  await page.getByLabel("切换工作区 后端技术", { exact: true }).click();
});
test("Session timer counts foreground reading and pauses for lost focus, dialogs and idle time", async ({
  page,
}) => {
  const existing = new Set(
    (await get("/reading")).events.map((e: any) => e.id),
  );
  await page.clock.install();
  await openFile(page, "中文与Unicode.txt");
  const timer = page.locator(".session-timer output");
  await expect(timer).toHaveText("00:00");
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const seconds = async () =>
    (await timer.textContent())!
      .split(":")
      .reduce((total, part) => total * 60 + Number(part), 0);
  const started = await seconds();
  await expect(page.locator(".session-timer")).toHaveAttribute(
    "data-state",
    "running",
  );
  await page.clock.runFor(10000);
  await expect.poll(seconds).toBe(started + 10);
  // Headless Chromium emulates focus per page. Exercise the focus contract
  // here; the Electron test below uses actual native window focus changes.
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
    });
    window.dispatchEvent(new Event("blur"));
  });
  await page.clock.runFor(10000);
  await expect.poll(seconds).toBe(started + 10);
  await expect(page.locator(".session-timer")).toHaveAttribute(
    "data-state",
    "paused",
  );
  await page.evaluate(() => {
    delete (document as any).hasFocus;
    window.dispatchEvent(new Event("focus"));
  });
  await page.clock.runFor(5000);
  await expect.poll(seconds).toBe(started + 15);
  await page.getByTitle("阅读设置", { exact: true }).click();
  await page.clock.runFor(10000);
  await expect.poll(seconds).toBe(started + 15);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.clock.runFor(5000);
  await expect.poll(seconds).toBe(started + 20);
  await page.getByRole("button", { name: "阅读数据", exact: true }).click();
  await expect(page.locator(".reading-stats-heading")).toBeVisible();
  await page.clock.runFor(10000);
  await expect.poll(seconds).toBe(started + 20);
  const recorded = (await get("/reading")).events.filter(
    (e: any) => !existing.has(e.id),
  );
  expect(
    Math.floor(
      recorded.reduce((ms: number, e: any) => ms + e.endedAt - e.startedAt, 0) /
        1000,
    ),
  ).toBe(started + 20);
  await page.getByRole("button", { name: "关闭阅读数据", exact: true }).click();
  await page.clock.runFor(5000);
  await expect.poll(seconds).toBe(started + 25);
  await page.clock.runFor(120000);
  await expect(page.locator(".session-timer")).toHaveAttribute(
    "data-state",
    "paused",
  );
  const idleTime = await seconds();
  await page.clock.runFor(30000);
  expect(await seconds()).toBe(idleTime);
  await page.locator(".plain-text").click();
  await page.clock.runFor(5000);
  expect(await seconds()).toBe(idleTime + 5);
  await page.screenshot({ path: path.join(evidence, "session-timer.png") });
  await page.locator(".file-item").filter({ hasText: "幂等性.md" }).click();
  await expect(page.locator(".document-breadcrumb strong")).toHaveText(
    "幂等性.md",
  );
  await expect(timer).toHaveText("00:00");
});
test("Session timer resumes after idle and reconciles native or delayed foreground signals", async ({
  page,
}) => {
  await page.clock.install();
  await openFile(page, "中文与Unicode.txt");
  const timer = page.locator(".session-timer");
  await expect(timer).toHaveAttribute("data-state", "running");
  await page.locator(".plain-text").click();
  await page.mouse.move(0, 0);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const seconds = async () =>
    (await timer.locator("output").textContent())!
      .split(":")
      .reduce((n, part) => n * 60 + Number(part), 0);
  await page.clock.runFor(121000);
  await expect(timer).toHaveAttribute("data-state", "paused");
  const idle = await seconds();
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
    });
    document.documentElement.dataset.readingSystemActive = "false";
    window.dispatchEvent(new Event("openreading-system-state"));
  });
  await page.clock.runFor(10000);
  expect(await seconds()).toBe(idle);
  // Electron can activate its native window before Chromium updates hasFocus.
  // Return without clicking or moving the pointer inside the reader.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.documentElement.dataset.readingSystemActive = "true";
    window.dispatchEvent(new Event("openreading-system-state"));
  });
  await expect(timer).toHaveAttribute("data-state", "running");
  await page.clock.runFor(5000);
  expect(await seconds()).toBe(idle + 5);
  // A browser focus notification may be delayed or omitted. Sampling must
  // detect the actual state transition without backfilling the hidden gap.
  await page.evaluate(() => {
    delete document.documentElement.dataset.readingSystemActive;
  });
  await page.clock.runFor(10000);
  const paused = await seconds();
  expect(paused).toBe(idle + 5);
  await expect(timer).toHaveAttribute("data-state", "paused");
  await page.evaluate(() => {
    delete (document as any).hasFocus;
  });
  await page.clock.runFor(1000);
  await expect(timer).toHaveAttribute("data-state", "running");
  expect(await seconds()).toBe(paused);
  await page.clock.runFor(5000);
  expect(await seconds()).toBe(paused + 5);
  // Repeated reports of the same native state must not defeat idle detection.
  await page.evaluate(() => {
    document.documentElement.dataset.readingSystemActive = "true";
    window.dispatchEvent(new Event("openreading-system-state"));
  });
  await page.clock.runFor(121000);
  await expect(timer).toHaveAttribute("data-state", "paused");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("openreading-system-state")),
  );
  await expect(timer).toHaveAttribute("data-state", "paused");
});
test("Concurrent reader windows preserve each other's offline reading receipts", async ({
  page,
  context,
}) => {
  let blocked = new Set<string>();
  let blockAll = true;
  await context.route("**/api/reading/events", async (route) => {
    const events = route.request().postDataJSON().events;
    if (blockAll || events.some((e: any) => blocked.has(e.member)))
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "OFFLINE", message: "offline" }),
      });
    else await route.continue();
  });
  const receipts = (p: Page) =>
    p.evaluate(
      () =>
        new Promise<any[]>((resolve, reject) => {
          const request = indexedDB.open("openreading-recovery", 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("drafts", "readonly");
            const values = tx
              .objectStore("drafts")
              .getAll(
                IDBKeyRange.bound("reading-event:", "reading-event:\uffff"),
              );
            tx.oncomplete = () => {
              db.close();
              resolve(values.result);
            };
          };
        }),
    );
  await page.clock.install();
  await page.bringToFront();
  await openFile(page, "中文与Unicode.txt");
  await expect(page.locator(".session-timer")).toHaveAttribute(
    "data-state",
    "running",
  );
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.clock.runFor(16000);
  await expect
    .poll(async () => (await receipts(page)).length)
    .toBeGreaterThan(0);
  const first = (await receipts(page)).map((e) => e.id);
  const firstMember = (await receipts(page))[0].member;
  const second = await context.newPage();
  await second.goto(base);
  await expect(second.locator(".file-item")).toHaveCount(docs.length);
  await second.clock.install();
  await second.bringToFront();
  await openFile(second, "幂等性.md");
  await expect(second.locator(".session-timer")).toHaveAttribute(
    "data-state",
    "running",
  );
  await second.clock.pauseAt(await second.evaluate(() => Date.now() + 1000));
  await second.clock.runFor(16000);
  await expect
    .poll(
      async () => new Set((await receipts(second)).map((e) => e.member)).size,
    )
    .toBe(2);
  const all = await receipts(second);
  const secondMember = all.find((e) => e.member !== firstMember)!.member;
  expect(first.every((id) => all.some((e) => e.id === id))).toBe(true);
  // Acknowledging window A must not erase window B's offline receipts.
  blockAll = false;
  blocked = new Set([secondMember]);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect
    .poll(
      async () =>
        (await receipts(page)).filter((e) => e.member === firstMember).length,
    )
    .toBe(0);
  expect((await receipts(page)).some((e) => e.member === secondMember)).toBe(
    true,
  );
  blocked.clear();
  await second.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await receipts(second)).length).toBe(0);
  const saved = (await get("/reading")).events;
  for (const event of all)
    expect(saved.filter((e: any) => e.id === event.id)).toHaveLength(1);
  await second.close();
});
test("File sorting covers the whole library and preserves the current reader and preference", async ({
  page,
}) => {
  const names = page.locator(".file-item > div > span");
  const expectedNames = async (mode: string, query = "") => {
    const result = await get(
      `/workspaces/${workspace.id}/documents?sort=${mode}&q=${encodeURIComponent(query)}`,
    );
    return result.items.map((d: any) =>
      d.bindings[0].relativePath.split("/").pop(),
    );
  };
  const choose = async (label: string, mode: string, query = "") => {
    await page.getByLabel("文件排序", { exact: true }).click();
    await page.getByRole("menuitemradio", { name: label, exact: true }).click();
    await expect(names).toHaveText(await expectedNames(mode, query));
    await expect
      .poll(async () => (await get("/preferences")).documentSort)
      .toBe(mode);
  };
  await openFile(page, "幂等性.md");
  await page
    .locator(".reader")
    .evaluate((el) => ((window as any).sortingReader = el));
  for (const [label, mode] of [
    ["添加时间（最新在前）", "added"],
    ["添加时间（最早在前）", "added-oldest"],
    ["文件名（A–Z）", "name"],
    ["最近阅读", "recent"],
  ]) {
    await choose(label, mode);
    expect(
      await page
        .locator(".reader")
        .evaluate((el) => el === (window as any).sortingReader),
    ).toBe(true);
    await expect(page.locator(".document-breadcrumb strong")).toHaveText(
      "幂等性.md",
    );
  }
  await openFile(page, "中文与Unicode.txt");
  await expect(names.first()).toHaveText("中文与Unicode.txt");
  await page.getByLabel("搜索文件名").fill("可靠");
  await expect(names).toHaveText(["可靠接口.epub"]);
  await choose("文件名（A–Z）", "name", "可靠");
  await page.getByLabel("搜索文件名").fill("");
  await expect(names).toHaveText(await expectedNames("name"));
  await page.reload();
  await expect(names).toHaveText(await expectedNames("name"));
  await page.getByLabel("文件排序", { exact: true }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "文件名（A–Z）", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: path.join(evidence, "file-sort-menu.png") });
  await page.keyboard.press("Escape");
  await client.put(base + "/api/preferences", {
    headers: { "X-CSRF-Token": csrf },
    data: { language: "en" },
  });
  await page.reload();
  await page.getByLabel("Sort files", { exact: true }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "Recently read", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitemradio", { name: "Default order", exact: true })
    .click();
  await expect(names).toHaveText(await expectedNames("default"));
  await client.put(base + "/api/preferences", {
    headers: { "X-CSRF-Token": csrf },
    data: { language: "zh" },
  });
});

test("M2 Markdown selection capture survives focus, annotation and refresh", async ({
  page,
}) => {
  await openFile(page, "幂等性.md");
  await expect(page.locator(".prose h1")).toContainText("接口重试");
  await selectText(
    page.locator(".prose"),
    "幂等性意味着重复执行同一操作，最终效果与执行一次相同。",
  );
  await expect(page.locator(".selection-toolbar")).toBeVisible();
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await page
    .getByLabel("评论输入")
    .fill("M2：用唯一请求 ID 保证重试安全。代码 `@小阅` 不应调用模型。");
  await page.getByLabel("发送评论").click();
  await expect(page.locator(".note-body")).toContainText("M2：用唯一请求 ID");
  await expect(page.locator(".annotation-mark").first()).toBeVisible();
  await page.screenshot({
    path: path.join(evidence, "02-markdown-thread.png"),
  });
  await page.reload();
  await expect(page.locator(".discussion")).toBeHidden();
  await page.locator(".annotation-mark").first().click();
  await expect(page.locator(".note-body")).toContainText("M2：用唯一请求 ID");
  await expect(page.locator(".annotation-mark").first()).toBeVisible();
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath === "幂等性.md"),
  );
  const threads = await get("/documents/" + d.id + "/threads");
  expect(threads[0].messages).toHaveLength(1);
  await page.locator(".quote-button").first().click();
});
test("A08 actual browser UTF-16 range and Unicode codepoint roundtrip", async ({
  page,
}) => {
  await openFile(page, "中文与Unicode.txt");
  const quote = "中文𠮷👩‍💻é";
  await selectText(page.locator(".plain-text"), quote);
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await page.getByLabel("评论输入").fill("Unicode 首尾不可偏移");
  await page.getByLabel("发送评论").click();
  await expect(page.locator(".quote-button").first()).toContainText(quote);
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath === "中文与Unicode.txt"),
  );
  const threads = await get("/documents/" + d.id + "/threads");
  const a = threads[0].anchor;
  expect(a.quote.exact).toBe(quote);
  const selector = a.selectors.find((s: any) => s.type === "text");
  expect(selector.end - selector.start).toBe(Array.from(quote).length);
  await page.reload();
  await expect(page.locator(".annotation-mark").first()).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "03-unicode.png") });
});
test("A04 A05 A06 PDF multiline native quads across twelve viewports", async ({
  page,
}) => {
  await openFile(page, "双栏与扫描混合.pdf");
  await expect(page.locator(".textLayer span").first()).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.pdf-page[data-page-index="0"] .textLayer span').count(),
    )
    .toBeGreaterThan(20);
  await page
    .locator('.pdf-page[data-page-index="0"] .textLayer')
    .evaluate((el) => {
      const spans = Array.from(el.querySelectorAll("span")).filter((s) =>
        s.textContent?.startsWith("LEFT"),
      );
      const range = document.createRange();
      range.setStart(spans[0].firstChild!, 0);
      range.setEnd(spans[2].firstChild!, spans[2].textContent!.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await expect(page.locator(".selection-toolbar")).toBeVisible();
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await page.getByLabel("评论输入").fill("PDF 多行坐标验收");
  await page.getByLabel("发送评论").click();
  await expect(page.locator(".note-body")).toContainText("PDF 多行坐标");
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath.includes("双栏与扫描混合.pdf")),
  );
  const threads = await get("/documents/" + d.id + "/threads");
  const a = threads[0].anchor;
  expect(a.quote.exact).not.toContain("RIGHT");
  const q = a.selectors.find((s: any) => s.type === "pdf");
  expect(q.quads.length).toBeGreaterThanOrEqual(3);
  const checks: any[] = [];
  for (const scale of ["0.5", "1", "2"]) {
    await page.getByLabel("PDF 缩放").selectOption(scale);
    for (let rotation = 0; rotation < 4; rotation++) {
      await expect
        .poll(() => page.locator(".annotation-mark").count())
        .toBeGreaterThanOrEqual(3);
      await page.waitForTimeout(150);
      const box = await page.locator(".annotation-mark").first().boundingBox();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
      const geometry = await page
        .locator('.pdf-page[data-page-index="0"] .textLayer')
        .evaluate((el) => {
          const span = Array.from(el.querySelectorAll("span")).find((s) =>
            s.textContent?.startsWith("LEFT"),
          );
          const range = document.createRange();
          range.selectNodeContents(span!);
          const b = range.getBoundingClientRect();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        });
      const drift = Math.max(
        Math.abs(box!.x - geometry.x),
        Math.abs(box!.y - geometry.y),
        Math.abs(box!.width - geometry.width),
        Math.abs(box!.height - geometry.height),
      );
      expect(
        drift,
        JSON.stringify({ scale, rotation: rotation * 90, box, geometry }),
      ).toBeLessThan(3);
      await page.locator(".quote-button").first().click();
      await expect(page.locator(".annotation-mark").first()).toBeInViewport({
        ratio: 0.1,
      });
      checks.push({
        scale: Number(scale),
        rotation: rotation * 90,
        driftPixels: drift,
      });
      if (scale === "1" && (rotation === 0 || rotation === 1))
        await page.screenshot({
          path: path.join(evidence, `04-pdf-100-${rotation * 90}.png`),
        });
      await page.getByTitle("旋转 PDF", { exact: true }).click();
    }
  }
  await writeFile(
    path.join(evidence, "pdf-geometry.json"),
    JSON.stringify({ quads: q.quads, checks, quote: a.quote.exact }, null, 2),
  );
  await expect(page.getByText("单页选区；跨页请分段批注")).toBeVisible();
});
test("A09 mixed PDF page capabilities and page note", async ({ page }) => {
  await openFile(page, "双栏与扫描混合.pdf");
  await page.getByLabel("PDF 页码").fill("2");
  await expect(
    page.getByText(
      "此页没有可选文字。可添加页级笔记，小阅仅能讨论你输入的文字。",
    ),
  ).toBeVisible();
  await expect(
    page.locator('.pdf-page[data-page-index="1"] .textLayer span'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "页级笔记", exact: true }).click();
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await page.getByLabel("评论输入").fill("扫描页只记录自己的观察");
  await page.getByLabel("发送评论").click();
  await expect(page.locator(".note-body").last()).toContainText("扫描页只记录");
  await page.screenshot({ path: path.join(evidence, "05-scanned-page.png") });
});
async function toolbarGeometry(page: Page) {
  const frame = await page.locator(".epub-container iframe").boundingBox();
  const local = await page
    .frameLocator(".epub-container iframe")
    .locator("body")
    .evaluate((el) => {
      const rect = el.ownerDocument
        .defaultView!.getSelection()!
        .getRangeAt(0)
        .getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
    });
  const toolbar = await page.locator(".selection-toolbar").boundingBox();
  if (!frame || !toolbar) throw Error("Reader or toolbar is not visible");
  const selection = {
    left: frame.x + local.left,
    top: frame.y + local.top,
    right: frame.x + local.right,
    bottom: frame.y + local.bottom,
  };
  const gap = Math.min(
    Math.abs(selection.top - toolbar.y - toolbar.height),
    Math.abs(toolbar.y - selection.bottom),
  );
  const overlap =
    Math.min(toolbar.x + toolbar.width, selection.right) -
    Math.max(toolbar.x, selection.left);
  return { selection, toolbar, gap, overlap };
}
test("Fullscreen reading retains the reader and whole-book progress persists", async ({
  page,
}) => {
  await openFile(page, "可靠接口.epub");
  await page.getByLabel("页面布局").selectOption("single");
  await expect(page.locator(".document-title .reader-progress")).toBeVisible();
  await expect(page.locator(".reader .reader-progress")).toHaveCount(0);
  const headerProgressTop = (await page
    .locator(".document-progress")
    .boundingBox())!.y;
  const value = async () =>
    Number(
      (await page.getByLabel("阅读进度百分比").textContent())!.replace("%", ""),
    );
  await expect(page.getByLabel("阅读进度百分比")).toHaveText(/^[\d.]+%$/);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect.poll(value).toBeGreaterThan(0);
  expect((await page.locator(".document-progress").boundingBox())!.y).toBe(
    headerProgressTop,
  );
  expect(await value()).toBeLessThan(100);
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath.includes("可靠接口.epub")),
  );
  await expect
    .poll(
      async () =>
        (await get("/documents/" + d.id + "/reading-state")).locator
          ?.percentage,
    )
    .toBe(await value());
  const saved = (await get("/documents/" + d.id + "/reading-state")).locator;
  await page.reload();
  await expect(page.getByLabel("阅读进度百分比")).toHaveText(
    `${saved.percentage}%`,
  );
  await expect
    .poll(
      async () =>
        (await get("/documents/" + d.id + "/reading-state")).locator?.cfi,
    )
    .toBe(saved.cfi);
  await page
    .locator(".reader")
    .evaluate((el) => ((window as any).originalReader = el));
  await page.getByRole("button", { name: "全屏阅读", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.className))
    .toBe("reading-main");
  await expect
    .poll(() =>
      page
        .locator(".reading-main")
        .evaluate((el) =>
          Math.abs(el.getBoundingClientRect().width - window.innerWidth),
        ),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await page
      .locator(".reader")
      .evaluate((el) => (window as any).originalReader === el),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "退出全屏阅读", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(
      ".reading-main:fullscreen .document-progress .reader-progress",
    ),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(evidence, "fullscreen-reading.png"),
  });
  // Escape restores the prior layout, keeping discussion collapsed.
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "全屏阅读", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".discussion")).toBeHidden();
  await expect(page.getByTitle("收起文件栏", { exact: true })).toBeVisible();
  for (let i = 0; i < 20 && (await value()) < 100; i++) {
    const old = await value();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect.poll(value).toBeGreaterThan(old);
  }
  await expect(page.getByLabel("阅读进度百分比")).toHaveText("100%");
  await writeFile(
    path.join(evidence, "reading-progress.json"),
    JSON.stringify(
      { saved, final: 100, fullscreenRetainedReader: true },
      null,
      2,
    ),
  );
});
for (const [format, file] of [
  ["epub", "可靠接口.epub"],
  ["pdf", "双栏与扫描混合.pdf"],
] as const) {
  test(`Fullscreen controls hide after ten seconds and return at the edges (${format})`, async ({
    page,
  }) => {
    await page.clock.install();
    await openFile(page, file);
    // Footer metadata loads asynchronously and can wrap onto another line.
    // Finish that layout change before measuring the fullscreen geometry.
    await expect(page.locator(".estimated-reading-time")).toBeVisible();
    if (format === "epub")
      await page.getByLabel("页面布局").selectOption("double");
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.getByRole("button", { name: "全屏阅读", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "退出全屏阅读", exact: true }),
    ).toBeVisible();
    // Start the idle deadline after the fullscreen transition's pointer events.
    await page.mouse.move(20, 5);
    await page.mouse.move(600, 400);
    const header = page.locator(".document-bar"),
      footer = page.locator(".reading-footer");
    const reader = page.locator(".reader");
    const node = await reader.elementHandle();
    const bounds = await reader.boundingBox();
    await page.clock.runFor(9999);
    await expect(header).toBeVisible();
    await expect(footer).toBeVisible();
    await page.clock.runFor(1);
    await expect(header).toBeHidden();
    await expect(footer).toBeHidden();
    await expect(page.getByLabel("阅读页码", { exact: true })).toBeVisible();
    await expect(page.getByLabel("阅读页码", { exact: true })).toHaveText(
      format === "epub" ? /^本章 \d+(?:–\d+)? \/ \d+ 页$/ : /^\d+ \/ \d+ 页$/,
    );
    if (format === "epub")
      await expect(page.locator(".reader > .page-tools")).toBeHidden();
    expect(await reader.boundingBox()).toEqual(bounds);
    expect(await node!.evaluate((el) => el.isConnected)).toBe(true);
    await page.screenshot({
      path: path.join(evidence, `fullscreen-clean-${format}.png`),
    });
    const viewport = page.viewportSize()!;
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await expect(header).toBeHidden();
    await page.mouse.move(20, 5);
    await expect(header).toBeVisible();
    await page.clock.runFor(10000);
    await expect(header).toBeHidden();
    await page.mouse.move(20, viewport.height - 5);
    await expect(footer).toBeVisible();
    await page.getByLabel("当前文档搜索").focus();
    await page.clock.runFor(10000);
    await expect(header).toBeVisible();
    await page.getByLabel("当前文档搜索").blur();
    await page.clock.runFor(10000);
    await expect(header).toBeHidden();
    await page.keyboard.press("Tab");
    await expect(header).toBeVisible();
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);
    await page.clock.runFor(11000);
    await expect(header).toBeVisible();
    await expect(footer).toBeVisible();
  });
}
test("EPUB page numbers follow page turns, window size, font size and scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await openFile(page, "双页阅读.epub");
  await page.getByLabel("页面布局").selectOption("double");
  const counter = page.getByLabel("阅读页码", { exact: true });
  await expect(counter).toHaveText(/^本章 \d+–\d+ \/ \d+ 页$/);
  const numbers = async () =>
    (await counter.textContent())!.match(/\d+/g)!.map(Number);
  const initial = await numbers();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect
    .poll(async () => (await numbers())[0])
    .toBeGreaterThan(initial[0]);
  const wideTotal = (await numbers()).at(-1)!;
  await page.setViewportSize({ width: 1800, height: 650 });
  await expect
    .poll(async () => (await numbers()).at(-1)!)
    .toBeGreaterThan(wideTotal);
  const shorterTotal = (await numbers()).at(-1)!;
  await page.getByTitle("阅读设置", { exact: true }).click();
  await page.getByLabel("阅读字号").fill("30");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect
    .poll(async () => (await numbers()).at(-1)!)
    .toBeGreaterThan(shorterTotal);
  await page.getByLabel("页面布局").selectOption("scroll");
  await expect(counter).toHaveText(/^本章 \d+(?:–\d+)? \/ \d+ 页$/);
  await page.locator(".epub-container .epub-container").evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  await expect.poll(async () => (await numbers())[0]).toBeGreaterThan(1);
  await page.screenshot({ path: path.join(evidence, "epub-page-number.png") });
  await page.getByTitle("阅读设置", { exact: true }).click();
  await page.getByLabel("阅读字号").fill("18");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
});
test("PDF, Markdown and TXT show their reading percentage", async ({
  page,
}) => {
  for (const name of ["幂等性.md", "中文与Unicode.txt"]) {
    await openFile(page, name);
    await expect(
      page.locator(".document-title .reader-progress"),
    ).toBeVisible();
    await expect(page.locator(".reader .reader-progress")).toHaveCount(0);
    await expect(page.getByLabel("阅读进度百分比")).toHaveText(/^[\d.]+%$/);
    await page.locator(".reader").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.getByLabel("阅读进度百分比")).toHaveText("100%");
  }
  await openFile(page, "500页按需加载.pdf");
  await expect(page.getByLabel("阅读进度百分比")).toHaveText("0.2%");
  await page.getByLabel("PDF 页码").fill("250");
  await expect(page.getByLabel("阅读进度百分比")).toHaveText("50%");
  await page.getByLabel("PDF 页码").fill("500");
  await expect(page.getByLabel("阅读进度百分比")).toHaveText("100%");
});
for (const [file, layout] of [
  ["双页阅读.epub", "double"],
  ["双页阅读.epub", "scroll"],
  ["500页按需加载.pdf", "single"],
  ["幂等性.md", ""],
  ["中文与Unicode.txt", ""],
] as const) {
  test(`Reading progress slider seeks on release and persists (${file}, ${layout || "text"})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1480, height: 650 });
    await openFile(page, file);
    if (layout) await page.getByLabel("页面布局").selectOption(layout);
    const slider = page.getByRole("slider", {
      name: "整本阅读进度",
      exact: true,
    });
    const percentage = async () =>
      Number(
        (await page.getByLabel("阅读进度百分比").textContent())!.replace(
          "%",
          "",
        ),
      );
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveAttribute("aria-busy", "false");
    await slider.focus();
    await slider.press("Home");
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveAttribute("aria-busy", "false");
    await expect.poll(percentage).toBeLessThan(10);
    const readerPosition = async () =>
      file.endsWith(".epub")
        ? page.getByLabel("阅读页码", { exact: true }).textContent()
        : file.endsWith(".pdf")
          ? page.getByLabel("PDF 页码").inputValue()
          : page.locator(".reader").evaluate((el) => Math.round(el.scrollTop));
    const before = await readerPosition();
    const box = (await slider.boundingBox())!;
    const x = (value: number) => box.x + 4.5 + ((box.width - 9) * value) / 100;
    await page.mouse.move(
      x(Number(await slider.inputValue())),
      box.y + box.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(x(65), box.y + box.height / 2, { steps: 8 });
    await expect.poll(percentage).toBeGreaterThan(63);
    await expect.poll(percentage).toBeLessThan(67);
    expect(await readerPosition()).toBe(before);
    await page.mouse.up();
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveAttribute("aria-busy", "false");
    await expect.poll(readerPosition).not.toBe(before);
    await expect.poll(percentage).toBeGreaterThan(45);
    await expect.poll(percentage).toBeLessThan(80);
    const member = docs.find((d: any) =>
      d.bindings.some((b: any) => b.relativePath.endsWith(file)),
    );
    await expect
      .poll(
        async () =>
          (await get(`/documents/${member.id}/reading-state`)).locator
            ?.percentage,
      )
      .toBe(await percentage());
    const saved = (await get(`/documents/${member.id}/reading-state`)).locator;
    const metrics = async () =>
      page.locator(".reader").evaluate((el) => {
        const f = el.querySelector("iframe"),
          b = f?.contentDocument?.body;
        const s = b && f?.contentWindow?.getComputedStyle(b);
        return {
          reader: {
            width: el.clientWidth,
            height: el.clientHeight,
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
          },
          image: el
            .querySelector(".prose img")
            ?.getBoundingClientRect()
            .toJSON(),
          body: s && {
            width: s.width,
            height: s.height,
            font: s.fontSize,
            lineHeight: s.lineHeight,
            padding: s.padding,
          },
          page: el.parentElement?.parentElement?.querySelector(
            ".reader-page-number",
          )?.textContent,
        };
      });
    const beforeReload = await metrics();
    await page.reload();
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveAttribute("aria-busy", "false");
    await writeFile(
      path.join(
        evidence,
        `seek-restore-${layout || file.split(".").at(-1)}.json`,
      ),
      JSON.stringify(
        {
          saved,
          beforeReload,
          afterReload: await metrics(),
          restored: await percentage(),
        },
        null,
        2,
      ),
    );
    await expect
      .poll(async () => Math.abs((await percentage()) - saved.percentage))
      .toBeLessThan(5);
    await slider.focus();
    await slider.press("End");
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveAttribute("aria-busy", "false");
    await expect(page.getByLabel("阅读进度百分比")).toHaveText("100%");
    await expect(slider).toBeFocused();
    await page.screenshot({
      path: path.join(evidence, `seek-${layout || file.split(".").at(-1)}.png`),
    });
    await slider.press("Home");
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveAttribute("aria-busy", "false");
    await expect.poll(percentage).toBeLessThan(10);
  });
}
test("PDF zoom shortcuts support Mac and Windows modifiers, preserve the reading point and persist", async ({
  page,
}) => {
  await openFile(page, "500页按需加载.pdf");
  const zoom = page.getByLabel("PDF 缩放");
  await page.getByLabel("页面布局").selectOption("single");
  await zoom.selectOption("1");
  await page.getByLabel("PDF 页码").fill("8");
  const sheet = page.locator('.pdf-page[data-page-index="7"]');
  await expect(sheet.locator(".textLayer")).toContainText("page 8");
  for (const modifier of ["Control", "Meta"]) {
    await page.locator(".reader-pdf").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press(`${modifier}+=`);
    await expect(zoom).toHaveValue("1.25");
    await page.keyboard.press(`${modifier}+-`);
    await expect(zoom).toHaveValue("1");
    await page.keyboard.press(`${modifier}+=`);
    await page.keyboard.press(`${modifier}+0`);
    await expect(zoom).toHaveValue("1");
  }
  await page.getByLabel("PDF 页码").fill("8");
  const reader = page.locator(".reader-pdf");
  const box = (await reader.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height * 0.6 };
  const position = async () => {
    const b = (await sheet.boundingBox())!;
    return { x: (point.x - b.x) / b.width, y: (point.y - b.y) / b.height };
  };
  const before = await position();
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    ratio: devicePixelRatio,
  }));
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => Number(await zoom.inputValue()))
    .toBeGreaterThan(1);
  await expect(sheet.locator(".textLayer")).toContainText("page 8");
  const after = await position();
  expect(Math.abs(after.y - before.y)).toBeLessThan(0.005);
  expect(Math.abs(after.x - before.x)).toBeLessThan(0.005);
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
  expect(
    await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio })),
  ).toEqual(viewport);
  await page.screenshot({ path: path.join(evidence, "pdf-zoom-focused.png") });
  const scale = await zoom.inputValue();
  await expect
    .poll(async () => (await get("/preferences")).pdfScale)
    .toBe(Number(scale));
  await page.reload();
  await expect(zoom).toHaveValue(scale);
  await page.keyboard.press("Control+0");
  await expect(zoom).toHaveValue("1");
  await reader.hover();
  await page.keyboard.down("Meta");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Meta");
  await expect
    .poll(async () => Number(await zoom.inputValue()))
    .toBeGreaterThan(1);
  await zoom.selectOption("0.75");
  // The earlier gesture's idle save must not override a direct menu choice.
  await page.waitForTimeout(220);
  await expect
    .poll(async () => (await get("/preferences")).pdfScale)
    .toBe(0.75);
  await page.keyboard.press("Control+0");
  await expect(zoom).toHaveValue("1");
  await page.getByLabel("PDF 页码").fill("1");
  const scaleBeforeScroll = await zoom.inputValue();
  await reader.hover();
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() => reader.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100);
  await expect(zoom).toHaveValue(scaleBeforeScroll);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.keyboard.press("Control+=");
  await expect(zoom).toHaveValue(scaleBeforeScroll);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("PDF 页码").fill("1");
});

test("PDF pinch input scales only the document, clamps limits and coalesces preference writes", async ({
  page,
  browserName,
}) => {
  await openFile(page, "双栏与扫描混合.pdf");
  await page.getByLabel("页面布局").selectOption("single");
  const zoom = page.getByLabel("PDF 缩放");
  await zoom.selectOption("1");
  const reader = page.locator(".reader-pdf");
  const width = (await page.locator(".workspace-rail").boundingBox())!.width;
  const saved: any[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().endsWith("/api/preferences")
    )
      saved.push(request.postDataJSON());
  });
  // A burst models high-frequency pinch events; visual updates happen per frame,
  // while persistence waits for the end of the gesture.
  await reader.evaluate((el) => {
    const b = el.getBoundingClientRect();
    for (let i = 0; i < 20; i++)
      el.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -5,
          clientX: b.left + b.width / 2,
          clientY: b.top + b.height / 2,
        }),
      );
  });
  await expect
    .poll(async () => Number(await zoom.inputValue()))
    .toBeGreaterThan(1.2);
  await expect
    .poll(async () => (await get("/preferences")).pdfScale)
    .toBe(Number(await zoom.inputValue()));
  expect(saved.length).toBeLessThanOrEqual(2);
  expect(saved.length).toBeGreaterThan(0);
  if (browserName === "chromium") {
    const session = await page.context().newCDPSession(page);
    const box = (await reader.boundingBox())!;
    const before = Number(await zoom.inputValue());
    await session.send("Input.synthesizePinchGesture", {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      scaleFactor: 1.25,
      relativeSpeed: 800,
      gestureSourceType: "mouse",
    });
    await expect
      .poll(async () => Number(await zoom.inputValue()))
      .toBeGreaterThan(before);
    await session.detach();
  }
  expect((await page.locator(".workspace-rail").boundingBox())!.width).toBe(
    width,
  );
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
  // Safari delivers a relative GestureEvent scale for the whole gesture.
  await reader.evaluate((el) => {
    for (const [type, scale] of [
      ["gesturestart", 1],
      ["gesturechange", 1.2],
      ["gestureend", 1.2],
    ] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "scale", { value: scale });
      el.dispatchEvent(event);
    }
  });
  for (let i = 0; i < 12; i++) await page.keyboard.press("Control+=");
  await expect(zoom).toHaveValue("4");
  await page.keyboard.press("Control+=");
  await expect(zoom).toHaveValue("4");
  for (let i = 0; i < 12; i++) await page.keyboard.press("Control+-");
  await expect(zoom).toHaveValue("0.25");
  await page.keyboard.press("Control+-");
  await expect(zoom).toHaveValue("0.25");
  await page.keyboard.press("Control+0");
  await expect(zoom).toHaveValue("1");
  await page.screenshot({ path: path.join(evidence, "pdf-zoom.png") });
});

test("PDF wheel scrolling loads adjacent pages, keeps page anchors and restores position", async ({
  page,
}) => {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 30; i++) {
    const size: [number, number] =
      i % 3 === 1 ? [900, 500] : i % 3 === 2 ? [420, 650] : [612, 792];
    const sheet = pdf.addPage(size);
    sheet.drawText(`Continuous page ${i + 1}.`, {
      x: 45,
      y: size[1] - 70,
      size: 18,
      font,
    });
    sheet.drawText(
      "A page keeps its own selection and annotation coordinates.",
      { x: 45, y: size[1] - 110, size: 11, font },
    );
  }
  const response = await client.post(
    base + `/api/workspaces/${workspace.id}/imports`,
    {
      headers: { "X-CSRF-Token": csrf },
      multipart: {
        files: {
          name: "连续分页混合尺寸.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from(await pdf.save()),
        },
      },
    },
  );
  expect(response.ok()).toBe(true);
  const scan = (await response.json()).scan.id;
  await expect
    .poll(async () => (await get("/scans/" + scan)).state)
    .toBe("completed");
  docs = (await get(`/workspaces/${workspace.id}/documents`)).items;
  await page.reload();
  await openFile(page, "01_连续分页混合尺寸.pdf");
  await page.getByLabel("PDF 缩放").selectOption("1");
  const footerControls = page.locator(".reading-footer .page-tools");
  await expect(footerControls).toBeVisible();
  await expect(page.locator(".reader-pdf .page-tools")).toHaveCount(0);
  const footerTop = (await footerControls.boundingBox())!.y;
  const readerBox = (await page.locator(".reader").boundingBox())!;
  expect(footerTop).toBeGreaterThanOrEqual(readerBox.y + readerBox.height);
  const layer = (index: number) =>
    page.locator(`.pdf-page[data-page-index="${index}"] .textLayer`);
  await expect(layer(0)).toContainText("Continuous page 1.");
  await page.locator(".reader").hover();
  await page.mouse.wheel(0, 1100);
  await expect
    .poll(async () => Number(await page.getByLabel("PDF 页码").inputValue()))
    .toBeGreaterThan(1);
  await expect(layer(1)).toContainText("Continuous page 2.");
  expect((await footerControls.boundingBox())!.y).toBe(footerTop);
  expect(await page.locator(".pdf-page canvas").count()).toBeLessThanOrEqual(5);
  await page.getByLabel("PDF 页码").fill("1");
  await expect(layer(0)).toContainText("Continuous page 1.");
  await page.locator(".reader").hover();
  await page.mouse.wheel(0, 420);
  await expect(layer(1).locator("span").first()).toBeInViewport();
  // Select a neighboring visible page while the first page remains the current one.
  await expect(page.getByLabel("PDF 页码")).toHaveValue("1");
  await page.locator(".pdf-pages").evaluate((el) => {
    const start = el.querySelector(
      '.pdf-page[data-page-index="0"] .textLayer span',
    )!;
    const end = el.querySelector(
      '.pdf-page[data-page-index="1"] .textLayer span',
    )!;
    const range = document.createRange();
    range.setStart(start.firstChild!, 0);
    range.setEnd(end.firstChild!, end.textContent!.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    start.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await expect(
    page.getByText("请在同一页或章节选择，跨页内容请分段批注", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".selection-toolbar")).toHaveCount(0);
  await layer(1).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.querySelector("span")!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await page.getByLabel("评论输入").fill("连续阅读中的第二页批注");
  await page.getByLabel("发送评论").click();
  await expect(page.locator(".note-body")).toContainText(
    "连续阅读中的第二页批注",
  );
  const document = docs.find((d) =>
    d.bindings.some((b: any) =>
      b.relativePath.includes("连续分页混合尺寸.pdf"),
    ),
  );
  const notes = await get(`/documents/${document.id}/threads`);
  const anchor = notes[0].anchor;
  expect(anchor.selectors.find((s: any) => s.type === "pdf").pageIndex).toBe(1);
  expect(anchor.selectors.find((s: any) => s.type === "text").block).toBe(
    "page-1",
  );
  await page.getByLabel("PDF 页码").fill("25");
  await expect(layer(24)).toContainText("Continuous page 25.");
  await expect(layer(0)).toHaveCount(0);
  await page.locator(".quote-button").first().click();
  await expect(layer(1)).toContainText("Continuous page 2.");
  await expect(page.locator(".annotation-mark").first()).toBeInViewport({
    ratio: 0.1,
  });
  await page.getByLabel("PDF 页码").fill("20");
  await expect(layer(19)).toContainText("Continuous page 20.");
  await page.locator(".reader").hover();
  await page.mouse.wheel(0, 180);
  await expect
    .poll(
      async () =>
        (await get(`/documents/${document.id}/reading-state`)).locator
          ?.pageOffset || 0,
    )
    .toBeGreaterThan(0.1);
  const saved = (await get(`/documents/${document.id}/reading-state`)).locator;
  await page.reload();
  await expect(layer(saved.pageIndex)).toContainText(
    `Continuous page ${saved.pageIndex + 1}.`,
  );
  await expect(page.getByLabel("PDF 页码")).toHaveValue(
    String(saved.pageIndex + 1),
  );
  await expect
    .poll(
      async () =>
        (await get(`/documents/${document.id}/reading-state`)).locator
          ?.pageOffset,
    )
    .toBeCloseTo(saved.pageOffset, 1);
  expect(await page.locator(".pdf-page canvas").count()).toBeLessThanOrEqual(5);
  await page.getByRole("button", { name: "全屏阅读", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.className))
    .toBe("reading-main");
  await expect(layer(saved.pageIndex)).toBeInViewport();
  await expect(
    page.locator(".reading-main:fullscreen .reading-footer .page-tools"),
  ).toBeVisible();
  await expect(page.getByLabel("PDF 页码")).toBeInViewport();
  await page.getByRole("button", { name: "退出全屏阅读", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  await page.screenshot({ path: path.join(evidence, "continuous-pdf.png") });
});
test("Mobile app download QR serves the bundled Android APK without library access", async ({
  page,
  browser,
}) => {
  test.skip(
    !process.env.OR_ANDROID_APK,
    "Provide the bundled APK through OR_ANDROID_APK",
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "手机与同步", exact: true }).click();
  await expect(page.getByText("APK 已就绪", { exact: false })).toBeVisible();
  await page
    .getByRole("button", { name: "生成下载二维码", exact: true })
    .click();
  await expect(page.getByAltText("手机应用下载二维码")).toBeVisible();
  const link = (await page.locator(".installer-link").textContent())!.trim();
  expect(link).toMatch(/^http:\/\/[^/]+\/install\/[a-f0-9]{32}\?lang=zh$/);
  await page.screenshot({
    path: path.join(evidence, "desktop-download-qr.png"),
  });
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/155.0 Mobile Safari/537.36",
  });
  try {
    const landing = await phone.newPage();
    await landing.goto(link);
    await expect(
      landing.getByRole("link", { name: "下载安卓 APK" }),
    ).toBeVisible();
    await expect(
      landing.getByText("iOS 真机版尚未开放安装", { exact: false }),
    ).toBeVisible();
    await landing.screenshot({
      path: path.join(evidence, "android-install-page.png"),
    });
    const apkURL = await landing
      .getByRole("link", { name: "下载安卓 APK" })
      .getAttribute("href");
    const response = await phone.request.get(new URL(apkURL!, link).href);
    expect(response.status()).toBe(200);
    const digest = (data: Buffer) =>
      createHash("sha256").update(data).digest("hex");
    const downloaded = digest(await response.body());
    expect(downloaded).toBe(
      digest(await readFile(process.env.OR_ANDROID_APK!)),
    );
    const denied = await phone.request.get(
      new URL("/api/workspaces", link).href,
    );
    expect(denied.status()).toBe(404);
    await writeFile(
      path.join(evidence, "apk-download.json"),
      JSON.stringify(
        {
          bytes: (await response.body()).length,
          sha256: downloaded,
          libraryRoute: denied.status(),
        },
        null,
        2,
      ),
    );
    await page.getByRole("button", { name: "停止安装包分享" }).click();
    await expect(page.getByAltText("手机应用下载二维码")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "生成下载二维码", exact: true }),
    ).toBeVisible();
  } finally {
    await phone.close();
  }
});
test("Reader text reflows into the space released by collapsed panels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  const measurements: any[] = [];
  for (const [name, content] of [
    ["幂等性.md", page.locator(".prose")],
    [
      "可靠接口.epub",
      page.frameLocator(".epub-container iframe").locator("p").first(),
    ],
  ] as const) {
    await openFile(page, name);
    if (name.endsWith(".epub"))
      await page.getByLabel("页面布局").selectOption("scroll");
    await expect(page.locator(".discussion")).toBeHidden();
    await expect(content).toBeVisible();
    const width = async () => (await content.boundingBox())!.width;
    const defaultWidth = await width();
    await page.getByTitle("展开讨论", { exact: true }).click();
    await expect.poll(width).toBeLessThan(defaultWidth - 250);
    const expandedPanel = await width();
    await page.getByTitle("收起讨论", { exact: true }).click();
    await expect.poll(width).toBeGreaterThan(expandedPanel + 250);
    const collapsedPanel = await width();
    // The visible text must also fit inside the reader, not just its shell.
    const reader = (await page.locator(".reader").boundingBox())!;
    const frame = name.endsWith(".epub")
      ? await page.locator(".epub-container iframe").boundingBox()
      : null;
    const text = (await content.boundingBox())!;
    expect(text.x + text.width).toBeLessThanOrEqual(
      reader.x + reader.width + 1,
    );
    if (frame) expect(frame.width).toBeLessThanOrEqual(reader.width);
    await page.getByTitle("展开讨论", { exact: true }).click();
    await expect.poll(width).toBeLessThan(collapsedPanel - 250);
    await expect
      .poll(async () => Math.abs((await width()) - expandedPanel))
      .toBeLessThan(3);
    measurements.push({
      name,
      expandedPanel,
      collapsedPanel,
      restored: await width(),
    });
  }
  await writeFile(
    path.join(evidence, "reader-panel-width.json"),
    JSON.stringify(measurements, null, 2),
  );
  await page.getByTitle("收起讨论", { exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.locator(".epub-container iframe").boundingBox())?.width ||
        0,
    )
    .toBeGreaterThan(1200);
  await page.screenshot({
    path: path.join(evidence, "reader-panel-collapsed.png"),
  });
});
test("A07 EPUB toolbar stays beside the actual selection after scrolling and resizing", async ({
  page,
}) => {
  await openFile(page, "可靠接口.epub");
  await page.getByLabel("页面布局").selectOption("scroll");
  const paragraph = page
    .frameLocator(".epub-container iframe")
    .locator("p")
    .first();
  await selectText(paragraph, "幂等性意味着重复执行同一操作");
  await expect(page.locator(".selection-toolbar")).toBeVisible();
  await expect
    .poll(async () => (await toolbarGeometry(page)).gap)
    .toBeLessThan(16);
  const before = await toolbarGeometry(page);
  expect(before.overlap).toBeGreaterThan(0);
  await page.locator(".epub-container .epub-container").evaluate((el) => {
    el.scrollTop += 70;
  });
  await expect
    .poll(async () => (await toolbarGeometry(page)).gap)
    .toBeLessThan(16);
  await expect
    .poll(async () => (await toolbarGeometry(page)).toolbar.y)
    .toBeLessThan(before.toolbar.y - 40);
  const afterScroll = await toolbarGeometry(page);
  await page.setViewportSize({ width: 1260, height: 900 });
  await selectText(paragraph, "幂等性意味着重复执行同一操作");
  await expect(page.locator(".selection-toolbar")).toBeVisible();
  await expect
    .poll(async () => (await toolbarGeometry(page)).gap)
    .toBeLessThan(16);
  const resized = await toolbarGeometry(page);
  expect(resized.overlap).toBeGreaterThan(0);
  await writeFile(
    path.join(evidence, "epub-toolbar.json"),
    JSON.stringify({ before, afterScroll, resized }, null, 2),
  );
  await page.screenshot({ path: path.join(evidence, "12-epub-toolbar.png") });
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await expect(page.locator(".composer blockquote")).toContainText(
    "幂等性意味着重复执行同一操作",
  );
  await expect(page.getByLabel("评论输入")).toBeEnabled();
});
test("A07 SVG EPUB cover preserves aspect ratio across sidebar and window changes", async ({
  page,
}) => {
  await openFile(page, "封面与正文.epub");
  const svg = page.frameLocator(".epub-container iframe").locator("svg");
  await expect(svg).toBeVisible();
  const cover = await svg.boundingBox(),
    viewport = await page.locator(".reader-epub").boundingBox();
  expect(cover!.height).toBeLessThan(viewport!.height);
  expect(cover!.y + cover!.height).toBeLessThanOrEqual(
    viewport!.y + viewport!.height,
  );
  const image = await svg.locator("image").evaluate(async (el) => {
    const image = new Image();
    image.src = el.getAttribute("href") || el.getAttribute("xlink:href") || "";
    await image.decode();
    return image.naturalWidth;
  });
  expect(image).toBe(2);
  const assertProportions = async () => {
    await expect(svg).toHaveAttribute("preserveAspectRatio", "xMidYMid meet");
    await expect(svg.locator("image")).toHaveAttribute(
      "preserveAspectRatio",
      "xMidYMid meet",
    );
    await expect
      .poll(() =>
        svg
          .evaluate((el: SVGSVGElement) => {
            const matrix = el.getScreenCTM();
            return matrix
              ? Math.abs(
                  Math.hypot(matrix.a, matrix.b) -
                    Math.hypot(matrix.c, matrix.d),
                )
              : Infinity;
          })
          .catch(() => Infinity),
      )
      .toBeLessThan(0.000001);
  };
  await assertProportions();
  await page.getByTitle("展开讨论", { exact: true }).click();
  await expect(page.locator(".discussion")).toBeVisible();
  await assertProportions();
  await page.getByTitle("收起讨论", { exact: true }).click();
  for (const [width, height] of [
    [1680, 1000],
    [1260, 900],
    [900, 800],
  ]) {
    await page.setViewportSize({ width, height });
    await assertProportions();
  }
  await page.screenshot({ path: path.join(evidence, "13-epub-cover.png") });
  await page.getByRole("button", { name: "下一节", exact: true }).click();
  await expect(
    page.frameLocator(".epub-container iframe").locator("p").first(),
  ).toContainText("幂等性意味着");
});
test("A07 actual local EPUB cover and chapter are readable without redistributing the book", async ({
  page,
}) => {
  test.skip(
    !process.env.OR_REAL_EPUB,
    "Provide an authorized local EPUB through OR_REAL_EPUB",
  );
  await openFile(page, "用户EPUB验证.epub");
  const frame = page.frameLocator(".epub-container iframe");
  await expect(frame.locator("svg")).toBeVisible();
  const cover = await frame.locator("svg").boundingBox(),
    viewport = await page.locator(".reader-epub").boundingBox();
  expect(cover!.height).toBeLessThan(viewport!.height);
  expect(cover!.y + cover!.height).toBeLessThanOrEqual(
    viewport!.y + viewport!.height,
  );
  const image = await frame.locator("image").evaluate(async (el) => {
    const image = new Image();
    image.src = el.getAttribute("href") || el.getAttribute("xlink:href") || "";
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  expect(image.width).toBeGreaterThan(0);
  const scale = await frame.locator("svg").evaluate((el: SVGSVGElement) => {
    const matrix = el.getScreenCTM()!;
    return {
      x: Math.hypot(matrix.a, matrix.b),
      y: Math.hypot(matrix.c, matrix.d),
    };
  });
  expect(scale.x).toBeCloseTo(scale.y, 6);
  await expect(frame.locator("image")).toHaveAttribute(
    "preserveAspectRatio",
    "xMidYMid meet",
  );

  await page.getByRole("button", { name: "下一节", exact: true }).click();
  await expect
    .poll(async () => (await frame.locator("body").innerText()).trim().length)
    .toBeGreaterThan(0);
  // Some books put a short title page between the cover and the first text chapter.
  for (
    let i = 0;
    i < 5 && (await frame.locator("body").innerText()).trim().length <= 40;
    i++
  ) {
    await page.getByRole("button", { name: "下一节", exact: true }).click();
    await expect(frame.locator("body")).toBeAttached();
  }
  await expect
    .poll(async () => (await frame.locator("body").innerText()).trim().length)
    .toBeGreaterThan(40);
  await writeFile(
    path.join(evidence, "real-epub.json"),
    JSON.stringify(
      {
        coverFitsViewport: true,
        coverImageDecoded: image,
        nextChapterHasText: true,
        bookRedistributed: false,
      },
      null,
      2,
    ),
  );
});
test("Arrow keys move one viewport through Markdown and TXT", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  for (const name of ["幂等性.md", "中文与Unicode.txt"]) {
    await openFile(page, name);
    const reader = page.locator(".reader");
    await reader.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => reader.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => reader.evaluate((el) => el.scrollTop)).toBe(0);
  }
});

test("Arrow keys turn PDF pages and spreads without interfering with inputs or settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await openFile(page, "500页按需加载.pdf");
  await page.getByLabel("页面布局").selectOption("single");
  const number = page.getByLabel("PDF 页码");
  // Earlier tests deliberately save a position. Start this navigation test at
  // its explicit boundary without changing the product's resume behavior.
  await number.fill("1");
  await expect(
    page.locator('.pdf-page[data-page-index="0"] .textLayer'),
  ).toContainText("page 1");
  // Opening a book leaves focus on the file button: keys should work there too.
  await page
    .locator(".file-item")
    .filter({ hasText: "500页按需加载.pdf" })
    .focus();
  await page.keyboard.press("ArrowLeft");
  await expect(number).toHaveValue("1");
  await page.keyboard.press("ArrowRight");
  await expect(number).toHaveValue("2");
  await page.keyboard.press("ArrowLeft");
  await expect(number).toHaveValue("1");
  await page.getByLabel("页面布局").selectOption("double");
  await page.locator(".reader-pdf").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ArrowRight");
  await expect(number).toHaveValue("3");
  await page.keyboard.press("ArrowLeft");
  await expect(number).toHaveValue("1");
  const search = page.getByLabel("搜索文件名");
  await search.fill("page");
  await search.press("ArrowLeft");
  expect(
    await search.evaluate((el: HTMLInputElement) => el.selectionStart),
  ).toBe(3);
  await search.press("ArrowRight");
  await expect(number).toHaveValue("1");
  await search.fill("");
  await number.focus();
  await number.press("ArrowRight");
  await expect(number).toHaveValue("1");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(number).toHaveValue("1");
  await page.locator(".reader-pdf").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+ArrowRight");
  await expect(number).toHaveValue("1");
  await number.fill("500");
  await page.locator(".reader-pdf").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ArrowRight");
  await expect(number).toHaveValue("500");
  await number.fill("1");
  await page.getByRole("button", { name: "页级笔记", exact: true }).click();
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  const comment = page.getByLabel("评论输入");
  await comment.fill("Keep the caret here");
  await comment.press("ArrowLeft");
  await comment.press("ArrowRight");
  await expect(number).toHaveValue("1");
  await expect(comment).toHaveValue("Keep the caret here");
  await page.getByLabel("页面布局").selectOption("single");
});

test("Arrow keys work inside the EPUB iframe in single and double page modes", async ({
  page,
  browserName,
}) => {
  test.fail(
    browserName === "webkit",
    "WebKit suppresses native key callbacks in script-disabled EPUB frames; main-window shortcuts work without weakening the sandbox.",
  );
  await page.setViewportSize({ width: 1680, height: 1000 });
  await openFile(page, "双页阅读.epub");
  const body = () =>
    page.frameLocator(".epub-container iframe").locator("body");
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath.includes("双页阅读.epub")),
  );
  const state = async () =>
    (await get(`/documents/${d.id}/reading-state`)).locator;
  const resetPage = async () => {
    const slider = page.getByLabel("整本阅读进度", { exact: true });
    await expect(slider).toBeEnabled();
    await expect(slider).toHaveAttribute("aria-busy", "false");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/documents/${d.id}/reading-state`) &&
        response.request().method() === "PUT" &&
        response.ok(),
    );
    await slider.click({ position: { x: 0, y: 5 } });
    await expect(slider).toHaveAttribute("aria-busy", "false");
    await saved;
    await expect.poll(async () => (await state())?.cfi).toContain("epubcfi(");
  };
  await page.getByLabel("页面布局").selectOption("single");
  await resetPage();
  const startCFI = (await state()).cfi;
  await page.getByRole("button", { name: "下一页", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await state())?.cfi).not.toBe(startCFI);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await state())?.cfi).toBe(startCFI);
  for (const layout of ["single", "double"]) {
    await page.getByLabel("页面布局").selectOption(layout);
    await expect(body().locator("p").first()).toContainText("段落 1");
    await resetPage();
    await body().click({ position: { x: 8, y: 8 } });
    // Compare the stable live location, not an outstanding debounced save.
    await expect.poll(async () => (await state())?.cfi).toContain("epubcfi(");
    const before = (await state()).cfi;
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await state())?.cfi).not.toBe(before);
    await body().click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await state())?.cfi).toBe(before);
  }
});

test("EPUB window pagination reflows every viewport without vertical scrolling", async ({
  page,
}) => {
  const legacy = await client.put(`${base}/api/preferences`, {
    headers: { "X-CSRF-Token": csrf },
    data: { epubFlow: "scrolled-doc", epubSpread: false },
  });
  expect(legacy.ok()).toBe(true);
  await page.reload();
  await openFile(page, "双页阅读.epub");
  await expect(page.getByLabel("页面布局")).toHaveValue("scroll");
  const reader = page.locator(".reader-epub");
  await expect
    .poll(() =>
      reader.evaluate((el) =>
        Math.max(
          el.scrollHeight - el.clientHeight,
          ...Array.from(
            el.querySelectorAll<HTMLElement>(".epub-container"),
          ).map((stage) => stage.scrollHeight - stage.clientHeight),
        ),
      ),
    )
    .toBeGreaterThan(100);
  await page.getByLabel("页面布局").selectOption("single");
  const body = page.frameLocator(".epub-container iframe").locator("body");
  const geometry = () =>
    reader.evaluate((el) => {
      const container = el.querySelector<HTMLElement>(
        ":scope > .epub-container",
      )!;
      const stage = container.querySelector<HTMLElement>(".epub-container")!;
      const frame = container.querySelector<HTMLIFrameElement>("iframe")!;
      const d = frame.contentDocument!,
        b = d.body;
      const box = frame.getBoundingClientRect(),
        outer = el.getBoundingClientRect(),
        stageBox = stage.getBoundingClientRect();
      const lines = Array.from(b.querySelectorAll("h1, h2, p"))
        .flatMap((p) => {
          const range = d.createRange();
          range.selectNodeContents(p);
          return Array.from(range.getClientRects());
        })
        .filter(
          (r) =>
            r.right + box.left > stageBox.left &&
            r.left + box.left < stageBox.right &&
            r.width > 0,
        );
      return {
        readerOverflow: el.scrollHeight - el.clientHeight,
        stageOverflow: stage.scrollHeight - stage.clientHeight,
        bodyOverflow: b.scrollHeight - b.clientHeight,
        frameHeight: frame.clientHeight,
        availableHeight: container.clientHeight,
        columnWidth: parseFloat(getComputedStyle(b).columnWidth),
        frameBottom: box.bottom,
        readerBottom: outer.bottom,
        lines: lines.length,
        lineBottom: Math.max(...lines.map((r) => r.bottom)),
        tops: [
          el.scrollTop,
          stage.scrollTop,
          d.documentElement.scrollTop,
          b.scrollTop,
        ],
      };
    });
  const assertFits = async () => {
    let measured: Awaited<ReturnType<typeof geometry>>;
    await expect
      .poll(
        async () => {
          try {
            measured = await geometry();
            const g = measured;
            return g.lines > 0 && g.columnWidth > 0
              ? Math.max(
                  g.readerOverflow,
                  g.stageOverflow,
                  g.bodyOverflow,
                  Math.abs(g.frameHeight - g.availableHeight),
                )
              : Infinity;
          } catch {
            return Infinity;
          }
        },
        { message: "Window pagination must fit", timeout: 10000 },
      )
      .toBeLessThanOrEqual(2)
      .catch((e) => {
        console.log("pagination geometry", measured!);
        throw e;
      });
    const g = measured!;
    expect(g.lineBottom).toBeLessThanOrEqual(g.frameHeight + 1);
    expect(g.frameBottom).toBeLessThanOrEqual(g.readerBottom + 1);
    return g;
  };
  const checks = [];
  for (const layout of ["single", "double"]) {
    await page.getByLabel("页面布局").selectOption(layout);
    for (const [width, height] of [
      [1680, 1000],
      [1680, 700],
      [1000, 650],
      [900, 500],
    ]) {
      await page.setViewportSize({ width, height });
      checks.push({ layout, width, height, ...(await assertFits()) });
    }
  }
  await page.setViewportSize({ width: 1680, height: 1000 });
  const tall = await assertFits();
  await page.setViewportSize({ width: 1680, height: 600 });
  const short = await assertFits();
  expect(short.lines).toBeLessThan(tall.lines);
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath.includes("双页阅读.epub")),
  );
  const location = async () =>
    (await get(`/documents/${d.id}/reading-state`)).locator;
  await expect.poll(async () => (await location())?.cfi).toContain("epubcfi(");
  const before = (await location()).cfi;
  await body.click({ position: { x: 8, y: 8 } });
  await page.mouse.wheel(0, 600);
  expect((await geometry()).tops).toEqual([0, 0, 0, 0]);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect.poll(async () => (await location())?.cfi).not.toBe(before);
  await assertFits();
  await page.getByTitle("展开讨论", { exact: true }).click();
  await assertFits();
  await page.getByTitle("收起讨论", { exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("阅读字号").fill("26");
  await page.getByLabel("阅读行距").fill("2.2");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await assertFits();
  await page.getByRole("button", { name: "全屏阅读", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await assertFits();
  await page.screenshot({
    path: path.join(evidence, "epub-window-fullscreen.png"),
  });
  await page.getByRole("button", { name: "退出全屏阅读", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(false);
  await assertFits();
  await page.reload();
  await expect(body.locator("p").first()).toBeAttached();
  await assertFits();
  await page.screenshot({
    path: path.join(evidence, "epub-window-pagination.png"),
  });
  await writeFile(
    path.join(evidence, "epub-window-geometry.json"),
    JSON.stringify(checks, null, 2),
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("阅读字号").fill("18");
  await page.getByLabel("阅读行距").fill("1.9");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("页面布局").selectOption("scroll");
  await page.reload();
  await expect(page.getByLabel("页面布局")).toHaveValue("scroll");
  await expect(
    page.getByRole("button", { name: "下一节", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".reader-paginated")).toHaveCount(0);
});

test("Two-page PDF fits both pages, preserves right-page annotations and falls back in a narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await openFile(page, "500页按需加载.pdf");
  await page.getByLabel("页面布局").selectOption("double");
  await page.getByLabel("PDF 页码").fill("1");
  const sheet = (index: number) =>
    page.locator(`.pdf-page[data-page-index="${index}"]`);
  await expect(sheet(1).locator(".textLayer")).toContainText("page 2");
  const assertPair = async () => {
    const a = (await sheet(0).boundingBox())!,
      b = (await sheet(1).boundingBox())!,
      host = (await page.locator(".reader-pdf").boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width + 20);
    expect(b.x + b.width).toBeLessThanOrEqual(host.x + host.width);
    expect(a.y + a.height).toBeLessThanOrEqual(host.y + host.height);
    expect(a.width / a.height).toBeCloseTo(612 / 792, 3);
  };
  await assertPair();
  await page.screenshot({ path: path.join(evidence, "two-page-pdf.png") });
  await selectText(
    sheet(1).locator(".textLayer"),
    "Only the current page canvas should be resident.",
  );
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await page.getByLabel("评论输入").fill("双页右侧的批注");
  await page.getByLabel("发送评论").click();
  await expect(page.locator(".note-body")).toContainText("双页右侧的批注");
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath.includes("500页按需加载.pdf")),
  );
  const threads = await get(`/documents/${d.id}/threads`);
  expect(
    threads.at(-1).anchor.selectors.find((s: any) => s.type === "pdf")
      .pageIndex,
  ).toBe(1);
  await page.getByTitle("收起讨论", { exact: true }).click();
  await expect
    .poll(async () => {
      const a = await sheet(0).boundingBox(),
        b = await sheet(1).boundingBox();
      return a && b ? Math.abs(b.y - a.y) : Infinity;
    })
    .toBeLessThan(2);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByLabel("PDF 页码")).toHaveValue("3");
  await expect(sheet(2).locator(".textLayer")).toContainText("page 3");
  await page.getByLabel("PDF 页码").fill("8");
  await expect(sheet(7).locator(".textLayer")).toContainText("page 8");
  await page.getByLabel("PDF 缩放").selectOption("1.25");
  await expect(sheet(7).locator(".textLayer")).toContainText("page 8");
  await page.getByTitle("旋转 PDF").click();
  await expect
    .poll(async () => {
      const b = await sheet(7).boundingBox();
      return b ? b.width / b.height : 0;
    })
    .toBeCloseTo(792 / 612, 2);
  for (let i = 0; i < 3; i++) {
    await page.getByTitle("旋转 PDF").click();
    await expect(sheet(7).locator(".textLayer")).toContainText("page 8");
    await expect(page.getByLabel("PDF 页码")).toHaveValue("8");
  }
  await page.getByLabel("PDF 缩放").selectOption("1");
  await page.setViewportSize({ width: 800, height: 850 });
  await expect
    .poll(async () => {
      const a = await sheet(6).boundingBox(),
        b = await sheet(7).boundingBox();
      return a && b ? b.y - a.y : 0;
    })
    .toBeGreaterThan(100);
  await expect
    .poll(
      async () =>
        (await get(`/documents/${d.id}/reading-state`)).locator?.pageIndex,
    )
    .toBe(7);
  await page.reload();
  await expect(page.getByLabel("页面布局")).toHaveValue("double");
  await expect(page.getByLabel("PDF 页码")).toHaveValue("8");
  expect(await page.locator(".pdf-page canvas").count()).toBeLessThanOrEqual(8);
  await page.getByLabel("页面布局").selectOption("single");
});

test("Two-page EPUB reflows live text, turns a spread and retains CFI notes and layout", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__createdBookResources = 0;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (value) => {
      (window as any).__createdBookResources++;
      return create(value);
    };
  });
  await page.reload();
  await page.setViewportSize({ width: 1680, height: 1000 });
  await openFile(page, "双页阅读.epub");
  await page.getByLabel("页面布局").selectOption("double");
  const body = page.frameLocator(".epub-container iframe").locator("body");
  await expect(body.locator("p").first()).toContainText("段落 1");
  const columns = () =>
    body.evaluate((el) => {
      const width = parseFloat(getComputedStyle(el).columnWidth);
      const rects = Array.from(el.querySelectorAll("p"))
        .flatMap((p) => Array.from(p.getClientRects()))
        .filter(
          (r) =>
            r.x >= 0 &&
            r.x < el.ownerDocument.defaultView!.innerWidth &&
            r.height > 0,
        );
      return {
        width,
        viewport:
          (el.ownerDocument.defaultView!.frameElement as HTMLElement).closest(
            ".reader",
          )!.clientWidth - 40,
        right: rects.some((r) => r.x > width),
        localImport: getComputedStyle(el)
          .getPropertyValue("--local-import-loaded")
          .trim(),
      };
    });
  await expect
    .poll(async () => {
      const c = await columns();
      return c.width / c.viewport;
    })
    .toBeLessThan(0.55);
  expect((await columns()).right).toBe(true);
  expect((await columns()).localImport).toBe("yes");
  await expect(page.getByLabel("阅读进度百分比")).toHaveText(/^[\d.]+%$/);
  expect(
    await page.evaluate(() => (window as any).__createdBookResources),
  ).toBe(0);
  await expect
    .poll(() =>
      page
        .locator(".reader-epub")
        .evaluate((el) => el.scrollHeight - el.clientHeight),
    )
    .toBeLessThanOrEqual(2);
  await page.screenshot({ path: path.join(evidence, "two-page-epub.png") });
  await selectText(body.locator("p").first(), "阅读同一本书");
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await page.getByLabel("评论输入").fill("双页 EPUB 批注");
  await page.getByLabel("发送评论").click();
  await expect(page.locator(".note-body")).toContainText("双页 EPUB 批注");
  await page.getByTitle("收起讨论", { exact: true }).click();
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath.includes("双页阅读.epub")),
  );
  await expect
    .poll(
      async () => (await get(`/documents/${d.id}/reading-state`)).locator?.cfi,
    )
    .toContain("epubcfi(");
  const before = (await get(`/documents/${d.id}/reading-state`)).locator.cfi;
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect
    .poll(
      async () => (await get(`/documents/${d.id}/reading-state`)).locator?.cfi,
    )
    .not.toBe(before);
  await page.setViewportSize({ width: 800, height: 850 });
  await expect
    .poll(async () => {
      const c = await columns();
      return c.width / c.viewport;
    })
    .toBeGreaterThan(0.8);
  await page.reload();
  await expect(page.getByLabel("页面布局")).toHaveValue("double");
  await expect(body.locator("p").first()).toBeAttached();
  await page.getByTitle("展开讨论", { exact: true }).click();
  await expect(page.locator(".note-body")).toContainText("双页 EPUB 批注");
  await page.getByLabel("页面布局").selectOption("scroll");
  await page.getByTitle("收起讨论", { exact: true }).click();
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await page
    .locator(".outline")
    .getByRole("button", { name: "事务", exact: true })
    .click();
  const image = page
    .frameLocator(".epub-container iframe")
    .getByAltText("按需加载图片");
  await expect(image).toBeAttached();
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBe(2);
  expect(
    await page.evaluate(() => (window as any).__createdBookResources),
  ).toBe(1);
  await page.getByRole("button", { name: "文件", exact: true }).click();
});

test("EPUB first-paint and repeat-open measurements for an authorized local book", async ({
  page,
}) => {
  test.skip(
    !process.env.OR_REAL_EPUB,
    "Provide an authorized EPUB via OR_REAL_EPUB",
  );
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath.includes("用户EPUB验证.epub")),
  );
  const prepared = await post(`/documents/${d.documentId}/prepare`, {
    workspaceDocumentId: d.id,
    sourceEntryId: d.bindings[0].id,
  });
  const reset = await client.put(
    `${base}/api/documents/${d.id}/reading-state`,
    {
      headers: { "X-CSRF-Token": csrf },
      data: { versionId: prepared.version.id, locator: {} },
    },
  );
  expect(reset.ok()).toBe(true);
  const timings: any[] = [];
  for (let i = 0; i < 2; i++) {
    if (i) await openFile(page, "中文与Unicode.txt");
    const started = performance.now();
    await openFile(page, "用户EPUB验证.epub");
    const frame = page.frameLocator(".epub-container iframe");
    await expect(frame.locator("svg, img").first()).toBeVisible({
      timeout: 20000,
    });
    await frame
      .locator("image, img")
      .first()
      .evaluate(async (el) => {
        const image = new Image();
        image.src =
          el.getAttribute("src") ||
          el.getAttribute("href") ||
          el.getAttribute("xlink:href") ||
          "";
        await image.decode();
      });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const geometry = await frame.locator("body").evaluate((body) => {
      const graphic = body.querySelector("svg, img");
      const box = graphic?.getBoundingClientRect();
      return {
        width: box?.width,
        height: box?.height,
        writingMode: getComputedStyle(body).writingMode,
        bodyWidth: body.getBoundingClientRect().width,
        textLength: body.textContent?.trim().length,
      };
    });
    const elapsed = Math.round(performance.now() - started);
    timings.push({ open: i + 1, elapsedMs: elapsed, geometry });
    console.log("epub-first-paint", JSON.stringify(timings.at(-1)));
    await writeFile(
      path.join(evidence, "epub-open-timings.json"),
      JSON.stringify(
        {
          timings,
          scope:
            "Click to rendered first chapter/cover; authorized local file not redistributed",
        },
        null,
        2,
      ),
    );
    expect(geometry.width || 0).toBeGreaterThan(0);
    expect(geometry.height || 0).toBeGreaterThan(0);
  }
});

test("A07 real EPUB CFI highlight reprojects through typography and mode changes", async ({
  page,
}) => {
  await openFile(page, "可靠接口.epub");
  const frame = page.frameLocator(".epub-container iframe");
  await expect(frame.locator("p").first()).toContainText("幂等性意味着");
  await selectText(frame.locator("p").first(), "幂等性意味着重复执行同一操作");
  await expect(page.locator(".selection-toolbar")).toBeVisible();
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  // Exercise the parent-frame input with a real focus transition from the book.
  await page.getByLabel("评论输入").click();
  await page.getByLabel("评论输入").fill("EPUB 重排后仍应指向这句话");
  await expect(page.getByLabel("评论输入")).toHaveValue(
    "EPUB 重排后仍应指向这句话",
  );
  await page.getByLabel("发送评论").click();
  await expect(page.locator(".note-body")).toContainText("EPUB 重排");
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath.includes("可靠接口.epub")),
  );
  const initial = await get("/documents/" + d.id + "/threads");
  const cfi = initial[0].anchor.selectors.find(
    (s: any) => s.type === "epub",
  ).cfi;
  expect(cfi).toContain("epubcfi(");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("阅读字号").fill("24");
  await page.getByLabel("阅读行距").fill("2.3");
  await page.getByLabel("阅读字体").selectOption("serif");
  await page.getByLabel("EPUB 阅读模式").selectOption("paginated");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 1250, height: 900 });
  await page.waitForTimeout(500);
  await page.locator(".quote-button").first().click();
  await expect(page.locator(".note-body")).toContainText("EPUB 重排");
  await page.screenshot({ path: path.join(evidence, "06-epub-reflow.png") });
  await page.reload();
  await page.getByTitle("展开讨论", { exact: true }).click();
  await expect(page.locator(".note-body")).toContainText("EPUB 重排");
  const current = await get("/documents/" + d.id + "/threads");
  expect(
    current[0].anchor.selectors.find((s: any) => s.type === "epub").cfi,
  ).toBe(cfi);
  await writeFile(
    path.join(evidence, "epub-cfi.json"),
    JSON.stringify(
      {
        before: cfi,
        after: current[0].anchor.selectors.find((s: any) => s.type === "epub")
          .cfi,
        fontSize: 24,
        lineHeight: 2.3,
        fontFamily: "serif",
        flow: "paginated",
        width: 1250,
      },
      null,
      2,
    ),
  );
});
test("M3 context preview, explicit assistant, streaming and invalid citations", async ({
  page,
}) => {
  await openFile(page, "幂等性.md");
  await page.getByTitle("展开讨论", { exact: true }).click();
  if ((await page.locator(".thread-card").count()) === 0) {
    await selectText(
      page.locator(".prose"),
      "幂等性意味着重复执行同一操作，最终效果与执行一次相同。",
    );
    await page
      .locator(".selection-toolbar")
      .getByRole("button", { name: "评论", exact: true })
      .click();
    await page.getByLabel("评论输入").fill("助手验收原文笔记");
    await page.getByLabel("发送评论").click();
    await expect(page.locator(".note-body")).toBeVisible();
    await page.getByRole("button", { name: "全部批注", exact: true }).click();
  }
  await page
    .locator(".thread-actions")
    .getByRole("button", { name: "打开讨论", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "@ 小阅", exact: true }).click();
  await page.getByLabel("选择模型").selectOption(provider.id);
  await page.getByLabel("上下文范围").selectOption("selection");
  await page.getByLabel("评论输入").fill("用 Go 接口解释这段话");
  await page.getByRole("button", { name: "预览发送内容" }).click();
  await expect(
    page.getByRole("dialog", { name: "本次发送内容预览" }),
  ).toContainText("当前问题");
  await expect(page.getByRole("dialog")).toContainText("仅选段模式");
  await page.screenshot({
    path: path.join(evidence, "07-context-preview.png"),
  });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.route(
    "**/api/threads/*/messages",
    async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    },
    { times: 1 },
  );
  await page.getByLabel("发送评论").click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload();
  await page.getByTitle("展开讨论", { exact: true }).click();
  await expect(page.locator(".mock-badge")).toBeVisible();
  await page.reload();
  await page.getByTitle("展开讨论", { exact: true }).click();
  await expect(page.locator(".assistant-body")).toContainText("无效来源");
  await expect(
    page.locator(".citations button").filter({ hasText: "S999" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: path.join(evidence, "08-streaming-answer.png"),
  });
  await page.reload();
  await page.getByTitle("展开讨论", { exact: true }).click();
  await expect(page.locator(".assistant-body")).toContainText("无效来源");
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath.includes("幂等性.md")),
  );
  const threads = await get("/documents/" + d.id + "/threads");
  const runs = threads.flatMap((t: any) =>
    t.messages.filter((m: any) => m.run).map((m: any) => m.run),
  );
  const run = await get("/ai-runs/" + runs[runs.length - 1].id);
  expect(run.attempts).toHaveLength(1);
  expect(
    threads
      .flatMap((t: any) => t.messages)
      .filter((m: any) => m.body === "用 Go 接口解释这段话"),
  ).toHaveLength(1);
});
test("A18 malicious EPUB script, remote resources and URL protocols are blocked", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url()) && !r.url().startsWith(base))
      requests.push(r.url());
  });
  await openFile(page, "恶意内容测试.epub");
  const frame = page.frameLocator(".epub-container iframe");
  await expect(frame.locator("h1")).toContainText("安全章节");
  await expect(frame.locator("script")).toHaveCount(0);
  await expect(frame.locator("[onerror]")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).__EPUB_PWNED),
  ).toBeUndefined();
  expect(requests).toEqual([]);
  await page.screenshot({ path: path.join(evidence, "10-epub-safety.png") });
});
test("M5 500-page continuous PDF keeps bounded canvases and records observed process memory", async ({
  page,
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Process RSS sampling uses Chrome DevTools; core reading is covered separately",
  );
  const session = await browser.newBrowserCDPSession();
  const samples: any[] = [];
  const sample = async () => {
    const processes = await session.send("SystemInfo.getProcessInfo");
    const ids = processes.processInfo.map((p: any) => p.id);
    let rss = 0;
    try {
      rss = execFileSync("/bin/ps", ["-o", "rss=", "-p", ids.join(",")], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/)
        .reduce((sum, x) => sum + Number(x), 0);
    } catch {}
    samples.push({
      rssKB: rss,
      canvasCount: await page.locator(".pdf-page canvas").count(),
    });
  };
  const start = Date.now();
  await openFile(page, "500页按需加载.pdf");
  await expect(page.locator(".textLayer span").first()).toBeVisible();
  const firstOpen = Date.now() - start;
  await sample();
  for (const number of ["250", "500", "1"]) {
    await page.getByLabel("PDF 页码").fill(number);
    await expect(
      page.locator(
        `.pdf-page[data-page-index="${Number(number) - 1}"] .textLayer`,
      ),
    ).toContainText("page " + number);
    await sample();
    expect(await page.locator(".pdf-page canvas").count()).toBeLessThanOrEqual(
      5,
    );
  }
  await openFile(page, "中文与Unicode.txt");
  const cached = Date.now();
  await openFile(page, "500页按需加载.pdf");
  await expect(page.locator(".textLayer span").first()).toBeVisible();
  const cachedOpen = Date.now() - cached;
  await sample();
  await writeFile(
    path.join(evidence, "pdf-500-pages.json"),
    JSON.stringify(
      {
        pages: 500,
        firstOpenMs: firstOpen,
        cachedOpenMs: cachedOpen,
        observedPeakChromeRSSKB: Math.max(...samples.map((x) => x.rssKB)),
        sampling:
          "after first page and page changes; all processes of the test Chrome; observed samples, not a continuous OS peak",
        samples,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: path.join(evidence, "11-pdf-500.png") });
  await session.detach();
});
test("A19 browser backup download and fresh restore preview", async ({
  page,
}) => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "备份与恢复", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "创建完整备份", exact: true }).click();
  const download = await downloadPromise;
  const file = path.join(dataDir, "browser-backup.zip");
  await download.saveAs(file);
  await page.locator('input[type=file][accept=".zip"]').setInputFiles(file);
  await expect(page.locator(".restore-preview")).toContainText("哈希校验通过");
  await page.screenshot({ path: path.join(evidence, "09-backup-preview.png") });
});
test("M5 local HTTP and browser-visible note-save latency p95", async ({
  page,
  browserName,
}) => {
  await openFile(page, "中文与Unicode.txt");
  let d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath === "中文与Unicode.txt"),
  );
  let threads = await get("/documents/" + d.id + "/threads");
  if (!threads.length) {
    await selectText(page.locator(".plain-text"), "中文𠮷👩‍💻é");
    await page
      .locator(".selection-toolbar")
      .getByRole("button", { name: "评论", exact: true })
      .click();
    await page.getByLabel("评论输入").fill("保存延迟基准");
    await page.getByLabel("发送评论").click();
    await expect(page.locator(".note-body")).toBeVisible();
    threads = await get("/documents/" + d.id + "/threads");
  }
  const times: number[] = [];
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    await post("/threads/" + threads[0].threadId + "/messages", {
      message: { body: "保存延迟样本 " + i, recipient: "note" },
      clientRequestId: crypto.randomUUID(),
    });
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  await writeFile(
    path.join(evidence, "save-latency.json"),
    JSON.stringify(
      {
        samples: times.length,
        p95Ms: p95,
        minMs: times[0],
        maxMs: times.at(-1),
        scope:
          "local HTTP client through SQLite commit and response parsing; excludes React paint; no provider call",
      },
      null,
      2,
    ),
  );
  expect(p95).toBeLessThan(300);
  if (browserName === "chromium") {
    await page.reload();
    await expect(page.locator(".file-item")).toHaveCount(docs.length);
    await openFile(page, "中文与Unicode.txt");
    await page.getByTitle("展开讨论", { exact: true }).click();
    await expect(page.locator(".note-body").last()).toHaveText(
      "保存延迟样本 39",
    );
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          response
            .url()
            .includes(
              "/drafts/" + encodeURIComponent(d.id + ":" + threads[0].threadId),
            ),
      ),
      page
        .locator(".thread-actions")
        .getByRole("button", { name: "打开讨论", exact: true })
        .first()
        .click(),
    ]);
    await expect(page.getByLabel("评论输入")).toBeEnabled();
    const visibleTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const body = "可见保存反馈样本 " + i;
      await page.getByLabel("评论输入").fill(body);
      const started = performance.now();
      await page.getByLabel("发送评论").click();
      await expect(page.locator(".note-body").last()).toHaveText(body);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      visibleTimes.push(performance.now() - started);
    }
    visibleTimes.sort((a, b) => a - b);
    const visibleP95 = visibleTimes[Math.ceil(visibleTimes.length * 0.95) - 1];
    await writeFile(
      path.join(evidence, "save-visible-latency.json"),
      JSON.stringify(
        {
          samples: visibleTimes.length,
          p95Ms: visibleP95,
          minMs: visibleTimes[0],
          maxMs: visibleTimes.at(-1),
          scope:
            "Playwright click through SQLite commit, refreshed note body visible and two animation frames; includes automation overhead; no provider call",
        },
        null,
        2,
      ),
    );
    expect(visibleP95).toBeLessThan(300);
  }
});
test("A05 actual two-column paper preserves selected extraction and preview", async ({
  page,
}) => {
  test.skip(
    !process.env.OR_REAL_PDF,
    "Set OR_REAL_PDF to the PDF.js official demo PDF; source is not distributed",
  );
  await openFile(page, "真实双栏论文.pdf");
  await expect(
    page.locator('.pdf-page[data-page-index="0"] .textLayer'),
  ).toContainText("Dynamic languages");
  await page
    .locator('.pdf-page[data-page-index="0"] .textLayer')
    .evaluate((el) => {
      const spans = Array.from(el.querySelectorAll("span")).filter(
        (s) => s.firstChild?.nodeType === Node.TEXT_NODE,
      );
      const start = spans.findIndex((s) =>
        s.textContent?.includes("Dynamic languages such as JavaScript"),
      );
      if (start < 0) throw Error("real PDF selection unavailable");
      const range = document.createRange();
      range.setStart(spans[start].firstChild!, 0);
      range.setEnd(
        spans[start + 2].firstChild!,
        spans[start + 2].textContent!.length,
      );
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  await expect(page.locator(".selection-toolbar")).toBeVisible();
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  await page.getByLabel("评论输入").fill("公开双栏论文选区验证");
  await page.getByLabel("发送评论").click();
  await expect(page.locator(".note-body")).toContainText(
    "公开双栏论文选区验证",
  );
  const d = docs.find((d) =>
    d.bindings.some((b: any) => b.relativePath === "真实双栏论文.pdf"),
  );
  const threads = await get("/documents/" + d.id + "/threads");
  const anchor = threads[0].anchor;
  expect(anchor.quote.exact).not.toContain("and is used for the application");
  await page
    .locator(".thread-actions")
    .getByRole("button", { name: "继续讨论", exact: true })
    .click();
  await page.getByRole("button", { name: "@ 小阅", exact: true }).click();
  await page.getByLabel("选择模型").selectOption(provider.id);
  await page.getByLabel("上下文范围").selectOption("selection");
  await page.getByLabel("评论输入").fill("只预览，不向外部模型发送");
  await page.getByRole("button", { name: "预览发送内容" }).click();
  await expect(page.getByRole("dialog")).toContainText(anchor.quote.exact);
  await writeFile(
    path.join(evidence, "real-paper.json"),
    JSON.stringify(
      {
        source:
          "https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf",
        pages: 14,
        documentVersionId: anchor.documentVersionId,
        selectedCodepoints: Array.from(anchor.quote.exact).length,
        quads: anchor.selectors.find((s: any) => s.type === "pdf").quads.length,
        previewExactMatch: true,
        externalModelCalled: false,
        redistributed: false,
      },
      null,
      2,
    ),
  );
});

test("Markdown restores its position after a delayed image without overriding a subsequent seek", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1480, height: 650 });
  await openFile(page, "幂等性.md");
  const image = page.locator(".prose img");
  await expect
    .poll(() =>
      image.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
    )
    .toBe(true);
  // Establish the saved position through a user seek, which also ends the
  // initial automatic restoration while late fonts are still settling.
  await page
    .getByRole("slider", { name: "整本阅读进度", exact: true })
    .press("End");
  const member = docs.find((d: any) =>
    d.bindings.some((b: any) => b.relativePath.endsWith("幂等性.md")),
  );
  await expect
    .poll(
      async () =>
        (await get(`/documents/${member.id}/reading-state`)).locator
          ?.percentage,
    )
    .toBe(100);
  const heldResource = /\/api\/manifests\/[^/]+\/resource\?/;
  for (const seek of [false, true]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(heldResource, async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".prose")).toContainText("接口重试与幂等性");
      await expect(image).toHaveCount(1);
      if (seek) {
        await page
          .getByRole("slider", { name: "整本阅读进度", exact: true })
          .press("Home");
      }
      release();
      await expect
        .poll(() =>
          image.evaluate(
            (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
          ),
        )
        .toBe(true);
      await expect(page.getByLabel("阅读进度百分比")).toHaveText(
        seek ? "0%" : "100%",
      );
    } finally {
      release();
      await page.unroute(heldResource);
    }
  }
});

test("Typing or pasting @小阅 in a comment asks the assistant", async ({
  page,
}) => {
  await openFile(page, "幂等性.md");
  await selectText(
    page.locator(".prose"),
    "幂等性意味着重复执行同一操作，最终效果与执行一次相同。",
  );
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "评论", exact: true })
    .click();
  const input = page.getByLabel("评论输入");
  await input.fill("代码 `@小阅` 只是笔记");
  await expect(page.getByLabel("选择模型")).toHaveCount(0);
  await input.fill("@");
  await expect(page.getByLabel("选择模型")).toHaveCount(0);
  await input.pressSequentially("小阅 解释一下幂等性");
  await expect(page.getByLabel("选择模型")).toBeVisible();
  await expect(page.getByLabel("发送评论")).toBeDisabled();
  await page.getByLabel("选择模型").selectOption(provider.id);
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/threads") &&
      response.request().method() === "POST",
  );
  await page.getByLabel("发送评论").click();
  const response = await created;
  expect(response.ok()).toBeTruthy();
  const question = response.request().postDataJSON().message;
  expect(question.recipient).toBe("assistant");
  expect(question.body).toBe("@小阅 解释一下幂等性");
  expect(question.contextPackage).toBeTruthy();
  await expect(page.locator(".assistant-body")).toHaveCount(1);
  await expect(page.locator(".run-status span")).toHaveText("已完成");
  await expect(input).toHaveValue("");

  await page.getByRole("button", { name: "记笔记", exact: true }).click();
  await input.fill("再举一个例子 @ 小阅");
  await expect(page.getByLabel("选择模型")).toBeVisible();
  const replied = page.waitForResponse(
    (response) =>
      /\/api\/threads\/[^/]+\/messages$/.test(response.url()) &&
      response.request().method() === "POST",
  );
  await page.getByLabel("发送评论").click();
  const reply = await replied;
  expect(reply.ok(), await reply.text()).toBeTruthy();
  expect(reply.request().postDataJSON().message.recipient).toBe("assistant");
  await expect(page.locator(".assistant-body")).toHaveCount(2);
});

test("Deleting EPUB annotations clears their highlights immediately and after redisplay", async ({
  page,
}) => {
  const sourcePath = await mkdtemp(
    path.join(tmpdir(), "openreading-annotation-deletion-"),
  );
  await copyFile(
    "fixtures/可靠接口.epub",
    path.join(sourcePath, "标注删除.epub"),
  );
  const source = await post(`/workspaces/${workspace.id}/sources`, {
    path: sourcePath,
    label: "Highlight deletion",
  });
  await expect
    .poll(async () => (await get(`/scans/${source.scan.id}`)).state)
    .toBe("completed");
  docs = (await get(`/workspaces/${workspace.id}/documents`)).items;
  await page.reload();
  await openFile(page, "标注删除.epub");
  const paragraph = page
    .frameLocator(".epub-container iframe")
    .locator("p")
    .first();
  const create = async (quote: string) => {
    await selectText(paragraph, quote);
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/threads") && r.request().method() === "POST",
    );
    await page.getByTitle("保存划线", { exact: true }).click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBeTruthy();
    const { threadId } = await response.json();
    await expect(
      page.locator(`.epub-highlight[data-thread-id="${threadId}"]`).first(),
    ).toBeVisible();
    return threadId;
  };
  const kept = await create("幂等性意味着重复执行同一操作");
  const removed = await create("最终效果与执行一次相同");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTitle("删除批注", { exact: true }).click();
  await expect(page.locator(".thread-card")).toHaveCount(1);
  await expect(
    page.locator(`.epub-highlight[data-thread-id="${removed}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator(`.epub-highlight[data-thread-id="${kept}"]`).first(),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTitle("删除批注", { exact: true }).click();
  await expect(page.locator(".thread-card")).toHaveCount(0);
  await expect(page.locator(".epub-highlight")).toHaveCount(0);
  await page.getByLabel("页面布局").selectOption("double");
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await page
    .locator(".outline")
    .getByRole("button", { name: "事务", exact: true })
    .click();
  await expect(
    page.frameLocator(".epub-container iframe").locator("h1"),
  ).toContainText("事务");
  await page
    .locator(".outline")
    .getByRole("button", { name: "接口重试", exact: true })
    .click();
  await expect(paragraph).toContainText("幂等性意味着");
  await expect(page.locator(".epub-highlight")).toHaveCount(0);
  await page.reload();
  await expect(paragraph).toContainText("幂等性意味着");
  await expect(page.locator(".epub-highlight")).toHaveCount(0);
});
