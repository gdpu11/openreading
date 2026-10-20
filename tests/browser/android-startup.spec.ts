import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
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
    page.getByRole("heading", { name: "把阅读带在身边" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "扫描电脑二维码" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("扫码直连同一网络中的电脑");
  await page.getByRole("button", { name: "切换黑白主题" }).click();
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
  await expect(firstPage.locator(".textLayer")).toContainText("LEFT Idempotency");
  await expect(firstPage.locator(".pdf-page-loading")).toHaveCount(0);
  expect(
    await firstPage
      .locator("canvas")
      .evaluate((canvas: HTMLCanvasElement) => canvas.width),
  ).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
