import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  chunks: new Map<string, { blob: Blob; total: number }>(),
  files: new Map<string, Blob>(),
  failCommit: false,
  native: false,
  commits: [] as { key: string; total: number }[],
}));
vi.mock("./storage", async (original) => {
  const real = await original<typeof import("./storage")>();
  return {
    ...real,
    nativeChunkCommit: () => fake.native,
    commitChunks: async (key: string, total: number) => {
      fake.commits.push({ key, total });
      if (fake.failCommit) throw Error("disk full");
    },
    loadChunk: async (key: string, offset: number) =>
      fake.chunks.get(key + ":" + offset),
    saveChunk: async (key: string, offset: number, chunk: any) => {
      fake.chunks.set(key + ":" + offset, chunk);
    },
    clearChunks: async (key: string) => {
      for (const k of fake.chunks.keys())
        if (k.startsWith(key + ":")) fake.chunks.delete(k);
    },
    storeBlob: async (key: string, blob: Blob) => {
      if (fake.failCommit) throw Error("disk full");
      fake.files.set(key, blob);
    },
  };
});
import { downloadBlob } from "./download";
import { hash } from "./storage";
const size = 2 * 1024 * 1024;
const data = new Uint8Array(size * 2 + 31).map((_, i) => i % 251);
const key = await hash(data.buffer);
const part = (range: string, source = data) => {
  const [start, requested] = range.slice(6).split("-").map(Number);
  const end = Math.min(requested, source.length - 1);
  return new Response(source.slice(start, end + 1), {
    status: 206,
    headers: { "Content-Range": `bytes ${start}-${end}/${source.length}` },
  });
};
beforeEach(() => {
  fake.chunks.clear();
  fake.files.clear();
  fake.failCommit = false;
  fake.native = false;
  fake.commits = [];
});

it("resumes a partially downloaded file after a new invocation and keeps progress above zero", async () => {
  const first = vi.fn(async (range: string) => {
    if (range.startsWith(`bytes=${size}-`)) throw Error("offline");
    return part(range);
  });
  await expect(downloadBlob(key, data.length, first, () => {})).rejects.toThrow(
    "offline",
  );
  expect(fake.chunks.size).toBe(1);
  expect(fake.files.size).toBe(0);
  const resumed = vi.fn(async (range: string) => part(range));
  const progress = vi.fn();
  await downloadBlob(key, data.length, resumed, progress);
  expect(resumed.mock.calls.map(([range]) => range)).toEqual([
    `bytes=${size}-${size * 2 - 1}`,
    `bytes=${size * 2}-${data.length - 1}`,
  ]);
  expect(progress.mock.calls[0]).toEqual([size, data.length]);
  expect(
    Buffer.from(await fake.files.get(key)!.arrayBuffer()).equals(
      Buffer.from(data),
    ),
  ).toBe(true);
  expect(fake.chunks.size).toBe(0);
});

it("retains every completed range if saving the final file is interrupted", async () => {
  fake.failCommit = true;
  await expect(
    downloadBlob(
      key,
      undefined,
      async (range) => part(range),
      () => {},
    ),
  ).rejects.toThrow("disk full");
  expect(fake.chunks.size).toBe(3);
  fake.failCommit = false;
  const request = vi.fn();
  await downloadBlob(key, undefined, request, () => {});
  expect(request).not.toHaveBeenCalled();
  expect(await hash(await fake.files.get(key)!.arrayBuffer())).toBe(key);
});

it("never appends a full 200 response to a saved prefix", async () => {
  fake.chunks.set(key + ":0", {
    blob: new Blob([data.slice(0, size)]),
    total: data.length,
  });
  const request = vi.fn(async () => new Response(data));
  await downloadBlob(key, data.length, request, () => {});
  expect(request).toHaveBeenCalledOnce();
  expect(fake.files.get(key)?.size).toBe(data.length);
});

it("separates changed content by hash and removes corrupt ranges after final verification", async () => {
  fake.chunks.set(key + ":0", {
    blob: new Blob([new Uint8Array(size)]),
    total: data.length,
  });
  const changed = data.slice();
  changed[0]++;
  const changedKey = await hash(changed.buffer);
  const fresh = vi.fn(async (range: string) => part(range, changed));
  await downloadBlob(changedKey, changed.length, fresh, () => {});
  expect(fresh.mock.calls[0][0]).toBe(`bytes=0-${size - 1}`);
  await expect(
    downloadBlob(
      key,
      data.length,
      async (range) => part(range),
      () => {},
    ),
  ).rejects.toThrow("校验失败");
  expect(fake.chunks.has(key + ":0")).toBe(false);
  expect(fake.files.has(key)).toBe(false);
});

it("rejects wrong ranges and truncated responses without persisting them", async () => {
  for (const response of [
    new Response(data.slice(0, 10), {
      status: 206,
      headers: { "Content-Range": `bytes 1-10/${data.length}` },
    }),
    new Response(data.slice(0, 10), {
      status: 206,
      headers: { "Content-Range": `bytes 0-${size - 1}/${data.length}` },
    }),
    new Response(data.slice(0, 10), { status: 206 }),
  ]) {
    await expect(
      downloadBlob(
        key,
        data.length,
        async () => response,
        () => {},
      ),
    ).rejects.toThrow();
    expect(fake.chunks.size).toBe(0);
    expect(fake.files.size).toBe(0);
  }
});

it("saves empty files and empty resources without an invalid range loop", async () => {
  const emptyKey = await hash(new ArrayBuffer(0)),
    request = vi.fn();
  await downloadBlob(emptyKey, 0, request, () => {});
  expect(request).not.toHaveBeenCalled();
  await downloadBlob(
    emptyKey,
    undefined,
    async () =>
      new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */0" },
      }),
    () => {},
  );
  expect(fake.files.get(emptyKey)?.size).toBe(0);
});

it("commits native ranges without constructing a whole-file Blob and waits for the saving stage", async () => {
  fake.native = true;
  const stages: string[] = [];
  const progress: number[] = [];
  await downloadBlob(
    key,
    data.length,
    async (range) => part(range),
    (received) => progress.push(received),
    async (stage) => {
      stages.push(stage);
      expect(progress.at(-1)).toBe(data.length);
      expect(fake.commits).toHaveLength(0);
      expect(fake.chunks.size).toBe(3);
      await Promise.resolve();
    },
  );
  expect(stages).toEqual(["saving"]);
  expect(fake.commits).toEqual([{ key, total: data.length }]);
  expect(fake.files.size).toBe(0);
  expect(fake.chunks.size).toBe(0);
});

it("retries a native save failure using durable chunks without re-downloading", async () => {
  fake.native = true;
  fake.failCommit = true;
  await expect(
    downloadBlob(
      key,
      data.length,
      async (range) => part(range),
      () => {},
    ),
  ).rejects.toThrow("disk full");
  expect(fake.chunks.size).toBe(3);
  fake.failCommit = false;
  const request = vi.fn();
  await downloadBlob(key, data.length, request, () => {});
  expect(request).not.toHaveBeenCalled();
  expect(fake.commits).toHaveLength(2);
  expect(fake.chunks.size).toBe(0);
});

it("splits a full native response into durable ranges before committing", async () => {
  fake.native = true;
  await downloadBlob(
    key,
    data.length,
    async () => new Response(data),
    () => {},
    () => {
      expect([...fake.chunks.values()].map((c) => c.blob.size)).toEqual([
        size,
        size,
        31,
      ]);
    },
  );
  expect(fake.commits).toEqual([{ key, total: data.length }]);
  expect(fake.chunks.size).toBe(0);
});
