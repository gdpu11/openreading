import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("system EPUB opening handles startup, running apps and repeated opens", async () => {
  test.skip(process.platform !== "darwin");
  test.setTimeout(120000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-open-file-"));
  const material = join(dir, "Only the chosen book");
  await mkdir(material);
  const first = join(material, "系统打开 空格.EPUB");
  const second = join(material, "另一本书.epub");
  await copyFile(resolve("fixtures/封面与正文.epub"), first);
  await copyFile(first, second);
  const original = await readFile(first);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({
      args: [resolve("desktop/main.cjs"), first],
      executablePath: resolve(
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      env: {
        ...process.env,
        OR_DESKTOP_SMOKE: "1",
        OR_DESKTOP_DATA: join(dir, "data"),
      },
    });
    await expect.poll(() => app!.windows().length).toBe(2);
    const library = app.windows()[0];
    const reader = app.windows()[1];
    await expect(
      reader.frameLocator(".epub-container iframe").locator("body"),
    ).toBeVisible();
    const target = await reader.evaluate(
      () => window.openReadingDesktop!.readerTarget!,
    );
    const documents = () =>
      library.evaluate(
        async (workspace) =>
          (await fetch(`/api/workspaces/${workspace}/documents`)).json(),
        target.workspaceId,
      );
    expect((await documents()).items).toHaveLength(1);
    const sources = await library.evaluate(
      async (workspace) =>
        (await fetch(`/api/workspaces/${workspace}/sources`)).json(),
      target.workspaceId,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe("imported_collection");

    // The native open-file event is delivered to the running main process.
    await library.bringToFront();
    await expect
      .poll(() => library.evaluate(() => document.hasFocus()))
      .toBe(true);
    await app.evaluate(({ app }, path) => {
      for (let n = 0; n < 2; n++)
        app.emit("open-file", { preventDefault() {} } as any, path);
    }, first);
    await expect
      .poll(() => reader.evaluate(() => document.hasFocus()))
      .toBe(true);
    expect(app.windows()).toHaveLength(2);
    expect((await documents()).items).toHaveLength(1);
    expect(
      await reader.evaluate(
        () => window.openReadingDesktop!.readerTarget!.memberId,
      ),
    ).toBe(target.memberId);

    await app.evaluate(({ app }, path) => {
      app.emit("open-file", { preventDefault() {} } as any, path);
    }, second);
    await expect.poll(() => app!.windows().length).toBe(3);
    await expect(
      app.windows()[2].frameLocator(".epub-container iframe").locator("body"),
    ).toBeVisible();
    expect((await documents()).items).toHaveLength(2);
    expect(await readFile(first)).toEqual(original);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
