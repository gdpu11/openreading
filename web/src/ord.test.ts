import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ writeFile: vi.fn(), share: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE" },
  Filesystem: { writeFile: fake.writeFile },
}));
vi.mock("@capacitor/share", () => ({ Share: { share: fake.share } }));
import { saveORD, saveExport } from "./ord";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "FileReader",
    class {
      result = "";
      onload = () => {};
      async readAsDataURL(blob: Blob) {
        this.result =
          "data:application/zip;base64," +
          Buffer.from(await blob.arrayBuffer()).toString("base64");
        this.onload();
      }
    },
  );
});
it("shares byte-exact ORD through a cache file URI, including long Unicode filenames", async () => {
  const fileUri = "file:///app/cache/openreading-exports/book.ord";
  fake.writeFile.mockResolvedValue({ uri: fileUri });
  const bytes = new Uint8Array([0x50, 0x4b, 0, 255, 232, 10]);
  await saveORD(new Blob([bytes]), "书籍".repeat(150) + ".epub");
  const options = fake.writeFile.mock.calls[0][0];
  expect(options.directory).toBe("CACHE");
  expect(Buffer.from(options.data, "base64")).toEqual(Buffer.from(bytes));
  expect(
    new TextEncoder().encode(options.path.split("/").pop()).length,
  ).toBeLessThan(200);
  expect(fake.share).toHaveBeenCalledWith(
    expect.objectContaining({ files: [fileUri] }),
  );
});
it("does not open the share sheet when saving the package failed", async () => {
  fake.writeFile.mockRejectedValue(Error("disk full"));
  await expect(saveORD(new Blob(["book"]), "book.txt")).rejects.toThrow(
    "disk full",
  );
  expect(fake.share).not.toHaveBeenCalled();
});

it("shares UTF-8 reading statistics CSV using a native file URI", async () => {
  const uri = "file:///app/cache/reading.csv";
  fake.writeFile.mockResolvedValue({ uri });
  const text = "\ufeff日期,阅读秒数\n2026-10-19,82";
  await saveExport(new Blob([text]), "阅读数据", "csv");
  const options = fake.writeFile.mock.calls[0][0];
  expect(options.path).toMatch(/\.csv$/);
  expect(Buffer.from(options.data, "base64").toString("utf8")).toBe(text);
  expect(fake.share).toHaveBeenCalledWith(
    expect.objectContaining({
      files: [uri],
      dialogTitle: "保存或分享阅读数据",
    }),
  );
});
