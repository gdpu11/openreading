import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Cumulative reading survives reopening, merges receipts and stays separate from the session timer", async ({
  page,
}) => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), "openreading-cumulative-"));
  let server: ChildProcess | undefined;
  try {
    const material = join(directory, "books");
    await mkdir(material);
    await writeFile(
      join(material, "读书这件小事.md"),
      "# 读书这件小事\n\n今天读了一点，明天再接着读。\n\n不用一次读完，也能看见自己投入的时间。\n",
    );
    await writeFile(
      join(material, "另一本书.txt"),
      "每本书的阅读时间分别记录。",
    );
    server = spawn(
      resolve(process.env.OR_TEST_BINARY || "release/openreading"),
      [
        "--port",
        "0",
        "--machine-readable",
        "--data-dir",
        join(directory, "data"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stderr!.resume();
    const ready = await new Promise<{ url: string; code: string }>(
      (done, reject) => {
        let buffer = "";
        const timeout = setTimeout(
          () => reject(Error("service startup timeout")),
          10000,
        );
        server!.once("error", reject);
        server!.stdout!.on("data", (chunk) => {
          buffer += chunk;
          for (const line of buffer.split("\n").slice(0, -1)) {
            const value = JSON.parse(line);
            if (value.type === "ready") {
              clearTimeout(timeout);
              done(value);
            }
          }
          buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
        });
      },
    );
    await page.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await page.goto(ready.url);
    await page.getByLabel("本机配对码").fill(ready.code);
    await page.getByRole("button", { name: /进入阅读空间/ }).click();
    await expect(page.locator(".workspace-rail")).toBeVisible();
    const csrf = (await (await page.request.get(ready.url + "/api/me")).json())
      .csrf;
    const post = async (path: string, data: unknown) => {
      const response = await page.request.post(ready.url + "/api" + path, {
        data,
        headers: { "X-CSRF-Token": csrf },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };
    const workspace = await post("/workspaces", { name: "阅读时间验证" });
    const source = await post(`/workspaces/${workspace.id}/sources`, {
      path: material,
      label: "演示书库",
    });
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(ready.url + `/api/scans/${source.scan.id}`)
            ).json()
          ).state,
      )
      .toBe("completed");
    const docs = (
      await (
        await page.request.get(
          ready.url + `/api/workspaces/${workspace.id}/documents`,
        )
      ).json()
    ).items;
    const book = docs.find((d: any) => d.format === "markdown"),
      other = docs.find((d: any) => d.format === "txt");
    const start = Date.now() - 86400000;
    const receipt = (member: string, from: number, to: number) => ({
      id: crypto.randomUUID(),
      member,
      startedAt: from,
      endedAt: to,
    });
    const original = receipt(book.id, start, start + 60000);
    await post("/reading/events", {
      events: [
        original,
        original,
        receipt(book.id, start + 30000, start + 90000),
        receipt(other.id, start, start + 60000),
      ],
    });
    await page.reload();
    await expect(page.locator(".file-item")).toHaveCount(2);
    await page.evaluate(
      async (events) => {
        await new Promise<void>((done, reject) => {
          const open = indexedDB.open("openreading-recovery", 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result,
              tx = db.transaction("drafts", "readwrite");
            for (const e of events)
              tx.objectStore("drafts").put(e, "reading-event:" + e.id);
            tx.oncomplete = () => {
              db.close();
              done();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      },
      [original, receipt(book.id, start - 86400000, start - 86400000 + 30000)],
    );
    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page
      .locator(".file-item")
      .filter({ hasText: "读书这件小事.md" })
      .click();
    await expect(page.getByRole("article")).toContainText("今天读了一点");
    const total = page.getByLabel("累计阅读时长", { exact: true }),
      session = page.getByLabel("本次阅读时长", { exact: true });
    const seconds = async () =>
      (await total.textContent())!
        .split(":")
        .reduce((sum, part) => sum * 60 + Number(part), 0);
    await expect(total).toHaveText("02:00");
    const before = await seconds();
    await page.clock.runFor(5000);
    expect(await seconds()).toBe(before + 5);
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        value: () => false,
      });
      window.dispatchEvent(new Event("blur"));
    });
    const paused = await seconds();
    await page.clock.runFor(30000);
    expect(await seconds()).toBe(paused);
    await page.reload();
    await page
      .locator(".file-item")
      .filter({ hasText: "读书这件小事.md" })
      .click();
    await expect(session).toHaveText("00:00");
    await expect.poll(seconds).toBeGreaterThanOrEqual(paused);
    await page
      .locator(".file-item")
      .filter({ hasText: "另一本书.txt" })
      .click();
    await expect(total).toHaveText("01:00");
    await page.route("**/api/reading/documents/*", (route) => route.abort());
    await page
      .locator(".file-item")
      .filter({ hasText: "读书这件小事.md" })
      .click();
    await expect(total).toHaveText("暂不可用");
    await page.unroute("**/api/reading/documents/*");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(seconds).toBeGreaterThanOrEqual(paused);
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect(total).toBeVisible();
    await expect(session).toBeVisible();
    await page.screenshot({
      path: join(
        process.env.OR_EVIDENCE_DIR || directory,
        "cumulative-reading.png",
      ),
    });
    expect(await page.pageErrors()).toEqual([]);
  } finally {
    server?.kill("SIGINT");
    await rm(directory, { recursive: true, force: true });
  }
});
