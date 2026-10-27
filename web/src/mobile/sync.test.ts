import { describe, it, expect } from "vitest";
import { pairPayload, randomToken, retainOfflineLibrary } from "./sync";
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
describe("offline books after PC selection changes", () => {
  const library = (documents: any[], deviceId = "phone") => ({
    deviceId,
    workspaces: [{ id: "w", name: "书库", documents }],
    readingData: { events: [{ id: "time-a", member: "a" }] },
  });
  it("keeps deselected books, notes and reading time available without downloading them again", () => {
    const previous = library([
      { id: "a", threads: [{ id: "note" }] },
      { id: "b" },
    ]);
    const incoming = library([{ id: "b", title: "新版" }]);
    incoming.readingData.events = [];
    const merged = retainOfflineLibrary(previous, incoming);
    expect(merged.workspaces[0].documents).toEqual([
      { id: "b", title: "新版", localOnly: false },
      { id: "a", threads: [{ id: "note" }], localOnly: true },
    ]);
    expect(merged.readingData.events).toEqual([{ id: "time-a", member: "a" }]);
    expect(previous.workspaces[0].documents[0].localOnly).toBeUndefined();
    expect(
      retainOfflineLibrary(merged, library([{ id: "a", title: "重新选中" }]))
        .workspaces[0].documents[0],
    ).toEqual({ id: "a", title: "重新选中", localOnly: false });
  });
  it("never merges another device's library into a new connection", () => {
    const incoming = library([], "another-phone");
    expect(retainOfflineLibrary(library([{ id: "a" }]), incoming)).toBe(
      incoming,
    );
  });
});
