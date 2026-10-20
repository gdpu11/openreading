import { beforeEach, expect, it, vi } from "vitest";
vi.hoisted(() =>
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() }),
);
import { getLanguage, setLanguage, tr } from "./index";
beforeEach(() => setLanguage("en"));
it("uses English by default and switches application strings in both directions", () => {
  expect(getLanguage()).toBe("en");
  expect(tr("设置")).toBe("Settings");
  setLanguage("zh");
  expect(tr("Settings")).toBe("设置");
  expect(tr("设置")).toBe("设置");
});
it("translates parameterized UI messages without translating their data", () => {
  expect(tr("已扫描 12 / 30 份文件")).toBe("Scanned 12 / 30 files");
  expect(tr("编辑 我的模型平台")).toBe("Edit 我的模型平台");
  expect(tr("编辑 我的  模型平台")).toBe("Edit 我的  模型平台");
  expect(tr("这是一段用户自己的笔记")).toBe("这是一段用户自己的笔记");
  setLanguage("zh");
  expect(tr("Scanned 12 / 30 files")).toBe("已扫描 12 / 30 份文件");
});
