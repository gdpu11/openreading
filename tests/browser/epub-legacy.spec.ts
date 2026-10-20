import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test.use({ trace: "off", screenshot: "off" });
test("Electron legacy EPUB displays live progress and reopens at the saved position", async () => {
  test.skip(
    process.platform !== "darwin" || !process.env.OR_REAL_EPUB,
    "Requires an authorized local EPUB on Mac",
  );
  const dir = await mkdtemp(join(tmpdir(), "openreading-native-epub-"));
  let app: any;
  try {
    await mkdir(join(dir, "material"));
    await copyFile(
      process.env.OR_REAL_EPUB!,
      join(dir, "material", "Private.epub"),
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
    const library = await app.firstWindow();
    await library.waitForURL(/127.0.0.1/);
    await expect(
      library.getByRole("heading", { name: "Welcome to Open Reading." }),
    ).toBeVisible();
    await library.evaluate(
      async (sourcePath: string) => {
        const me = await (await fetch("/api/me")).json();
        const mutate = async (url: string, method: string, body: any) => {
          const r = await fetch("/api" + url, {
            method,
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": me.csrf,
            },
            body: JSON.stringify(body),
          });
          if (!r.ok) throw Error(await r.text());
          return r.json();
        };
        const workspace = await mutate("/workspaces", "POST", {
          name: "EPUB compatibility",
        });
        await mutate("/preferences", "PUT", {
          language: "zh",
          epubFlow: "paginated",
          epubSpread: true,
        });
        localStorage.setItem("open-reading-language", "zh");
        const source = await mutate(
          `/workspaces/${workspace.id}/sources`,
          "POST",
          { path: sourcePath, label: "Private book" },
        );
        for (let i = 0; i < 100; i++) {
          if (
            (await (await fetch(`/api/scans/${source.scan.id}`)).json())
              .state === "completed"
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw Error("EPUB scan incomplete");
      },
      join(dir, "material"),
    );
    await library.reload();
    let opening = app.waitForEvent("window");
    await library.locator(".library-book").click();
    let book = await opening;
    await expect(
      book.frameLocator(".epub-container iframe").locator("body"),
    ).toContainText("从优秀到卓越");
    let slider = book.getByRole("slider", { name: "整本阅读进度" });
    await expect(slider).toBeEnabled();
    await book.getByRole("button", { name: "下一页", exact: true }).click();
    await expect
      .poll(async () =>
        parseFloat((await book.getByLabel("阅读进度百分比").textContent())!),
      )
      .toBeGreaterThan(0);
    const rect = (await slider.boundingBox())!;
    await slider.click({
      position: { x: rect.width * 0.55, y: rect.height / 2 },
    });
    await expect(slider).toHaveAttribute("aria-busy", "false");
    await expect
      .poll(async () =>
        parseFloat((await book.getByLabel("阅读进度百分比").textContent())!),
      )
      .toBeGreaterThan(50);
    await expect(
      book.frameLocator(".epub-container iframe").locator("body"),
    ).toBeVisible();
    const closed = book.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }: any) =>
      BrowserWindow.getAllWindows()
        .find((w: any) => w.readerTarget)
        .close(),
    );
    await closed;
    opening = app.waitForEvent("window");
    await library.locator(".library-book").click();
    book = await opening;
    slider = book.getByRole("slider", { name: "整本阅读进度" });
    await expect(slider).toBeEnabled();
    await expect
      .poll(async () =>
        parseFloat((await book.getByLabel("阅读进度百分比").textContent())!),
      )
      .toBeGreaterThan(50);
    expect(await book.pageErrors()).toEqual([]);
    const evidence = resolve(
      process.env.OR_NATIVE_EVIDENCE_DIR ||
        "docs/evidence/epub-entities/native",
    );
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "private-book.json"),
      JSON.stringify(
        {
          nativeWindows: true,
          bodyReadable: true,
          progressRestored: true,
          bookRedistributed: false,
        },
        null,
        2,
      ),
    );
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
