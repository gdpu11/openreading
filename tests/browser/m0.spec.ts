import { test, expect } from "@playwright/test";
test("M0 PDF native coordinates and mixed scanned capability", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:5173/m0.html");
  await page.waitForFunction(() => !!(window as any).m0);
  const r = await page.evaluate(() => (window as any).m0.pdf());
  expect(r.maxError).toBeLessThan(0.0001);
  expect(r.scannedItems).toBe(0);
  expect(r.textItems).toBeGreaterThan(20);
});
test("M0 actual epub.js CFI survives reflow", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173/m0.html");
  await page.waitForFunction(() => !!(window as any).m0);
  const r = await page.evaluate(() => (window as any).m0.epub());
  expect(r.cfi).toContain("epubcfi(");
  expect(r.actual).toBe(r.expected);
});
