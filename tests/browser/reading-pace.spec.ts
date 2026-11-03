import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";

test("measures actual text advancement, learns personal speed after an hour and shows totals", async ({
  page,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(15000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-personal-pace-"));
  let service: ChildProcess | undefined;
  try {
    const material = join(dir, "books");
    await mkdir(material);
    const paragraphs = Array.from(
      { length: 100 },
      (_, i) =>
        `第${i + 1}段。${"阅读需要按自己的节奏继续，统计真实经过的文字而不是跳过的内容。".repeat(10)}`,
    );
    await writeFile(join(material, "阅读速度.txt"), paragraphs.join("\n\n"));
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file(
      "META-INF/container.xml",
      '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
    );
    zip.file(
      "book.opf",
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">pace</dc:identifier><dc:title>阅读速度 EPUB</dc:title></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>',
    );
    zip.file(
      "one.xhtml",
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>阅读速度</title></head><body>' +
        paragraphs.map((p) => `<p>${p}</p>`).join("") +
        "</body></html>",
    );
    await writeFile(
      join(material, "阅读速度.epub"),
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    service = spawn(
      resolve(process.env.OR_TEST_BINARY || "release/openreading"),
      ["--data-dir", join(dir, "data"), "--port", "0"],
    );
    const { code, base } = await new Promise<{ code: string; base: string }>(
      (done, reject) => {
        let out = "";
        const read = (chunk: Buffer) => {
          out += chunk;
          const code = out.match(/配对码：([a-f0-9]+)/)?.[1],
            base = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (code && base) done({ code, base });
        };
        service!.stdout!.on("data", read);
        service!.stderr!.on("data", read);
        service!.once("error", reject);
        service!.once("exit", () => reject(Error("test service exited")));
      },
    );
    await page.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await page.clock.install();
    await page.goto(base);
    await page.getByLabel("本机配对码").fill(code);
    await page.getByRole("button", { name: /进入阅读空间/ }).click();
    const csrf = (await (await page.request.get(base + "/api/me")).json()).csrf;
    const post = async (path: string, body: unknown) => {
      const r = await page.request.post(base + "/api" + path, {
        data: body,
        headers: { "X-CSRF-Token": csrf },
      });
      expect(r.ok(), await r.text()).toBeTruthy();
      return r.json();
    };
    const get = async (path: string) =>
      (await page.request.get(base + "/api" + path)).json();
    const workspace = await post("/workspaces", { name: "自动阅读速度" });
    const source = await post(`/workspaces/${workspace.id}/sources`, {
      path: material,
      label: "阅读测试",
    });
    await expect
      .poll(async () => (await get(`/scans/${source.scan.id}`)).state)
      .toBe("completed");
    await page.reload();
    await page
      .locator(".file-item")
      .filter({ hasText: "阅读速度.txt" })
      .click();
    await expect(page.locator(".reader-status")).toHaveCount(0);
    await expect(page.getByLabel("当前阅读速度")).toContainText("300");
    await page.evaluate(() => {
      document.documentElement.dataset.readingSystemActive = "true";
      window.dispatchEvent(new Event("openreading-system-state"));
    });
    await page.clock.runFor(21000);
    await page.locator(".reader").evaluate((el) => {
      el.scrollTo({
        top: el.scrollTop + el.clientHeight * 0.6,
        behavior: "instant",
      });
    });
    await page.clock.runFor(1500);
    await expect
      .poll(async () => (await get("/reading/pace")).words)
      .toBeGreaterThan(0);
    const measured = await get("/reading/pace");
    expect(measured.learned).toBe(false);
    expect(measured.speed).toBe(300);
    const beforeSeek = measured.words;
    const progress = page.getByRole("slider", { name: "整本阅读进度" });
    const progressBounds = (await progress.boundingBox())!;
    await progress.click({
      position: { x: progressBounds.width * 0.9, y: progressBounds.height / 2 },
    });
    await page.clock.runFor(2000);
    expect((await get("/reading/pace")).words).toBe(beforeSeek);
    const docs = (await get(`/workspaces/${workspace.id}/documents`)).items;
    const member = docs.find((d: any) => d.format === "txt").id;
    const start = Date.now() - 3 * 3600000;
    const samples = Array.from({ length: 59 }, (_, i) => ({
      id: crypto.randomUUID(),
      member,
      startedAt: start + i * 60000,
      endedAt: start + (i + 1) * 60000,
      words: 500,
    }));
    await post("/reading/events", { events: samples });
    expect((await get("/reading/pace")).learned).toBe(false);
    await post("/reading/events", {
      events: [
        {
          id: crypto.randomUUID(),
          member,
          startedAt: start + 59 * 60000,
          endedAt: start + 60 * 60000,
          words: 500,
        },
      ],
    });
    const learned = await get("/reading/pace");
    expect(learned.learned).toBe(true);
    await page.clock.runFor(16000);
    await expect(page.getByLabel("当前阅读速度")).toContainText(
      String(learned.speed),
    );
    await page.getByRole("button", { name: "阅读数据", exact: true }).click();
    await expect(page.getByTestId("reading-speed")).toContainText(
      String(learned.speed),
    );
    await expect(page.getByTestId("reading-words")).toContainText(
      learned.words.toLocaleString("zh-CN"),
    );
    await page.screenshot({
      path: "/private/tmp/openreading-personal-pace-stats.png",
    });
    await page
      .getByRole("button", { name: "关闭阅读数据", exact: true })
      .click();
    await page
      .locator(".file-item")
      .filter({ hasText: "阅读速度.epub" })
      .click();
    await expect(page.locator(".reader-status")).toHaveCount(0);
    await expect(
      page.frameLocator(".epub-container iframe").locator("body"),
    ).toContainText("阅读需要");
    await expect(page.getByLabel("当前阅读速度")).toContainText(
      String(learned.speed),
    );
    await page.getByLabel("页面布局", { exact: true }).selectOption("single");
    await page.locator(".reader").click({ position: { x: 12, y: 12 } });
    // A full desktop CJK page contains far more text than the partial TXT
    // scroll above; give it a plausible dwell instead of simulating skimming.
    await page.clock.runFor(65000);
    await page.keyboard.press("ArrowRight");
    await page.clock.runFor(1500);
    const epubMember = docs.find((d: any) => d.format === "epub").id;
    await expect
      .poll(async () =>
        (await get(`/reading/documents/${epubMember}`)).events.some(
          (e: any) => e.words > 0,
        ),
      )
      .toBe(true);
  } finally {
    service?.kill("SIGINT");
    if (service && service.exitCode === null)
      await new Promise<void>((done) => service!.once("exit", () => done()));
    await rm(dir, { recursive: true, force: true });
  }
});
