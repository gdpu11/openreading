import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ request: vi.fn(), native: true }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => fake.native },
  registerPlugin: () => ({ request: fake.request }),
}));
import { lanRequest, validLAN } from "./lan";
import { pairPayload } from "./sync";
beforeEach(() => {
  fake.native = true;
  vi.resetAllMocks();
});
it("requires an exact private HTTPS origin and a QR certificate pin", () => {
  const pin = "a".repeat(64),
    origin = "https://192.168.1.23:53318";
  const p = {
    origin,
    certificateFingerprint: pin,
    id: "b".repeat(32),
    secret: "c".repeat(64),
  };
  expect(
    pairPayload(
      origin + "/mobile#pair=" + encodeURIComponent(JSON.stringify(p)),
    ),
  ).toEqual(p);
  for (const host of [
    "http://192.168.1.23:53318",
    "https://192.168.1.23:53318/path",
    "https://user:password@192.168.1.23:53318",
    "https://192.168.1.23.evil.example",
    "https://8.8.8.8:53318",
    "https://127.0.0.1:53318",
  ]) {
    expect(validLAN(host, pin)).toBe(false);
  }
  expect(validLAN(origin)).toBe(false);
  expect(() =>
    pairPayload(
      origin +
        "/mobile#pair=" +
        encodeURIComponent(
          JSON.stringify({ ...p, certificateFingerprint: undefined }),
        ),
    ),
  ).toThrow();
});
it("passes only scoped requests through the native TLS bridge and preserves response bytes", async () => {
  const bytes = new Uint8Array([0, 255, 80, 75, 232]);
  fake.request.mockResolvedValue({
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(bytes).toString("base64"),
  });
  const response = await lanRequest(
    "https://10.0.0.5:53318",
    "a".repeat(64),
    "/sync/files/version?member=member",
    "local-device-token",
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(fake.request).toHaveBeenCalledWith(
    expect.objectContaining({
      fingerprint: "a".repeat(64),
      headers: { Authorization: "Bearer local-device-token" },
    }),
  );
  fake.request.mockClear();
  await expect(
    lanRequest("https://10.0.0.5:53318", "a".repeat(64), "/session", "token"),
  ).rejects.toThrow();
  expect(fake.request).not.toHaveBeenCalled();
  fake.native = false;
  await expect(
    lanRequest(
      "https://10.0.0.5:53318",
      "a".repeat(64),
      "/sync/library",
      "token",
    ),
  ).rejects.toThrow("手机 Open Reading 应用");
});
it("preserves multipart ORD uploads, including their boundary and binary payload", async () => {
  vi.stubGlobal(
    "FileReader",
    class {
      result = "";
      onload = () => {};
      async readAsDataURL(blob: Blob) {
        this.result =
          "data:;base64," +
          Buffer.from(await blob.arrayBuffer()).toString("base64");
        this.onload();
      }
    },
  );
  fake.request.mockResolvedValue({
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: btoa('{"annotations":1}'),
  });
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([80, 75, 0, 255])]), "book.ord");
  form.append("clientRequestId", "request");
  await lanRequest(
    "https://172.16.0.2:53318",
    "a".repeat(64),
    "/sync/workspaces/workspace/ord",
    "token",
    form,
  );
  const sent = fake.request.mock.calls[0][0];
  expect(sent.headers["Content-Type"]).toMatch(
    /^multipart\/form-data; boundary=/,
  );
  const decoded = Buffer.from(sent.body, "base64");
  expect(decoded.includes(Buffer.from([80, 75, 0, 255]))).toBe(true);
  expect(decoded.toString()).toContain('filename="book.ord"');
  vi.unstubAllGlobals();
});
