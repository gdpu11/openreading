import { test, expect, type BrowserContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
test.describe.configure({ mode: "serial" });
let service: ChildProcess, upstream: Server, context: BrowserContext;
let base = "http://127.0.0.1:7325",
  endpoint = "",
  csrf = "",
  workspace: any;
const calls: any[] = [];
const evidence = path.resolve(
  "docs/evidence/model-settings",
  process.env.OR_BROWSER || "chromium",
);
async function post(route: string, body: any, method = "POST") {
  const response = await context.request.fetch(base + "/api" + route, {
    method,
    data: body,
    headers: { "X-CSRF-Token": csrf },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
test.beforeAll(async ({ browser }) => {
  await mkdir(evidence, { recursive: true });
  upstream = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe("Bearer local-ui-test");
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "reader-alpha" }, { id: "reader-beta" }],
        }),
      );
      return;
    }
    let body = "";
    for await (const part of req) body += part;
    calls.push(JSON.parse(body));
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      'data: {"choices":[{"delta":{"content":"已使用所选模型 [S1]"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  endpoint = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
  const data = await mkdtemp(path.join(tmpdir(), "openreading-model-ui-"));
  const code = await new Promise<string>((resolve, reject) => {
    service = spawn(
      path.resolve("release/openreading"),
      ["--data-dir", data, "--port", "7325"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const timer = setTimeout(
      () => reject(Error("service startup timeout: " + out)),
      10000,
    );
    service.stdout!.on("data", (b) => {
      out += b.toString();
      const m = out.match(/配对码：([a-f0-9]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    service.stderr!.on("data", (b) => {
      out += b.toString();
    });
    service.on("error", reject);
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
  });
  const page = await context.newPage();
  await page.addInitScript(() =>
    localStorage.setItem("open-reading-language", "zh"),
  );
  await page.goto(base);
  await page.getByLabel("本机配对码").fill(code);
  await page.getByRole("button", { name: /进入阅读空间/ }).click();
  await expect(page.locator(".workspace-rail")).toBeVisible();
  csrf = (await (await context.request.get(base + "/api/me")).json()).csrf;
  workspace = await post("/workspaces", { name: "多平台阅读" });
  const source = await mkdtemp(path.join(tmpdir(), "openreading-model-book-"));
  await writeFile(
    path.join(source, "模型选择.txt"),
    "模型调用需要明确选择平台与模型，并固定本次发送的原文范围。\n",
  );
  const added = await post(`/workspaces/${workspace.id}/sources`, {
    path: source,
    label: "测试材料",
  });
  await expect
    .poll(
      async () =>
        (
          await (
            await context.request.get(base + "/api/scans/" + added.scan.id)
          ).json()
        ).state,
    )
    .toBe("completed");
  await page.close();
});
test.afterAll(async () => {
  await context?.close();
  if (service && service.exitCode === null) {
    const exited = new Promise((resolve) => service.once("exit", resolve));
    service.kill("SIGINT");
    await exited;
  }
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

async function settings(page: any) {
  await page.addInitScript(() =>
    localStorage.setItem("open-reading-language", "zh"),
  );
  await page.goto(base);
  await expect(page.locator(".workspace-rail")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await page.getByRole("button", { name: "模型与隐私", exact: true }).click();
}
test("platform picker, shared key, multiple models and actual selected-model request", async () => {
  const page = await context.newPage();
  await settings(page);
  await page.getByRole("button", { name: "添加提供方", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /智谱 Coding Plan/ }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(evidence, "01-platform-picker.png"),
  });
  await page
    .getByRole("button", {
      name: "OpenAI 支持 Chat Completions 的文本模型",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("提供方 API 地址")).toHaveValue(
    "https://api.openai.com/v1",
  );
  await page.getByRole("button", { name: "返回提供方", exact: true }).click();
  await page
    .getByRole("button", { name: "添加自定义提供方", exact: true })
    .click();
  await expect(page.getByLabel("提供方 API 地址")).toHaveValue("");
  await page.getByLabel("提供方名称").fill("本机 LiteLLM 测试");
  await page.getByLabel("提供方 API 地址").fill(endpoint);
  await page.getByLabel("提供方 API Key").fill("local-ui-test");
  await page.getByRole("button", { name: "获取模型", exact: true }).click();
  await page.getByLabel("reader-alpha", { exact: true }).check();
  await page.getByLabel("reader-beta", { exact: true }).check();
  await page
    .getByLabel("默认模型", { exact: true })
    .selectOption("reader-alpha");
  await page.getByLabel("为“多平台阅读”启用此提供方").check();
  await page.screenshot({
    path: path.join(evidence, "02-provider-editor.png"),
  });
  await page.getByRole("button", { name: "保存提供方", exact: true }).click();
  await expect(page.locator(".provider-card")).toContainText(
    /2\s*个模型 · 当前工作区已启用/,
  );
  await page.screenshot({ path: path.join(evidence, "03-provider-list.png") });
  await page
    .getByRole("button", { name: "编辑 本机 LiteLLM 测试", exact: true })
    .click();
  await expect(page.getByLabel("提供方 API Key")).toHaveValue("");
  await expect(page.getByLabel("提供方 API Key")).toHaveAttribute(
    "placeholder",
    "已绑定，留空保留",
  );
  await page.getByRole("button", { name: "保存提供方", exact: true }).click();
  await expect(page.locator(".provider-card")).toContainText("密钥已绑定");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".file-item").filter({ hasText: "模型选择.txt" }).click();
  await expect(page.locator(".reader-status")).toHaveCount(0);
  await page.locator(".prose").evaluate((el) => {
    const node = el.ownerDocument
      .createTreeWalker(el, NodeFilter.SHOW_TEXT)
      .nextNode()!;
    const range = el.ownerDocument.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 10);
    const selected = el.ownerDocument.getSelection()!;
    selected.removeAllRanges();
    selected.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page
    .locator(".selection-toolbar")
    .getByRole("button", { name: "问小阅", exact: true })
    .click();
  const option = await page
    .getByLabel("选择模型")
    .locator("option")
    .filter({ hasText: "reader-beta" })
    .getAttribute("value");
  await page.getByLabel("选择模型").selectOption(option!);
  await page.getByLabel("评论输入").fill("解释所选原文");
  await page.getByRole("button", { name: "预览发送内容", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "本次发送内容预览" }),
  ).toContainText("reader-beta");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("发送评论").click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].model).toBe("reader-beta");
  await expect(page.locator(".assistant-body")).toContainText("已使用所选模型");
  await writeFile(
    path.join(evidence, "request-check.json"),
    JSON.stringify(
      {
        selectedModel: calls[0].model,
        calls: calls.length,
        sharedCredential: true,
        providerCount: 1,
        realExternalAPI: false,
      },
      null,
      2,
    ),
  );
  await page.close();
});

test("legacy configuration edits, manual models, workspace disabling and provider removal", async () => {
  await post("/providers", {
    name: "旧版配置",
    protocol: "openai",
    baseUrl: endpoint,
    modelId: "legacy-model",
    apiKey: "local-ui-test",
  });
  const page = await context.newPage();
  await settings(page);
  await page
    .getByRole("button", { name: "编辑 旧版配置", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: /legacy-model/ }),
  ).toBeChecked();
  await page.getByLabel("手动模型 ID", { exact: true }).fill("manual-model");
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await page
    .getByLabel("默认模型", { exact: true })
    .selectOption("manual-model");
  await page.getByRole("button", { name: "保存提供方", exact: true }).click();
  const card = page.locator(".provider-card").filter({ hasText: "旧版配置" });
  await expect(card).toContainText("manual-model");
  await expect(card).toContainText("当前工作区未启用");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "删除 旧版配置", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await page
    .getByRole("button", { name: "编辑 本机 LiteLLM 测试", exact: true })
    .click();
  await page.getByLabel("为“多平台阅读”启用此提供方").uncheck();
  await page.getByRole("button", { name: "保存提供方", exact: true }).click();
  await expect(page.locator(".provider-card")).toContainText(
    "当前工作区未启用",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.close();
});
