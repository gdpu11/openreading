import { test, expect, chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("A18 Chrome Firefox and WebKit pair with one code and keep independent sessions", async () => {
  test.setTimeout(60000);
  const evidence = path.resolve("docs/evidence");
  await mkdir(evidence, { recursive: true });
  const dataDir = await mkdtemp(path.join(tmpdir(), "openreading-pairing-"));
  const processHandle: ChildProcess = spawn(path.resolve("release/openreading"), ["--data-dir", dataDir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const browsers: Browser[] = [];
  const contexts: BrowserContext[] = [];
  try {
    const { base, code } = await new Promise<{ base: string; code: string }>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(Error("Pairing server startup timed out")), 10000);
      processHandle.stdout!.on("data", chunk => {
        output += chunk;
        const base = output.match(/打开：(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        const code = output.match(/配对码：([a-f0-9]+)/)?.[1];
        if (base && code) {
          clearTimeout(timer);
          resolve({ base, code });
        }
      });
      processHandle.on("error", reject);
      processHandle.on("exit", () => {
        clearTimeout(timer);
        reject(Error("Pairing server exited during startup"));
      });
    });
    browsers.push(await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }));
    browsers.push(await firefox.launch({ executablePath: firefox.executablePath(), headless: true, timeout: 10000 }));
    browsers.push(await webkit.launch({ executablePath: webkit.executablePath(), headless: true, timeout: 10000 }));
    const pages: Page[] = [];
    for (const browser of browsers) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
      contexts.push(context);
      pages.push(await context.newPage());
    }
    const pair = async (page: Page) => {
      await page.addInitScript(() => localStorage.setItem("open-reading-language", "zh"));
      await page.goto(base);
      await expect(page.getByText("同一配对码支持多个浏览器", { exact: false })).toBeVisible();
      await page.getByLabel("本机配对码").fill(code);
      await page.getByRole("button", { name: "进入阅读空间" }).click();
      await expect(page.locator(".workspace-rail")).toBeVisible();
    };
    await pair(pages[0]);
    await pages[0].getByRole("button", { name: "新建工作区", exact: true }).click();
    await pages[0].getByLabel("工作区名称").fill("多浏览器共享阅读");
    await pages[0].getByRole("button", { name: "创建工作区", exact: true }).click();
    await expect(pages[0].getByRole("button", { name: "切换工作区 多浏览器共享阅读", exact: true })).toBeVisible();
    // The first successful login must not consume the code for either browser.
    await Promise.all([pair(pages[1]), pair(pages[2])]);
    const cookies: string[] = [], csrf: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      await expect(pages[i].getByRole("button", { name: "切换工作区 多浏览器共享阅读", exact: true })).toBeVisible();
      const cookie = (await contexts[i].cookies()).find(c => c.name === "openreading_session");
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe("Strict");
      cookies.push(cookie!.value);
      const response = await contexts[i].request.get(base + "/api/me");
      expect(response.status()).toBe(200);
      csrf.push((await response.json()).csrf);
      await pages[i].reload();
      await expect(pages[i].locator(".workspace-rail")).toBeVisible();
      expect(await pages[i].pageErrors()).toEqual([]);
    }
    expect(new Set(cookies).size).toBe(3);
    expect(new Set(csrf).size).toBe(3);
    const crossSession = await contexts[1].request.post(base + "/api/workspaces", { data: { name: "cross-session csrf must fail" }, headers: { "X-CSRF-Token": csrf[0] } });
    expect(crossSession.status()).toBe(403);
    for (let i = 0; i < contexts.length; i++) {
      const result = await contexts[i].request.post(base + "/api/workspaces", { data: { name: `浏览器 ${i + 1} 写入` }, headers: { "X-CSRF-Token": csrf[i] } });
      expect(result.status()).toBe(200);
    }
    await pages[0].reload();
    await expect(pages[0].getByRole("button", { name: "切换工作区 浏览器 3 写入", exact: true })).toBeVisible();
    await pages[0].screenshot({ path: path.join(evidence, "multibrowser-chrome.png") });
    await writeFile(path.join(evidence, "multibrowser.json"), JSON.stringify({ date: new Date().toISOString(), engines: browsers.map(browser => ({ name: browser.browserType().name(), version: browser.version() })), sameServer: true, samePairingCode: true, independentSessionCookies: true, independentCSRF: true, crossSessionCSRFRejected: true, previousBrowserRemainsAuthenticated: true, refreshRestoresEachSession: true, eachBrowserWritesSharedData: true, pageErrors: [] }, null, 2));
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    if (processHandle.exitCode === null) {
      const exited = new Promise<void>(resolve => processHandle.once("exit", () => resolve()));
      processHandle.kill("SIGINT");
      await exited;
    }
  }
});
