import { test, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
test.use({ trace: "off", screenshot: "off" });
test("deployed HTTPS phone pairing and offline note roundtrip", async ({
  browser,
}) => {
  test.skip(
    !process.env.OR_CLOUD_ACCESS_FILE || !process.env.OR_CLOUD_URL,
    "Explicit cloud credentials are required",
  );
  test.setTimeout(120000);
  const origin = process.env.OR_CLOUD_URL!,
    code = (await readFile(process.env.OR_CLOUD_ACCESS_FILE!, "utf8")).trim();
  const pc = await browser.newContext(),
    phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
  let ws: any,
    device: any,
    csrf = "";
  try {
    const login = await pc.request.post(origin + "/api/session", {
      data: { code },
    });
    expect(login.status()).toBe(200);
    csrf = (await login.json()).csrf;
    const headers = { "X-CSRF-Token": csrf };
    ws = await (
      await pc.request.post(origin + "/api/workspaces", {
        headers,
        data: { name: "跨端同步验收 · 临时资料" },
      })
    ).json();
    const uploaded = await pc.request.post(
      origin + "/api/workspaces/" + ws.id + "/imports",
      {
        headers,
        multipart: {
          files: {
            name: "跨端同步验收.txt",
            mimeType: "text/plain",
            buffer: Buffer.from(
              "这是一份自动验收资料，仅用于验证手机离线阅读和笔记同步。",
            ),
          },
        },
      },
    );
    expect(uploaded.status()).toBe(200);
    const grant = await (
      await pc.request.post(origin + "/api/pair/grants", {
        headers,
        data: { workspaceIds: [ws.id] },
      })
    ).json();
    let offline = false;
    await phone.route("**/api/**", (r) => (offline ? r.abort() : r.continue()));
    const page = await phone.newPage();
    await page.addInitScript(() =>
      localStorage.setItem("open-reading-language", "zh"),
    );
    await page.goto(
      origin +
        "/mobile#pair=" +
        encodeURIComponent(
          JSON.stringify({ origin, id: grant.id, secret: grant.secret }),
        ),
    );
    await page.getByLabel("设备名称").fill("跨端自动验收（临时）");
    await page.getByRole("button", { name: "连接此电脑" }).click();
    await expect
      .poll(async () => {
        const r = await pc.request.get(origin + "/api/pair/grants/" + grant.id);
        return (await r.json()).state;
      })
      .toBe("claimed");
    device = await (
      await pc.request.post(
        origin + "/api/pair/grants/" + grant.id + "/approve",
        { headers, data: {} },
      )
    ).json();
    await expect(
      page.getByRole("button", { name: /跨端同步验收.txt/ }),
    ).toBeVisible();
    await expect(page.locator(".mobile-status")).toHaveText("文件与笔记已同步");
    offline = true;
    await page.getByRole("button", { name: /跨端同步验收.txt/ }).click();
    await expect(page.locator(".plain-text")).toContainText("自动验收资料");
    await page.locator(".plain-text").evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page
      .getByRole("textbox", { name: "手机笔记", exact: true })
      .fill("手机离线笔记已通过公网同步回电脑。");
    await page
      .getByRole("button", { name: "保存手机笔记", exact: true })
      .click();
    await expect(page.locator(".mobile-status")).toContainText("等待同步");
    offline = false;
    await page.getByRole("button", { name: "同步文件与笔记" }).click();
    await expect
      .poll(async () => {
        const notes = await (
          await pc.request.get(origin + "/api/workspaces/" + ws.id + "/notes")
        ).json();
        return notes[0]?.messages?.[0]?.body;
      })
      .toBe("手机离线笔记已通过公网同步回电脑。");
    await expect(page.locator(".mobile-status")).toHaveText("文件与笔记已同步");
    await mkdir("docs/evidence/native", { recursive: true });
    await page.screenshot({
      path: resolve("docs/evidence/native/deployed-phone-reading.png"),
    });
  } finally {
    if (device?.id)
      await pc.request.delete(origin + "/api/devices/" + device.id, {
        headers: { "X-CSRF-Token": csrf },
      });
    if (ws?.id)
      await pc.request.delete(
        origin + "/api/workspaces/" + ws.id + "?confirm=delete-learning-data",
        { headers: { "X-CSRF-Token": csrf } },
      );
    await phone.close();
    await pc.close();
  }
});
