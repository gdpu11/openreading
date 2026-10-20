import { describe, it, expect } from "vitest";
import { pairPayload, randomToken } from "./sync";
describe("mobile pairing trust boundary", () => {
  it("requires an HTTPS QR from the same server and never a master access code", () => {
    const p = {
      origin: "https://reader.example",
      id: "a".repeat(32),
      secret: "b".repeat(64),
    };
    const url = (v: any, host = "https://reader.example") =>
      host + "/mobile#pair=" + encodeURIComponent(JSON.stringify(v));
    expect(pairPayload(url(p))).toEqual(p);
    expect(() =>
      pairPayload(url({ ...p, origin: "http://reader.example" })),
    ).toThrow();
    expect(() => pairPayload(url(p, "https://evil.example"))).toThrow();
    expect(() =>
      pairPayload(url({ ...p, origin: "https://user:pass@reader.example" })),
    ).toThrow();
    expect(() =>
      pairPayload(url({ ...p, origin: "https://reader.example/path" })),
    ).toThrow();
    expect(() =>
      pairPayload("https://reader.example/mobile?code=master"),
    ).toThrow();
  });
  it("generates independent cryptographically random device credentials", () => {
    const a = randomToken(),
      b = randomToken();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(b);
  });
});
