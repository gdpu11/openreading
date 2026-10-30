import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

test("desktop OCR converts a scanned PDF into readable EPUB text", async () => {
  test.skip(process.platform !== "darwin", "Uses the real macOS OCR engine");
  test.setTimeout(120000);
  const dir = await mkdtemp(join(tmpdir(), "openreading-scanned-conversion-"));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
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
    const png = await library.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 1600;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 1200, 1600);
      ctx.fillStyle = "black";
      ctx.font = "48px Arial";
      ctx.fillText("SCANNED READING SAMPLE", 70, 140);
      ctx.fillText("Books can become selectable text.", 70, 230);
      ctx.fillText("扫描书籍可以识别为文字。", 70, 320);
      ctx.fillStyle = "#d4e7ff";
      ctx.fillRect(90, 500, 700, 380);
      ctx.strokeStyle = "#2255aa";
      ctx.lineWidth = 8;
      ctx.strokeRect(90, 500, 700, 380);
      ctx.beginPath();
      ctx.moveTo(160, 800);
      ctx.lineTo(300, 690);
      ctx.lineTo(480, 720);
      ctx.lineTo(700, 580);
      ctx.stroke();
      ctx.fillStyle = "black";
      ctx.font = "30px Arial";
      ctx.fillText("Revenue chart", 150, 550);
      ctx.font = "48px Arial";
      ctx.fillText("After the illustration.", 70, 1000);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    const pdf = await PDFDocument.create();
    const image = await pdf.embedPng(Buffer.from(png, "base64"));
    const scannedPage = pdf.addPage([600, 800]);
    scannedPage.drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
    // Real scans often have a watermark text layer that is not the book body.
    scannedPage.drawText("Archive watermark", { x: 70, y: 30, size: 10 });
    pdf.addPage([600, 800]); // Keep page order without embedding a blank scan.
    const original = Buffer.from(await pdf.save());
    const material = join(dir, "material");
    await mkdir(material);
    const input = join(material, "Scanned.pdf");
    await writeFile(input, original);
    await library.evaluate(async (sourcePath) => {
      const me = await (await fetch("/api/me")).json();
      const mutate = async (url: string, body: unknown) => {
        const response = await fetch("/api" + url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": me.csrf,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return response.json();
      };
      const workspace = await mutate("/workspaces", {
        name: "Scan conversion",
      });
      const source = await mutate(`/workspaces/${workspace.id}/sources`, {
        path: sourcePath,
        label: "Generated scans",
      });
      for (let i = 0; i < 150; i++) {
        const scan = await (await fetch(`/api/scans/${source.scan.id}`)).json();
        if (scan.state === "completed") return;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw Error("Source scan timed out");
    }, material);
    await library.reload();
    const output = join(dir, "Scanned.epub");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, output);
    await library
      .locator(".library-book")
      .filter({ hasText: "Scanned.pdf" })
      .click({ button: "right" });
    await library
      .getByRole("menuitem", { name: "Convert to EPUB", exact: true })
      .click();
    await library
      .getByLabel("Conversion mode", { exact: true })
      .selectOption("ocr");
    const dialog = library.getByRole("dialog", {
      name: "Convert book",
      exact: true,
    });
    await expect(dialog).toContainText(
      "Recognize text and illustrations automatically",
    );
    await dialog
      .getByRole("button", { name: "Start conversion", exact: true })
      .click();
    await expect(dialog).toBeHidden({ timeout: 90000 });
    const zip = await JSZip.loadAsync(await readFile(output));
    const chapter = await zip.file("EPUB/page-1.xhtml")!.async("string");
    expect(chapter).toContain("SCANNED READING SAMPLE");
    expect(chapter).toContain("Books can become selectable text");
    expect(chapter).toContain("扫描书籍");
    expect(chapter).toContain('<p dir="auto">');
    expect(zip.file("EPUB/images/page-1.jpg")).toBeNull();
    expect(zip.file("EPUB/images/page-2.jpg")).toBeNull();
    expect(zip.file(/EPUB\/images\/figure-1-\d+\.png/).length).toBeGreaterThan(
      0,
    );
    expect(chapter).toContain("<figure>");
    // The first extracted chart or photo is not necessarily a book cover.
    expect(await zip.file("EPUB/book.opf")!.async("string")).not.toContain(
      'properties="cover-image"',
    );
    expect(chapter).not.toContain("Revenue chart");
    expect(chapter.indexOf("<figure>")).toBeLessThan(
      chapter.indexOf("After the illustration"),
    );
    const ocrReport = JSON.parse(
      await zip.file("META-INF/openreading-ocr.json")!.async("string"),
    );
    expect(ocrReport.pages[0].illustrations).toBeGreaterThan(0);
    expect(await readFile(input)).toEqual(original);
    const opening = app.waitForEvent("window");
    await library
      .locator(".library-book")
      .filter({ hasText: "Scanned.epub" })
      .click();
    const reader = await opening;
    await expect(
      reader.frameLocator(".epub-container iframe").locator("body"),
    ).toContainText("SCANNED READING SAMPLE");
    await expect(
      reader.frameLocator(".epub-container iframe").locator("img").first(),
    ).toBeVisible();
    const evidence = resolve("test-results/scanned-conversion");
    await mkdir(evidence, { recursive: true });
    await reader.screenshot({ path: join(evidence, "ocr-epub-reader.png") });
    await writeFile(
      join(evidence, "scanned-to-text.epub"),
      await readFile(output),
    );
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
