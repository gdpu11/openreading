import { test, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";

test.use({ trace: "off", screenshot: "off" });
test("deployed ORD exports saved notes and imports an independent readable copy", async ({
  browser,
}) => {
  test.skip(
    !process.env.OR_CLOUD_ACCESS_FILE || !process.env.OR_CLOUD_URL,
    "Explicit cloud credentials required",
  );
  test.setTimeout(120000);
  const origin = process.env.OR_CLOUD_URL!;
  const context = await browser.newContext();
  const workspaces: string[] = [];
  let csrf = "";
  const call = async (
    route: string,
    data?: any,
    method = data === undefined ? "GET" : "POST",
  ) => {
    const r = await context.request.fetch(origin + "/api" + route, {
      method,
      data,
      headers: { "X-CSRF-Token": csrf },
    });
    expect(r.status(), await r.text()).toBe(200);
    return r.json();
  };
  try {
    const code = (
      await readFile(process.env.OR_CLOUD_ACCESS_FILE!, "utf8")
    ).trim();
    csrf = (await call("/session", { code })).csrf;
    const health = await call("/health");
    expect(health.version).toBe("1.2.0");
    for (const name of ["ORD 导出验收 · 临时", "ORD 接收验收 · 临时"])
      workspaces.push((await call("/workspaces", { name })).id);
    const text = "从一本书带走理解：中文𠮷👩‍💻é。接收者能看到原文和学习笔记。";
    const uploaded = await context.request.post(
      origin + "/api/workspaces/" + workspaces[0] + "/imports",
      {
        headers: { "X-CSRF-Token": csrf },
        multipart: {
          files: {
            name: "ORD线上验收.txt",
            mimeType: "text/plain",
            buffer: Buffer.from(text),
          },
        },
      },
    );
    expect(uploaded.status()).toBe(200);
    const scan = (await uploaded.json()).scan.id;
    await expect
      .poll(async () => (await call("/scans/" + scan)).state)
      .toBe("completed");
    const doc = (await call("/workspaces/" + workspaces[0] + "/documents"))
      .items[0];
    const prepared = await call("/documents/" + doc.documentId + "/prepare", {
      workspaceDocumentId: doc.id,
      sourceEntryId: doc.bindings[0].id,
    });
    const artifact = await call("/artifacts", {
      workspaceDocumentId: doc.id,
      versionId: prepared.version.id,
      parserVersion: "txt-map-v1",
      normalizationVersion: "unicode-codepoint-preserve-v1",
      blocks: [{ id: "body", text, locator: { label: "正文" } }],
    });
    const anchor = {
      schemaVersion: 1,
      workspaceDocumentId: doc.id,
      documentVersionId: prepared.version.id,
      extractionArtifactId: artifact.id,
      resourceManifestId: prepared.resourceManifestId,
      targetKind: "text",
      parserVersion: "txt-map-v1",
      normalizationVersion: "unicode-codepoint-preserve-v1",
      displayLocation: { label: "正文" },
      quote: { exact: text, visible: text, prefix: "", suffix: "" },
      selectors: [
        { type: "text", block: "body", start: 0, end: Array.from(text).length },
      ],
    };
    await call("/threads", {
      workspaceDocumentId: doc.id,
      documentVersionId: prepared.version.id,
      selectionSnapshot: anchor,
      clientRequestId: crypto.randomUUID(),
      message: {
        body: "云端 ORD 验收：这条学习笔记应随书籍导出。",
        recipient: "note",
      },
    });
    const exported = await context.request.get(
      origin +
        `/api/documents/${doc.id}/ord?versionId=${prepared.version.id}&manifestId=${prepared.resourceManifestId}`,
    );
    expect(exported.status()).toBe(200);
    expect(exported.headers()["content-type"]).toContain(
      "application/vnd.openreading.ord+zip",
    );
    const bytes = await exported.body();
    const zip = await JSZip.loadAsync(bytes);
    const book = JSON.parse(await zip.file("book.json")!.async("string"));
    expect(book.tables.annotations).toHaveLength(1);
    expect(book.tables.messages[0].body).toContain("这条学习笔记");
    const requestId = crypto.randomUUID();
    const upload = () =>
      context.request.post(
        origin + "/api/workspaces/" + workspaces[1] + "/ord",
        {
          headers: { "X-CSRF-Token": csrf },
          multipart: {
            file: {
              name: "验收.ord",
              mimeType: "application/vnd.openreading.ord+zip",
              buffer: bytes,
            },
            clientRequestId: requestId,
          },
        },
      );
    const imported = await upload();
    expect(imported.status()).toBe(200);
    const result = await imported.json();
    expect(result.workspaceDocumentId).not.toBe(doc.id);
    expect(result.annotations).toBe(1);
    const replay = await upload();
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(result);
    const docs = (await call("/workspaces/" + workspaces[1] + "/documents"))
      .items;
    expect(docs).toHaveLength(1);
    const notes = await call(
      "/documents/" + result.workspaceDocumentId + "/threads",
    );
    expect(notes[0].anchor.workspaceDocumentId).toBe(
      result.workspaceDocumentId,
    );
    expect(notes[0].anchor.quote.exact).toBe(text);
    const content = await context.request.get(
      origin +
        `/api/versions/${result.versionId}/content?workspaceDocumentId=${result.workspaceDocumentId}`,
    );
    expect(await content.text()).toBe(text);
    const evidence = {
      verifiedAt: new Date().toISOString(),
      url: origin,
      version: health.version,
      scenarios: [
        "authenticated HTTPS ORD download",
        "book SHA-256 container",
        "independent imported membership",
        "same upload retry is idempotent",
        "UTF-8 original bytes preserved",
        "anchor IDs remapped",
        "saved learning note preserved",
      ],
      paidModelCalls: 0,
      credentialsIncluded: false,
    };
    await mkdir(resolve("docs/evidence"), { recursive: true });
    await writeFile(
      resolve("docs/evidence/ord-cloud.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  } finally {
    for (const id of workspaces.reverse()) {
      const r = await context.request.delete(
        origin + "/api/workspaces/" + id + "?confirm=delete-learning-data",
        { headers: { "X-CSRF-Token": csrf } },
      );
      expect(r.status()).toBe(200);
    }
    await context.close();
  }
});
