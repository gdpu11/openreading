import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
let service: ChildProcess, base: string, code: string, data: string;
const evidence = path.resolve("docs/evidence/language-copy");
async function select(page: Page, quote: string) {
  const p = page.frameLocator(".epub-container iframe").locator("p").first();
  await p.click();
  await p.evaluate((el, quote) => {
    const node = el.firstChild!;
    const start = node.textContent!.indexOf(quote);
    const r = el.ownerDocument.createRange();
    r.setStart(node, start);
    r.setEnd(node, start + quote.length);
    const s = el.ownerDocument.defaultView!.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, quote);
}
test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  data = await mkdtemp(path.join(tmpdir(), "openreading-language-"));
  await new Promise<void>((resolve, reject) => {
    let output = "";
    service = spawn(path.resolve("release/openreading"), [
      "--data-dir",
      data,
      "--port",
      "0",
      "--machine-readable",
    ]);
    service.stdout!.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n")) {
        try {
          const ready = JSON.parse(line);
          if (ready.type === "ready") {
            base = ready.url;
            code = ready.code;
            resolve();
            return;
          }
        } catch {}
      }
    });
    service.once("error", reject);
    service.once("exit", (status) => {
      if (status) reject(Error("Service exited: " + status));
    });
  });
});
test.afterAll(() => service?.kill("SIGINT"));
test("English default, persistent language settings, untouched book/notes and copy feedback", async ({
  page,
  context,
}) => {
  await page.goto(base);
  await expect(page.getByLabel("Local pairing code")).toBeVisible();
  await expect(page.getByLabel("Language / 语言")).toHaveValue("en");
  await page.getByLabel("Local pairing code").fill(code);
  await page
    .getByRole("button", { name: "Enter reading space", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome to Open Reading." }),
  ).toBeVisible();
  const material = path.join(data, "test-material");
  await mkdir(material);
  await writeFile(
    path.join(material, "界面与原文.md"),
    "# 设置\n\n文件\n\n复制选段\n\n这是一段用户自己的内容，不应该翻译。\n",
  );
  await copyFile(
    "fixtures/可靠接口.epub",
    path.join(material, "可靠接口.epub"),
  );
  await page.evaluate(
    async ({ material }) => {
      const me = await (await fetch("/api/me")).json();
      const headers = {
        "Content-Type": "application/json",
        "X-CSRF-Token": me.csrf,
      };
      const w = await (
        await fetch("/api/workspaces", {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "我的中文书库" }),
        })
      ).json();
      const s = await (
        await fetch(`/api/workspaces/${w.id}/sources`, {
          method: "POST",
          headers,
          body: JSON.stringify({ path: material, label: "测试资料" }),
        })
      ).json();
      for (let i = 0; i < 100; i++) {
        const job = await (await fetch("/api/scans/" + s.scan.id)).json();
        if (job.state === "completed") return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw Error("Scan timeout");
    },
    { material },
  );
  await page.reload();
  await page.locator(".file-item").filter({ hasText: "界面与原文.md" }).click();
  await expect(page.locator(".prose h1")).toHaveText("设置");
  await expect(page.locator(".prose")).toContainText("文件");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reading preferences", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".modal")).toContainText("Pure white · Light");
  await page.screenshot({ path: path.join(evidence, "english-settings.png") });
  await page.getByLabel("Language / 语言").selectOption("zh");
  await expect(
    page.getByRole("button", { name: "阅读偏好", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (await fetch("/api/preferences")).json()).language,
      ),
    )
    .toBe("zh");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeVisible();
  await page.locator(".file-item").filter({ hasText: "可靠接口.epub" }).click();
  const quote = "幂等性意味着重复执行同一操作";
  await expect(page.locator(".reader-status")).toHaveCount(0);
  await select(page, quote);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: base,
  });
  await page.getByTitle("复制选段", { exact: true }).click();
  await expect(page.locator(".toast")).toHaveText("已复制选段");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(quote);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("Language / 语言").selectOption("en");
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (await fetch("/api/preferences")).json()).language,
      ),
    )
    .toBe("en");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await select(page, quote);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByLabel("Comment input").fill("设置：这是我的中文笔记");
  await page.getByLabel("Send comment").click();
  await expect(page.locator(".note-body")).toHaveText("设置：这是我的中文笔记");
  await page.screenshot({
    path: path.join(evidence, "english-reader-user-content.png"),
  });
  // Clipboard API rejection must fall back to the selected-text copy, and a
  // refusal by both mechanisms must show a failure instead of a false success.
  await page.locator(".toast").waitFor({ state: "hidden" });
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(Error("Test denied")),
    });
  });
  await select(page, quote);
  await page.getByTitle("Copy selection", { exact: true }).click();
  await expect(page.locator(".toast")).toHaveText("Selection copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(quote);
  await page.locator(".toast").waitFor({ state: "hidden" });
  await page.evaluate(() => {
    document.execCommand = () => false;
  });
  await select(page, quote);
  await page.getByTitle("Copy selection", { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Copy failed");
  await expect(page.locator(".toast")).toHaveCount(0);
  expect(await page.pageErrors()).toEqual([]);
});
