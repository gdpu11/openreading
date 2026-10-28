import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";

let server: Server;
let origin: string;

test.beforeAll(async () => {
  const root = resolve(
    process.env.OR_ANDROID_WEB_DIR || "internal/server/static",
  );
  // Serve the production assets, as Capacitor does, without a Go backend.
  server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    const file = resolve(
      root,
      "." + (["/", "/mobile"].includes(path) ? "/index.html" : path),
    );
    try {
      const body = await readFile(file);
      response.setHeader(
        "Content-Type",
        (
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".mjs": "text/javascript",
            ".css": "text/css",
          } as Record<string, string>
        )[extname(file)] || "application/octet-stream",
      );
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});

test.afterAll(async () => {
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
});

test("paired phone waits for a PC sync request across startup, foreground and reconnect", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("open-reading-language", "zh"));
  let bookRequests = 0;
  await page.route("**/api/sync/**", async (route) => {
    if (route.request().url().endsWith("/sync/status")) await route.fulfill({ json: { enabled: false } });
    else if (route.request().url().endsWith("/sync/reading")) await route.fulfill({json:{events:[],memberIds:[],goalMinutes:30}});
    else { bookRequests++; await route.fulfill({ status: 403, json: { message: "No PC selection" } }); }
  });
  await page.goto(origin + "/mobile");
  await expect(page.locator(".mobile-app")).toBeVisible();
  await page.evaluate(async (origin) => {
    const db = await new Promise<IDBDatabase>((done) => { const r = indexedDB.open("open-reading-mobile", 1); r.onupgradeneeded = () => r.result.createObjectStore("data"); r.onsuccess = () => done(r.result); });
    await new Promise<void>((done, reject) => {
      const tx = db.transaction("data", "readwrite");
      tx.objectStore("data").put(JSON.stringify({ origin, token: "b".repeat(64), deviceId: "phone", name: "我的 Android" }), "connection");
      tx.oncomplete = () => done(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, origin);
  await page.clock.install();
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("button",{name:"电脑与同步",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"电脑与同步",exact:true}).click();
  await expect(page.getByText("已配对电脑书库", { exact: true })).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(65000);
  expect(bookRequests).toBe(0);
  await expect(page.locator(".mobile-sync-status")).toContainText("选择想读的书");
  expect(await page.locator(".mobile-app").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  if (process.env.OR_EVIDENCE_DIR) {
    await mkdir(process.env.OR_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: resolve(process.env.OR_EVIDENCE_DIR, "phone-sync-settings-light.png") });
  }
  await page.getByRole("button",{name:"返回设置",exact:true}).click();
  await page.getByRole("button", { name: "书架", exact: true }).click();
  await expect(page.locator(".mobile-empty-shelf")).toContainText("只带上你想读的书");
  if (process.env.OR_EVIDENCE_DIR) await page.screenshot({ path: resolve(process.env.OR_EVIDENCE_DIR, "phone-sync-empty-shelf.png") });
  expect(await page.pageErrors()).toEqual([]);
});

test("Android production startup works without modern WebView built-ins", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    delete (globalThis as any).Iterator;
    delete (Promise as any).withResolvers;
    delete (Promise as any).try;
    delete (Map.prototype as any).getOrInsertComputed;
    localStorage.setItem("open-reading-language", "zh");
    // The native bridge identifies Android even at the root URL.
    (window as any).androidBridge = {};
    (window as any).Capacitor = {
      PluginHeaders: [
        { name: "DeviceVault", methods: [{ name: "get", rtype: "promise" }] },
        { name: "App", methods: [{ name: "addListener" }] },
      ],
      nativePromise: async () => ({}),
      nativeCallback: () => "test-listener",
    };
  });
  await page.goto(origin);
  await expect(
    page.getByRole("heading", { name: "书架", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("button",{name:"电脑与同步",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"电脑与同步",exact:true}).click();
  await expect(
    page.getByRole("heading", { name: "把阅读带在身边" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "扫描电脑二维码" }),
  ).toBeVisible();
  await expect(page.getByLabel("同步文件与笔记")).toHaveCount(0);
  await page.getByRole("button",{name:"返回设置",exact:true}).click();
  await page.getByRole("button",{name:"通用设置",exact:true}).click();
  await page.getByLabel("深色模式", { exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
});

test("mobile production PDF worker renders an offline PDF", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(origin + "/seed", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto(origin + "/seed");
  const pdf = await readFile("fixtures/双栏与扫描混合.pdf");
  const contentHash = createHash("sha256").update(pdf).digest("hex");
  await page.evaluate(
    async ({ contentHash, data, origin }) => {
      localStorage.setItem("open-reading-language", "zh");
      const database = await new Promise<IDBDatabase>((done, reject) => {
        const request = indexedDB.open("open-reading-mobile", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("data");
        request.onsuccess = () => done(request.result);
        request.onerror = () => reject(request.error);
      });
      const version = { id: "pdf-version", contentHash };
      await new Promise<void>((done, reject) => {
        const tx = database.transaction("data", "readwrite");
        const store = tx.objectStore("data");
        store.put(
          JSON.stringify({
            origin,
            deviceId: "phone",
            token: "test",
            name: "phone",
          }),
          "connection",
        );
        store.put(
          {
            outbox: [],
            drafts: {},
            library: {
              workspaces: [
                {
                  id: "workspace",
                  name: "离线书库",
                  documents: [
                    {
                      id: "pdf",
                      workspaceDocumentId: "pdf",
                      workspaceId: "workspace",
                      title: "兼容性 PDF",
                      format: "pdf",
                      version,
                      versions: [version],
                      threads: [],
                      manifests: [],
                    },
                  ],
                },
              ],
            },
          },
          "state",
        );
        store.put(
          new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
            type: "application/pdf",
          }),
          "blob:" + contentHash,
        );
        tx.oncomplete = () => done();
        tx.onerror = () => reject(tx.error);
      });
      database.close();
    },
    { contentHash, data: pdf.toString("base64"), origin },
  );
  await page.addInitScript(() => {
    delete (globalThis as any).Iterator;
    delete (Promise as any).withResolvers;
  });
  await page.goto(origin + "/mobile");
  await page.getByRole("button", { name: /兼容性 PDF/ }).click();
  const firstPage = page.locator('.pdf-page[data-page-index="0"]');
  await expect(firstPage.locator(".textLayer")).toContainText(
    "LEFT Idempotency",
  );
  await expect(firstPage.locator(".pdf-page-loading")).toHaveCount(0);
  expect(
    await firstPage
      .locator("canvas")
      .evaluate((canvas: HTMLCanvasElement) => canvas.width),
  ).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("Android scan starts automatically and hands the QR to native pairing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("open-reading-language", "zh");
    (window as any).androidBridge = {};
    const pairing = {
      origin: "https://192.168.1.2:53318",
      id: "a".repeat(32),
      secret: "b".repeat(64),
      certificateFingerprint: "c".repeat(64),
    };
    (window as any).__nativeCalls = [];
    (window as any).Capacitor = {
      PluginHeaders: [
        {
          name: "DeviceVault",
          methods: [
            { name: "get", rtype: "promise" },
            { name: "set", rtype: "promise" },
          ],
        },
        { name: "App", methods: [{ name: "addListener" }] },
        {
          name: "CapacitorBarcodeScanner",
          methods: [{ name: "scanBarcode", rtype: "promise" }],
        },
        { name: "LocalSync", methods: [{ name: "request", rtype: "promise" }] },
      ],
      nativeCallback: () => "test-listener",
      nativePromise: async (plugin: string, method: string, options: any) => {
        (window as any).__nativeCalls.push({ plugin, method, options });
        if (plugin === "CapacitorBarcodeScanner")
          return {
            ScanResult:
              pairing.origin +
              "/mobile#pair=" +
              encodeURIComponent(JSON.stringify(pairing)),
            format: 0,
          };
        if (plugin === "LocalSync")
          return {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: btoa(
              JSON.stringify({ state: "claimed", fingerprint: "123456" }),
            ),
          };
        return {};
      },
    };
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("button",{name:"电脑与同步",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"电脑与同步",exact:true}).click();
  await page
    .getByRole("button", { name: "扫描电脑二维码", exact: true })
    .click();
  await expect(page.locator(".mobile-approval")).toContainText("123456");
  await expect(page.locator(".mobile-approval")).toContainText("请在电脑上核对确认码");
  const calls = await page.evaluate(() => (window as any).__nativeCalls);
  const scan = calls.find(
    (call: any) => call.plugin === "CapacitorBarcodeScanner",
  );
  expect(scan.options).toMatchObject({ hint: 0, scanButton: false });
  const claim = calls.find(
    (call: any) =>
      call.plugin === "LocalSync" &&
      call.options.url.endsWith("/api/pair/claim"),
  );
  expect(claim.options.fingerprint).toBe("c".repeat(64));
  expect(claim.options.method).toBe("POST");
});
