import { validLAN, privateIPv4, lanRequest } from "./lan";
import { ApiError, setReaderTransport } from "../api";
import {
  cachedBlob,
  hash,
  persistState,
  type Connection,
  type MobileState,
} from "./storage";
import { downloadBlob } from "./download";
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
  headers: Record<string, string> = {},
): Promise<any> {
  const r = await (
    c.certificateFingerprint
      ? lanRequest(
          c.origin,
          c.certificateFingerprint,
          path,
          c.token,
          body,
          headers,
        )
      : fetch(c.origin + "/api" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...headers,
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
  if (!r.ok && !(r.status === 416 && headers.Range)) {
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
export function retainOfflineLibrary(previous: any, incoming: any) {
  if (!previous || previous.deviceId !== incoming.deviceId) return incoming;
  const retained = new Set<string>();
  const workspaces = incoming.workspaces.map((w: any) => ({ ...w, documents: w.documents.map((d: any) => ({ ...d, localOnly: false })) }));
  for (const workspace of previous.workspaces) {
    let next = workspaces.find((w: any) => w.id === workspace.id);
    if (!next) {
      next = { ...workspace, documents: [] };
      workspaces.push(next);
    }
    const current = new Set(next.documents.map((d: any) => d.id));
    for (const doc of workspace.documents) if (!current.has(doc.id)) {
      retained.add(doc.id);
      next.documents.push({ ...doc, localOnly: true });
    }
  }
  const readingData = incoming.readingData && {
    ...incoming.readingData,
    events: [...new Map([
      ...(previous.readingData?.events || []).filter((e: any) => retained.has(e.member)),
      ...incoming.readingData.events,
    ].map((e: any) => [e.id, e])).values()],
  };
  return { ...incoming, workspaces, ...(readingData ? { readingData } : {}) };
}
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
  onProgress("正在检查已下载文件…");
  const cached = new Set<string>();
  const pending = [];
  for (const d of documents) {
    const wanted = new Set(
      [d.version?.id, ...d.threads.map((t: any) => t.originalVersionId)].filter(
        Boolean,
      ),
    );
    const files = d.versions
      .filter((v: any) => wanted.has(v.id))
      .map((v: any) => ({
        hash: v.contentHash,
        size: v.size,
        path: `/sync/files/${encodeURIComponent(v.id)}?member=${encodeURIComponent(d.id)}`,
      }));
    for (const manifest of d.manifests) {
      for (const resource of manifest.resources) {
        files.push({
          hash: resource.blobHash,
          size: undefined,
          path: `/sync/resources/${encodeURIComponent(manifest.id)}?member=${encodeURIComponent(d.id)}&path=${encodeURIComponent(resource.path)}`,
        });
      }
    }
    for (const f of files) {
      if (!cached.has(f.hash) && (await cachedBlob(f.hash))) cached.add(f.hash);
    }
    if (files.some((f: any) => !cached.has(f.hash))) pending.push({ d, files });
  }
  let done = documents.length - pending.length;
  onProgress(`已同步 ${done}/${documents.length} 个文件`);
  for (const { d, files } of pending) {
    for (const file of files) {
      if (cached.has(file.hash)) continue;
      await downloadBlob(
        file.hash,
        file.size,
        (range) => remote(c, file.path, undefined, { Range: range }),
        (received, total) => {
          const percent = total ? Math.floor((received * 100) / total) : 0;
          onProgress(
            `已同步 ${done}/${documents.length} 个文件 · ${d.title} · ${percent}%`,
          );
        },
      );
      cached.add(file.hash);
    }
    onProgress(`已同步 ${++done}/${documents.length} 个文件`);
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
  s.library = retainOfflineLibrary(s.library, library);
  await persistState(s);
  return s.library;
}
export function mobileReader(s: () => MobileState) {
  const artifacts = new Map<string, any>();
  setReaderTransport({
    async api(path, method, body: any) {
      if(path.includes("/recognized-pages")&&method==="GET"){const url=new URL("https://local.invalid"+path),member=path.split("/")[2],doc=allDocuments(s()).find((d:any)=>d.id===member);return (doc?.recognizedPages||[]).filter((p:any)=>p.versionId===url.searchParams.get("version"));}
      const match =
        /^\/documents\/([^/]+)\/(bookmarks|preferences)(?:\/([^/]+))?$/.exec(
          path,
        );
      if (match) {
        const doc = s()
          .library?.workspaces.flatMap((w: any) => w.documents)
          .find((d: any) => d.id === match[1]);
        if (!doc) throw Error("此书不在手机书库中");
        if (match[2] === "preferences") {
          if (method === "GET")
            return { data: doc.preferences || {}, revision: 0 };
          throw Error("手机阅读设置保存在本机");
        }
        if (method === "GET") return doc.bookmarks || [];
        if (method === "POST") {
          const operationId = crypto.randomUUID(),
            mark = {
              id: operationId,
              workspaceDocumentId: doc.id,
              ...body,
              createdAt: new Date().toISOString(),
            };
          (doc.bookmarks ||= []).push(mark);
          s().outbox.push({
            type: "bookmark",
            operationId,
            member: doc.id,
            ...body,
          });
          await persistState(s());
          return mark;
        }
        if (method === "DELETE") {
          const pending = s().outbox.find(
            (op: any) => op.type === "bookmark" && op.operationId === match[3],
          );
          if (pending)
            s().outbox = s().outbox.filter(
              (op: any) => op.operationId !== pending.operationId,
            );
          else
            s().outbox.push({
              type: "delete-bookmark",
              operationId: crypto.randomUUID(),
              member: doc.id,
              bookmarkId: match[3],
            });
          doc.bookmarks = (doc.bookmarks || []).filter(
            (mark: any) => mark.id !== match[3],
          );
          await persistState(s());
          return { ok: true };
        }
      }
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
