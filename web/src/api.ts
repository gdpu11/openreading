export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
type ReaderTransport = {
  api: (path: string, method: string, body?: unknown) => Promise<any>;
  content: (version: string, member: string) => Promise<ArrayBuffer>;
  resource: (manifest: string, member: string, path: string) => Promise<string>;
};
let readerTransport: ReaderTransport | undefined;
export function setReaderTransport(value: ReaderTransport) {
  readerTransport = value;
}
export async function readContent(
  version: string,
  member: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (readerTransport) return readerTransport.content(version, member);
  const r = await fetch(contentURL(version, member), { signal });
  if (!r.ok) throw Error("无法读取快照");
  return r.arrayBuffer();
}
export async function pdfSource(
  version: string,
  member: string,
  signal?: AbortSignal,
) {
  return readerTransport
    ? { data: new Uint8Array(await readContent(version, member, signal)) }
    : { url: contentURL(version, member) };
}
export async function imageSource(
  manifest: string,
  member: string,
  path: string,
): Promise<string> {
  return readerTransport
    ? readerTransport.resource(manifest, member, path)
    : `/api/manifests/${manifest}/resource?workspaceDocumentId=${encodeURIComponent(member)}&path=${encodeURIComponent(path)}`;
}
let csrf = "";
export function setCSRF(v: string) {
  csrf = v;
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  options: {
    keepalive?: boolean;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  if (readerTransport) return readerTransport.api(path, method, body);
  const response = await fetch("/api" + path, {
    ...options,
    method,
    credentials: "same-origin",
    headers: {
      ...(body instanceof FormData
        ? {}
        : {
            "Content-Type":
              body instanceof Blob ? body.type : "application/json",
          }),
      "X-CSRF-Token": csrf,
      ...options.headers,
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData || body instanceof Blob
          ? body
          : JSON.stringify(body),
  }).catch(() => {
    throw new ApiError(
      "NETWORK_ERROR",
      "无法连接本机服务，草稿已保留，恢复后可重试",
      0,
    );
  });
  if (!response.ok) {
    let e;
    try {
      e = await response.json();
    } catch {
      e = { code: "NETWORK_ERROR", message: "服务暂时不可用，请保留草稿" };
    }
    throw new ApiError(e.code, e.message, response.status);
  }
  return response.json();
}
export const uid = () => crypto.randomUUID();
export const contentURL = (version: string, member: string) =>
  `/api/versions/${version}/content?workspaceDocumentId=${encodeURIComponent(member)}`;
export async function localDraftEntries(prefix: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("openreading-recovery", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("drafts");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("drafts", "readonly");
      const request = tx
        .objectStore("drafts")
        .getAll(IDBKeyRange.bound(prefix, prefix + "\uffff"));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
export async function localDraft(key: string, value?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("openreading-recovery", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("drafts");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(
        "drafts",
        value === undefined ? "readonly" : "readwrite",
      );
      const request =
        value === undefined
          ? tx.objectStore("drafts").get(key)
          : value === null
            ? tx.objectStore("drafts").delete(key)
            : tx.objectStore("drafts").put(value, key);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
