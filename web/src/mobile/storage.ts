import type { ReadingEvent } from "../reading/data";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Filesystem, Encoding } from "@capacitor/filesystem";
const Vault = registerPlugin<{
  get: () => Promise<{ value?: string }>;
  set: (v: { value: string }) => Promise<void>;
  clear: () => Promise<void>;
}>("DeviceVault");
const native = Capacitor.isNativePlatform();
async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("open-reading-mobile", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("data");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idb(key: string, value?: any, remove = false): Promise<any> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(
        "data",
        value === undefined && !remove ? "readonly" : "readwrite",
      ),
      store = tx.objectStore("data");
    const r = remove
      ? store.delete(key)
      : value === undefined
        ? store.get(key)
        : store.put(value, key);
    let result: any;
    r.onsuccess = () => (result = r.result);
    tx.oncomplete = () => {
      d.close();
      resolve(result);
    };
    tx.onerror = () => {
      d.close();
      reject(tx.error);
    };
  });
}
export type Connection = {
  origin: string;
  certificateFingerprint?: string;
  token: string;
  name: string;
  deviceId?: string;
  pendingGrant?: string;
};
export type MobileState = {
  library: any;
  outbox: any[];
  readingEvents?: ReadingEvent[];
  drafts: Record<string, string>;
  bookPreferences?: Record<string, any>;
  lastBook?: string;
};
let generation = 0,
  serial = Promise.resolve();
export const emptyState = (): MobileState => ({
  library: null,
  outbox: [],
  drafts: {},
});
export async function connection(): Promise<Connection | null> {
  const value = native ? (await Vault.get()).value : await idb("connection");
  return value ? JSON.parse(value) : null;
}
export async function saveConnection(c: Connection) {
  const value = JSON.stringify(c);
  if (native) await Vault.set({ value });
  else await idb("connection", value);
}
export async function clearConnection() {
  if (native) await Vault.clear();
  else await idb("connection", undefined, true);
}
export async function loadState(): Promise<MobileState> {
  if (!native) return (await idb("state")) || emptyState();
  let chosen: any = null;
  for (const slot of [0, 1]) {
    try {
      const r = await Filesystem.readFile({
        path: `openreading/state-${slot}.json`,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      const v = JSON.parse(r.data as string);
      if (
        v.hash ===
          (await hash(
            new TextEncoder().encode(JSON.stringify(v.state)).buffer,
          )) &&
        v.generation > (chosen?.generation ?? -1)
      )
        chosen = v;
    } catch {}
  }
  if (chosen) {
    generation = chosen.generation;
    return chosen.state;
  }
  return emptyState();
}
export async function persistState(s: MobileState) {
  const copy = structuredClone(s);
  const task = serial.then(async () => {
    if (!native) {
      await idb("state", copy);
      return;
    }
    const next = generation + 1;
    const value = JSON.stringify({
      generation: next,
      state: copy,
      hash: await hash(new TextEncoder().encode(JSON.stringify(copy)).buffer),
    });
    await Filesystem.writeFile({
      path: `openreading/state-${next % 2}.json`,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data: value,
      recursive: true,
    });
    generation = next;
  });
  serial = task.catch(() => {});
  await task;
}
export async function hash(data: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
export async function cachedBlob(key: string): Promise<Blob | undefined> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error("无效的文件校验值");
  if (!native) return idb("blob:" + key);
  try {
    const r = await Filesystem.readFile({
      directory: Directory.Data,
      path: "openreading/files/" + key,
    });
    // Decode locally: fetch(data:) is intentionally forbidden by the native
    // application's CSP and would make every cached file appear unavailable.
    const binary = atob(r.data as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if ((await hash(bytes.buffer)) !== key) return undefined;
    return new Blob([bytes]);
  } catch {
    return undefined;
  }
}
export async function storeBlob(key: string, blob: Blob) {
  if ((await hash(await blob.arrayBuffer())) !== key)
    throw Error("文件校验失败，下载未保存，请重试");
  if (!native) {
    await idb("blob:" + key, blob);
    return;
  }
  const base64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  await Filesystem.writeFile({
    directory: Directory.Data,
    path: "openreading/files/" + key,
    data: base64,
    recursive: true,
  });
}

export type DownloadChunk = { blob: Blob; total: number };
function partialKey(key: string, offset: number) {
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw Error("无效的下载断点");
  return `openreading/partial/${key}/${offset}.json`;
}
export async function loadChunk(
  key: string,
  offset: number,
): Promise<DownloadChunk | undefined> {
  const path = partialKey(key, offset);
  try {
    let value;
    if (native) {
      const file = await Filesystem.readFile({
        directory: Directory.Data,
        path,
        encoding: Encoding.UTF8,
      });
      value = JSON.parse(file.data as string);
      const binary = atob(value.data),
        bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      value.blob = new Blob([bytes]);
    } else value = await idb(path);
    if (
      !value ||
      !(value.blob instanceof Blob) ||
      !Number.isSafeInteger(value.total) ||
      value.total < 0 ||
      (await hash(await value.blob.arrayBuffer())) !== value.hash
    )
      return undefined;
    return { blob: value.blob, total: value.total };
  } catch {
    return undefined;
  }
}
export async function saveChunk(
  key: string,
  offset: number,
  chunk: DownloadChunk,
) {
  const path = partialKey(key, offset);
  const digest = await hash(await chunk.blob.arrayBuffer());
  if (!native) {
    await idb(path, { ...chunk, hash: digest });
    return;
  }
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(chunk.blob);
  });
  await Filesystem.writeFile({
    directory: Directory.Data,
    path,
    encoding: Encoding.UTF8,
    data: JSON.stringify({ total: chunk.total, hash: digest, data }),
    recursive: true,
  });
}
export async function clearChunks(key: string) {
  const directory = partialKey(key, 0).replace(/\/0\.json$/, "");
  if (native) {
    await Filesystem.rmdir({
      directory: Directory.Data,
      path: directory,
      recursive: true,
    }).catch(() => {});
  } else {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("data", "readwrite"),
        store = tx.objectStore("data");
      const request = store.openKeyCursor(
        IDBKeyRange.bound(directory + "/", directory + "/\uffff"),
      );
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }).finally(() => d.close());
  }
}
export async function coverCache(
  key: string,
  value?: Blob,
): Promise<Blob | undefined> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error("无效的封面缓存标识");
  return idb("cover:" + key, value);
}
export async function clearFiles() {
  if (native) {
    try {
      await Filesystem.rmdir({
        directory: Directory.Data,
        path: "openreading",
        recursive: true,
      });
    } catch {}
  }
  {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("data", "readwrite");
      tx.objectStore("data").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    d.close();
  }
  generation = 0;
}
