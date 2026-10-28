import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.use({ trace: "off", screenshot: "off" });
test("desktop shelf selects books, folders and a workspace for one phone only", async ({
  browser,
}) => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-library-sync-"));
  const code = "a".repeat(64);
  const server = spawn(
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
  server.stderr.resume();
  const pc = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const base = await new Promise<string>((done, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(Error("Service startup timeout")),
        10000,
      );
      server.stdout.on("data", (chunk) => {
        output += chunk;
        try {
          const ready = JSON.parse(output.trim());
          clearTimeout(timeout);
          done(ready.url);
        } catch {}
      });
      server.once("error", reject);
      server.once("exit", () => {
        clearTimeout(timeout);
        reject(Error("Service exited"));
      });
    });
    const login = await pc.request.post(base + "/api/session", {
      data: { code },
    });
    expect(login.ok()).toBeTruthy();
    const headers = { "X-CSRF-Token": (await login.json()).csrf };
    const post = async (path: string, data: any) => {
      const response = await pc.request.post(base + "/api" + path, {
        headers,
        data,
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };
    const ws = await post("/workspaces", { name: "随身阅读" });
    const other = await post("/workspaces", { name: "留在电脑的资料" });
    const form = new FormData();
    for (const name of ["慢慢读.md", "读书笔记.txt", "留一点时间.md"])
      form.append(
        "files",
        new File(["# 演示资料\n\n只同步自己选择的书籍。\n" + name], name),
      );
    expect(
      (
        await pc.request.post(base + `/api/workspaces/${ws.id}/imports`, {
          headers,
          multipart: form,
        })
      ).ok(),
    ).toBeTruthy();
    expect(
      (
        await pc.request.post(base + `/api/workspaces/${other.id}/imports`, {
          headers,
          multipart: {
            files: {
              name: "不同步.txt",
              mimeType: "text/plain",
              buffer: Buffer.from("留在电脑"),
            },
          },
        })
      ).ok(),
    ).toBeTruthy();
    const sourceFolder = (await (await pc.request.get(base + `/api/workspaces/${ws.id}/sources`)).json())[0];
    const page = await pc.newPage();
    page.on("pageerror", (error) =>
      console.error("Desktop render error:", error.message),
    );
    await page.addInitScript(() => {
      localStorage.setItem("open-reading-language", "zh");
      (window as any).openReadingDesktop = {
        onClosing: () => () => {},
        onThread: () => () => {},
        setLanguage: async () => {},
        openBook: async () => {
          (window as any).openedBooks = ((window as any).openedBooks || 0) + 1;
        },
      };
    });
    await page.goto(base);
    await expect(page.locator(".library-book")).toHaveCount(3);
    await expect(page.locator(".library-tools > button")).toHaveText(["刷新"]);
    await expect(
      page.locator(".library-title-row").getByRole("button", {
        name: "同步到手机", exact: true,
      }),
    ).toBeVisible();
    if (process.env.OR_EVIDENCE_DIR) {
      await mkdir(process.env.OR_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({
        path: join(process.env.OR_EVIDENCE_DIR, "desktop-sync-entry.png"),
      });
    }
    await page
      .getByRole("button", { name: "设置", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "手机与同步", exact: true }).click();
    await expect(page.locator(".sync-scope")).toHaveCount(0);
    await expect(page.getByRole("button", {name:"修改同步范围",exact:true})).toHaveCount(0);
    const grantResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pair/grants") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "生成手机配对二维码", exact: true })
      .click();
    const grant = await (await grantResponse).json(),
      token = "b".repeat(64);
    const phoneHeaders = {
      Authorization: "Bearer " + token,
      Origin: "capacitor://localhost",
    };
    expect(
      (
        await pc.request.post(base + "/api/pair/claim", {
          headers: phoneHeaders,
          data: {
            id: grant.id,
            secret: grant.secret,
            token,
            name: "我的 Android",
          },
        })
      ).ok(),
    ).toBeTruthy();
    const approved = page.waitForResponse(
      (r) => r.url().endsWith("/approve") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "确认授权此设备", exact: true })
      .click();
    const device = await (await approved).json();
    await expect(
      page.getByText("已配对。可以在手机搜索选书，或返回电脑书库选择同步范围。", {
        exact: true,
      }),
    ).toBeVisible();
    const snapshot = async (headers: Record<string, string>) => {
      const response = await pc.request.get(base + "/api/sync/library", {
        headers,
      });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).workspaces.flatMap(
        (w: any) => w.documents,
      );
    };
    expect(await snapshot(phoneHeaders)).toHaveLength(0);
    expect(
      await (
        await pc.request.get(base + "/api/sync/status", {
          headers: phoneHeaders,
        })
      ).json(),
    ).toEqual({ enabled: false });
    const secondGrant = await post("/pair/grants", {
      workspaceIds: [ws.id],
      syncScope: { mode: "manual", memberIds: [] },
    });
    const secondToken = "c".repeat(64),
      secondHeaders = {
        Authorization: "Bearer " + secondToken,
        Origin: "capacitor://localhost",
      };
    expect(
      (
        await pc.request.post(base + "/api/pair/claim", {
          headers: secondHeaders,
          data: {
            id: secondGrant.id,
            secret: secondGrant.secret,
            token: secondToken,
            name: "另一部手机",
          },
        })
      ).ok(),
    ).toBeTruthy();
    await post(`/pair/grants/${secondGrant.id}/approve`, {});
    await page
      .getByRole("dialog", { name: "设置", exact: true })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    const panel = page.getByRole("region", { name: "选择手机同步书籍" });
    const choosePhone = () =>
      panel.getByLabel("同步到手机").selectOption(device.id);
    const save = async () => {
      await panel
        .getByRole("button", { name: "开始同步", exact: true })
        .click();
      await expect(panel.getByLabel("手机接收进度")).toBeVisible();
      await panel.getByRole("button", {name:"退出同步选择",exact:true}).click();
      await expect(panel).toHaveCount(0);
    };
    // Start with another authorized workspace so a stale full-scope retry
    // would restore its authorization after the concurrent window removes it.
    await expect.poll(async () => (await (await pc.request.get(base + `/api/workspaces/${other.id}/documents`)).json()).items.length).toBe(1);
    const otherBook = (await (await pc.request.get(base + `/api/workspaces/${other.id}/documents`)).json()).items[0];
    expect((await pc.request.put(`${base}/api/devices/${device.id}/scope`, {headers,data:{workspaceIds:[ws.id, other.id],syncScope:{mode:"manual",memberIds:[otherBook.id]}}})).ok()).toBeTruthy();
    await page.getByRole("button", { name: "同步到手机", exact: true }).click();
    await choosePhone();
    await page.getByRole("checkbox", { name: /选择同步 .*慢慢读.md/ }).check();
    expect(await page.evaluate(() => (window as any).openedBooks || 0)).toBe(0);
    // Another window removes a workspace after this panel opened. Reload
    // the actual scope instead of attaching a new revision to stale checks.
    expect((await pc.request.put(`${base}/api/devices/${device.id}/scope`, {headers,data:{workspaceIds:[ws.id],syncScope:{mode:"manual",memberIds:[]}}})).ok()).toBeTruthy();
    await panel.getByRole("button",{name:"开始同步",exact:true}).click();
    await expect(page.getByText("同步清单已在其他窗口更新，已载入最新清单，请重新核对勾选。",{exact:true})).toBeVisible();
    await expect(page.getByRole("checkbox",{name:/选择同步 .*慢慢读.md/})).not.toBeChecked();
    await save();
    const afterConflict = (await (await pc.request.get(base + "/api/devices")).json()).find((d: any) => d.id === device.id);
    expect(afterConflict.workspaceIds).toEqual([ws.id]);
    expect(await snapshot(phoneHeaders)).toHaveLength(0);
    await page.getByRole("button", { name: "同步到手机", exact: true }).click();
    await choosePhone();
    await page.getByRole("checkbox", { name: /选择同步 .*慢慢读.md/ }).check();
    await save();
    expect((await snapshot(phoneHeaders)).map((d: any) => d.title)).toEqual([
      expect.stringContaining("慢慢读.md"),
    ]);
    await page.getByRole("button", { name: "同步到手机", exact: true }).click();
    await choosePhone();
    const selectedDevice = (await (await pc.request.get(base + "/api/devices")).json()).find((d: any) => d.id === device.id);
    const progressBody = {revision:selectedDevice.syncScope.revision,phase:"downloading",done:0,total:1,title:"慢慢读.md",received:5,bytes:10};
    expect((await pc.request.post(base + "/api/sync/progress",{headers:phoneHeaders,data:progressBody})).ok()).toBeTruthy();
    await expect(panel.getByLabel("手机接收进度")).toContainText("手机正在接收书籍");
    await expect(panel.getByLabel("手机接收进度")).toContainText("50%");
    if (process.env.OR_EVIDENCE_DIR) await page.screenshot({path:join(process.env.OR_EVIDENCE_DIR,"desktop-transfer-progress.png")});
    expect((await pc.request.post(base + "/api/sync/progress",{headers:phoneHeaders,data:{...progressBody,phase:"completed",done:1}})).ok()).toBeTruthy();
    await expect(panel.getByLabel("手机接收进度")).toContainText("手机已确认接收完成");
    await page.route("**/api/devices/*/sync-progress",async route=>{
      const response=await route.fetch();
      const body=await response.json();
      await route.fulfill({json:{...body,lastSeenAt:Date.now()-60000}});
    });
    await expect(panel.getByLabel("手机接收进度")).toContainText("上次同步已完成");
    await expect(panel.getByLabel("手机接收进度")).toContainText("手机当前离线");
    await expect(panel.getByLabel("手机接收进度")).not.toContainText("请保持手机应用打开");
    await page.unroute("**/api/devices/*/sync-progress");
    await panel.getByRole("button",{name:"退出同步选择",exact:true}).click();
    expect(await snapshot(secondHeaders)).toHaveLength(0);
    expect(
      await (
        await pc.request.get(base + "/api/sync/status", {
          headers: phoneHeaders,
        })
      ).json(),
    ).toEqual({ enabled: true });
    await page
      .locator(".library-book")
      .filter({ hasText: "读书笔记.txt" })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "同步到手机…", exact: true })
      .click();
    await choosePhone();
    await expect(
      page.getByRole("checkbox", { name: /选择同步 .*读书笔记.txt/ }),
    ).toBeChecked();
    await page
      .getByRole("checkbox", { name: /选择同步 .*慢慢读.md/ })
      .uncheck();
    await save();
    expect((await snapshot(phoneHeaders)).map((d: any) => d.title)).toEqual([
      expect.stringContaining("读书笔记.txt"),
    ]);
    await page
      .locator(".library-book")
      .filter({ hasText: "慢慢读.md" })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "同步所在文件夹…", exact: true })
      .click();
    await choosePhone();
    await expect(panel).toContainText("本工作区已选 3 本");
    await page
      .getByRole("checkbox", { name: /选择同步 .*留一点时间.md/ })
      .uncheck();
    await save();
    expect(await snapshot(phoneHeaders)).toHaveLength(2);
    await page.locator(".library-sources > summary").hover();
    await page.getByRole("button", { name: "同步文件夹 " + sourceFolder.label, exact: true }).click();
    await choosePhone();
    await expect(panel).toContainText("本工作区已选 3 本");
    await panel.getByRole("button", { name: "清空本工作区", exact: true }).click();
    await panel.getByLabel("添加同步文件夹").selectOption(JSON.stringify([sourceFolder.id, ""]));
    await expect(panel).toContainText("本工作区已选 3 本");
    await save();
    await page.getByRole("button", { name: "同步到手机", exact: true }).click();
    await choosePhone();
    await panel.getByLabel("同步整个工作区", { exact: false }).check();
    await expect(panel).toContainText("本工作区已选 3 本");
    const evidence = process.env.OR_EVIDENCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, "desktop-sync-light.png") });
    }
    await save();
    expect(await snapshot(phoneHeaders)).toHaveLength(3);
    expect(await snapshot(secondHeaders)).toHaveLength(0);
    await page.getByRole("button", { name: "同步到手机", exact: true }).click();
    await choosePhone();
    await panel
      .getByRole("button", { name: "清空本工作区", exact: true })
      .click();
    await expect(panel).toContainText("本工作区已选 0 本");
    await save();
    expect(await snapshot(phoneHeaders)).toHaveLength(0);
    await page.reload();
    await page.getByRole("button", { name: "同步到手机", exact: true }).click();
    await choosePhone();
    await expect(panel).toContainText("本工作区已选 0 本");
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator(".library-book")
          .first()
          .evaluate(
            (el) =>
              getComputedStyle(el).color ===
              getComputedStyle(document.documentElement).color,
          ),
      )
      .toBe(true);
    if (evidence)
      await page.screenshot({ path: join(evidence, "desktop-sync-dark.png") });
    expect(await page.pageErrors()).toEqual([]);
  } finally {
    await pc.close();
    if (server.exitCode === null) {
      const stopped = new Promise<void>((done) =>
        server.once("exit", () => done()),
      );
      server.kill("SIGTERM");
      await stopped;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
