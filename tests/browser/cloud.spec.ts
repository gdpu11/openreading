import { test, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

test.skip(!process.env.OR_CLOUD_URL, "Explicit cloud verification only");
test.use({ trace: "off", screenshot: "off" });
test("HTTPS login, upload, annotation, backup and container restart persistence", async ({
  page,
}) => {
  test.setTimeout(120000);
  const base = process.env.OR_CLOUD_URL!;
  const code = (
    await readFile(process.env.OR_CLOUD_ACCESS_FILE!, "utf8")
  ).trim();
  let workspaceId = "";
  async function login() {
    await page.getByLabel("访问码", { exact: true }).fill(code);
    await page.getByRole("button", { name: /进入阅读空间/ }).click();
    await expect(page.locator(".workspace-rail")).toBeVisible();
  }
  async function call(route: string, method = "GET", data?: any) {
    const me = await (await page.request.get(base + "/api/me")).json();
    const r = await page.request.fetch(base + "/api" + route, {
      method,
      data,
      headers: { Origin: base, "X-CSRF-Token": me.csrf },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }
  try {
    await page.addInitScript(() => localStorage.setItem("open-reading-language", "zh"));
    await page.goto(base);
    await login();
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "openreading_session")?.secure).toBe(
      true,
    );
    expect((await call("/me")).serverMode).toBe(true);
    const workspace = await call("/workspaces", "POST", {
      name: "云端部署验收",
    });
    workspaceId = workspace.id;
    await page.reload();
    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: "部署验收.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(
          "# 阅伴阅读验收\n\n云端导入的原文与评论应保存在独立的持久化数据卷中。\n",
        ),
      });
    await page.locator(".file-item").filter({ hasText: "部署验收.md" }).click();
    await expect(page.locator(".prose")).toContainText("云端导入的原文");
    await page.locator(".prose").evaluate((el) => {
      const walker = el.ownerDocument.createTreeWalker(
        el,
        NodeFilter.SHOW_TEXT,
      );
      let node: Text | null = null;
      while (walker.nextNode()) {
        const n = walker.currentNode as Text;
        if (n.data.includes("云端导入")) {
          node = n;
          break;
        }
      }
      if (!node) throw Error("fixture not found");
      const range = el.ownerDocument.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 12);
      const selected = el.ownerDocument.getSelection()!;
      selected.removeAllRanges();
      selected.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page
      .locator(".selection-toolbar")
      .getByRole("button", { name: "评论", exact: true })
      .click();
    await page.getByLabel("评论输入").fill("HTTPS 云端评论：重启后应保留");
    await page.getByLabel("发送评论").click();
    await expect(page.locator(".note-body")).toContainText("HTTPS 云端评论");
    const backup = await call("/backups", "POST", {});
    expect(backup.offlineVersions).toBeGreaterThan(0);
    await mkdir("docs/evidence/cloud", { recursive: true });
    await page.screenshot({ path: "docs/evidence/cloud/reading.png" });
    if (process.env.OR_CLOUD_RESTART === "1") {
      execFileSync(
        "ssh",
        [
          "-i",
          process.env.OR_CLOUD_SSH_KEY!,
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          process.env.OR_CLOUD_SSH_HOST!,
          "cd /opt/openreading && docker compose restart openreading",
        ],
        { timeout: 30000, stdio: "pipe" },
      );
      await expect
        .poll(async () => {
          try {
            return (await page.request.get(base + "/api/health")).status();
          } catch {
            return 0;
          }
        })
        .toBe(200);
      await page.reload();
      await login();
      await page
        .locator(".file-item")
        .filter({ hasText: "部署验收.md" })
        .click();
      await expect(page.locator(".prose")).toContainText("云端导入的原文");
      await expect(page.locator(".thread-card")).toContainText(
        "HTTPS 云端评论",
      );
      await page.screenshot({ path: "docs/evidence/cloud/after-restart.png" });
    }
  } finally {
    if (workspaceId)
      await call(
        `/workspaces/${workspaceId}?confirm=delete-learning-data`,
        "DELETE",
      );
  }
});
