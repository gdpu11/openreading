import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.use({ trace: "off", screenshot: "off" });
test("Native reading timer recovers from a stale activation sample and excludes background time", async () => {
  test.skip(process.platform !== "darwin");
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-reading-focus-"));
  const material = join(dir, "material");
  await mkdir(material);
  await copyFile("fixtures/可靠接口.epub", join(material, "Book.epub"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({
      args: [resolve("desktop/main.cjs")],
      executablePath: resolve(
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      env: {
        ...process.env,
        OR_DESKTOP_SMOKE: "1",
        OR_DESKTOP_DATA: join(dir, "data"),
      },
    });
    const library = await app.firstWindow();
    await library.waitForURL(/127.0.0.1/);
    await library.evaluate(async (sourcePath) => {
      const me = await (await fetch("/api/me")).json();
      const post = async (path: string, body: unknown, method = "POST") => {
        const response = await fetch("/api" + path, {
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
      const workspace = await post("/workspaces", { name: "Focus test" });
      await post("/preferences", { language: "zh" }, "PUT");
      localStorage.setItem("open-reading-language", "zh");
      const source = await post(`/workspaces/${workspace.id}/sources`, {
        path: sourcePath,
        label: "Book",
      });
      for (let i = 0; i < 100; i++) {
        const scan = await (await fetch(`/api/scans/${source.scan.id}`)).json();
        if (scan.state === "completed") return;
        await new Promise((done) => setTimeout(done, 30));
      }
      throw Error("Scan timed out");
    }, material);
    await library.reload();
    const opened = app.waitForEvent("window");
    await library.locator(".library-book").click();
    const book = await opened;
    await book.clock.install();
    await book.reload();
    await expect(
      book.frameLocator(".epub-container iframe").locator("body"),
    ).toContainText("接口重试");
    await book.clock.pauseAt(await book.evaluate(() => Date.now() + 1000));
    const focus = async (reader: boolean) =>
      app!.evaluate(({ app, BrowserWindow }, reader) => {
        const window = BrowserWindow.getAllWindows().find(
          (w) => !!(w as any).readerTarget === reader,
        )!;
        window.show();
        window.focus();
        app.focus({ steal: true });
      }, reader);
    const timer = book.locator(".session-timer");
    const seconds = async () =>
      (await timer.locator("output").textContent())!
        .split(":")
        .reduce((sum, part) => sum * 60 + Number(part), 0);
    await focus(true);
    await expect(timer).toHaveAttribute("data-state", "running");
    await book.clock.runFor(5000);
    const started = await seconds();
    expect(started).toBeGreaterThanOrEqual(4);

    // macOS can deliver activation before isFocused reports the settled state.
    // Reproduce that single stale sample, then restore the real native getter.
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (w) => (w as any).readerTarget,
      )!;
      (window as any).isFocused = () => false;
      try {
        window.emit("focus");
      } finally {
        delete (window as any).isFocused;
      }
      await window.webContents.executeJavaScript("Promise.resolve()");
    });
    await expect(timer).toHaveAttribute("data-state", "paused");
    await expect(timer).toHaveAttribute("data-state", "running", {
      timeout: 3500,
    });
    expect(await seconds()).toBe(started);
    await book.clock.runFor(5000);
    expect(await seconds()).toBe(started + 5);

    await focus(false);
    await expect(timer).toHaveAttribute("data-state", "paused");
    const paused = await seconds();
    await book.clock.runFor(30000);
    expect(await seconds()).toBe(paused);
    await focus(true);
    await expect(timer).toHaveAttribute("data-state", "running");
    await book.clock.runFor(5000);
    expect(await seconds()).toBe(paused + 5);
    await book.clock.runFor(121000);
    await expect(timer).toHaveAttribute("data-state", "paused");
    // Periodic native calibration must preserve the two-minute idle deadline.
    await book.waitForTimeout(1500);
    await expect(timer).toHaveAttribute("data-state", "paused");
    await focus(false);
    await expect(timer).toHaveAttribute("data-state", "paused");
    await focus(true);
    await expect(timer).toHaveAttribute("data-state", "running");
    expect(await book.pageErrors()).toEqual([]);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
