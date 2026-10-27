import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import https from "node:https";
import { createHash } from "node:crypto";
import net from "node:net";

test.use({ trace: "off", screenshot: "off", actionTimeout: 10000 });
test("computer-only LAN pairing and phone offline notes through a simulated native bridge", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const readingEvidence = resolve(
    process.env.OR_LAN_EVIDENCE_DIR || "docs/evidence/reading",
  );
  await mkdir(readingEvidence, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "openreading-lan-ui-"));
  const service = spawn(
    resolve(process.env.OR_TEST_BINARY || "release/lan-test-server"),
    ["--port", "0", "--data-dir", join(dir, "data"), "--machine-readable"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = await new Promise<any>((res, rej) => {
    let b = "";
    service.stdout!.on("data", (v) => {
      b += v;
      try {
        res(JSON.parse(b));
      } catch {}
    });
    service.once("exit", (v) => rej(Error("server exit " + v)));
    setTimeout(() => rej(Error("server timeout")), 10000).unref();
  });
  const pc = await browser.newContext(),
    phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
  try {
    const login = await pc.request.post(ready.url + "/api/session", {
      data: { code: ready.code },
    });
    const headers = { "X-CSRF-Token": (await login.json()).csrf };
    const ws = await (
      await pc.request.post(ready.url + "/api/workspaces", {
        headers,
        data: { name: "我的电脑书库" },
      })
    ).json();
    await mkdir(join(dir, "books"));
    const text =
      "这份阅读材料只在自己的电脑上。手机在局域网直接下载，离线也能留下学习笔记。";
    await writeFile(join(dir, "books", "电脑原文.txt"), text);
    const source = await (
      await pc.request.post(ready.url + `/api/workspaces/${ws.id}/sources`, {
        headers,
        data: { path: join(dir, "books"), label: "电脑文件" },
      })
    ).json();
    await expect
      .poll(
        async () =>
          (
            await (
              await pc.request.get(ready.url + "/api/scans/" + source.scan.id)
            ).json()
          ).state,
      )
      .toBe("completed");
    const portProbe = net.createServer();
    await new Promise<void>((r) => portProbe.listen(0, "127.0.0.1", r));
    const port = (portProbe.address() as any).port;
    await new Promise<void>((r) => portProbe.close(() => r()));
    const page = await pc.newPage();
    await page.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await page.goto(ready.url);
    await page
      .getByRole("button", { name: "设置", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "手机与同步", exact: true }).click();
    await expect(
      page.getByText("电脑就是书库服务器。", { exact: false }),
    ).toBeVisible();
    await page.getByLabel("局域网端口").fill(String(port));
    await page
      .getByRole("button", { name: "开启局域网同步", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "关闭局域网同步", exact: true }),
    ).toBeVisible();
    const grantResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pair/grants") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "生成手机配对二维码" }).click();
    const grant = await (await grantResponse).json();
    expect(grant.origin).toMatch(/^https:\/\/(192\.168\.|10\.|172\.)/);
    expect(grant.certificateFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const payload =
      grant.origin +
      "/mobile#pair=" +
      encodeURIComponent(
        JSON.stringify({
          origin: grant.origin,
          id: grant.id,
          secret: grant.secret,
          certificateFingerprint: grant.certificateFingerprint,
        }),
      );
    const certificate = JSON.parse(
      await readFile(join(dir, "data", ".lan-identity.json"), "utf8"),
    ).certificate;
    if (
      process.platform === "darwin" &&
      process.env.OR_NATIVE_PIN_PROBE === "1"
    ) {
      const proof = execFileSync(
        "python3",
        [
          resolve("tests/native/verify-lan-pins.py"),
          grant.origin,
          grant.certificateFingerprint,
        ],
        { timeout: 180000, encoding: "utf8" },
      );
      await writeFile(resolve("docs/evidence/lan-native-pins.log"), proof);
    }
    const memory = new Map<string, string>();
    let shared = 0;
    const sharedFiles: string[] = [];
    await phone.exposeFunction(
      "nativeLAN",
      async (plugin: string, method: string, opts: any) => {
        if (plugin === "DeviceVault") {
          if (method === "get") return { value: memory.get("credential") };
          if (method === "set") memory.set("credential", opts.value);
          if (method === "clear") memory.delete("credential");
          return {};
        }
        if (plugin === "Filesystem") {
          const key = opts.directory + ":" + opts.path;
          if (method === "readFile") {
            if (!memory.has(key)) throw Error("missing");
            return { data: memory.get(key) };
          }
          if (method === "writeFile") {
            memory.set(key, opts.data);
            return { uri: "file:///isolated-cache/" + opts.path };
          }
          if (method === "rmdir") return {};
          throw Error("unsupported FS " + method);
        }
        if (plugin === "CapacitorBarcodeScanner")
          return { ScanResult: payload };
        if (plugin === "Share") {
          shared++;
          sharedFiles.push(opts.files[0]);
          return {};
        }
        if (plugin === "App") return {};
        if (plugin !== "LocalSync") throw Error("unexpected plugin " + plugin);
        return new Promise((res, rej) => {
          const request = https.request(
            opts.url,
            {
              method: opts.method,
              ca: certificate,
              checkServerIdentity: (_host, cert) =>
                createHash("sha256").update(cert.raw).digest("hex") ===
                opts.fingerprint
                  ? undefined
                  : Error("电脑证书不一致"),
              headers: opts.headers,
            },
            (r) => {
              const body: Buffer[] = [];
              r.on("data", (v) => body.push(v));
              r.on("end", () =>
                res({
                  status: r.statusCode,
                  headers: r.headers,
                  body: Buffer.concat(body).toString("base64"),
                }),
              );
            },
          );
          request.on("error", rej);
          if (opts.body) request.write(Buffer.from(opts.body, "base64"));
          request.end();
        });
      },
    );
    await phone.addInitScript(() => {
      const plugins: Record<string, string[]> = {
        LocalSync: ["request"],
        DeviceVault: ["get", "set", "clear"],
        Filesystem: ["readFile", "writeFile", "rmdir"],
        App: ["addListener", "removeListener"],
        CapacitorBarcodeScanner: ["scanBarcode"],
        Share: ["share"],
      };
      (window as any).androidBridge = {};
      (window as any).Capacitor = {
        PluginHeaders: Object.entries(plugins).map(([name, methods]) => ({
          name,
          methods: methods.map((name) => ({ name, rtype: "promise" })),
        })),
        nativePromise: (plugin: string, method: string, options: any) =>
          (window as any).nativeLAN(plugin, method, options),
        nativeCallback: () => "test-listener",
      };
    });
    const mobile = await phone.newPage();
    await mobile.clock.install({ time: new Date() });
    await mobile.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await mobile.goto(ready.url + "/mobile");
    await mobile.getByRole("button", { name: "设置", exact: true }).click();
    await mobile
      .getByRole("button", { name: "扫描电脑二维码", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "确认授权此设备" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "确认授权此设备" }).click();
    await mobile.clock.runFor(2000);
    await expect(
      mobile.getByText("已配对电脑书库", { exact: true }),
    ).toBeVisible();
    await mobile
      .locator(".mobile-settings")
      .evaluate((el) => el.scrollTo(0, 0));
    await mobile.screenshot({
      path: join(readingEvidence, "phone-sync-settings-light.png"),
    });
    await mobile.getByRole("button", { name: "书架", exact: true }).click();
    await mobile.clock.runFor(31000);
    await expect(mobile.locator(".mobile-empty-shelf")).toContainText(
      "只带上你想读的书",
    );
    await page
      .getByRole("button", { name: "修改同步范围", exact: true })
      .click();
    await page
      .locator(".device-scope-editor")
      .getByLabel("文件选择方式")
      .selectOption("all");
    await page
      .getByRole("button", { name: "保存同步范围", exact: true })
      .click();
    await expect(
      page.getByText("同步范围已保存，下次手机同步时生效。", { exact: true }),
    ).toBeVisible();
    await mobile.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(
      mobile.getByRole("button", { name: /电脑原文.txt/ }),
    ).toBeVisible();
    await mobile.getByRole("button", { name: /电脑原文.txt/ }).click();
    await expect(mobile.locator(".plain-text")).toHaveText(text);
    await mobile.bringToFront();
    await mobile.clock.runFor(65000);
    await page
      .getByRole("button", { name: "关闭局域网同步", exact: true })
      .click();
    await mobile.bringToFront();
    await mobile.clock.runFor(17000);
    await mobile.getByRole("button", { name: "返回书库", exact: true }).click();
    await mobile.getByRole("button", { name: "设置", exact: true }).click();
    await mobile.getByRole("button", { name: "阅读数据", exact: true }).click();
    await expect(mobile.locator(".reading-stats")).toContainText(
      "阅读记录随所选书籍同步",
    );
    await mobile.screenshot({
      path: join(readingEvidence, "phone-statistics.png"),
    });
    await mobile.getByRole("button", { name: "导出数据", exact: true }).click();
    await expect.poll(() => shared).toBe(1);
    expect(sharedFiles[0]).toMatch(/\.csv$/);
    await mobile.getByRole("button", { name: "关闭阅读数据" }).click();
    await mobile.getByRole("button", { name: "书架", exact: true }).click();
    await mobile.getByRole("button", { name: /电脑原文.txt/ }).click();
    await expect(mobile.locator(".plain-text")).toHaveText(text);
    await mobile.locator(".plain-text").evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await mobile
      .getByLabel("手机笔记", { exact: true })
      .fill("无需云端，断开电脑时写的笔记。");
    await mobile
      .getByRole("button", { name: "保存手机笔记", exact: true })
      .click();
    await expect(mobile.locator(".plain-text")).toHaveText(text);
    await mobile.getByRole("button", { name: "返回书库", exact: true }).click();
    await mobile.getByRole("button", { name: "设置", exact: true }).click();
    await expect(mobile.locator(".mobile-sync-status")).toContainText(/离线|等待/);
    await page
      .getByRole("button", { name: "开启局域网同步", exact: true })
      .click();
    await mobile
      .getByRole("button", { name: "同步文件与笔记", exact: true })
      .click();
    await expect(mobile.locator(".mobile-sync-status")).toContainText("文件与笔记已同步");
    const readingData = await (
      await pc.request.get(ready.url + "/api/reading")
    ).json();
    expect(readingData.events.length).toBeGreaterThan(0);
    const intervals = readingData.events.map(
      (e: any) => e.endedAt - e.startedAt,
    );
    expect(
      intervals.reduce((a: number, b: number) => a + b, 0),
    ).toBeGreaterThanOrEqual(60000);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "阅读数据", exact: true }).click();
    await expect(page.locator(".reading-day-details")).toContainText(
      "电脑原文.txt",
    );
    await page.getByLabel("每日阅读目标（分钟）").fill("1");
    await page.getByRole("button", { name: "保存目标", exact: true }).click();
    await expect(page.locator(".reading-goal")).toContainText("今日目标已达成");
    await page.locator(".calendar-day.today").click();
    const csvDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出数据", exact: true }).click();
    expect((await csvDownload).suggestedFilename()).toContain("阅读数据.csv");
    await page.screenshot({
      path: join(readingEvidence, "desktop-statistics.png"),
    });
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({
      path: join(readingEvidence, "desktop-statistics-dark.png"),
    });
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    const notes = await (
      await pc.request.get(ready.url + `/api/workspaces/${ws.id}/notes`)
    ).json();
    expect(notes[0].messages[0].body).toBe("无需云端，断开电脑时写的笔记。");
    await mobile.getByRole("button", { name: "书架", exact: true }).click();
    await mobile.getByRole("button", { name: /电脑原文.txt/ }).click();
    await mobile
      .getByRole("button", { name: "导出本书 ORD", exact: true })
      .click();
    await expect.poll(() => shared).toBe(2);
    const evidence = resolve(
      process.env.OR_LAN_EVIDENCE_DIR || "docs/evidence/lan",
    );
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "pc-local-sync.png") });
    await mobile.screenshot({ path: join(evidence, "phone-local-reader.png") });
  } finally {
    await pc.close();
    await phone.close();
    if (service.exitCode === null) {
      const exited = new Promise((r) => service.once("exit", r));
      service.kill("SIGTERM");
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
