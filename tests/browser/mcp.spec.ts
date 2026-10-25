import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test.use({ trace: "off", screenshot: "off" });
test("MCP setup, client configurations and document delivery into the native reader", async ({
  request,
}) => {
  test.skip(process.platform !== "darwin");
  test.setTimeout(90000);
  const directory = await mkdtemp(join(tmpdir(), "openreading-mcp-ui-"));
  const evidence =
    process.env.OR_MCP_EVIDENCE || "/private/tmp/openreading-mcp-evidence";
  await mkdir(evidence, { recursive: true });
  const port = await new Promise<number>((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      server.close(() => done(port));
    });
  });
  let app: any;
  try {
    app = await electron.launch({
      args: [resolve("desktop/main.cjs")],
      env: {
        ...process.env,
        OR_DESKTOP_SMOKE: "1",
        OR_DESKTOP_DATA: join(directory, "data"),
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
    await library.evaluate(async () => {
      const me = await (await fetch("/api/me")).json();
      for (const [path, body] of [
        ["/api/workspaces", { name: "AI 文档" }],
        ["/api/preferences", { language: "zh" }],
      ] as const) {
        const response = await fetch(path, {
          method: path.endsWith("preferences") ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": me.csrf,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
      }
      localStorage.setItem("open-reading-language", "zh");
    });
    await library.reload();
    await library
      .getByRole("button", { name: "设置", exact: true })
      .first()
      .click();
    await library
      .getByRole("button", { name: "MCP 接入", exact: true })
      .click();
    const section = library.getByRole("region", { name: "MCP 接入" });
    await expect(
      section.getByText("MCP 已关闭", { exact: true }),
    ).toBeVisible();
    await section
      .getByLabel("接收文档的工作区")
      .selectOption({ label: "AI 文档" });
    await section.getByLabel("本机 MCP 端口").fill(String(port));
    await section.getByLabel("启用 MCP 接入").check();
    const settingsResponse = library.waitForResponse(
      (response: any) =>
        response.url().endsWith("/api/mcp/settings") &&
        response.request().method() === "PUT",
    );
    await section
      .getByRole("button", { name: "保存连接设置", exact: true })
      .click();
    const settings = await (await settingsResponse).json();
    await expect(
      section.getByText("MCP 已开启", { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByLabel("连接密钥", { exact: true }),
    ).toHaveAttribute("type", "password");
    // Capture the clipboard API output without replacing the user's clipboard.
    await library.evaluate(() => {
      navigator.clipboard.writeText = async (text) => {
        (window as any).__mcpCopied = text;
      };
    });
    await section
      .getByRole("button", { name: "复制配置（含密钥）", exact: true })
      .click();
    const codex = await library.evaluate(() => (window as any).__mcpCopied);
    expect(
      codex.includes("[mcp_servers.openreading]") &&
        codex.includes(settings.url) &&
        codex.includes(settings.token),
    ).toBe(true);
    await section.getByRole("button", { name: "Cursor", exact: true }).click();
    await section
      .getByRole("button", { name: "复制配置（含密钥）", exact: true })
      .click();
    const cursor = JSON.parse(
      await library.evaluate(() => (window as any).__mcpCopied),
    );
    expect(
      cursor.mcpServers.openreading.url === settings.url &&
        cursor.mcpServers.openreading.headers.Authorization ===
          "Bearer " + settings.token,
    ).toBe(true);
    await library.screenshot({
      path: join(evidence, "mcp-settings.png"),
      animations: "disabled",
    });
    await library
      .getByRole("dialog", { name: "设置", exact: true })
      .getByRole("button", { name: "关闭", exact: true })
      .click();

    let rpcID = 0;
    const rpc = async (method: string, params: any) => {
      const response = await request.post(settings.url, {
        headers: {
          Authorization: "Bearer " + settings.token,
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        data: { jsonrpc: "2.0", id: ++rpcID, method, params },
      });
      expect(response.status()).toBe(200);
      const message = await response.json();
      expect(message.error).toBeUndefined();
      return message.result;
    };
    await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "UI delivery test", version: "1" },
    });
    const tools = await rpc("tools/list", {});
    expect(tools.tools.map((tool: any) => tool.name).sort()).toEqual([
      "create_document",
      "list_documents",
      "read_document",
      "update_document",
    ]);
    const first = await rpc("tools/call", {
      name: "create_document",
      arguments: {
        title: "MCP 交付验收",
        content:
          "# MCP 投递测试\n\n这份方案由 MCP 直接投递，可以在阅读器里划线和做笔记。",
        clientRequestId: "native-delivery-create",
      },
    });
    expect(first.isError).not.toBe(true);
    await library.evaluate(() => window.dispatchEvent(new Event("focus")));
    const card = library
      .locator(".library-book")
      .filter({ hasText: "MCP 交付验收.md" });
    await expect(card).toBeVisible();
    await library.screenshot({
      path: join(evidence, "mcp-delivered-library.png"),
    });
    const readerEvent = app.waitForEvent("window");
    await card.click();
    const reader = await readerEvent;
    await expect(
      reader.getByRole("heading", { name: "MCP 投递测试", exact: true }),
    ).toBeVisible();
    await expect(
      reader.getByText(
        "这份方案由 MCP 直接投递，可以在阅读器里划线和做笔记。",
        { exact: true },
      ),
    ).toBeVisible();
    await reader.screenshot({
      path: join(evidence, "mcp-delivered-reader.png"),
    });
    const current = await rpc("tools/call", {
      name: "read_document",
      arguments: { documentId: first.structuredContent.documentId },
    });
    const updated = await rpc("tools/call", {
      name: "update_document",
      arguments: {
        documentId: first.structuredContent.documentId,
        expectedRevision: current.structuredContent.document.revision,
        content: "# MCP 投递测试\n\n更新后的方案补充了失败重试与版本冲突处理。",
        clientRequestId: "native-delivery-update",
      },
    });
    expect(updated.isError).not.toBe(true);
    // An open reader keeps its snapshot until reopened.
    await expect(
      reader.getByText(
        "这份方案由 MCP 直接投递，可以在阅读器里划线和做笔记。",
        { exact: true },
      ),
    ).toBeVisible();
    await reader.close();
    const reopenedEvent = app.waitForEvent("window");
    await card.click();
    const reopened = await reopenedEvent;
    await expect(
      reopened.getByText("更新后的方案补充了失败重试与版本冲突处理。", {
        exact: true,
      }),
    ).toBeVisible();
    await reopened.close();

    await library
      .getByRole("button", { name: "设置", exact: true })
      .first()
      .click();
    await library
      .getByRole("button", { name: "MCP 接入", exact: true })
      .click();
    await expect(
      section.getByText("MCP 已开启", { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: "复制配置（含密钥）", exact: true }),
    ).toBeDisabled();
    const tokenResponse = library.waitForResponse((response: any) =>
      response.url().endsWith("/api/mcp/token"),
    );
    library.once("dialog", (dialog: any) => dialog.accept());
    await section
      .getByRole("button", { name: "生成新连接密钥", exact: true })
      .click();
    await tokenResponse;
    const rejected = await request.post(settings.url, {
      headers: { Authorization: "Bearer " + settings.token },
      data: {},
    });
    expect(rejected.status()).toBe(401);
    await section.getByLabel("启用 MCP 接入").uncheck();
    await section
      .getByRole("button", { name: "保存连接设置", exact: true })
      .click();
    await expect(
      section.getByText("MCP 已关闭", { exact: true }),
    ).toBeVisible();
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
