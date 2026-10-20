import { validLAN, privateIPv4, lanRequest } from "./lan";
import { ApiError, setReaderTransport } from "../api";
import {
  cachedBlob,
  storeBlob,
  hash,
  persistState,
  type Connection,
  type MobileState,
} from "./storage";
export function pairPayload(value: string) {
  const url = new URL(value);
  const payload = JSON.parse(
    new URLSearchParams(url.hash.slice(1)).get("pair") || "null",
  );
  if (!payload) throw Error("请扫描 Open Reading 的配对二维码");
  const origin = new URL(payload.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    (privateIPv4(origin.hostname) &&
      !validLAN(payload.origin, payload.certificateFingerprint)) ||
    (!!payload.certificateFingerprint &&
      !validLAN(payload.origin, payload.certificateFingerprint)) ||
    origin.origin !== payload.origin ||
    url.origin !== origin.origin ||
    !/^\w{32}$/.test(payload.id) ||
    !/^\w{64}$/.test(payload.secret)
  )
    throw Error("配对二维码无效，服务器必须使用 HTTPS");
  return payload as {
    origin: string;
    id: string;
    secret: string;
    certificateFingerprint?: string;
  };
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
export async function remote(
  c: Connection,
  path: string,
  body?: any,
): Promise<any> {
  const r = await (
    c.certificateFingerprint
      ? lanRequest(c.origin, c.certificateFingerprint, path, c.token, body)
      : fetch(c.origin + "/api" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: "Bearer " + c.token,
            ...(body === undefined || body instanceof FormData
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body:
            body === undefined
              ? undefined
              : body instanceof FormData
                ? body
                : JSON.stringify(body),
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(120000),
        })
  ).catch((e) => {
    if (
      c.certificateFingerprint &&
      /证书|certificate|pin|浏览器|局域网同步地址/i.test(e.message || "")
    )
      throw new ApiError("LAN_TRUST", e.message, 0);
    throw new ApiError(
      "NETWORK_ERROR",
      c.certificateFingerprint
        ? "电脑暂时不可达，请确认电脑开机、局域网同步已开启，手机与电脑在同一网络；笔记仍保存在手机"
        : "当前离线，手机笔记已保留，联网后可重试",
      0,
    );
  });
  if (!r.ok) {
    const e = await r
      .json()
      .catch(() => ({ code: "SYNC_FAILED", message: "同步失败，请稍后重试" }));
    throw new ApiError(e.code, e.message, r.status);
  }
  return r;
}
export const request = async (c: Connection, path: string, body?: any) =>
  (await remote(c, path, body)).json();
export const allDocuments = (s: MobileState) =>
  s.library?.workspaces.flatMap((w: any) =>
    w.documents.map((d: any) => ({ ...d, workspaceName: w.name })),
  ) || [];
export async function synchronize(
  c: Connection,
  s: MobileState,
  onProgress: (s: string) => void,
) {
  // Server idempotency makes a replay after an interrupted acknowledgement safe.
  for (const op of [...s.outbox]) {
    onProgress("正在上传手机笔记…");
    try {
      const { error: _localError, ...command } = op;
      await request(c, "/sync/commands", command);
    } catch (e: any) {
      if (e.status === 401 || e.status === 0) throw e;
      op.error = e.message;
      const saved = s.outbox.find((v) => v.operationId === op.operationId);
      if (saved) saved.error = e.message;
      await persistState(s);
      if (e.status === 401) throw e;
      continue;
    }
    s.outbox = s.outbox.filter((v) => v.operationId !== op.operationId);
    await persistState(s);
  }
  onProgress("正在获取文件与笔记…");
  const library = await request(c, "/sync/library");
  // A fresh manifest is committed only after all blobs are complete and hashed.
  // Interrupted downloads keep the previous working offline library.
  const documents = library.workspaces.flatMap((w: any) => w.documents);
  let done = 0;
  for (const d of documents) {
    onProgress(`下载文件 ${++done}/${documents.length} · ${d.title}`);
    const wanted = new Set(
      [d.version?.id, ...d.threads.map((t: any) => t.originalVersionId)].filter(
        Boolean,
      ),
    );
    for (const v of d.versions.filter((v: any) => wanted.has(v.id))) {
      if (!(await cachedBlob(v.contentHash))) {
        const response = await remote(
          c,
          `/sync/files/${encodeURIComponent(v.id)}?member=${encodeURIComponent(d.id)}`,
        );
        await storeBlob(v.contentHash, await response.blob());
      }
    }
    for (const manifest of d.manifests) {
      for (const resource of manifest.resources) {
        if (!(await cachedBlob(resource.blobHash))) {
          const response = await remote(
            c,
            `/sync/resources/${encodeURIComponent(manifest.id)}?member=${encodeURIComponent(d.id)}&path=${encodeURIComponent(resource.path)}`,
          );
          await storeBlob(resource.blobHash, await response.blob());
        }
      }
    }
  }
  if (library.readingData) {
    // Old server versions remain usable for books/notes; new versions advertise
    // the reading ledger before a phone attempts to upload offline intervals.
    const allowedReading = new Set(documents.map((d: any) => d.id));
    const readingPending = (s.readingEvents || []).filter((e) =>
      allowedReading.has(e.member),
    );
    const acknowledged = new Set<string>();
    for (let i = 0; i < readingPending.length; i += 100) {
      const events = readingPending.slice(i, i + 100);
      onProgress("正在同步阅读时长…");
      await request(c, "/sync/reading/events", { events });
      events.forEach((e) => acknowledged.add(e.id));
    }
    library.readingData = await request(c, "/sync/reading");
    const confirmed = new Set<string>(
      library.readingData.events.map((e: any) => e.id),
    );
    // Publish acknowledgements and the replacement snapshot together. If the
    // response is interrupted, immutable intervals can be replayed safely.
    s.readingEvents = (s.readingEvents || []).filter(
      (e) => !acknowledged.has(e.id) || !confirmed.has(e.id),
    );
  }
  s.library = library;
  await persistState(s);
  return library;
}
export function mobileReader(s: () => MobileState) {
  const artifacts = new Map<string, any>();
  setReaderTransport({
    async api(path, method, body: any) {
      if (path === "/artifacts" && method === "POST") {
        const id = await hash(
          new TextEncoder().encode(JSON.stringify(body)).buffer,
        );
        artifacts.set(id, { id, ...body });
        return { id };
      }
      if (path.startsWith("/artifacts/") && method === "GET") {
        return artifacts.get(path.split("/")[2].split("?")[0]);
      }
      if (path.startsWith("/documents/") && path.endsWith("/resolve"))
        return { ok: true };
      if (path.startsWith("/manifests/") && method === "GET") {
        const id = path.split("/")[2].split("?")[0];
        return (
          allDocuments(s())
            .flatMap((d: any) => d.manifests)
            .find((m: any) => m.id === id) || { resources: [] }
        );
      }
      throw Error("此资源尚未同步，请先在电脑端打开后重新同步");
    },
    async content(version, member) {
      const doc = allDocuments(s()).find((d: any) => d.id === member),
        v = doc?.versions.find((v: any) => v.id === version),
        blob = v && (await cachedBlob(v.contentHash));
      if (!blob) throw Error("文件尚未下载，请联网同步");
      return blob.arrayBuffer();
    },
    async resource(manifest, member, path) {
      const d = allDocuments(s()).find((d: any) => d.id === member),
        resource = d?.manifests
          .find((m: any) => m.id === manifest)
          ?.resources.find((r: any) => r.path === path);
      const blob = resource && (await cachedBlob(resource.blobHash));
      if (!blob) throw Error("图片尚未同步");
      return URL.createObjectURL(new Blob([blob], { type: resource.mime }));
    },
  });
}
