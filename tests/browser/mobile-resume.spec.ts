import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

test.use({ trace: "off", screenshot: "off" });
test("phone restarts with completed files cached and a partial file resumed at its saved byte range", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-resume-"));
  const service = spawn(
    resolve("desktop/runtime/openreading"),
    ["--port", "0", "--data-dir", dir, "--machine-readable"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  let release = () => {};
  const resumed = new Promise<void>((done) => {
    release = done;
  });
  try {
    const base = await new Promise<string>((done, reject) => {
      let out = "";
      const timeout = setTimeout(
        () => reject(Error("Service startup timed out")),
        10000,
      );
      service.stdout.on("data", (chunk) => {
        out += chunk;
        try {
          const ready = JSON.parse(out.trim());
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
    const chunkSize = 2 * 1024 * 1024;
    const files = [
      Buffer.from("已下载的小文件"),
      Buffer.alloc(chunkSize * 2 + 17, 120),
    ];
    const hashes = files.map((bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    );
    const documents = files.map((bytes, i) => ({
      id: "book" + i,
      title: i ? "需要续传.txt" : "已下载.txt",
      format: "txt",
      version: {
        id: "version" + i,
        contentHash: hashes[i],
        size: bytes.length,
      },
      versions: [
        { id: "version" + i, contentHash: hashes[i], size: bytes.length },
      ],
      threads: [],
      manifests: [],
    }));
    const library = {
      workspaces: [{ id: "workspace", name: "断点续传", documents }],
      syncedAt: new Date().toISOString(),
    };
    const ranges: string[][] = [[], []];
    let restart = false,
      finished = false;
    await context.route("**/api/sync/**", async (route) => {
      if (finished) {
        await route.abort("failed");
        return;
      }
      if (route.request().url().endsWith("/sync/library")) {
        await route.fulfill({ json: library });
        return;
      }
      const index = Number(
        /\/files\/version(\d)/.exec(route.request().url())?.[1],
      );
      const range = route.request().headers().range;
      expect(range).toMatch(/^bytes=\d+-\d+$/);
      ranges[index].push(range);
      const [start, last] = range.slice(6).split("-").map(Number),
        bytes = files[index],
        end = Math.min(last, bytes.length - 1);
      if (index === 1 && start === chunkSize) {
        if (!restart) {
          await route.abort("failed");
          return;
        }
        await resumed;
      }
      await route.fulfill({
        status: 206,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        },
        body: bytes.subarray(start, end + 1),
      });
    });
    let phone = await context.newPage();
    await phone.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await phone.goto(base + "/mobile");
    await expect(
      phone.getByRole("button", { name: "扫描电脑二维码", exact: true }),
    ).toBeVisible();
    await phone.evaluate(async (origin) => {
      const db = await new Promise<IDBDatabase>((done, reject) => {
        const req = indexedDB.open("open-reading-mobile", 1);
        req.onsuccess = () => done(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((done, reject) => {
        const tx = db.transaction("data", "readwrite");
        tx.objectStore("data").put(
          JSON.stringify({
            origin,
            token: "a".repeat(64),
            name: "测试手机",
            deviceId: "phone",
          }),
          "connection",
        );
        tx.oncomplete = () => done();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, base);
    await phone.reload();
    await expect(phone.locator(".mobile-status")).toContainText("进度已保存");
    expect(ranges[0]).toHaveLength(1);
    expect(ranges[1]).toEqual([
      `bytes=0-${chunkSize - 1}`,
      `bytes=${chunkSize}-${chunkSize * 2 - 1}`,
    ]);
    // A new page has no in-memory download state, as when a WebView is reopened.
    await phone.close();
    restart = true;
    phone = await context.newPage();
    await phone.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await phone.goto(base + "/mobile");
    await expect(phone.locator(".mobile-status")).toContainText(
      "已同步 1/2 个文件",
    );
    release();
    await expect(phone.locator(".mobile-status")).toHaveText(
      "文件与笔记已同步",
    );
    expect(ranges[0]).toHaveLength(1);
    expect(ranges[1]).toEqual([
      `bytes=0-${chunkSize - 1}`,
      `bytes=${chunkSize}-${chunkSize * 2 - 1}`,
      `bytes=${chunkSize}-${chunkSize * 2 - 1}`,
      `bytes=${chunkSize * 2}-${files[1].length - 1}`,
    ]);
    const saved = await phone.evaluate(async (key) => {
      const db = await new Promise<IDBDatabase>((done) => {
        const r = indexedDB.open("open-reading-mobile", 1);
        r.onsuccess = () => done(r.result);
      });
      const blob = await new Promise<Blob>((done) => {
        const r = db
          .transaction("data")
          .objectStore("data")
          .get("blob:" + key);
        r.onsuccess = () => done(r.result);
      });
      db.close();
      return { size: blob.size, first: (await blob.text()).slice(0, 3) };
    }, hashes[1]);
    expect(saved).toEqual({ size: files[1].length, first: "xxx" });
    finished = true;
    await phone.reload();
    await expect(
      phone.getByRole("button", { name: /需要续传.txt/ }),
    ).toBeVisible();
    await expect(
      phone.getByRole("button", { name: /已下载.txt/ }),
    ).toBeVisible();
    expect(await phone.pageErrors()).toEqual([]);
  } finally {
    release();
    await context.close();
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
