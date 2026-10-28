import { describe, it, expect, vi } from "vitest";
const fake = vi.hoisted(() => ({
  files: new Map<string, string>(),
  fail: false,
  pauseWrite: undefined as Promise<void> | undefined,
  nativeAvailable: false,
  exists: true,
  commitError: undefined as any,
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    isPluginAvailable: () => fake.nativeAvailable,
    convertFileSrc: (uri: string) =>
      uri.replace("file://", "https://localhost/_capacitor_file_"),
  },
  registerPlugin: (name: string) =>
    name === "OfflineFiles"
      ? {
          has: async () => ({ exists: fake.exists }),
          get: async ({ key }: any) => ({
            exists: fake.exists,
            uri: "file:///openreading/files/" + key,
          }),
          commit: async () => {
            if (fake.commitError) throw fake.commitError;
          },
        }
      : {},
}));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    readFile: async ({ path }: any) => {
      if (!fake.files.has(path)) throw Error("missing");
      return { data: fake.files.get(path) };
    },
    writeFile: async ({ path, data }: any) => {
      if (fake.pauseWrite) await fake.pauseWrite;
      if (fake.fail) {
        fake.files.set(path, "partial");
        throw Error("disk full");
      }
      fake.files.set(path, data);
    },
    rmdir: async ({ path }: any) => {
      for (const key of fake.files.keys())
        if (key.startsWith(path + "/")) fake.files.delete(key);
    },
  },
}));
import {
  loadState,
  persistState,
  emptyState,
  hash,
  cachedBlob,
  hasBlob,
  commitChunks,
  loadChunk,
  saveChunk,
  clearChunks,
  clearFiles,
} from "./storage";
describe("native durable offline queue", () => {
  it("recovers the previous valid queue after an interrupted native state write", async () => {
    fake.files.clear();
    const state = emptyState();
    state.outbox.push({ operationId: "first", body: "已保存笔记" });
    await persistState(state);
    state.outbox.push({ operationId: "second", body: "中断写入" });
    fake.fail = true;
    await expect(persistState(state)).rejects.toThrow("disk full");
    fake.fail = false;
    const restored = await loadState();
    expect(restored.outbox).toEqual([
      { operationId: "first", body: "已保存笔记" },
    ]);
    restored.outbox.push({ operationId: "second", body: "重新保存" });
    await persistState(restored);
    expect((await loadState()).outbox).toHaveLength(2);
  });
  it("serializes state writes without sharing mutable snapshots", async () => {
    const s = emptyState();
    s.drafts.note = "a";
    const a = persistState(s);
    s.drafts.note = "b";
    const b = persistState(s);
    await Promise.all([a, b]);
    expect((await loadState()).drafts.note).toBe("b");
  });
});

it("persists native download chunks and discards interrupted or corrupt writes", async () => {
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
  try {
    const blob = new Blob(["a saved range"]),
      key = "a".repeat(64);
    await saveChunk(key, 0, { blob, total: 100 });
    expect(await (await loadChunk(key, 0))?.blob.text()).toBe("a saved range");
    fake.fail = true;
    await expect(
      saveChunk(key, blob.size, { blob, total: 100 }),
    ).rejects.toThrow("disk full");
    fake.fail = false;
    expect(await loadChunk(key, blob.size)).toBeUndefined();
    expect(await (await loadChunk(key, 0))?.blob.text()).toBe("a saved range");
    const path = `openreading/partial/${key}/0.json`;
    const record = JSON.parse(fake.files.get(path)!);
    record.data = btoa("corrupted");
    fake.files.set(path, JSON.stringify(record));
    expect(await loadChunk(key, 0)).toBeUndefined();
    await clearChunks(key);
    expect(fake.files.has(path)).toBe(false);
  } finally {
    fake.fail = false;
    vi.unstubAllGlobals();
  }
});

it("reads verified native files without any network or data-URL fetch", async () => {
  const text = "offline native document";
  const key = await hash(new TextEncoder().encode(text).buffer);
  fake.files.set("openreading/files/" + key, btoa(text));
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("CSP disallows data fetch"));
  try {
    expect(await (await cachedBlob(key))?.text()).toBe(text);
    expect(fetchSpy).not.toHaveBeenCalled();
    fake.files.set("openreading/files/" + key, btoa("corrupted"));
    expect(await cachedBlob(key)).toBeUndefined();
  } finally {
    fetchSpy.mockRestore();
  }
});

it("checks native cache without reading Base64 and reads only verified local file URLs", async () => {
  fake.nativeAvailable = true;
  const key = "a".repeat(64);
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("verified file"));
  try {
    expect(await hasBlob(key)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await (await cachedBlob(key))?.text()).toBe("verified file");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://localhost/_capacitor_file_/openreading/files/" + key,
    );
    fake.exists = false;
    expect(await hasBlob(key)).toBe(false);
    expect(await cachedBlob(key)).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    fake.nativeAvailable = false;
    fake.exists = true;
    fetchSpy.mockRestore();
  }
});

it("retains native partials after storage errors but clears them after integrity errors", async () => {
  const key = "b".repeat(64),
    path = `openreading/partial/${key}/0.json`;
  try {
    fake.files.set(path, "saved range");
    fake.commitError = Object.assign(Error("disk full"), {
      code: "OFFLINE_SAVE",
    });
    await expect(commitChunks(key, 1)).rejects.toThrow("disk full");
    expect(fake.files.has(path)).toBe(true);
    fake.commitError = Object.assign(Error("checksum failed"), {
      code: "INTEGRITY",
    });
    await expect(commitChunks(key, 1)).rejects.toThrow("checksum failed");
    expect(fake.files.has(path)).toBe(false);
  } finally {
    fake.commitError = undefined;
  }
});

it("waits for queued snapshots before clearing native offline data", async () => {
  let finishWrite!: () => void;
  fake.pauseWrite = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  const d = {
    close() {},
    transaction() {
      const tx: any = {
        objectStore: () => ({
          clear: () => queueMicrotask(() => tx.oncomplete()),
        }),
      };
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", {
    open() {
      const request: any = { result: d };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  });
  try {
    const state = emptyState();
    state.drafts.private = "must not come back after removal";
    const save = persistState(state);
    const clear = clearFiles();
    await Promise.resolve();
    finishWrite();
    await Promise.all([save, clear]);
    expect(
      [...fake.files.keys()].some((key) => key.startsWith("openreading/")),
    ).toBe(false);
    expect((await loadState()).drafts).toEqual({});
  } finally {
    fake.pauseWrite = undefined;
    vi.unstubAllGlobals();
  }
});
