import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.use({ trace: "off", screenshot: "off" });
test("phone offline reading time merges both ways without downloading books again", async ({
  browser,
}) => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-reading-sync-"));
  const code = "e".repeat(64);
  const child = spawn(
    resolve(process.env.OR_TEST_BINARY || "desktop/runtime/openreading"),
    [
      "--port",
      "0",
      "--data-dir",
      join(dir, "data"),
      "--machine-readable",
      "--public-url",
      "https://reader.example.invalid",
    ],
    {
      env: { ...process.env, OPENREADING_ACCESS_CODE: code },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.resume();
  const pc = await browser.newContext();
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const ready = await new Promise<any>((done, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(Error("startup timeout")), 10000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        try {
          const value = JSON.parse(output.trim());
          clearTimeout(timer);
          done(value);
        } catch {}
      });
      child.once("error", reject);
      child.once("exit", () => reject(Error("server exited")));
    });
    const login = await pc.request.post(ready.url + "/api/session", {
      data: { code },
    });
    const headers = { "X-CSRF-Token": (await login.json()).csrf };
    const api = async (
      path: string,
      body?: any,
      method = body === undefined ? "GET" : "POST",
    ) => {
      const r = await pc.request.fetch(ready.url + "/api" + path, {
        method,
        headers,
        data: body,
      });
      expect(r.ok(), await r.text()).toBeTruthy();
      return r.json();
    };
    const ws = await api("/workspaces", { name: "跨设备阅读" });
    const imported = await pc.request.post(
      ready.url + `/api/workspaces/${ws.id}/imports`,
      {
        headers,
        multipart: {
          files: {
            name: "随身阅读.txt",
            mimeType: "text/plain",
            buffer: Buffer.from(
              "阅读时间也应该跟着书走。\n\n离线阅读，回来继续。\n".repeat(20),
            ),
          },
        },
      },
    );
    expect(imported.ok()).toBeTruthy();
    const source = await imported.json();
    await expect
      .poll(async () => (await api("/scans/" + source.scan.id)).state)
      .toBe("completed");
    const book = (await api(`/workspaces/${ws.id}/documents`)).items[0];
    const grant = await api("/pair/grants", {
      workspaceIds: [ws.id],
      syncScope: { mode: "manual", memberIds: [book.id] },
    });
    const token = "d".repeat(64);
    const claim = await pc.request.post(ready.url + "/api/pair/claim", {
      headers: {
        Authorization: "Bearer " + token,
        Origin: "capacitor://localhost",
      },
      data: { id: grant.id, secret: grant.secret, token, name: "阅读测试手机" },
    });
    expect(claim.ok()).toBeTruthy();
    const device = await api(`/pair/grants/${grant.id}/approve`, {});
    await api(
      `/devices/${device.id}/scope`,
      {
        workspaceIds: [ws.id],
        syncScope: { mode: "manual", memberIds: [book.id] },
      },
      "PUT",
    );
    const start = Date.now() - 3600000;
    const desktop = {
      id: "desktop-reading-" + crypto.randomUUID(),
      member: book.id,
      startedAt: start,
      endedAt: start + 30000,
    };
    await api("/reading/events", { events: [desktop] });
    let offline = false;
    await phone.route("**/api/sync/**", (route) =>
      offline ? route.abort("failed") : route.continue(),
    );
    const page = await phone.newPage();
    await page.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await page.goto(ready.url + "/mobile");
    await page.locator(".mobile-app").waitFor();
    await page.evaluate(
      async (conn) => {
        const db = await new Promise<IDBDatabase>((done, reject) => {
          const r = indexedDB.open("open-reading-mobile", 1);
          r.onsuccess = () => done(r.result);
          r.onerror = () => reject(r.error);
        });
        await new Promise<void>((done, reject) => {
          const tx = db.transaction("data", "readwrite");
          tx.objectStore("data").put(JSON.stringify(conn), "connection");
          tx.oncomplete = () => done();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      },
      { origin: ready.url, token, deviceId: device.id, name: "阅读测试手机" },
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: /随身阅读.txt/ }),
    ).toBeVisible();
    offline = true;
    await page.clock.install();
    await page.getByRole("button", { name: /随身阅读.txt/ }).click();
    await expect(page.locator(".plain-text")).toContainText(
      "阅读时间也应该跟着书走",
    );
    await page.bringToFront();
    await expect(page.getByLabel("累计阅读时长", { exact: true })).toHaveText(
      "00:30",
    );
    await page.clock.runFor(17000);
    await expect(page.getByLabel("本次阅读时长", { exact: true })).toHaveText(
      /00:1[6-9]/,
    );
    await page.locator(".plain-text").click();
    await page.getByRole("button", { name: "返回书库", exact: true }).click();
    const readState = () =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((done) => {
          const r = indexedDB.open("open-reading-mobile", 1);
          r.onsuccess = () => done(r.result);
        });
        const s = await new Promise<any>((done) => {
          const r = db.transaction("data").objectStore("data").get("state");
          r.onsuccess = () => done(r.result);
        });
        db.close();
        return s;
      });
    await expect
      .poll(async () => ((await readState()).readingEvents || []).length)
      .toBeGreaterThan(0);
    const pending = (await readState()).readingEvents;
    const localMs = pending.reduce(
      (n: number, e: any) => n + e.endedAt - e.startedAt,
      0,
    );
    expect(localMs).toBeGreaterThanOrEqual(16000);
    await page.reload(); // All pending intervals survive a new app instance.
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button",{name:"电脑与同步",exact:true}).click();
    await expect(page.locator(".mobile-reading-sync-status")).toContainText(
      /已保存|本机/,
    );
    let manifests = 0;
    await phone.route("**/api/sync/library", async (route) => {
      manifests++;
      await route.abort("failed");
    });
    offline = false;
    await page
      .getByRole("button", { name: "同步阅读时间", exact: true })
      .click();
    await expect(page.locator(".mobile-reading-sync-status")).toContainText(
      "阅读时间已同步",
    );
    const first = await api("/reading");
    expect(first.events.map((e: any) => e.id).sort()).toEqual(
      [desktop.id, ...pending.map((e: any) => e.id)].sort(),
    );
    await page
      .getByRole("button", { name: "同步阅读时间", exact: true })
      .click();
    await expect(page.locator(".mobile-reading-sync-status")).toContainText(
      "阅读时间已同步",
    );
    expect((await api("/reading")).events).toHaveLength(first.events.length);
    expect((await readState()).readingEvents).toEqual([]);
    // A PC-only new interval reaches the phone through the same lightweight path.
    const later = {
      ...desktop,
      id: "later-desktop-" + crypto.randomUUID(),
      startedAt: start + 30000,
      endedAt: start + 45000,
    };
    await api("/reading/events", { events: [later] });
    await page
      .getByRole("button", { name: "同步阅读时间", exact: true })
      .click();
    await expect
      .poll(async () => ((await readState()).readingData?.events || []).length)
      .toBe(first.events.length + 1);
    await page.getByRole("button", { name: "阅读数据", exact: true }).click();
    await expect(page.locator(".reading-day-details")).toContainText(
      "随身阅读.txt",
    );
    await page
      .getByRole("button", { name: "关闭阅读数据", exact: true })
      .click();
    if(await page.getByRole("button",{name:"返回设置",exact:true}).count())await page.getByRole("button",{name:"返回设置",exact:true}).click();
    await page.getByRole("button", { name: "书架", exact: true }).click();
    await page.getByRole("button", { name: /随身阅读.txt/ }).click();
    const total = await page
      .getByLabel("累计阅读时长", { exact: true })
      .textContent();
    const seconds = total!.split(":").reduce((n, v) => n * 60 + Number(v), 0);
    expect(seconds).toBeGreaterThanOrEqual(
      Math.floor((45000 + localMs) / 1000),
    );
    // Removing a connection must wait for the independent reading ledger too;
    // otherwise its late receipt can recreate the just-cleared phone state.
    await page.locator(".plain-text").click();
    await page.getByRole("button", { name: "返回书库", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "电脑与同步", exact: true }).click();
    let releaseLedger!: () => void;
    const blockedLedger = new Promise<void>(resolve => { releaseLedger = resolve; });
    let ledgerStarted = false;
    await phone.route("**/api/sync/reading", async route => {
      ledgerStarted = true;
      await blockedLedger;
      await route.continue();
    });
    await page.getByRole("button", { name: "同步阅读时间", exact: true }).click();
    await expect.poll(() => ledgerStarted).toBe(true);
    await page.getByText("连接详情与移除", { exact: true }).click();
    let confirmations = 0;
    page.on("dialog", async dialog => { confirmations++; await dialog.dismiss(); });
    await page.getByRole("button", { name: "移除连接与手机缓存", exact: true }).click();
    await expect(page.getByText("请等本次同步完成后再移除连接", { exact: true })).toBeVisible();
    expect(confirmations).toBe(0);
    expect((await readState()).library.workspaces.flatMap((w: any) => w.documents)).toHaveLength(1);
    releaseLedger();
    await expect(page.locator(".mobile-reading-sync-status")).toContainText("阅读时间已同步");
    // The independent button never touches the deliberately unavailable manifest.
    expect(manifests).toBe(0);
    expect(await page.pageErrors()).toEqual([]);
  } finally {
    await pc.close();
    await phone.close();
    if (child.exitCode === null) {
      const stopped = new Promise<void>((done) =>
        child.once("exit", () => done()),
      );
      child.kill("SIGTERM");
      await stopped;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
