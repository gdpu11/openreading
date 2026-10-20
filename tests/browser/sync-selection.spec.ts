import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.use({ trace: "off", screenshot: "off" });
test("desktop selects file types and individual files, and updates an existing phone without pairing again", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-sync-selection-"));
  const code = "a".repeat(64);
  const service = spawn(
    resolve("desktop/runtime/openreading"),
    [
      "--port",
      "0",
      "--data-dir",
      dir,
      "--machine-readable",
      "--public-url",
      "https://reader.example.invalid",
    ],
    {
      env: { ...process.env, OPENREADING_ACCESS_CODE: code },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const pc = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const base = await new Promise<string>((done, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(Error("Service startup timed out")),
        10000,
      );
      service.stdout.on("data", (chunk) => {
        output += chunk;
        try {
          const ready = JSON.parse(output.trim());
          clearTimeout(timeout);
          done(ready.url);
        } catch {}
      });
      service.once("error", reject);
      service.once("exit", () => {
        clearTimeout(timeout);
        reject(Error("Service exited"));
      });
    });
    const login = await pc.request.post(base + "/api/session", {
      data: { code },
    });
    expect(login.status()).toBe(200);
    const headers = { "X-CSRF-Token": (await login.json()).csrf };
    const ws = await (
      await pc.request.post(base + "/api/workspaces", {
        headers,
        data: { name: "同步选择验收" },
      })
    ).json();
    const other = await (
      await pc.request.post(base + "/api/workspaces", {
        headers,
        data: { name: "另一个工作区" },
      })
    ).json();
    for (const [name, bytes] of [
      ["可靠接口.epub", await readFile("fixtures/可靠接口.epub")],
      ["双栏与扫描混合.pdf", await readFile("fixtures/双栏与扫描混合.pdf")],
      ["文字.txt", Buffer.from("文本内容")],
      ["笔记.md", Buffer.from("# Markdown 笔记")],
    ] as const) {
      const response = await pc.request.post(
        base + "/api/workspaces/" + ws.id + "/imports",
        {
          headers,
          multipart: {
            files: {
              name,
              mimeType: "application/octet-stream",
              buffer: bytes,
            },
          },
        },
      );
      expect(response.status()).toBe(200);
    }
    await pc.request.post(base + "/api/workspaces/" + other.id + "/imports", {
      headers,
      multipart: {
        files: {
          name: "其他.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("其他工作区"),
        },
      },
    });
    const page = await pc.newPage();
    await page.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await page.goto(base);
    await page
      .getByRole("button", { name: "设置", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "手机与同步", exact: true }).click();
    const picker = page.locator(".sync-scope").first();
    await expect(picker).toContainText("当前选中 5 个文件");
    await picker.getByLabel("另一个工作区", { exact: true }).uncheck();
    await picker.getByLabel("文件选择方式").selectOption("formats");
    await picker.getByLabel("TXT", { exact: true }).uncheck();
    await picker.getByLabel("Markdown", { exact: true }).uncheck();
    await expect(picker).toContainText("当前选中 2 个文件");
    const grantResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pair/grants") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "生成手机配对二维码", exact: true })
      .click();
    const grant = await (await grantResponse).json();
    const token = "b".repeat(64);
    const phoneHeaders = {
      Authorization: "Bearer " + token,
      Origin: "capacitor://localhost",
    };
    const claim = await pc.request.post(base + "/api/pair/claim", {
      headers: phoneHeaders,
      data: { id: grant.id, secret: grant.secret, token, name: "选择同步手机" },
    });
    expect(claim.status()).toBe(200);
    await page
      .getByRole("button", { name: "确认授权此设备", exact: true })
      .click();
    await expect(
      page.getByText("已授权。请在手机上下载并同步。"),
    ).toBeVisible();
    const readLibrary = async () => {
      const response = await pc.request.get(base + "/api/sync/library", {
        headers: phoneHeaders,
      });
      expect(response.status()).toBe(200);
      return (await response.json()).workspaces.flatMap(
        (w: any) => w.documents,
      );
    };
    expect((await readLibrary()).map((d: any) => d.format).sort()).toEqual([
      "epub",
      "pdf",
    ]);
    await page
      .getByRole("button", { name: "修改同步范围", exact: true })
      .click();
    const editor = page.locator(".device-scope-editor");
    await expect(editor.getByLabel("文件选择方式")).toHaveValue("formats");
    await expect(editor.getByLabel("PDF", { exact: true })).toBeChecked();
    await editor.getByLabel("文件选择方式").selectOption("manual");
    const save = editor.getByRole("button", {
      name: "保存同步范围",
      exact: true,
    });
    await expect(save).toBeDisabled();
    await editor.getByLabel("筛选文件类型").selectOption("epub");
    await editor
      .getByRole("button", { name: "勾选当前列表", exact: true })
      .click();
    await expect(editor).toContainText("当前选中 1 个文件");
    await editor.getByLabel("筛选文件类型").selectOption("");
    await editor.getByLabel("搜索同步文件").fill("文字");
    await editor
      .getByRole("button", { name: "勾选当前列表", exact: true })
      .click();
    await expect(editor).toContainText("当前选中 2 个文件");
    await editor
      .getByRole("button", { name: "取消勾选当前列表", exact: true })
      .click();
    await expect(editor).toContainText("当前选中 1 个文件");
    await save.click();
    await expect(
      page.getByText("同步范围已保存，下次手机同步时生效。"),
    ).toBeVisible();
    const manual = await readLibrary();
    expect(manual).toHaveLength(1);
    expect(manual[0].title).toContain("可靠接口.epub");
    await page.reload();
    await page
      .getByRole("button", { name: "设置", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "手机与同步", exact: true }).click();
    await page
      .getByRole("button", { name: "修改同步范围", exact: true })
      .click();
    await expect(editor.getByLabel("文件选择方式")).toHaveValue("manual");
    await expect(editor.getByLabel(/可靠接口.epub/)).toBeChecked();
    await editor.getByLabel("文件选择方式").selectOption("all");
    await editor
      .getByRole("button", { name: "保存同步范围", exact: true })
      .click();
    await expect(
      page.getByText("同步范围已保存，下次手机同步时生效。"),
    ).toBeVisible();
    expect(await readLibrary()).toHaveLength(4);
    expect(await page.pageErrors()).toEqual([]);
  } finally {
    await pc.close();
    if (service.exitCode === null) {
      const stopped = new Promise<void>((done) =>
        service.once("exit", () => done()),
      );
      service.kill("SIGTERM");
      await stopped;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
