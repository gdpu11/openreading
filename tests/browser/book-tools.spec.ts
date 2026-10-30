import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

test.use({ trace: "off", screenshot: "off" });
test("Native book conversion, original deletion, format filtering and reading estimates", async ({
  browser,
}) => {
  test.skip(process.platform !== "darwin");
  test.setTimeout(180000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-book-tools-"));
  const evidence = resolve("docs/evidence/book-tools");
  await mkdir(evidence, { recursive: true });
  const material = join(dir, "material");
  await mkdir(material);
  for (const name of ["双栏与扫描混合.pdf", "封面与正文.epub"])
    await copyFile(resolve("fixtures", name), join(material, name));
  await writeFile(join(material, "Estimate.txt"), "word ".repeat(18001));
  await writeFile(
    join(material, "Remove.txt"),
    "This file must remain after library removal",
  );
  await writeFile(
    join(material, "Delete.txt"),
    "Only this original may be deleted",
  );
  const originals = await Promise.all(
    ["双栏与扫描混合.pdf", "封面与正文.epub"].map(async (n) =>
      createHash("sha256")
        .update(await readFile(join(material, n)))
        .digest("hex"),
    ),
  );
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
    app.process().stderr?.on("data", (data: any) => {
      if (process.env.OR_DEBUG) console.log(String(data));
    });
    const library = await app.firstWindow();
    await library.waitForURL(/127.0.0.1/);
    await expect(
      library.getByRole("heading", { name: "Welcome to Open Reading." }),
    ).toBeVisible();
    await library.evaluate(async (sourcePath: string) => {
      const me = await (await fetch("/api/me")).json();
      const mutate = async (url: string, method: string, body: any) => {
        const response = await fetch("/api" + url, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": me.csrf,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return response.json();
      };
      const w = await mutate("/workspaces", "POST", { name: "Book tools" });
      await mutate("/preferences", "PUT", { language: "zh" });
      localStorage.setItem("open-reading-language", "zh");
      const s = await mutate(`/workspaces/${w.id}/sources`, "POST", {
        path: sourcePath,
        label: "Fixtures",
      });
      for (let i = 0; i < 150; i++) {
        const scan = await (await fetch(`/api/scans/${s.scan.id}`)).json();
        if (scan.state === "completed") return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw Error("scan timed out");
    }, material);
    await library.reload();
    const card = (name: string) =>
      library.locator(".library-book").filter({ hasText: name });
    await expect(library.locator(".library-book")).toHaveCount(5);
    const tools = library.locator(".library-tools");
    expect(
      await tools
        .locator(":scope > *")
        .evaluateAll((items: Element[]) =>
          items.map((item) =>
            item.tagName === "BUTTON"
              ? item.getAttribute("title")
              : item.querySelector("summary")?.getAttribute("aria-label") ||
                item.querySelector("summary")?.textContent?.trim(),
          ),
        ),
    ).toEqual(["刷新来源", "来源 1", "文件排序", "文件类型"]);

    let scans = 0;
    library.on("request", (request: any) => {
      if (
        request.method() === "POST" &&
        /\/sources\/[^/]+\/scan$/.test(request.url())
      )
        scans++;
    });
    const refresh = tools.getByTitle("刷新来源", { exact: true });
    await refresh.hover();
    expect(scans).toBe(0);
    const scanned = library.waitForRequest(
      (request: any) =>
        request.method() === "POST" &&
        /\/sources\/[^/]+\/scan$/.test(request.url()),
    );
    await refresh.click();
    await scanned;
    await expect(refresh).toBeEnabled();

    const hoverPanel = async (trigger: any, panel: any) => {
      await trigger.hover();
      await expect(panel).toBeVisible();
      await trigger.click();
      await expect(panel).toBeVisible();
      const box = await trigger.boundingBox();
      await library.mouse.move(box.x + box.width / 2, box.y + box.height + 4, {
        steps: 4,
      });
      await expect(panel).toBeVisible();
      await panel.hover();
      await expect(panel).toBeVisible();
      await library.mouse.move(0, 0);
      await expect(panel).toBeHidden();
    };
    await hoverPanel(
      tools.locator(".library-sources summary"),
      tools.locator(".library-sources-panel"),
    );
    const sort = library.getByLabel("文件排序", { exact: true });
    await hoverPanel(
      sort,
      library.getByRole("menu", { name: "文件排序方式", exact: true }),
    );
    const formatTrigger = tools.locator(".document-format-filter summary");
    const formatPanel = library.getByRole("menu", {
      name: "筛选文件类型",
      exact: true,
    });
    await hoverPanel(formatTrigger, formatPanel);
    await formatTrigger.focus();
    await formatTrigger.press("ArrowDown");
    await expect(
      library.getByRole("menuitemradio", { name: "全部格式", exact: true }),
    ).toBeFocused();
    await library.keyboard.press("End");
    await expect(
      library.getByRole("menuitemradio", { name: "Markdown", exact: true }),
    ).toBeFocused();
    await library.keyboard.press("Home");
    await library.keyboard.press("Escape");
    await expect(formatPanel).toBeHidden();
    await expect(formatTrigger).toBeFocused();
    await formatTrigger.press("Enter");
    await expect(formatPanel).toBeVisible();
    await formatTrigger.press("Shift+Tab");
    await expect(formatPanel).toBeHidden();

    const touch = await browser.newContext({
      hasTouch: true,
      viewport: { width: 1200, height: 900 },
      storageState: await library.context().storageState(),
    });
    try {
      await touch.addInitScript(() => {
        (window as any).openReadingDesktop = {
          readerTarget: null,
          setLanguage() {},
          onThread() {
            return () => {};
          },
          onClosing() {
            return () => {};
          },
        };
      });
      const page = await touch.newPage();
      await page.goto(library.url());
      const trigger = page.locator(".document-format-filter summary");
      await trigger.tap();
      await expect(
        page.getByRole("menu", { name: "筛选文件类型", exact: true }),
      ).toBeVisible();
      await page.getByRole("menuitemradio", { name: "PDF", exact: true }).tap();
      await expect(page.locator(".library-book")).toHaveCount(1);
      await expect(trigger).toContainText("PDF");
      await trigger.tap();
      await page.getByRole("heading", { name: "书库", exact: true }).tap();
      await expect(
        page.getByRole("menu", { name: "筛选文件类型", exact: true }),
      ).toBeHidden();
    } finally {
      await touch.close();
    }
    await sort.hover();
    await library.screenshot({
      path: join(evidence, "library-toolbar-hover.png"),
    });
    await library.mouse.move(0, 0);
    const format = async (name: string) => {
      await library.locator(".document-format-filter summary").hover();
      await library.getByRole("menuitemradio", { name, exact: true }).click();
    };
    await format("EPUB");
    await expect(library.locator(".library-book")).toHaveCount(1);
    await format("PDF");
    await expect(library.locator(".library-book")).toHaveCount(1);
    await format("TXT");
    await expect(library.locator(".library-book")).toHaveCount(3);
    await format("全部格式");
    let opening = app.waitForEvent("window");
    await card("Estimate.txt").click();
    let book = await opening;
    await expect(book.locator(".estimated-reading-time")).toHaveText(
      "预计阅读 1 小时 1 分钟",
    );
    await book.getByRole("button", { name: "阅读设置", exact: true }).click();
    const speed = book.getByLabel("阅读速度（字/词每分钟）", { exact: true });
    await speed.fill("600");
    await speed.press("Tab");
    await book.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(book.locator(".estimated-reading-time")).toHaveText(
      "预计阅读 31 分钟",
    );
    await app.evaluate(({ BrowserWindow }: any) =>
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        ?.close(),
    );
    const converted = async () => {
      const dialog = library.getByRole("dialog", { name: "转换书籍" });
      await Promise.race([
        dialog.waitFor({ state: "hidden", timeout: 60000 }),
        dialog
          .getByRole("alert")
          .waitFor({ state: "visible", timeout: 60000 })
          .then(async () => {
            throw Error(await dialog.getByRole("alert").textContent());
          }),
      ]);
    };
    const context = async (name: string, action: string) => {
      await card(name).click({ button: "right" });
      await library
        .getByRole("menu", { name: "书籍操作" })
        .getByRole("menuitem", { name: action, exact: true })
        .click();
    };
    await context("Remove.txt", "删除…");
    await expect(
      library.getByRole("radio", { name: /仅从当前书库移除/ }),
    ).toBeChecked();
    await library
      .getByRole("button", { name: "移出当前书库", exact: true })
      .click();
    await expect(card("Remove.txt")).toHaveCount(0);
    expect((await stat(join(material, "Remove.txt"))).isFile()).toBeTruthy();
    await context("Delete.txt", "删除…");
    await library.getByRole("radio", { name: /删除原始文件/ }).check();
    await expect(
      library.getByText("原始文件删除后，恢复书库不会还原原始文件。", {
        exact: true,
      }),
    ).toBeVisible();
    await library.screenshot({ path: join(evidence, "delete-options.png") });
    await library
      .getByRole("button", { name: "删除原始文件", exact: true })
      .click();
    await expect(card("Delete.txt")).toHaveCount(0);
    await expect(stat(join(material, "Delete.txt"))).rejects.toThrow();

    // Exercise the real native save and print handlers, replacing only the OS save panel.
    const outputPDF = join(dir, "converted.pdf");
    await app.evaluate(({ dialog }: any, output: string) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: output,
      });
    }, outputPDF);
    await context("封面与正文.epub", "转换为 PDF");
    await library
      .getByRole("button", { name: "开始转换", exact: true })
      .click();
    await converted();
    const pdf = await readFile(outputPDF);
    const parsed = await PDFDocument.load(pdf);
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(3);
    expect(pdf.toString("latin1")).toContain("/Subtype /Image");
    await writeFile(join(evidence, "converted.pdf"), pdf);
    opening = app.waitForEvent("window");
    await card("封面与正文.pdf").click();
    book = await opening;
    await expect(book.locator(".reader-status")).toHaveCount(0);
    await expect(book.locator(".pdf-page canvas").first()).toBeVisible();
    await book.getByLabel("PDF 页码", { exact: true }).fill("2");
    await book.getByLabel("PDF 页码", { exact: true }).press("Enter");
    await expect
      .poll(async () =>
        (
          await book
            .locator('.pdf-page[data-page-index="1"] .textLayer')
            .textContent()
        ).normalize("NFKC"),
      )
      .toContain("接口");
    await book.screenshot({ path: join(evidence, "converted-pdf.png") });
    const closing = book.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }: any) =>
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        ?.close(),
    );
    await closing;

    const outputEPUB = join(dir, "converted.epub");
    await app.evaluate(({ dialog }: any, output: string) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: output,
      });
    }, outputEPUB);
    await context("双栏与扫描混合.pdf", "转换为 EPUB");
    await library.getByLabel("转换方式", { exact: true }).selectOption("text");
    await library
      .getByRole("button", { name: "开始转换", exact: true })
      .click();
    await converted();
    let zip = await JSZip.loadAsync(await readFile(outputEPUB));
    expect(await zip.file("mimetype")!.async("string")).toBe(
      "application/epub+zip",
    );
    expect(await zip.file("EPUB/page-1.xhtml")!.async("string")).toContain(
      "Idempotency",
    );
    expect(await zip.file("EPUB/page-3.xhtml")!.async("string")).toContain(
      "Page three",
    );
    expect(zip.file("EPUB/images/page-2.jpg")).toBeTruthy();
    expect(zip.file("EPUB/images/page-1.jpg")).toBeNull();
    opening = app.waitForEvent("window");
    await card("双栏与扫描混合.epub").click();
    book = await opening;
    await expect(
      book.frameLocator(".epub-container iframe").locator("body"),
    ).toContainText("Idempotency");
    await expect(
      book.getByRole("slider", { name: "整本阅读进度" }),
    ).toBeEnabled();
    await book.screenshot({ path: join(evidence, "converted-epub.png") });
    const closeText = book.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }: any) =>
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        ?.close(),
    );
    await closeText;
    await context("双栏与扫描混合.epub", "删除…");
    await library
      .getByRole("button", { name: "移出当前书库", exact: true })
      .click();
    await expect(card("双栏与扫描混合.epub")).toHaveCount(0);
    // Image mode includes every original page and still supports book progress.
    await context("双栏与扫描混合.pdf", "转换为 EPUB");
    await library.getByLabel("转换方式", { exact: true }).selectOption("images");
    await library
      .getByRole("button", { name: "开始转换", exact: true })
      .click();
    await converted();
    zip = await JSZip.loadAsync(await readFile(outputEPUB));
    for (let i = 1; i <= 3; i++)
      expect(zip.file(`EPUB/images/page-${i}.jpg`)).toBeTruthy();
    await writeFile(
      join(evidence, "converted-images.epub"),
      await readFile(outputEPUB),
    );
    const imageCard = library
      .locator(".library-book")
      .filter({ hasText: "双栏与扫描混合.epub" })
      .last();
    opening = app.waitForEvent("window");
    await imageCard.click();
    book = await opening;
    await expect(book.locator(".estimated-reading-time")).toHaveText(
      "暂无文字，无法估算阅读时间",
    );
    await expect(
      book.getByRole("slider", { name: "整本阅读进度" }),
    ).toBeEnabled();
    await book.getByRole("button", { name: "下一节", exact: true }).click();
    await expect
      .poll(async () =>
        parseFloat(await book.getByLabel("阅读进度百分比").textContent()),
      )
      .toBeGreaterThan(0);
    await book.screenshot({ path: join(evidence, "image-epub-progress.png") });
    const after = await Promise.all(
      ["双栏与扫描混合.pdf", "封面与正文.epub"].map(async (n) =>
        createHash("sha256")
          .update(await readFile(join(material, n)))
          .digest("hex"),
      ),
    );
    expect(after).toEqual(originals);
    await library.screenshot({ path: join(evidence, "library-tools.png") });
    await library.evaluate(async () => {
      const me = await (await fetch("/api/me")).json();
      await fetch("/api/preferences", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": me.csrf,
        },
        body: JSON.stringify({ language: "en" }),
      });
      localStorage.setItem("open-reading-language", "en");
    });
    await library.reload();
    await expect(
      library.getByLabel("File type", { exact: true }),
    ).toBeVisible();
    await card("双栏与扫描混合.pdf").click({ button: "right" });
    await library
      .getByRole("menuitem", { name: "Convert to EPUB", exact: true })
      .click();
    await expect(
      library.getByRole("dialog", { name: "Convert book" }),
    ).toContainText("Keep original pages (images)");
    await library.getByRole("button", { name: "Cancel", exact: true }).click();
    await writeFile(
      join(evidence, "conversion-verification.json"),
      JSON.stringify(
        {
          pdfPages: parsed.getPageCount(),
          epubPages: 3,
          textAndImageModes: true,
          originalsUnchanged: true,
          deleteModes: true,
          filterFormats: ["pdf", "epub", "txt"],
          readingTime: true,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (app) {
      for (const page of app.windows())
        console.log(
          "DIAGNOSTIC",
          page.url(),
          await page
            .locator(".book-operation-dialog")
            .textContent({ timeout: 500 })
            .catch(() => ""),
        );
      console.log(
        "WINDOWS",
        await app.evaluate(({ BrowserWindow }: any) =>
          BrowserWindow.getAllWindows().map((w: any) => ({
            url: w.webContents.getURL(),
            loading: w.webContents.isLoading(),
          })),
        ),
      );
    }
    throw error;
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
