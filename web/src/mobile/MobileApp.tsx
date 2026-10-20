import { useLanguage } from "../i18n";
import { LanguageSelect } from "../i18n/LanguageSelect";
import { tr, locale } from "../i18n";
import { ReadingStats } from "../reading/ReadingStats";
import type { ReadingEvent } from "../reading/data";
import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { CapacitorBarcodeScanner } from "@capacitor/barcode-scanner";
import {
  BookOpen,
  CalendarDays,
  ArrowLeft,
  RefreshCw,
  ScanLine,
  Sun,
  Moon,
  FileText,
  Download,
  Upload,
  X,
} from "lucide-react";
import { Reader } from "../readers/Reader";
import type {
  Captured,
  Prepared,
  ReaderAdapter,
  ReaderPreferences,
} from "../readers/types";
import {
  connection,
  saveConnection,
  clearConnection,
  clearFiles,
  loadState,
  persistState,
  emptyState,
  type Connection,
  type MobileState,
} from "./storage";
import {
  allDocuments,
  mobileReader,
  pairPayload,
  randomToken,
  remote,
  request,
  synchronize,
} from "./sync";
import { ordPath, ordForm, ordResponse, saveORD } from "../ord";
import "./mobile.css";
const base: ReaderPreferences = {
  theme: "light",
  fontSize: 18,
  lineHeight: 1.9,
  fontFamily: "system-ui",
  pdfScale: 1,
  pdfRotation: 0,
  epubFlow: "scrolled-doc",
  encoding: "utf-8",
  leftWidth: 0,
  rightWidth: 0,
};
export function MobileApp() {
  useLanguage();
  const [c, setConnection] = useState<Connection | null>(null),
    [ordTarget, setOrdTarget] = useState(""),
    [ordBusy, setOrdBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [statsMode, setStatsMode] = useState(false),
    [foreground, setForeground] = useState(true),
    [view, setView] = useState<"library" | "notes">("library"),
    [doc, setDoc] = useState<Prepared | null>(null),
    [version, setVersion] = useState(0),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [input, setInput] = useState(""),
    [name, setName] = useState(
      Capacitor.getPlatform() === "ios" ? tr("我的 iPhone") : tr("我的手机"),
    ),
    [fingerprint, setFingerprint] = useState(""),
    [reconnecting, setReconnecting] = useState(false),
    [selection, setSelection] = useState<Captured | null>(null),
    [draft, setDraft] = useState(""),
    [editing, setEditing] = useState<any>(null),
    [prefs, setPrefs] = useState<ReaderPreferences>(() => ({
      ...base,
      theme:
        localStorage.getItem("open-reading-theme") === "dark"
          ? "dark"
          : "light",
    }));
  const state = useRef<MobileState>(emptyState()),
    ordInput = useRef<HTMLInputElement>(null),
    reader = useRef<ReaderAdapter>(null),
    syncing = useRef(false),
    alive = useRef(true),
    current = useRef<Connection | null>(null);
  current.current = c;
  const changed = () => setVersion((v) => v + 1);
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
    localStorage.setItem("open-reading-theme", prefs.theme);
  }, [prefs.theme]);
  const recordReading = (event: ReadingEvent) => {
    (state.current.readingEvents ||= []).push(event);
    void persistState(state.current).catch(() =>
      setError("阅读记录保存失败，请检查手机存储空间"),
    );
    changed();
  };
  async function sync(conn = current.current) {
    if (!conn?.deviceId || syncing.current) return;
    syncing.current = true;
    setError("");
    try {
      await synchronize(conn, state.current, setStatus);
      setStatus(
        state.current.outbox.length ? "部分笔记需要处理" : "文件与笔记已同步",
      );
      changed();
    } catch (e: any) {
      setError(
        e.status === 0
          ? conn.certificateFingerprint
            ? e.message
            : ""
          : e.status === 401
            ? "此手机授权已失效，请在电脑上重新配对。已下载文件和手机草稿仍保留。"
            : e.message || "网络暂时不可用，继续离线阅读；联网后可重试",
      );
      setStatus(
        state.current.outbox.length ? "离线书库 · 笔记等待同步" : "离线书库",
      );
    } finally {
      syncing.current = false;
    }
  }
  useEffect(() => {
    alive.current = true;
    void Promise.all([connection(), loadState()])
      .then(([conn, s]) => {
        if (!alive.current) return;
        state.current = s;
        setConnection(conn);
        mobileReader(() => state.current);
        setLoaded(true);
        if (conn?.deviceId) void sync(conn);
        const incoming = new URLSearchParams(location.hash.slice(1)).get(
          "pair",
        );
        if (incoming) {
          setInput(location.href);
          history.replaceState(null, "", location.pathname);
        }
      })
      .catch((e) => setError(e.message));
    const online = () => void sync();
    window.addEventListener("online", online);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void sync();
    }, 30000);
    const visibility = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", visibility);
    let nativeListener: Promise<any> | undefined;
    if (Capacitor.isNativePlatform())
      nativeListener = NativeApp.addListener("appStateChange", (s) => {
        setForeground(s.isActive);
        if (s.isActive) void sync();
      });
    void navigator.storage?.persist?.();
    return () => {
      alive.current = false;
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visibility);
      clearInterval(timer);
      void nativeListener?.then((l) => l.remove());
    };
  }, []);
  useEffect(() => {
    if (!c || c.deviceId) return;
    let active = true;
    const poll = async () => {
      try {
        const v = await request(
          c,
          "/pair/status?grant=" + encodeURIComponent(c.pendingGrant || ""),
        );
        if (!active) return;
        if (v.state === "approved") {
          const next = { ...c, deviceId: v.deviceId, pendingGrant: undefined };
          await saveConnection(next);
          setConnection(next);
          setFingerprint("");
          void sync(next);
        }
      } catch (e: any) {
        if (active) setError(e.message);
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [c?.token, c?.deviceId, c?.pendingGrant]);
  async function pair(value = input) {
    setError("");
    try {
      const p = pairPayload(value);
      if (
        c &&
        c.origin !== p.origin &&
        !(
          c.certificateFingerprint &&
          c.certificateFingerprint === p.certificateFingerprint
        )
      )
        throw Error(
          "当前手机还有另一书库的数据。请先同步或复制笔记，再移除旧连接。",
        );
      const next = {
        origin: p.origin,
        certificateFingerprint: p.certificateFingerprint,
        pendingGrant: p.id,
        token: c?.token || randomToken(),
        name: name.trim() || "我的手机",
      };
      await saveConnection(next);
      const v = await request(next, "/pair/claim", {
        ...p,
        token: next.token,
        name: next.name,
      });
      setFingerprint(v.fingerprint);
      setConnection(next);
      setReconnecting(false);
      setInput("");
      setStatus("请在电脑端核对确认码并授权");
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function scan() {
    try {
      const v = await CapacitorBarcodeScanner.scanBarcode({
        hint: 0,
        scanInstructions: "扫描电脑 Open Reading 设置中的配对二维码",
        scanButton: true,
        scanText: "扫描二维码",
        cancelButtonAccessibilityLabel: "取消扫描",
      });
      if (v.ScanResult) await pair(v.ScanResult);
    } catch (e: any) {
      setError(
        "无法扫码，请允许相机权限，或粘贴完整配对链接。" + (e.message || ""),
      );
    }
  }
  function open(d: any, anchor?: any) {
    const v = anchor
      ? d.versions.find((v: any) => v.id === anchor.documentVersionId)
      : d.version;
    if (!v) {
      setError("这份文档尚未缓存，请先同步");
      return;
    }
    const manifest =
      anchor?.resourceManifestId ||
      [...d.manifests].reverse().find((m: any) => m.versionId === v.id)?.id;
    setDoc({
      ...d,
      version: v,
      resourceManifestId: manifest,
      initialAnchor: anchor,
      historical: true,
    });
    setSelection(null);
    setEditing(null);
    setDraft("");
    setError("");
  }
  const documents = allDocuments(state.current),
    currentDoc = documents.find((d: any) => d.id === doc?.workspaceDocumentId);
  const key = editing
    ? "message:" + editing.id
    : doc
      ? "note:" + doc.workspaceDocumentId
      : "";
  function changeDraft(value: string) {
    setDraft(value);
    state.current.drafts[key] = value;
    void persistState(state.current).catch((e) =>
      setError("草稿保存失败：" + e.message),
    );
  }
  function compose(s: Captured | null) {
    setSelection(s);
    if (s) {
      setEditing(null);
      setDraft(
        state.current.drafts["note:" + s.anchor.workspaceDocumentId] || "",
      );
    }
  }
  async function saveNote() {
    if (!draft.trim() || (!selection && !editing) || !doc) return;
    try {
      const op = editing
        ? {
            operationId: crypto.randomUUID(),
            type: "edit",
            member: doc.workspaceDocumentId,
            messageId: editing.id,
            revision: editing.revision,
            body: draft,
          }
        : {
            operationId: crypto.randomUUID(),
            type: "create",
            member: doc.workspaceDocumentId,
            anchor: selection!.anchor,
            artifact: selection!.artifact,
            body: draft,
          };
      if (
        editing &&
        state.current.outbox.some((v) => v.messageId === editing.id)
      )
        throw Error("这条笔记已有待同步修改，请先同步或处理冲突");
      state.current.outbox.push(op);
      delete state.current.drafts[key];
      await persistState(state.current);
      setSelection(null);
      setEditing(null);
      setDraft("");
      reader.current?.clearNativeSelection();
      changed();
      setStatus("笔记已保存在手机，正在等待同步");
      void sync();
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function exportBook() {
    if (!c?.deviceId || !doc) return;
    if (syncing.current) {
      setError("正在同步，请稍后导出");
      return;
    }
    if (draft.trim() && (editing || selection)) {
      setError("请先保存当前笔记，再导出学习包");
      return;
    }
    syncing.current = true;
    setOrdBusy(true);
    setError("");
    try {
      await synchronize(c, state.current, setStatus);
      changed();
      if (
        state.current.outbox.some((op) => op.member === doc.workspaceDocumentId)
      )
        throw Error("本书仍有未同步笔记，请先处理后再导出，避免遗漏");
      setStatus("正在导出原文与笔记…");
      const response = await remote(
        c,
        "/sync" +
          ordPath(
            doc.workspaceDocumentId,
            doc.version.id,
            doc.resourceManifestId,
          ),
      );
      if (Number(response.headers.get("Content-Length")) > 100 * 1024 * 1024)
        throw Error("学习包超过手机 100 MB 上限，请在电脑端导出");
      const blob = await ordResponse(response);
      if (blob.size > 100 * 1024 * 1024)
        throw Error("学习包超过手机 100 MB 上限，请在电脑端导出");
      await saveORD(blob, doc.title);
      setStatus("ORD 已生成，可保存或分享给他人");
    } catch (e: any) {
      setError(e.message);
    } finally {
      syncing.current = false;
      setOrdBusy(false);
    }
  }
  async function importBook(file?: File) {
    if (!file || !c?.deviceId) return;
    if (syncing.current) {
      setError("正在同步，请稍后导入");
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setError("学习包超过手机 100 MB 上限，请在电脑端导入后同步");
      return;
    }
    const workspace = ordTarget || state.current.library?.workspaces[0]?.id;
    if (!workspace) {
      setError("请先同步并选择目标工作区");
      return;
    }
    syncing.current = true;
    setOrdBusy(true);
    setError("");
    try {
      setStatus("正在导入 ORD 学习包…");
      const result = await request(
        c,
        "/sync/workspaces/" + workspace + "/ord",
        ordForm(file),
      );
      await synchronize(c, state.current, setStatus);
      changed();
      setStatus(`已导入 ${result.title}，包含 ${result.annotations} 条标注`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      syncing.current = false;
      setOrdBusy(false);
    }
  }
  async function removeConnection() {
    if (syncing.current) {
      setError("请等本次同步完成后再移除连接");
      return;
    }
    if (
      !window.confirm(
        tr(
          state.current.outbox.length || state.current.readingEvents?.length
            ? "手机还有未同步笔记或阅读记录，移除会清除这些记录。请先同步并确认保存，仍要移除？"
            : "移除连接并清除手机已下载的文件与笔记？电脑和云端资料会保留。",
        ),
      )
    )
      return;
    try {
      await clearFiles();
      await clearConnection();
      state.current = emptyState();
      setConnection(null);
      setDoc(null);
      setStatus("");
      setError("");
      changed();
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function discard(op: any) {
    if (!window.confirm(tr("移除这条手机草稿？请先复制需要保留的内容。")))
      return;
    state.current.outbox = state.current.outbox.filter(
      (v) => v.operationId !== op.operationId,
    );
    await persistState(state.current);
    changed();
  }
  const threadNotes = (currentDoc?.threads || []).filter(
    (t: any) => t.originalVersionId === doc?.version.id,
  );
  return (
    <div className="mobile-app" data-refresh={version}>
      <header className="mobile-header">
        {doc ? (
          <button
            aria-label={tr("返回书库")}
            onClick={() => {
              setDoc(null);
              setSelection(null);
              setEditing(null);
            }}
          >
            <ArrowLeft />
          </button>
        ) : (
          <BookOpen />
        )}
        <div>
          <strong>Open Reading</strong>
          <small>{doc?.title || tr("我的随身书库")}</small>
        </div>
        {c?.deviceId && (
          <button
            aria-label={tr("阅读数据")}
            onClick={() => setStatsMode(true)}
          >
            <CalendarDays size={20} />
          </button>
        )}
        {doc && (
          <button
            aria-label={tr("导出本书 ORD")}
            disabled={ordBusy}
            onClick={() => void exportBook()}
          >
            <Download />
          </button>
        )}
        <button
          aria-label={tr("切换黑白主题")}
          onClick={() =>
            setPrefs({
              ...prefs,
              theme: prefs.theme === "dark" ? "light" : "dark",
            })
          }
        >
          {prefs.theme === "dark" ? <Sun /> : <Moon />}
        </button>
        {c?.deviceId && (
          <button aria-label={tr("同步文件与笔记")} onClick={() => void sync()}>
            <RefreshCw />
          </button>
        )}
      </header>
      <div className="mobile-status-row">
        <div className="mobile-status" role="status">
          {tr(status) ||
            (!loaded
              ? tr("正在打开书库…")
              : c?.deviceId
                ? tr("可离线阅读")
                : tr("扫码直连同一网络中的电脑"))}
        </div>
        <LanguageSelect compact />
      </div>
      {error && (
        <div className="mobile-error" role="alert">
          {tr(error)}
          <button aria-label={tr("关闭提示")} onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {statsMode && c?.deviceId && (
        <div className="reading-stats-overlay">
          <ReadingStats
            scope="authorized"
            data={{
              events: [
                ...(state.current.library?.readingData?.events || []),
                ...(state.current.readingEvents || []),
              ].map((e) => ({
                ...e,
                title:
                  e.title ||
                  allDocuments(state.current).find(
                    (d: any) => d.id === e.member,
                  )?.title,
              })),
              goalMinutes:
                state.current.library?.readingData?.goalMinutes || 30,
            }}
            notice={
              state.current.readingEvents?.length
                ? "含手机离线阅读记录，连接电脑后会自动合并"
                : "手机展示已授权工作区的阅读记录"
            }
            onClose={() => setStatsMode(false)}
          />
        </div>
      )}
      {!c?.deviceId || reconnecting ? (
        <main className="mobile-pair">
          <ScanLine size={48} />
          <h1>{tr("把阅读带在身边")}</h1>
          <p>
            {tr(
              "电脑打开本机书库，手机与电脑连接同一 Wi-Fi，在电脑设置 → 手机与同步中开启局域网同步并生成二维码。扫码后由电脑确认授权，不需要服务器。",
            )}
          </p>
          {reconnecting && (
            <button onClick={() => setReconnecting(false)}>
              {tr("返回现有书库")}
            </button>
          )}
          <label>
            {tr("设备名称")}
            <input
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button className="primary" onClick={scan}>
            {tr("扫描电脑二维码")}
          </button>
          <details>
            <summary>{tr("粘贴配对链接")}</summary>
            <textarea
              aria-label={tr("完整配对链接")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={tr("粘贴包含 #pair= 的完整链接")}
            />
            <button onClick={() => void pair()}>{tr("申请配对")}</button>
          </details>
          {input && (
            <button className="primary" onClick={() => void pair()}>
              {tr("连接此电脑")}
            </button>
          )}
          {c && !c.deviceId && (
            <div className="mobile-approval">
              <h2>{fingerprint || tr("等待电脑确认")}</h2>
              <p>{tr("请在电脑上核对确认码，再点击“确认授权此设备”。")}</p>
              <button
                onClick={async () => {
                  try {
                    if (state.current.library?.deviceId) {
                      const previous = {
                        ...c,
                        deviceId: state.current.library.deviceId,
                        pendingGrant: undefined,
                      };
                      await saveConnection(previous);
                      setConnection(previous);
                    } else {
                      await clearConnection();
                      setConnection(null);
                    }
                    setFingerprint("");
                    setError("");
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                {tr("取消配对")}
              </button>
            </div>
          )}
        </main>
      ) : doc ? (
        <>
          <div className="mobile-reader-wrap">
            <Reader
              ref={reader}
              key={doc.workspaceDocumentId + doc.version.id}
              doc={doc}
              preferences={prefs}
              onPdfScaleChange={(scale) =>
                setPrefs((current) => ({ ...current, pdfScale: scale }))
              }
              activityEnabled={
                foreground &&
                !statsMode &&
                !selection &&
                !editing &&
                view !== "notes"
              }
              onReading={recordReading}
              annotations={threadNotes}
              onSelect={compose}
              onPickThread={() => setView("notes")}
              onOutline={() => {}}
              onProgress={() => {}}
              onError={setError}
            />
          </div>
          <div className="mobile-reader-tools">
            <button
              onClick={() => setView(view === "notes" ? "library" : "notes")}
            >
              {view === "notes"
                ? tr("收起笔记")
                : tr(`笔记 ${currentDoc?.threads.length || 0}`)}
            </button>
            <label>
              {tr("字号")}
              <input
                aria-label={tr("手机阅读字号")}
                type="range"
                min={14}
                max={28}
                value={prefs.fontSize}
                onChange={(e) =>
                  setPrefs({ ...prefs, fontSize: Number(e.target.value) })
                }
              />
            </label>
          </div>
          {(selection || editing) && (
            <div className="mobile-compose">
              <button
                className="mobile-compose-close"
                aria-label={tr("收起编辑")}
                onClick={() => {
                  setSelection(null);
                  setEditing(null);
                }}
              >
                <X />
              </button>
              {selection && (
                <blockquote>
                  {selection.anchor.quote.exact ||
                    selection.anchor.displayLocation.label}
                </blockquote>
              )}
              <textarea
                aria-label={tr("手机笔记")}
                value={draft}
                onChange={(e) => changeDraft(e.target.value)}
                placeholder={tr("记下你的理解…")}
              />
              <button
                className="primary"
                disabled={!draft.trim()}
                onClick={() => void saveNote()}
              >
                {tr("保存手机笔记")}
              </button>
            </div>
          )}
        </>
      ) : (
        <main className="mobile-library">
          <nav>
            <button
              className={view === "library" ? "active" : ""}
              onClick={() => setView("library")}
            >
              {tr("文件")}
            </button>
            <button
              className={view === "notes" ? "active" : ""}
              onClick={() => setView("notes")}
            >
              {tr("笔记")}
            </button>
          </nav>
          {view === "library" ? (
            <>
              {documents.length === 0 && (
                <p>
                  {tr(
                    "授权的工作区还没有文件，或尚未完成首次同步。请在电脑端导入文件，再点击同步。",
                  )}
                </p>
              )}
              {documents.map((d: any) => (
                <button
                  className="mobile-document"
                  key={d.id}
                  onClick={() => open(d)}
                >
                  <FileText />
                  <span>
                    <strong>{d.title}</strong>
                    <small>
                      {d.workspaceName} · {d.format.toUpperCase()} ·{" "}
                      {d.version ? tr("已下载") : tr("待电脑缓存")}
                    </small>
                  </span>
                </button>
              ))}
            </>
          ) : null}
          <p className="mobile-footer">
            {c.origin}
            <br />
            {state.current.library?.syncedAt &&
              tr("上次同步 ") +
                new Date(state.current.library.syncedAt).toLocaleString(
                  locale(),
                )}
          </p>
          <div className="mobile-ord-import">
            <label>
              {tr("导入学习包到")}
              <select
                aria-label={tr("ORD 目标工作区")}
                value={
                  ordTarget || state.current.library?.workspaces[0]?.id || ""
                }
                onChange={(e) => setOrdTarget(e.target.value)}
              >
                {state.current.library?.workspaces.map((w: any) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={ordBusy}
              onClick={() => ordInput.current?.click()}
            >
              <Upload size={16} />
              {tr("导入 ORD 学习包")}
            </button>
            <small>
              {tr(
                "包含原文、标注和已保存笔记，导入为独立副本。手机导入、导出需联网，最大 100 MB。",
              )}
            </small>
          </div>
          <button
            onClick={() => {
              setReconnecting(true);
              setError("");
            }}
          >
            {tr("重新扫码授权（保留文件与笔记）")}
          </button>
          <button onClick={() => void removeConnection()}>
            {tr("移除连接与手机缓存")}
          </button>
        </main>
      )}
      <input
        ref={ordInput}
        type="file"
        accept=".ord,application/vnd.openreading.ord+zip,application/zip,application/octet-stream"
        hidden
        onChange={(e) => {
          void importBook(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {c?.deviceId && view === "notes" && (
        <section className={"mobile-notes" + (doc ? " over-reader" : "")}>
          <h2>{doc ? tr("本文件笔记") : tr("所有笔记")}</h2>
          {(doc ? [currentDoc] : documents).filter(Boolean).flatMap((d: any) =>
            d.threads.map((t: any) => (
              <article key={t.threadId}>
                <button
                  className="mobile-quote"
                  onClick={() => {
                    open(d, t.anchor);
                    setView("library");
                  }}
                >
                  {t.anchor.quote.exact ||
                    t.anchor.displayLocation?.label ||
                    d.title}
                </button>
                {t.messages.map((m: any) => (
                  <div className="mobile-note-message" key={m.id}>
                    <p>{m.body}</p>
                    {m.role === "user" && m.recipient === "note" && (
                      <button
                        onClick={() => {
                          open(d, t.anchor);
                          setEditing(m);
                          setSelection(null);
                          setDraft(
                            state.current.drafts["message:" + m.id] ?? m.body,
                          );
                          setView("library");
                        }}
                      >
                        {tr("修改笔记")}
                      </button>
                    )}
                  </div>
                ))}
              </article>
            )),
          )}
          {state.current.outbox.map((op) => (
            <article key={op.operationId}>
              <small>{op.error ? tr("需要处理") : tr("等待同步")}</small>
              <p>{op.body}</p>
              {op.error && <p role="alert">{tr(op.error)}</p>}
              <button onClick={() => void discard(op)}>
                {tr("移除手机草稿")}
              </button>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
