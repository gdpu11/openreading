import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.use({ trace: "off", screenshot: "off" });
test("settings only pairs phones; shelf owns selected books and workspace sync", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-sync-selection-"));
  const code = "a".repeat(64);
  const service = spawn(
    resolve(process.env.OR_TEST_BINARY || "desktop/runtime/openreading"),
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
    await pc.request.put(base + "/api/preferences", {headers,data:{activeWorkspaceId:ws.id}});
    await page.addInitScript(() => {
      localStorage.setItem("open-reading-language", "zh");
      (window as any).openReadingDesktop = {onClosing:()=>()=>{},onThread:()=>()=>{},setLanguage:async()=>{},openBook:async()=>{}};
    });
    await page.goto(base);
    await page
      .getByRole("button", { name: "设置", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "手机与同步", exact: true }).click();
    await expect(page.locator(".sync-scope")).toHaveCount(0);
    await expect(page.getByRole("button",{name:"修改同步范围",exact:true})).toHaveCount(0);
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
      page.getByText("已配对。可以在手机搜索选书，或返回电脑书库选择同步范围。"),
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
    expect(await readLibrary()).toHaveLength(0);
    await page.getByRole("dialog",{name:"设置",exact:true}).getByRole("button",{name:"关闭",exact:true}).click();
    await page.getByRole("button",{name:"同步到手机",exact:true}).click();
    const panel=page.getByRole("region",{name:"选择手机同步书籍"});
    await page.getByRole("checkbox",{name:/选择同步 .*可靠接口.epub/}).check();
    await page.getByRole("checkbox",{name:/选择同步 .*文字.txt/}).check();
    await panel.getByRole("button",{name:"开始同步",exact:true}).click();
    await expect(panel.getByRole("button",{name:"开始同步",exact:true})).toBeEnabled();
    expect((await readLibrary()).map((d:any)=>d.format).sort()).toEqual(["epub","txt"]);
    await page.reload();
    await page.getByRole("button",{name:"同步到手机",exact:true}).click();
    await expect(page.getByRole("checkbox",{name:/选择同步 .*可靠接口.epub/})).toBeChecked();
    await expect(page.getByRole("checkbox",{name:/选择同步 .*文字.txt/})).toBeChecked();
    await panel.getByLabel("同步整个工作区",{exact:false}).check();
    await panel.getByRole("button",{name:"开始同步",exact:true}).click();
    await expect(panel.getByRole("button",{name:"开始同步",exact:true})).toBeEnabled();
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
