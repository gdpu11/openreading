import {
  test,
  expect,
  type Locator,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";

type Library = {
  process: ChildProcess;
  dir: string;
  url: string;
  context: BrowserContext;
  csrf: string;
  workspace: any;
};
async function library(browser: Browser): Promise<Library> {
  const dir = await mkdtemp(join(tmpdir(), "openreading-ord-browser-"));
  const service = spawn(
    resolve("release/ord-test-server"),
    ["--port", "0", "--data-dir", dir, "--machine-readable"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = await new Promise<any>((resolve, reject) => {
    let buffer = "";
    service.stdout!.on("data", (chunk) => {
      buffer += chunk;
      try {
        resolve(JSON.parse(buffer));
      } catch {}
    });
    service.once("exit", (code) => reject(Error("service exit " + code)));
    setTimeout(() => reject(Error("service timeout")), 10000).unref();
  });
  const context = await browser.newContext();
  const response = await context.request.post(ready.url + "/api/session", {
    data: { code: ready.code },
  });
  expect(response.status()).toBe(200);
  const csrf = (await response.json()).csrf;
  const workspace = await (
    await context.request.post(ready.url + "/api/workspaces", {
      headers: { "X-CSRF-Token": csrf },
      data: { name: "ORD 验收书库" },
    })
  ).json();
  return { process: service, dir, context, url: ready.url, csrf, workspace };
}
async function dispose(l: Library) {
  await l.context.close();
  const stopped = new Promise((r) => l.process.once("exit", r));
  l.process.kill("SIGTERM");
  await stopped;
  await rm(l.dir, { recursive: true, force: true });
}
async function selectText(locator: Locator, quote: string) {
  await locator.click({ position: { x: 5, y: 5 } });
  await locator.evaluate((el, quote) => {
    const doc = el.ownerDocument;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.data.includes(quote)) continue;
      const range = doc.createRange();
      const at = node.data.indexOf(quote);
      range.setStart(node, at);
      range.setEnd(node, at + quote.length);
      const selection = doc.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
    throw Error("quote not found " + quote);
  }, quote);
}

const books = [
  {
    name: "幂等性.md",
    selector: ".prose",
    quote: "幂等性意味着重复执行同一操作，最终效果与执行一次相同。",
  },
  { name: "中文与Unicode.txt", selector: ".plain-text", quote: "中文𠮷👩‍💻é" },
  {
    name: "双栏与扫描混合.pdf",
    selector: '.pdf-page[data-page-index="0"] .textLayer',
    quote: "Idempotency keeps retries safe.",
  },
  {
    name: "可靠接口.epub",
    selector: "epub",
    quote: "幂等性意味着重复执行同一操作",
  },
];
for (const book of books)
  test(`ORD ${book.name}: export, fresh-library import, original text and anchored notes`, async ({
    browser,
  }) => {
    test.setTimeout(90000);
    const sender = await library(browser),
      receiver = await library(browser);
    const artifactDir = await mkdtemp(
      join(tmpdir(), "openreading-ord-download-"),
    );
    try {
      const response = await sender.context.request.post(
        sender.url + "/api/workspaces/" + sender.workspace.id + "/sources",
        {
          headers: { "X-CSRF-Token": sender.csrf },
          data: { path: resolve("fixtures"), label: "合成测试书籍" },
        },
      );
      expect(response.status()).toBe(200);
      const source = await response.json();
      await expect
        .poll(
          async () =>
            (
              await (
                await sender.context.request.get(
                  sender.url + "/api/scans/" + source.scan.id,
                )
              ).json()
            ).state,
        )
        .toBe("completed");
      const page = await sender.context.newPage();
      await page.addInitScript(() =>
        localStorage.setItem("open-reading-language", "zh"),
      );
      await page.goto(sender.url);
      await page.locator(".file-item").filter({ hasText: book.name }).click();
      const content =
        book.selector === "epub"
          ? page.frameLocator(".epub-container iframe").locator("p").first()
          : page.locator(book.selector);
      await expect(content).toContainText(book.quote);
      await selectText(content, book.quote);
      await expect(page.locator(".selection-toolbar")).toBeVisible();
      await page
        .locator(".selection-toolbar")
        .getByRole("button", { name: "评论", exact: true })
        .click();
      const note =
        "ORD 学习笔记：" + book.name + "，导入之后仍能回到选中的原文。";
      await page.getByLabel("评论输入").fill(note);
      await page.getByLabel("发送评论").click();
      await expect(page.locator(".note-body")).toContainText(note);
      const downloadEvent = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "导出本书 ORD", exact: true })
        .click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toMatch(/\.ord$/);
      const file = join(artifactDir, download.suggestedFilename());
      await download.saveAs(file);
      const zip = await JSZip.loadAsync(await readFile(file));
      const packed = JSON.parse(await zip.file("book.json")!.async("string"));
      expect(packed.tables.annotations).toHaveLength(1);
      const original = packed.tables.versions.find(
        (v: any) => v.id === packed.versionId,
      );
      expect(
        Buffer.from(
          await zip.file("blobs/" + original.content_hash)!.async("uint8array"),
        ),
      ).toEqual(await readFile(resolve("fixtures", book.name)));
      const receivePage = await receiver.context.newPage();
      await receivePage.addInitScript(() =>
        localStorage.setItem("open-reading-language", "zh"),
      );
      await receivePage.goto(receiver.url);
      await receivePage
        .locator('input[type="file"][accept*=".ord"]')
        .setInputFiles(file);
      await expect(receivePage.getByRole("status")).toContainText("1 条标注");
      await receivePage
        .locator(".file-item")
        .filter({ hasText: book.name })
        .click();
      await receivePage.getByTitle("展开讨论", { exact: true }).click();
      await expect(receivePage.locator(".note-body")).toContainText(note);
      await receivePage.locator(".quote-button").first().click();
      const imported =
        book.selector === "epub"
          ? receivePage.frameLocator(".epub-container iframe").locator("body")
          : receivePage.locator(book.selector);
      await expect(imported).toContainText(book.quote);
      await expect(
        receivePage
          .locator(
            book.selector === "epub" ? ".epub-highlight" : ".annotation-mark",
          )
          .first(),
      ).toBeVisible();
      if (book.name.endsWith(".md")) {
        const image = receivePage.locator(".prose img");
        await expect
          .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
          .toBeGreaterThan(0);
      }
      await receivePage.reload();
      await receivePage.getByTitle("展开讨论", { exact: true }).click();
      await expect(receivePage.locator(".note-body")).toContainText(note);
      await expect(imported).toContainText(book.quote);
      await expect(
        receivePage
          .locator(
            book.selector === "epub" ? ".epub-highlight" : ".annotation-mark",
          )
          .first(),
      ).toBeVisible();
      const evidence = resolve(
        process.env.OR_ORD_EVIDENCE_DIR || "docs/evidence/ord",
      );
      await mkdir(evidence, { recursive: true });
      await receivePage.screenshot({
        path: join(evidence, book.name + ".png"),
      });
      const docs = await (
        await receiver.context.request.get(
          receiver.url +
            "/api/workspaces/" +
            receiver.workspace.id +
            "/documents",
        )
      ).json();
      expect(docs.items).toHaveLength(1);
      expect(docs.items[0].id).not.toBe(packed.workspaceDocumentId);
    } finally {
      await Promise.all([dispose(sender), dispose(receiver)]);
      await rm(artifactDir, { recursive: true, force: true });
    }
  });
