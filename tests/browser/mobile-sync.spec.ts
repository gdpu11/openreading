import {
  test,
  expect,
  chromium,
  _electron as electron,
} from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import https from "node:https";
import http from "node:http";

test.use({ trace: "off", screenshot: "off" });
test("phone approval, verified offline files, queued notes, conflicts and revocation", async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-mobile-"));
  const evidence = resolve(
    process.env.OR_NATIVE_EVIDENCE_DIR || "docs/evidence/native",
  );
  await mkdir(evidence, { recursive: true });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  let backendPort = 0;
  const proxy = https.createServer(
    {
      key: await readFile(join(dir, "key.pem")),
      cert: await readFile(join(dir, "cert.pem")),
    },
    (req, res) => {
      const forward = http.request(
        {
          hostname: "127.0.0.1",
          port: backendPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode || 500, r.headers);
          r.pipe(res);
        },
      );
      forward.on("error", () => {
        res.writeHead(503);
        res.end();
      });
      req.pipe(forward);
    },
  );
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const origin = "https://127.0.0.1:" + (proxy.address() as any).port;
  const service = spawn(
    resolve("desktop/runtime/openreading"),
    [
      "--port",
      "0",
      "--data-dir",
      join(dir, "data"),
      "--machine-readable",
      "--public-url",
      origin,
    ],
    {
      env: {
        ...process.env,
        OPENREADING_ACCESS_CODE: "test-access-code-" + "a".repeat(40),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    service.stdout.on("data", (chunk) => {
      buffer += chunk;
      try {
        const v = JSON.parse(buffer.trim());
        backendPort = Number(new URL(v.url).port);
        resolve();
      } catch {}
    });
    service.once("exit", (code) => reject(Error("backend exit " + code)));
    setTimeout(() => reject(Error("service timeout")), 15000).unref();
  });
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const pc = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    }),
    phone = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
  try {
    const login = await pc.request.post(origin + "/api/session", {
      data: { code: "test-access-code-" + "a".repeat(40) },
    });
    expect(login.status()).toBe(200);
    const csrf = (await login.json()).csrf;
    const headers = { "X-CSRF-Token": csrf };
    const ws = await (
      await pc.request.post(origin + "/api/workspaces", {
        headers,
        data: { name: "随身阅读验收" },
      })
    ).json();
    await pc.request.post(origin + "/api/workspaces/" + ws.id + "/imports", {
      headers,
      multipart: {
        files: {
          name: "手机同步.md",
          mimeType: "text/markdown",
          buffer: Buffer.from(
            "# 随身阅读\n\n这一段原文用于检验手机离线文件和笔记同步。\n\n第二段内容在断网后仍然可以阅读。",
          ),
        },
      },
    });
    for (const file of ["双栏与扫描混合.pdf", "封面与正文.epub"]) {
      const response = await pc.request.post(
        origin + "/api/workspaces/" + ws.id + "/imports",
        {
          headers,
          multipart: {
            files: {
              name: file,
              mimeType: "application/octet-stream",
              buffer: await readFile(resolve("fixtures", file)),
            },
          },
        },
      );
      expect(response.status()).toBe(200);
    }
    const page = await pc.newPage();
    await page.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await page.goto(origin);
    await page
      .getByRole("button", { name: "设置", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "手机与同步", exact: true }).click();
    await expect(page.getByText("允许这部手机同步的工作区")).toBeVisible();
    // Generate through the actual settings UI and inspect only the synthetic
    // response. Pairing QR images are never written to screenshots or traces.
    const grantResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pair/grants") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "生成手机配对二维码" }).click();
    const grant = await (await grantResponse).json();
    const qr =
      origin +
      "/mobile#pair=" +
      encodeURIComponent(
        JSON.stringify({ origin, id: grant.id, secret: grant.secret }),
      );
    let offline = false;
    // Native app assets remain local when connectivity is lost. Abort only
    // remote API requests while allowing the bundled worker/fonts to load.
    await phone.route("**/api/**", (route) =>
      offline ? route.abort() : route.continue(),
    );
    const mobile = await phone.newPage();
    const errors: string[] = [];
    mobile.on("pageerror", (e) => errors.push(e.message));
    await mobile.goto(qr);
    await expect(mobile.getByLabel("Language / 语言")).toHaveValue("en");
    await mobile.getByLabel("Language / 语言").selectOption("zh");
    await mobile.getByRole("button", { name: "连接此电脑" }).click();
    await expect(
      page.getByRole("button", { name: "确认授权此设备" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "确认授权此设备" }).click();
    await expect(
      mobile.getByRole("button", { name: /手机同步.md/ }),
    ).toBeVisible();
    await expect(mobile.locator(".mobile-status")).toHaveText(
      "文件与笔记已同步",
    );
    await mobile.screenshot({
      path: join(evidence, "phone-library-light.png"),
    });
    offline = true;
    await mobile.getByRole("button", { name: /双栏与扫描混合.pdf/ }).click();
    await expect(mobile.locator(".pdf-page canvas").first()).toBeVisible();
    await expect
      .poll(() => mobile.locator(".textLayer span").count())
      .toBeGreaterThan(0);
    await mobile
      .locator(".reader")
      .evaluate((el) => el.scrollBy({ top: 1000, behavior: "instant" }));
    await expect(mobile.getByLabel("PDF 页码")).toHaveValue("2");
    await expect(
      mobile.locator('.pdf-page[data-page-index="1"] canvas'),
    ).toBeVisible();
    await expect(
      mobile.getByText(
        "此页没有可选文字。可添加页级笔记，小阅仅能讨论你输入的文字。",
        { exact: true },
      ),
    ).toBeVisible();
    await mobile.getByRole("button", { name: "返回书库" }).click();
    await mobile.getByRole("button", { name: /封面与正文.epub/ }).click();
    await expect(
      mobile.getByRole("button", { name: "下一节", exact: true }),
    ).toBeVisible();
    await mobile.getByRole("button", { name: "下一节", exact: true }).click();
    await expect(
      mobile.frameLocator(".epub-container iframe").locator("body"),
    ).toContainText("第1章");
    await mobile.getByRole("button", { name: "返回书库" }).click();
    await mobile.getByRole("button", { name: /手机同步.md/ }).click();
    await expect(mobile.locator(".prose")).toContainText(
      "第二段内容在断网后仍然可以阅读",
    );
    await mobile
      .locator(".prose p")
      .first()
      .evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
    await mobile
      .getByRole("textbox", { name: "手机笔记", exact: true })
      .fill("手机断网时写下的理解。");
    await mobile
      .getByRole("button", { name: "保存手机笔记", exact: true })
      .click();
    await expect(mobile.locator(".mobile-status")).toContainText(/离线|等待/);
    await mobile.getByRole("button", { name: "切换黑白主题" }).click();
    expect(await mobile.locator("html").getAttribute("data-theme")).toBe(
      "dark",
    );
    expect(
      await mobile
        .locator(".mobile-app")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgb(0, 0, 0)");
    expect(
      await mobile
        .getByRole("button", { name: "返回书库" })
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe("rgb(238, 238, 238)");
    await mobile.screenshot({ path: join(evidence, "phone-offline-dark.png") });
    offline = false;
    await mobile.getByRole("button", { name: "同步文件与笔记" }).click();
    await expect
      .poll(async () => {
        const notes = await (
          await pc.request.get(origin + "/api/workspaces/" + ws.id + "/notes")
        ).json();
        return notes[0]?.messages?.[0]?.body;
      })
      .toBe("手机断网时写下的理解。");
    await expect(mobile.locator(".mobile-status")).toHaveText(
      "文件与笔记已同步",
    );
    await mobile.getByRole("button", { name: /^笔记 / }).click();
    await mobile.getByRole("button", { name: "修改笔记" }).click();
    offline = true;
    await mobile
      .getByRole("textbox", { name: "手机笔记", exact: true })
      .fill("手机修改的冲突草稿");
    await mobile
      .getByRole("button", { name: "保存手机笔记", exact: true })
      .click();
    const notes = await (
        await pc.request.get(origin + "/api/workspaces/" + ws.id + "/notes")
      ).json(),
      msg = notes[0].messages[0];
    const edit = await pc.request.patch(origin + "/api/messages/" + msg.id, {
      headers,
      data: { body: "电脑已更新的笔记", revision: msg.revision },
    });
    expect(edit.status()).toBe(200);
    offline = false;
    await mobile.getByRole("button", { name: "同步文件与笔记" }).click();
    await expect(mobile.locator(".mobile-status")).toHaveText(
      "部分笔记需要处理",
    );
    await mobile.getByRole("button", { name: /^笔记 / }).click();
    await expect(
      mobile.getByText("手机修改的冲突草稿", { exact: true }),
    ).toBeVisible();
    await expect(
      mobile.getByText("电脑已更新的笔记", { exact: true }),
    ).toBeVisible();
    await mobile.screenshot({
      path: join(evidence, "phone-note-conflict.png"),
    });
    await mobile.getByRole("button", { name: "返回书库" }).click();
    const retryGrant = await (
      await pc.request.post(origin + "/api/pair/grants", {
        headers,
        data: { workspaceIds: [ws.id] },
      })
    ).json();
    await mobile
      .getByRole("button", { name: "重新扫码授权（保留文件与笔记）" })
      .click();
    await mobile.locator("summary").click();
    await mobile.getByRole("textbox", { name: "完整配对链接" }).fill(
      origin +
        "/mobile#pair=" +
        encodeURIComponent(
          JSON.stringify({
            origin,
            id: retryGrant.id,
            secret: retryGrant.secret,
          }),
        ),
    );
    await mobile.getByRole("button", { name: "申请配对", exact: true }).click();
    await mobile.getByRole("button", { name: "取消配对", exact: true }).click();
    await expect(
      mobile.getByText("手机修改的冲突草稿", { exact: true }),
    ).toBeVisible();
    await mobile.getByRole("button", { name: "文件", exact: true }).click();
    await expect(
      mobile.getByRole("button", { name: /手机同步.md/ }),
    ).toBeVisible();
    await pc.request.delete(origin + "/api/pair/grants/" + retryGrant.id, {
      headers,
    });
    // ORD must not silently omit a conflicting, queued phone note.
    await mobile.getByRole("button", { name: /手机同步.md/ }).click();
    await mobile
      .getByRole("button", { name: "导出本书 ORD", exact: true })
      .click();
    await expect(mobile.locator(".mobile-error")).toContainText(
      "仍有未同步笔记",
    );
    await mobile.getByRole("button", { name: /^笔记 / }).click();
    mobile.once("dialog", (dialog) => dialog.accept());
    await mobile
      .getByRole("button", { name: "移除手机草稿", exact: true })
      .click();
    await mobile.getByRole("button", { name: "收起笔记", exact: true }).click();
    const downloaded = mobile.waitForEvent("download");
    await mobile
      .getByRole("button", { name: "导出本书 ORD", exact: true })
      .click();
    const ord = await downloaded;
    expect(ord.suggestedFilename()).toMatch(/\.ord$/);
    const ordFile = join(dir, "phone-book.ord");
    await ord.saveAs(ordFile);
    await mobile.getByRole("button", { name: "返回书库", exact: true }).click();
    await mobile
      .locator('input[type="file"][accept*=".ord"]')
      .setInputFiles(ordFile);
    await expect(mobile.locator(".mobile-status")).toContainText(
      "包含 1 条标注",
    );
    await expect(
      mobile.getByRole("button", { name: /手机同步.md/ }),
    ).toHaveCount(2);
    const afterOrd = await (
      await pc.request.get(origin + "/api/workspaces/" + ws.id + "/notes")
    ).json();
    expect(afterOrd).toHaveLength(2);
    expect(
      afterOrd.every((t: any) => t.messages[0].body === "电脑已更新的笔记"),
    ).toBe(true);
    await mobile.screenshot({ path: join(evidence, "phone-ord-import.png") });
    const devices = await (
      await pc.request.get(origin + "/api/devices")
    ).json();
    await pc.request.delete(origin + "/api/devices/" + devices[0].id, {
      headers,
    });
    await mobile.getByRole("button", { name: "同步文件与笔记" }).click();
    await expect(mobile.locator(".mobile-error")).toContainText("授权已失效");
    expect(errors).toEqual([]);
  } finally {
    await pc.close();
    await phone.close();
    await browser.close();
    service.kill("SIGINT");
    await new Promise<void>((resolve) => {
      if (service.exitCode !== null) resolve();
      else service.once("exit", () => resolve());
    });
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("Electron launches bundled service in an isolated renderer and preserves the local library", async () => {
  test.skip(process.platform !== "darwin");
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-electron-"));
  let app: any;
  try {
    await mkdir(join(dir, "desktop-profile"));
    await writeFile(
      join(dir, "desktop-profile", "desktop.json"),
      JSON.stringify({ mode: "cloud" }),
    );
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
    const window = await app.firstWindow();
    await window.waitForURL(/127.0.0.1/);
    await expect(
      window.getByRole("heading", { name: "Welcome to Open Reading." }),
    ).toBeVisible();
    expect(
      await app.evaluate(({ Menu }: any) =>
        Menu.getApplicationMenu().items.map((i: any) => i.label),
      ),
    ).toContain("Library");
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByLabel("Language / 语言").selectOption("zh");
    await expect(
      window.getByRole("button", { name: "阅读偏好", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(({ Menu }: any) =>
          Menu.getApplicationMenu().items.map((i: any) => i.label),
        ),
      )
      .toContain("书库");
    await expect
      .poll(() =>
        window.evaluate(
          async () => (await (await fetch("/api/preferences")).json()).language,
        ),
      )
      .toBe("zh");
    await window.getByRole("button", { name: "关闭", exact: true }).click();
    expect(
      await window.evaluate(() => ({
        node: typeof (window as any).require,
        process: typeof (window as any).process,
      })),
    ).toEqual({ node: "undefined", process: "undefined" });
    const created = await window.evaluate(async () => {
      const me = await (await fetch("/api/me")).json();
      return (
        await fetch("/api/workspaces", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": me.csrf,
          },
          body: JSON.stringify({ name: "Electron 重启持久书库" }),
        })
      ).ok;
    });
    expect(created).toBe(true);
    await app.close();
    app = null;
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
    let reopened = await app.firstWindow();
    const library = reopened;
    await reopened.waitForURL(/127.0.0.1/);
    await expect(
      reopened.getByRole("button", {
        name: /切换工作区 Electron 重启持久书库/,
      }),
    ).toBeVisible();
    await reopened.evaluate(async (sourcePath) => {
      const me = await (await fetch("/api/me")).json();
      const spaces = await (await fetch("/api/workspaces")).json();
      const source = await (
        await fetch(`/api/workspaces/${spaces[0].id}/sources`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": me.csrf,
          },
          body: JSON.stringify({ path: sourcePath, label: "全屏阅读测试资料" }),
        })
      ).json();
      for (let i = 0; i < 100; i++) {
        const job = await (await fetch(`/api/scans/${source.scan.id}`)).json();
        if (job.state === "completed") return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw Error("Fixture scan did not complete");
    }, resolve("fixtures"));
    await library.reload();
    await expect(library.locator(".navigator")).toHaveCount(0);
    await expect(library.locator(".library-toolbar")).toBeVisible();
    expect(
      (await library.locator(".library-search").boundingBox())!.height,
    ).toBeLessThanOrEqual(48);
    const coverBook = library
      .locator(".library-book")
      .filter({ hasText: "封面与正文.epub" });
    const pdfCard = library
      .locator(".library-book")
      .filter({ hasText: "双栏与扫描混合.pdf" });
    await expect(coverBook.locator("img")).toBeVisible({ timeout: 20000 });
    await expect(pdfCard.locator("img")).toBeVisible({ timeout: 20000 });
    const unopened = await library.evaluate(async () => {
      const spaces = await (await fetch("/api/workspaces")).json();
      return (
        await (
          await fetch("/api/workspaces/" + spaces[0].id + "/documents")
        ).json()
      ).items;
    });
    expect(unopened.every((d: any) => !d.lastOpened)).toBe(true);
    const coveredMember = unopened.find((d: any) =>
      d.bindings[0].relativePath.endsWith("封面与正文.epub"),
    ).id;
    await expect
      .poll(() =>
        library.evaluate(
          async (member: string) =>
            (await fetch("/api/documents/" + member + "/thumbnail")).status,
          coveredMember,
        ),
      )
      .toBe(200);
    // Simulate a fresh browser cache (the desktop service port changes on restart).
    await library.evaluate(
      (member: string) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("openreading-recovery", 1);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("drafts", "readwrite");
            tx.objectStore("drafts").delete("library-cover:" + member);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      coveredMember,
    );
    let repeatedCoverRequests = 0;
    const countCover = (request: any) => {
      if (request.url().includes("/documents/" + coveredMember + "/cover"))
        repeatedCoverRequests++;
    };
    library.on("request", countCover);
    await library.reload();
    await expect(coverBook.locator("img")).toBeVisible();
    expect(repeatedCoverRequests).toBe(0);
    library.off("request", countCover);
    await library
      .getByLabel("搜索文件名", { exact: true })
      .fill("no-matching-books");
    await expect(
      library.getByRole("heading", { name: "没有找到匹配的书籍" }),
    ).toBeVisible();
    await expect(library.locator(".library-toolbar")).toBeVisible();
    await library.getByLabel("搜索文件名", { exact: true }).fill("");
    await expect(library.locator(".library-book")).toHaveCount(unopened.length);
    await library.getByLabel("文件排序", { exact: true }).click();
    await library
      .getByRole("menuitemradio", { name: "文件名（A–Z）", exact: true })
      .click();
    const sorted = await library.evaluate(async () => {
      const spaces = await (await fetch("/api/workspaces")).json();
      return (
        await (
          await fetch(
            "/api/workspaces/" + spaces[0].id + "/documents?sort=name",
          )
        ).json()
      ).items.map((d: any) => d.bindings[0].relativePath.split("/").pop());
    });
    await expect(library.locator(".library-book strong")).toHaveText(sorted);
    await library.locator(".library-sources summary").click();
    await expect(library.locator(".library-sources-panel")).toContainText(
      "全屏阅读测试资料",
    );
    await library.locator(".library-sources summary").click();
    await library.getByTitle("刷新来源", { exact: true }).click();
    await expect(library.locator(".toast")).toContainText("来源已复核");
    const bookWindow = app.waitForEvent("window");
    await library
      .locator(".library-book")
      .filter({ hasText: "可靠接口.epub" })
      .click();
    reopened = await bookWindow;
    await reopened.clock.install();
    await reopened.reload();
    await expect(reopened.locator(".reader-window")).toBeVisible();
    await expect(reopened.locator(".workspace-rail")).toBeHidden();
    await expect(library.locator(".desktop-library")).toBeVisible();
    await expect(library.locator(".reader")).toHaveCount(0);
    await expect(reopened.getByLabel("阅读进度百分比")).toHaveText(/^[\d.]+%$/);
    const bookBody = () =>
      reopened.frameLocator(".epub-container iframe").locator("body");
    await expect(bookBody()).toContainText("第1章 接口重试");
    await expect(
      reopened.locator(".reading-footer .book-word-count"),
    ).toHaveText(/全书字数 [1-9][\d,]* 字\/词/);
    // Actual native focus notifications must pause the same clock shown in
    // the toolbar, including when an EPUB iframe has keyboard focus.
    await reopened.clock.pauseAt(
      await reopened.evaluate(() => Date.now() + 1000),
    );
    await app.evaluate(({ app, BrowserWindow }: any) => {
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        .show();
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        .focus();
      app.focus({ steal: true });
    });
    await expect(reopened.locator(".session-timer")).toHaveAttribute(
      "data-state",
      "running",
    );
    const sessionSeconds = async () =>
      (await reopened
        .getByRole("timer", { name: "本次阅读时长" })
        .textContent())!
        .split(":")
        .reduce((n: number, part: string) => n * 60 + Number(part), 0);
    const started = await sessionSeconds();
    await reopened.clock.runFor(5000);
    // Native activation can settle between one-second sampling ticks.
    expect(await sessionSeconds()).toBeGreaterThanOrEqual(started + 4);
    expect(await sessionSeconds()).toBeLessThanOrEqual(started + 5);
    await app.evaluate(({ BrowserWindow }: any) =>
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        .blur(),
    );
    await expect(reopened.locator(".session-timer")).toHaveAttribute(
      "data-state",
      "paused",
    );
    const paused = await sessionSeconds();
    await reopened.clock.runFor(10000);
    expect(await sessionSeconds()).toBe(paused);
    await app.evaluate(({ app, BrowserWindow }: any) => {
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        .focus();
      app.focus({ steal: true });
    });
    await expect(reopened.locator(".session-timer")).toHaveAttribute(
      "data-state",
      "running",
    );
    await reopened.clock.runFor(5000);
    expect(await sessionSeconds()).toBeGreaterThanOrEqual(paused + 4);
    expect(await sessionSeconds()).toBeLessThanOrEqual(paused + 5);
    // An expired idle timer must resume from native activation alone, including
    // restoring a minimized window without touching the book's iframe.
    await reopened.clock.runFor(121000);
    await expect(reopened.locator(".session-timer")).toHaveAttribute(
      "data-state",
      "paused",
    );
    const idlePaused = await sessionSeconds();
    await app.evaluate(({ BrowserWindow }: any) =>
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        .minimize(),
    );
    await reopened.clock.runFor(10000);
    expect(await sessionSeconds()).toBe(idlePaused);
    await app.evaluate(({ app, BrowserWindow }: any) => {
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        .restore();
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        .focus();
      app.focus({ steal: true });
    });
    await expect(reopened.locator(".session-timer")).toHaveAttribute(
      "data-state",
      "running",
    );
    // Native restore and visibility events use the real macOS animation clock.
    // Verify sustained counting on real time instead of advancing a fake clock
    // through a native transition that may still be completing.
    await reopened.clock.resume();
    await expect.poll(sessionSeconds).toBeGreaterThan(idlePaused + 2);
    await reopened.getByLabel("页面布局").selectOption("single");
    const initialProgress = await reopened
      .getByLabel("阅读进度百分比")
      .textContent();
    await bookBody().click({ position: { x: 8, y: 8 } });
    await reopened.keyboard.press("ArrowRight");
    await expect(reopened.getByLabel("阅读进度百分比")).not.toHaveText(
      initialProgress,
    );
    await bookBody().click({ position: { x: 8, y: 8 } });
    await reopened.keyboard.press("ArrowLeft");
    await expect(reopened.getByLabel("阅读进度百分比")).toHaveText(
      initialProgress,
    );
    const readingSlider = reopened.getByRole("slider", {
      name: "整本阅读进度",
      exact: true,
    });
    await expect(readingSlider).toBeEnabled();
    await readingSlider.focus();
    await readingSlider.press("End");
    await expect(reopened.getByLabel("阅读进度百分比")).toHaveText("100%");
    await expect(readingSlider).toHaveAttribute("aria-busy", "false");
    await readingSlider.press("Home");
    await expect
      .poll(async () =>
        Number(
          (await reopened.getByLabel("阅读进度百分比").textContent())!.replace(
            "%",
            "",
          ),
        ),
      )
      .toBeLessThan(10);
    await expect(readingSlider).toHaveAttribute("aria-busy", "false");
    const sliderBox = (await readingSlider.boundingBox())!;
    await reopened.mouse.move(
      sliderBox.x + 4.5,
      sliderBox.y + sliderBox.height / 2,
    );
    await reopened.mouse.down();
    await reopened.mouse.move(
      sliderBox.x + 4.5 + (sliderBox.width - 9) * 0.65,
      sliderBox.y + sliderBox.height / 2,
      { steps: 8 },
    );
    const previewProgress = Number(
      (await reopened.getByLabel("阅读进度百分比").textContent())!.replace(
        "%",
        "",
      ),
    );
    expect(previewProgress).toBeGreaterThan(64);
    expect(previewProgress).toBeLessThan(66);
    await reopened.mouse.up();
    await expect(readingSlider).toHaveAttribute("aria-busy", "false");
    await readingSlider.press("Home");
    await expect(readingSlider).toHaveAttribute("aria-busy", "false");
    await expect(reopened.getByLabel("阅读进度百分比")).toHaveText(
      initialProgress,
    );
    // Exercise the actual sandboxed desktop clipboard policy, without granting
    // renderer clipboard-read permission or exposing Node APIs to the book.
    const paragraph = reopened
      .frameLocator(".epub-container iframe")
      .locator("p")
      .first();
    const quote = "幂等性意味着重复执行同一操作";
    await paragraph.click();
    await paragraph.evaluate((el, quote) => {
      const node = el.firstChild!;
      const start = node.textContent!.indexOf(quote);
      const range = el.ownerDocument.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + quote.length);
      const selection = el.ownerDocument.defaultView!.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, quote);
    await reopened.getByTitle("复制选段", { exact: true }).click();
    await expect(reopened.locator(".toast")).toHaveText("已复制选段");
    expect(
      await app.evaluate(({ clipboard }: any) => clipboard.readText()),
    ).toBe(quote);
    expect(
      await reopened.evaluate(() =>
        Object.keys(window.openReadingDesktop || {}),
      ),
    ).toEqual([
      "readerTarget",
      "openBook",
      "renderBookPDF",
      "saveConvertedBook",
      "showLibrary",
      "onThread",
      "onClosing",
      "setLanguage",
    ]);
    expect(
      await bookBody().evaluate(
        () => typeof (window as any).openReadingDesktop,
      ),
    ).toBe("undefined");

    await app.evaluate(({ app, BrowserWindow }: any) => {
      const window = BrowserWindow.getAllWindows().find(
        (w: any) => w.readerTarget,
      );
      (globalThis as any).readingFullscreenEntered = false;
      window.once("enter-full-screen", () => {
        (globalThis as any).readingFullscreenEntered = true;
      });
      window.show();
      window.focus();
      app.focus({ steal: true });
    });
    await reopened
      .getByRole("button", { name: "全屏阅读", exact: true })
      .click();
    await expect
      .poll(() =>
        reopened.evaluate(() => document.fullscreenElement?.className),
      )
      .toBe("reading-main");
    await expect
      .poll(
        () => app.evaluate(() => (globalThis as any).readingFullscreenEntered),
        { timeout: 20000 },
      )
      .toBe(true);
    await reopened.clock.pauseAt(
      await reopened.evaluate(() => Date.now() + 1000),
    );
    await reopened.clock.runFor(10000);
    await expect(reopened.locator(".document-bar")).toBeHidden();
    await expect(reopened.locator(".reading-footer")).toBeHidden();
    await expect(
      reopened.getByLabel("阅读页码", { exact: true }),
    ).toBeVisible();
    await reopened.mouse.move(20, 5);
    await expect(reopened.locator(".document-bar")).toBeVisible();
    await reopened.clock.resume();
    await reopened
      .getByRole("button", { name: "退出全屏阅读", exact: true })
      .click();
    await expect
      .poll(() => reopened.evaluate(() => document.fullscreenElement === null))
      .toBe(true);
    const epubWindow = reopened;
    const epubProgress = await epubWindow
      .getByLabel("阅读进度百分比")
      .textContent();
    const pdfWindow = app.waitForEvent("window");
    await library
      .locator(".library-book")
      .filter({ hasText: "双栏与扫描混合.pdf" })
      .click();
    reopened = await pdfWindow;
    await expect(reopened.getByLabel("PDF 缩放")).toBeVisible();
    await expect(epubWindow.getByLabel("阅读进度百分比")).toHaveText(
      epubProgress!,
    );
    await expect(epubWindow.locator(".session-timer")).toHaveAttribute(
      "data-state",
      "paused",
    );
    expect(app.windows()).toHaveLength(3);
    // Reopening the same book focuses its existing reader.
    await library
      .locator(".library-book")
      .filter({ hasText: "双栏与扫描混合.pdf" })
      .click();
    expect(app.windows()).toHaveLength(3);
    await expect(reopened.locator(".reader-status")).toHaveCount(0);
    const pdfZoom = reopened.getByLabel("PDF 缩放");
    await pdfZoom.selectOption("1");
    const nativeKey = async (modifier: string, key: string) => {
      await app.evaluate(
        ({ BrowserWindow }: any, input: any) => {
          const contents = BrowserWindow.getAllWindows().find((w: any) =>
            w.getTitle().includes("双栏与扫描混合.pdf"),
          ).webContents;
          contents.sendInputEvent({
            type: "keyDown",
            keyCode: input.key,
            modifiers: [input.modifier],
          });
          contents.sendInputEvent({
            type: "keyUp",
            keyCode: input.key,
            modifiers: [input.modifier],
          });
        },
        { modifier, key },
      );
    };
    for (const modifier of ["meta", "control"]) {
      await nativeKey(modifier, "=");
      await expect(pdfZoom).toHaveValue("1.25");
      await nativeKey(modifier, "-");
      await expect(pdfZoom).toHaveValue("1");
    }
    await app.evaluate(({ Menu }: any) =>
      Menu.getApplicationMenu().getMenuItemById("reading-zoom-in").click(),
    );
    await expect(pdfZoom).toHaveValue("1.25");
    await app.evaluate(({ Menu }: any) =>
      Menu.getApplicationMenu().getMenuItemById("reading-zoom-reset").click(),
    );
    await expect(pdfZoom).toHaveValue("1");
    const pinch = await reopened.context().newCDPSession(reopened);
    const pdfBox = (await reopened.locator(".reader-pdf").boundingBox())!;
    await pinch.send("Input.synthesizePinchGesture", {
      x: pdfBox.x + pdfBox.width / 2,
      y: pdfBox.y + pdfBox.height / 2,
      scaleFactor: 1.25,
      relativeSpeed: 800,
      gestureSourceType: "mouse",
    });
    await expect
      .poll(async () => Number(await pdfZoom.inputValue()))
      .toBeGreaterThan(1);
    expect(
      await app.evaluate(({ BrowserWindow }: any) =>
        BrowserWindow.getAllWindows()
          .find((w: any) => w.readerTarget)
          .webContents.getZoomFactor(),
      ),
    ).toBe(1);
    expect(await reopened.evaluate(() => window.visualViewport!.scale)).toBe(1);
    await pinch.detach();
    const screenshotDir =
      process.env.OR_NATIVE_EVIDENCE_DIR || "docs/evidence/native";
    await mkdir(screenshotDir, { recursive: true });
    await reopened.screenshot({
      path: join(screenshotDir, "electron-macos.png"),
    });
    await expect(library.locator(".error-toast")).toHaveCount(0);
    await library.screenshot({ path: join(screenshotDir, "library.png") });
    await epubWindow.screenshot({
      path: join(screenshotDir, "epub-window.png"),
    });
    // Closing the library must leave the shared service and both books alive.
    await app.evaluate(({ BrowserWindow }: any) =>
      BrowserWindow.getAllWindows()
        .find((w: any) => !w.readerTarget)
        .close(),
    );
    expect(
      await app.evaluate(({ BrowserWindow }: any) =>
        BrowserWindow.getAllWindows()
          .find((w: any) => !w.readerTarget)
          .isVisible(),
      ),
    ).toBe(false);
    expect(
      await reopened.evaluate(
        async () => (await (await fetch("/api/health")).json()).status,
      ),
    ).toBe("ok");
    await epubWindow.getByTitle("显示书库", { exact: true }).click();
    expect(
      await app.evaluate(({ BrowserWindow }: any) =>
        BrowserWindow.getAllWindows()
          .find((w: any) => !w.readerTarget)
          .isVisible(),
      ),
    ).toBe(true);
    // Save a final page and a draft while another book remains open.
    await reopened
      .getByRole("slider", { name: "整本阅读进度", exact: true })
      .press("End");
    await expect(reopened.getByLabel("阅读进度百分比")).toHaveText("100%");
    await reopened
      .getByRole("button", { name: "页级笔记", exact: true })
      .click();
    await reopened.getByRole("button", { name: "评论", exact: true }).click();
    const draftBox = reopened.locator("textarea").first();
    await draftBox.fill("多窗口关闭前保留的学习笔记");
    const pdfMember = await reopened.evaluate(
      () => window.openReadingDesktop!.readerTarget!.memberId,
    );
    const closed = reopened.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }: any) =>
      BrowserWindow.getAllWindows()
        .find((w: any) => w.getTitle().includes("双栏与扫描混合.pdf"))
        .close(),
    );
    await closed;
    expect(app.windows()).toHaveLength(2);
    const savedDraft = await library.evaluate(
      async (member: string) =>
        (
          await (
            await fetch(
              "/api/drafts/" +
                encodeURIComponent(member + ":new") +
                "?workspaceDocumentId=" +
                member,
            )
          ).json()
        ).body,
      pdfMember,
    );
    expect(savedDraft).toBe("多窗口关闭前保留的学习笔记");
    const reopenedPdf = app.waitForEvent("window");
    await library
      .locator(".library-book")
      .filter({ hasText: "双栏与扫描混合.pdf" })
      .click();
    const restoredPdf = await reopenedPdf;
    await expect(restoredPdf.getByLabel("阅读进度百分比")).toHaveText("100%");
    await expect(restoredPdf.locator("textarea").first()).toHaveValue(
      "多窗口关闭前保留的学习笔记",
    );
    // Discussion stays collapsed by default, even when a draft is recovered.
    await restoredPdf.getByTitle("展开讨论", { exact: true }).click();
    await restoredPdf
      .getByRole("button", { name: "发送评论", exact: true })
      .click();
    await expect(
      restoredPdf
        .locator(".message")
        .filter({ hasText: "多窗口关闭前保留的学习笔记" }),
    ).toBeVisible();
    await library
      .getByRole("button", { name: "笔记与复习", exact: true })
      .click();
    await library
      .locator(".note-summary")
      .filter({ hasText: "双栏与扫描混合.pdf" })
      .click();
    expect(app.windows()).toHaveLength(3);
    await expect(
      restoredPdf
        .locator(".message")
        .filter({ hasText: "多窗口关闭前保留的学习笔记" }),
    ).toBeVisible();
    await restoredPdf.getByLabel("页面布局").selectOption("double");
    await epubWindow.getByLabel("页面布局").selectOption("double");
    await expect
      .poll(() =>
        library.evaluate(async () => {
          const prefs = await (await fetch("/api/preferences")).json();
          return [prefs.pdfSpread, prefs.epubSpread];
        }),
      )
      .toEqual([true, true]);

    await expect(epubWindow.getByLabel("阅读进度百分比")).toHaveText(
      epubProgress!,
    );
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Electron library actions and word counts persist across book windows and service restarts", async () => {
  test.skip(process.platform !== "darwin");
  const dir = await mkdtemp(join(tmpdir(), "openreading-count-native-"));
  const evidence = resolve(
    process.env.OR_NATIVE_EVIDENCE_DIR || "docs/evidence/word-count/native",
  );
  await mkdir(evidence, { recursive: true });
  await mkdir(join(dir, "material"));
  await writeFile(
    join(dir, "material", "Count.txt"),
    "中文𠮷 Hello world! 👩‍💻 e\u0301",
  );
  const launch = () =>
    electron.launch({
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
  let app: any;
  try {
    app = await launch();
    let library = await app.firstWindow();
    await library.waitForURL(/127.0.0.1/);
    await expect(
      library.getByRole("heading", { name: "Welcome to Open Reading." }),
    ).toBeVisible();
    await library.evaluate(
      async (sourcePath: string) => {
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
        const workspace = await mutate("/workspaces", "POST", {
          name: "Word count",
        });
        await mutate("/preferences", "PUT", { language: "zh" });
        localStorage.setItem("open-reading-language", "zh");
        const source = await mutate(
          `/workspaces/${workspace.id}/sources`,
          "POST",
          { path: sourcePath, label: "Count" },
        );
        for (let i = 0; i < 100; i++) {
          const scan = await (
            await fetch(`/api/scans/${source.scan.id}`)
          ).json();
          if (scan.state === "completed") return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw Error("Count fixture scan incomplete");
      },
      join(dir, "material"),
    );
    await library.reload();
    let opened = app.waitForEvent("window");
    await library
      .locator(".library-book")
      .filter({ hasText: "Count.txt" })
      .click();
    let book = await opened;
    await expect(book.locator(".reading-footer .book-word-count")).toHaveText(
      "全书字数 6 字/词",
    );
    expect(app.windows()).toHaveLength(2);
    await book.screenshot({ path: join(evidence, "word-count-macos.png") });
    const card = () =>
      library.locator(".library-book").filter({ hasText: "Count.txt" });
    await card().click({ button: "right" });
    const menu = () => library.getByRole("menu", { name: "书籍操作" });
    await expect(menu()).toBeVisible();
    await library.screenshot({
      path: join(evidence, "book-context-menu-macos.png"),
    });
    await menu()
      .getByRole("menuitemcheckbox", { name: "收藏", exact: true })
      .click();
    await card().click({ button: "right" });
    await menu()
      .getByRole("menuitemcheckbox", { name: "标记为已读完" })
      .click();
    await expect(card().getByLabel("已收藏")).toBeVisible();
    await expect(card().getByLabel("已读完")).toBeVisible();
    await library.getByRole("button", { name: "收藏", exact: true }).click();
    await expect(card()).toBeVisible();
    await library
      .getByRole("button", { name: "全部书籍", exact: true })
      .click();

    await app.close();
    app = null;
    app = await launch();
    library = await app.firstWindow();
    await library.waitForURL(/127.0.0.1/);
    let recomputed = 0;
    app.on("window", (page: any) =>
      page.on("request", (request: any) => {
        if (
          request.method() === "PUT" &&
          request.url().includes("/word-count?")
        )
          recomputed++;
      }),
    );
    opened = app.waitForEvent("window");
    await library
      .locator(".library-book")
      .filter({ hasText: "Count.txt" })
      .click();
    book = await opened;
    await expect(book.locator(".reading-footer .book-word-count")).toHaveText(
      "全书字数 6 字/词",
    );
    expect(recomputed).toBe(0);
    await expect(card().getByLabel("已收藏")).toBeVisible();
    await expect(card().getByLabel("已读完")).toBeVisible();
    await rm(join(dir, "material", "Count.txt"));
    await library.getByTitle("刷新来源", { exact: true }).click();
    await expect(library.getByRole("status")).toContainText("来源已复核");
    await card().click({ button: "right" });
    await menu().getByRole("menuitem", { name: "删除…" }).click();
    await library
      .getByRole("button", { name: "移出当前书库", exact: true })
      .click();
    await expect(card()).toHaveCount(0);
    await library.getByTitle("刷新来源", { exact: true }).click();
    await expect(library.getByRole("status")).toContainText("来源已复核");
    await expect(card()).toHaveCount(0);
    await library.getByRole("button", { name: "已删除", exact: true }).click();
    await expect(card()).toBeVisible();
    await card().focus();
    await card().press("Shift+F10");
    await menu().getByRole("menuitem", { name: "恢复到书库" }).click();
    await expect(card()).toHaveCount(0);
    await library
      .getByRole("button", { name: "全部书籍", exact: true })
      .click();
    await expect(card()).toBeVisible();
    await library.screenshot({
      path: join(evidence, "library-status-macos.png"),
    });
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
