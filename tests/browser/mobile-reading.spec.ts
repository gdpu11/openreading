import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
let service: ChildProcess, base: string, dir: string, fixture: Buffer;
test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "openreading-mobile-reading-"));
  service = spawn(
    resolve(process.env.OR_TEST_BINARY || "release/openreading"),
    ["--port", "0", "--data-dir", dir, "--machine-readable"],
  );
  base = await new Promise<string>((done, reject) => {
    let output = "";
    service.stdout!.on("data", (chunk) => {
      output += chunk;
      try {
        done(JSON.parse(output.trim()).url);
      } catch {}
    });
    service.once("error", reject);
    service.once("exit", () => reject(Error("Test server exited")));
  });
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
  );
  zip.file(
    "book.opf",
    '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">mobile-reading</dc:identifier><dc:title>手机排版测试</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="toc"><itemref idref="one"/><itemref idref="two"/></spine></package>',
  );
  zip.file(
    "toc.ncx",
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="one"><navLabel><text>第一章</text></navLabel><content src="one.xhtml"/></navPoint><navPoint id="two"><navLabel><text>第二章</text></navLabel><content src="two.xhtml"/></navPoint></navMap></ncx>',
  );
  for (const [name, title] of [
    ["one", "第一章"],
    ["two", "第二章"],
  ]) {
    zip.file(
      `${name}.xhtml`,
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><style>body {margin:0 5pt;padding:0;} .publisher {line-height:1.3;} .publisher span {line-height:1.2 !important;}</style></head><body><h1>${title}</h1>` +
        Array.from(
          { length: 60 },
          (_, i) =>
            `<p class="publisher" style="line-height: 21px !important"><span>第 ${i + 1} 段。${"手机阅读应当按屏翻页，保留章节位置，字号和行距由读者选择。".repeat(6)}</span></p>`,
        ).join("") +
        "</body></html>",
    );
  }
  fixture = await zip.generateAsync({ type: "nodebuffer" });
});
test.afterAll(async () => {
  service?.kill("SIGINT");
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function openBook(
  page: Page,
  bytes = fixture,
  title = "手机排版测试.epub",
) {
  await page.addInitScript(() =>
    localStorage.setItem("open-reading-language", "zh"),
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  await page.route("**/test-book.epub", (route) =>
    route.fulfill({ body: bytes, contentType: "application/epub+zip" }),
  );
  await page.goto(base + "/mobile");
  await expect(page.locator(".mobile-tabbar")).toBeVisible();
  await page.evaluate(
    async ({ hash, title }) => {
      const blob = await (await fetch("/test-book.epub")).blob();
      const db = await new Promise<IDBDatabase>((done, reject) => {
        const r = indexedDB.open("open-reading-mobile", 1);
        r.onsuccess = () => done(r.result);
        r.onerror = () => reject(r.error);
      });
      const version = { id: "version", contentHash: hash, size: blob.size };
      await new Promise<void>((done, reject) => {
        const tx = db.transaction("data", "readwrite"),
          store = tx.objectStore("data");
        store.put(blob, "blob:" + hash);
        store.put(
          {
            library: {
              workspaces: [
                {
                  id: "workspace",
                  name: "阅读测试",
                  documents: [
                    {
                      id: "book",
                      workspaceDocumentId: "book",
                      workspaceId: "workspace",
                      title,
                      format: "epub",
                      version,
                      versions: [version],
                      threads: [],
                      manifests: [],
                    },
                  ],
                },
              ],
            },
            outbox: [],
            drafts: {},
            bookPreferences: {
              book: { epubFlow: "scrolled-doc", fontSize: 18, lineHeight: 1.9 },
            },
          },
          "state",
        );
        tx.oncomplete = () => done();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { hash, title },
  );
  await page.reload();
  await page.locator(".mobile-document").first().click();
  await expect(page.locator(".reader-status")).toHaveCount(0);
  await expect(page.locator(".epub-container iframe")).toBeVisible();
}
const body = (page: Page) =>
  page.frameLocator(".epub-container iframe").locator("body");
const stage = (page: Page) =>
  page.locator(".reader-epub > .epub-container > .epub-container");
async function settings(page: Page) {
  if (
    (await page.locator(".mobile-app").getAttribute("data-chrome-visible")) ===
    "false"
  )
    await page
      .locator(".mobile-reader-wrap .reader")
      .tap({ position: { x: 195, y: 4 } });
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
}
async function ratio(page: Page) {
  return body(page).evaluate((el) => {
    const paragraph = [...el.querySelectorAll("p")].find(
      (p) => (p.textContent?.length || 0) > 80,
    )!;
    const s = getComputedStyle(paragraph),
      span = getComputedStyle(paragraph.querySelector("span") || paragraph);
    return {
      paragraph: parseFloat(s.lineHeight) / parseFloat(s.fontSize),
      span: parseFloat(span.lineHeight) / parseFloat(span.fontSize),
    };
  });
}

test("phone line spacing overrides publisher rules and leaves a single horizontal gutter in both flows", async ({
  page,
}) => {
  await openBook(page);
  await settings(page);
  for (const [label, height] of [
    ["紧凑", 1.6],
    ["宽松", 2.2],
    ["标准", 1.9],
  ] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect
      .poll(async () => (await ratio(page)).paragraph)
      .toBeCloseTo(height, 2);
    await expect
      .poll(async () => (await ratio(page)).span)
      .toBeCloseTo(height, 2);
  }
  await page.getByRole("button", { name: "关闭阅读设置", exact: true }).click();
  const gutter = async () => {
    const frame = (await page.locator(".epub-container iframe").boundingBox())!;
    return body(page).evaluate((el, x) => {
      const box = el.querySelector("p")!.getBoundingClientRect();
      return { left: x + box.left, right: 390 - x - box.right };
    }, frame.x);
  };
  for (const flow of ["上下滚动", "左右翻页"]) {
    await settings(page);
    await page.getByRole("button", { name: flow, exact: true }).click();
    await page
      .getByRole("button", { name: "关闭阅读设置", exact: true })
      .click();
    await expect
      .poll(async () => Math.max(...Object.values(await gutter())))
      .toBeLessThanOrEqual(24);
    expect(Math.min(...Object.values(await gutter()))).toBeGreaterThanOrEqual(
      12,
    );
  }
});

test("phone edge taps, swipes and page controls scroll within the chapter before advancing", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "The native swipe sequence uses Chromium CDP",
  );
  await openBook(page);
  await expect(
    body(page).getByRole("heading", { name: "第一章", exact: true }),
  ).toBeAttached();
  await page.touchscreen.tap(30, 400);
  expect(await stage(page).evaluate((el) => el.scrollTop)).toBe(0);
  // Let the no-op boundary navigation leave the rendition queue before the
  // next gesture; user gestures are separated by a rendered frame too.
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  await page.touchscreen.tap(360, 400);
  await expect
    .poll(() => stage(page).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(300);
  await expect(
    body(page).getByRole("heading", { name: "第一章", exact: true }),
  ).toBeAttached();
  const first = await stage(page).evaluate((el) => el.scrollTop);
  await page.touchscreen.tap(30, 400);
  await expect
    .poll(() => stage(page).evaluate((el) => el.scrollTop))
    .toBeLessThan(first - 300);
  const touch = await context.newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 330, y: 400 }],
  });
  for (const x of [280, 230, 180, 130, 80])
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: 400 }],
    });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await touch.detach();
  await expect
    .poll(() => stage(page).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(300);
  const swiped = await stage(page).evaluate((el) => el.scrollTop);
  await page.touchscreen.tap(195, 400);
  await page.getByRole("button", { name: "下一页或章节", exact: true }).click();
  await expect
    .poll(() => stage(page).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(swiped + 300);
  await expect(
    body(page).getByRole("heading", { name: "第一章", exact: true }),
  ).toBeAttached();
  await stage(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.getByRole("button", { name: "下一页或章节", exact: true }).click();
  await expect(
    body(page).getByRole("heading", { name: "第二章", exact: true }),
  ).toBeAttached();
  await page.getByRole("button", { name: "上一页或章节", exact: true }).click();
  await expect(
    body(page).getByRole("heading", { name: "第一章", exact: true }),
  ).toBeAttached();
  await expect
    .poll(() =>
      stage(page).evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(4);
  await page.getByRole("button", { name: "下一页或章节", exact: true }).click();
  await expect(
    body(page).getByRole("heading", { name: "第二章", exact: true }),
  ).toBeAttached();
  await settings(page);
  await page.getByRole("button", { name: "左右翻页", exact: true }).click();
  await page.getByRole("button", { name: "关闭阅读设置", exact: true }).click();
  await expect
    .poll(() => stage(page).evaluate((el) => el.scrollWidth / el.clientWidth))
    .toBeGreaterThan(2);
  const pageNumber = page.locator(".reader-page-number");
  const beforePage = await pageNumber.textContent();
  await page.touchscreen.tap(360, 400);
  await expect.poll(() => pageNumber.textContent()).not.toBe(beforePage);
  await expect(
    body(page).getByRole("heading", { name: "第二章", exact: true }),
  ).toBeAttached();
  await page.touchscreen.tap(30, 400);
  await expect(pageNumber).toHaveText(beforePage!);
});

test("authorized local phone EPUB respects spacing and keeps right-edge turns inside its long chapter", async ({
  page,
}) => {
  test.skip(
    !process.env.OR_MOBILE_REAL_EPUB,
    "Provide an authorized local book",
  );
  await openBook(
    page,
    await readFile(process.env.OR_MOBILE_REAL_EPUB!),
    "本机书籍.epub",
  );
  await page.touchscreen.tap(195, 400);
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await page
    .locator(".book-tools-panel")
    .getByRole("button", {
      name: process.env.OR_MOBILE_REAL_CHAPTER || "前言",
      exact: true,
    })
    .click();
  await expect(page.locator(".book-tools-panel")).toHaveCount(0);
  await expect(page.locator(".mobile-app")).toHaveAttribute(
    "data-chrome-visible",
    "false",
  );
  await expect
    .poll(() => stage(page).evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(2000);
  await settings(page);
  await page.getByRole("button", { name: "宽松", exact: true }).click();
  await expect
    .poll(async () => (await ratio(page)).paragraph)
    .toBeCloseTo(2.2, 2);
  await page.getByRole("button", { name: "关闭阅读设置", exact: true }).click();
  const before = await body(page).innerText();
  await page.touchscreen.tap(360, 400);
  await expect
    .poll(() => stage(page).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(300);
  expect(await body(page).innerText()).toBe(before);
  if (process.env.OR_EVIDENCE_DIR) {
    await mkdir(process.env.OR_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: join(process.env.OR_EVIDENCE_DIR, "phone-epub-spacing.png"),
    });
  }
});
