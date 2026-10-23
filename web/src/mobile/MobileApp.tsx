import { NotesCenter } from "../learning/NotesCenter";
import { BookTools } from "../readers/BookTools";
import { MobileCover } from "./MobileCover";
import type { OutlineItem } from "../readers/types";
import {
  Search,
  Settings,
  NotebookPen,
  ChevronRight,
  Plus,
  SlidersHorizontal,
  Bookmark,
  ArrowUpRight,
} from "lucide-react";
import { dailyTotals, dayKey } from "../reading/data";
import "../learning/learning.css";
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
    [view, setView] = useState<"library" | "notes" | "settings">("library"),
    [shelfQuery, setShelfQuery] = useState(""),
    [shelfFilter, setShelfFilter] = useState("all"),
    [outline, setOutline] = useState<OutlineItem[]>([]),
    [readerSettings, setReaderSettings] = useState(false),
    [progressHost, setProgressHost] = useState<HTMLDivElement | null>(null),
    [pageHost, setPageHost] = useState<HTMLSpanElement | null>(null),
    [showBookNotes, setShowBookNotes] = useState(false),
    [doc, setDoc] = useState<Prepared | null>(null),
    [version, setVersion] = useState(0),
    [status, setStatus] = useState(""),
    [syncError, setSyncError] = useState(""),
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
  useEffect(() => {
    if (!doc) return;
    (state.current.bookPreferences ||= {})[doc.workspaceDocumentId] = prefs;
    void persistState(state.current).catch((e) => setError(e.message));
  }, [prefs, doc?.workspaceDocumentId]);
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordPosition = (locator: any) => {
    if (!doc) return;
    const target = state.current.library?.workspaces
      .flatMap((w: any) => w.documents)
      .find((d: any) => d.id === doc.workspaceDocumentId);
    if (!target) return;
    target.readingState = {
      ...target.readingState,
      versionId: doc.version.id,
      locator,
    };
    if (positionTimer.current) clearTimeout(positionTimer.current);
    positionTimer.current = setTimeout(
      () => void persistState(state.current).catch((e) => setError(e.message)),
      400,
    );
  };
  useEffect(
    () => () => {
      if (positionTimer.current) clearTimeout(positionTimer.current);
    },
    [],
  );
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
    setSyncError("");
    try {
      await synchronize(conn, state.current, setStatus);
      setStatus(
        state.current.outbox.length ? "部分笔记需要处理" : "文件与笔记已同步",
      );
      changed();
    } catch (e: any) {
      setSyncError(
        e.status === 0
          ? conn.certificateFingerprint
            ? e.message
            : ""
          : e.status === 401
            ? "此手机授权已失效，请在电脑上重新配对。已下载文件和手机草稿仍保留。"
            : e.message || "网络暂时不可用，继续离线阅读；联网后可重试",
      );
      setStatus(
        state.current.outbox.length
          ? "同步已中断，进度已保存 · 笔记等待同步"
          : "同步已中断，进度已保存，下次将继续",
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
          setView("settings");
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
        scanButton: false,
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
    setOutline([]);
    setShowBookNotes(false);
    state.current.lastBook = d.id;
    setPrefs({
      ...base,
      theme: prefs.theme,
      ...d.preferences,
      ...state.current.bookPreferences?.[d.id],
    });
    void persistState(state.current).catch((e) => setError(e.message));
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
  const notes = documents.flatMap((d: any) =>
    (d.threads || []).map((n: any) => ({
      ...n,
      title: d.title,
      workspaceId:
        d.workspaceId ||
        state.current.library?.workspaces.find((w: any) =>
          w.documents.some((book: any) => book.id === d.id),
        )?.id,
    })),
  );
  const visibleBooks = documents.filter(
    (d: any) =>
      (!shelfQuery ||
        d.title.toLocaleLowerCase().includes(shelfQuery.toLocaleLowerCase())) &&
      (shelfFilter === "all" ||
        (shelfFilter === "reading"
          ? !!d.readingState && !d.finishedAt
          : shelfFilter === "finished"
            ? !!d.finishedAt
            : d.format === shelfFilter)),
  );
  const lastBook =
    documents.find((d: any) => d.id === state.current.lastBook) ||
    documents.find((d: any) => d.readingState);
  const todayMinutes = Math.floor(
    (dailyTotals([
      ...(state.current.library?.readingData?.events || []),
      ...(state.current.readingEvents || []),
    ])[dayKey(Date.now())] || 0) / 60000,
  );
  const saveLearning = async (n: any, changes: any) => {
    const book = state.current.library?.workspaces
        .flatMap((w: any) => w.documents)
        .find((d: any) => d.id === n.workspaceDocumentId),
      thread = book?.threads.find((t: any) => t.threadId === n.threadId);
    if (!thread) throw Error("笔记尚未同步");
    const operation = {
      operationId: crypto.randomUUID(),
      type: "learning",
      member: n.workspaceDocumentId,
      threadId: n.threadId,
      ...changes,
    };
    state.current.outbox.push(operation);
    if (changes.tags) thread.tags = changes.tags;
    if (changes.outcome) {
      let days = thread.intervalDays || 1;
      if (changes.outcome === "again") days = 1;
      else if (changes.outcome === "good") days = Math.min(180, days * 2);
      else if (changes.outcome === "easy") days = Math.min(365, days * 4);
      thread.intervalDays = days;
      thread.dueAt =
        changes.outcome === "pause"
          ? ""
          : new Date(
              Date.now() +
                (changes.outcome === "schedule" ? 0 : days * 86400000),
            ).toISOString();
    }
    thread.learningRevision = (thread.learningRevision || 0) + 1;
    await persistState(state.current);
    changed();
    void sync();
  };
  const editNote = (n: any, m: any) => {
    const book = documents.find((d: any) => d.id === n.workspaceDocumentId);
    if (!book) return;
    open(book, n.anchor);
    setEditing(m);
    setSelection(null);
    setDraft(state.current.drafts["message:" + m.id] ?? m.body);
    setShowBookNotes(false);
    setView("library");
  };
  const closeBook = () => {
    setDoc(null);
    setSelection(null);
    setEditing(null);
    setShowBookNotes(false);
    setReaderSettings(false);
    window.speechSynthesis?.cancel();
  };
  return (
    <div
      className={"mobile-app" + (doc ? " reader-mode" : "")}
      data-refresh={version}
    >
      <header className="mobile-header">
        {doc ? (
          <>
            <button aria-label={tr("返回书库")} onClick={closeBook}>
              <ArrowLeft size={22} />
            </button>
            <div className="mobile-reader-title">
              <strong>{doc.title.replace(/\.[^.]+$/, "")}</strong>
            </div>
            <button
              aria-label={tr("导出本书 ORD")}
              disabled={ordBusy}
              onClick={() => void exportBook()}
            >
              <Download size={20} />
            </button>
          </>
        ) : (
          <>
            <div>
              <span className="mobile-brand">OPEN READING</span>
              <h1>
                {tr(
                  view === "library"
                    ? "书架"
                    : view === "notes"
                      ? "笔记"
                      : "设置",
                )}
              </h1>
            </div>
            {view === "library" && (
              <button
                className="mobile-round-button"
                aria-label={tr("添加书籍")}
                onClick={() => setView("settings")}
              >
                <Plus size={23} />
              </button>
            )}
          </>
        )}
      </header>
      {error && (
        <div className="mobile-error" role="alert">
          {tr(error)}
          <button aria-label={tr("关闭提示")} onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {statsMode && (
        <div className="reading-stats-overlay">
          <ReadingStats
            scope="authorized"
            data={{
              events: [
                ...(state.current.library?.readingData?.events || []),
                ...(state.current.readingEvents || []),
              ],
              goalMinutes:
                state.current.library?.readingData?.goalMinutes || 30,
            }}
            notice="含手机离线阅读记录，连接电脑后会自动合并"
            onClose={() => setStatsMode(false)}
          />
        </div>
      )}
      {doc ? (
        <>
          <div className="mobile-reader-wrap">
            <Reader
              ref={reader}
              progressContainer={progressHost}
              wordCountContainer={null}
              pdfControlsContainer={null}
              pageNumberContainer={pageHost}
              key={doc.workspaceDocumentId + doc.version.id}
              doc={doc}
              preferences={prefs}
              onPdfScaleChange={(scale) =>
                setPrefs((p) => ({ ...p, pdfScale: scale }))
              }
              activityEnabled={
                foreground &&
                !statsMode &&
                !selection &&
                !editing &&
                !showBookNotes &&
                !readerSettings
              }
              onReading={recordReading}
              annotations={threadNotes}
              onSelect={compose}
              onPickThread={() => setShowBookNotes(true)}
              onOutline={setOutline}
              onProgress={recordPosition}
              onError={setError}
            />
          </div>
          <div className="mobile-reader-toolbar">
            <div className="mobile-reader-pagebar">
              <button
                aria-label={tr("上一页或章节")}
                onClick={() => reader.current?.turnPage(-1)}
              >
                <ArrowLeft size={16} />
              </button>
              <div className="mobile-progress-host" ref={setProgressHost} />
              <span ref={setPageHost} />
              <button
                aria-label={tr("下一页或章节")}
                onClick={() => reader.current?.turnPage(1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <BookTools
              doc={doc}
              reader={reader}
              outline={outline}
              encoding={prefs.encoding}
              mobile
              onError={setError}
            />
            <div className="mobile-reader-secondary">
              <button onClick={() => setShowBookNotes(!showBookNotes)}>
                <NotebookPen size={18} />
                {tr("笔记")} {currentDoc?.threads.length || 0}
              </button>
              {doc.format === "pdf" && (
                <button onClick={() => reader.current?.addPageNote()}>
                  {tr("页级笔记")}
                </button>
              )}
              <button
                aria-label={tr("阅读设置")}
                onClick={() => setReaderSettings(true)}
              >
                <span className="type-icon">Aa</span>
                {tr("阅读设置")}
              </button>
            </div>
          </div>
          {readerSettings && (
            <section
              className="mobile-sheet"
              role="dialog"
              aria-label={tr("阅读设置")}
            >
              <header>
                <h3>{tr("阅读设置")}</h3>
                <button
                  aria-label={tr("关闭阅读设置")}
                  onClick={() => setReaderSettings(false)}
                >
                  <X size={20} />
                </button>
              </header>
              <label>
                {tr("字号")}
                <input
                  aria-label={tr("手机阅读字号")}
                  type="range"
                  min="14"
                  max="30"
                  value={prefs.fontSize}
                  onChange={(e) =>
                    setPrefs({ ...prefs, fontSize: Number(e.target.value) })
                  }
                />
                {prefs.fontSize}
              </label>
              <label>
                {tr("行距")}
                <input
                  type="range"
                  min="1.3"
                  max="2.5"
                  step=".1"
                  value={prefs.lineHeight}
                  onChange={(e) =>
                    setPrefs({ ...prefs, lineHeight: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                {tr("字体")}
                <select
                  value={prefs.fontFamily}
                  onChange={(e) =>
                    setPrefs({ ...prefs, fontFamily: e.target.value })
                  }
                >
                  <option value="system-ui">{tr("系统字体")}</option>
                  <option value="serif">{tr("衬线字体")}</option>
                </select>
              </label>
              <label>
                {tr("阅读模式")}
                <select
                  value={prefs.epubFlow}
                  onChange={(e) =>
                    setPrefs({ ...prefs, epubFlow: e.target.value })
                  }
                >
                  <option value="scrolled-doc">{tr("章节滚动")}</option>
                  <option value="paginated">{tr("单页")}</option>
                </select>
              </label>
              <button
                className="mobile-theme-choice"
                onClick={() =>
                  setPrefs({
                    ...prefs,
                    theme: prefs.theme === "dark" ? "light" : "dark",
                  })
                }
              >
                {prefs.theme === "dark" ? (
                  <Sun size={18} />
                ) : (
                  <Moon size={18} />
                )}{" "}
                {tr("切换黑白主题")}
              </button>
              <small>{tr("阅读设置会单独记住这本书的偏好。")}</small>
            </section>
          )}
          {(selection || editing) && (
            <div className="mobile-compose">
              <header>
                <strong>{tr("写下你的理解")}</strong>
                <button
                  className="mobile-compose-close"
                  aria-label={tr("收起编辑")}
                  onClick={() => {
                    setSelection(null);
                    setEditing(null);
                  }}
                >
                  <X size={20} />
                </button>
              </header>
              {selection && (
                <blockquote>
                  {selection.anchor.quote.exact ||
                    selection.anchor.displayLocation.label}
                </blockquote>
              )}
              <textarea
                autoFocus
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
      ) : view === "library" ? (
        <main className="mobile-library">
          <div className="mobile-shelf-search">
            <Search size={18} />
            <input
              aria-label={tr("搜索书架")}
              placeholder={tr("搜索书名")}
              value={shelfQuery}
              onChange={(e) => setShelfQuery(e.target.value)}
            />
          </div>
          {lastBook && !shelfQuery && (
            <button className="mobile-continue" onClick={() => open(lastBook)}>
              <div className="continue-cover">
                <MobileCover book={lastBook} />
              </div>
              <div>
                <span className="continue-label">{tr("继续阅读")}</span>
                <h2>{lastBook.title.replace(/\.[^.]+$/, "")}</h2>
                <p>
                  {lastBook.readingState?.locator?.percentage != null
                    ? tr("已读") +
                      ` ${lastBook.readingState.locator.percentage}%`
                    : tr("翻开书页，接着上次的思考")}
                </p>
                <span className="continue-action">
                  {tr("开始阅读")} <ArrowUpRight size={14} />
                </span>
              </div>
            </button>
          )}
          <div className="mobile-shelf-section">
            <div className="mobile-shelf-tabs">
              {[
                ["all", "全部"],
                ["reading", "在读"],
                ["finished", "已读"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  aria-pressed={shelfFilter === key}
                  onClick={() => setShelfFilter(key)}
                >
                  {tr(label)}
                </button>
              ))}
            </div>
            <span>
              {documents.length} {tr("本")}
            </span>
          </div>
          {!loaded ? (
            <div className="mobile-shelf-grid">
              {[0, 1, 2].map((i) => (
                <div className="mobile-cover cover-skeleton" key={i} />
              ))}
            </div>
          ) : visibleBooks.length ? (
            <div className="mobile-shelf-grid">
              {visibleBooks.map((d: any) => (
                <button
                  className="mobile-document"
                  aria-label={d.title}
                  key={d.id}
                  onClick={() => open(d)}
                >
                  <MobileCover book={d} />
                  <strong>{d.title.replace(/\.[^.]+$/, "")}</strong>
                  <small>
                    {d.finishedAt
                      ? tr("已读完")
                      : d.readingState?.locator?.percentage != null
                        ? tr("已读") + ` ${d.readingState.locator.percentage}%`
                        : d.version
                          ? tr("未读")
                          : tr("待下载")}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <div className="mobile-empty-shelf">
              <div className="empty-book-stack">
                <BookOpen size={42} strokeWidth={1} />
              </div>
              <h2>
                {tr(shelfQuery ? "没有找到这本书" : "把喜欢的书，放在这里")}
              </h2>
              <p>
                {tr(
                  shelfQuery
                    ? "试试其他关键词"
                    : "连接电脑书库，把阅读带在身边。",
                )}
              </p>
              {!c?.deviceId && (
                <button className="primary" onClick={() => setView("settings")}>
                  {tr("设置书库连接")}
                  <ChevronRight size={16} />
                </button>
              )}
            </div>
          )}
        </main>
      ) : view === "notes" ? (
        <main className="mobile-notes-page">
          <NotesCenter
            notes={notes}
            onOpen={(n) => {
              const d = documents.find(
                (d: any) => d.id === n.workspaceDocumentId,
              );
              if (d) {
                open(d, n.anchor);
                setView("library");
              }
            }}
            onSave={saveLearning}
            onEdit={editNote}
          />
          {state.current.outbox
            .filter(
              (op: any) =>
                op.type === "create" || op.type === "edit" || op.error,
            )
            .map((op: any) => (
              <article className="learning-card" key={op.operationId}>
                <small>{tr(op.error ? "需要处理" : "等待同步")}</small>
                <p>{op.body || tr("学习记录等待同步")}</p>
                {op.error && <p role="alert">{tr(op.error)}</p>}
                <button onClick={() => void discard(op)}>
                  {tr("移除手机草稿")}
                </button>
              </article>
            ))}
        </main>
      ) : (
        <main className="mobile-settings">
          <section className="mobile-reading-summary">
            <div>
              <span>{tr("今日阅读")}</span>
              <strong>
                {todayMinutes}
                <small>{tr("分钟")}</small>
              </strong>
            </div>
            <button
              aria-label={tr("阅读数据")}
              onClick={() => setStatsMode(true)}
            >
              {tr("阅读日历")}
              <ChevronRight size={17} />
            </button>
          </section>
          <section className="mobile-settings-group">
            <h2>{tr("书库与设备")}</h2>
            <div className="mobile-connection-title">
              <span
                className={
                  c?.deviceId ? "connection-dot connected" : "connection-dot"
                }
              />
              <div>
                <strong>
                  {c?.deviceId ? tr("已连接电脑书库") : tr("尚未连接书库")}
                </strong>
                <small>{c?.name || tr("电脑与手机连接同一 Wi-Fi")}</small>
              </div>
            </div>
            {c?.deviceId && (
              <>
                <button
                  className="mobile-settings-row"
                  aria-label={tr("同步文件与笔记")}
                  onClick={() => void sync()}
                >
                  <RefreshCw size={19} />
                  <span>{tr("同步文件与笔记")}</span>
                  <ChevronRight size={17} />
                </button>
                {syncError && (
                  <p className="mobile-sync-error" role="alert">
                    {tr(syncError)}
                  </p>
                )}
                <div className="mobile-sync-status" role="status">
                  {tr(status) || tr("可离线阅读")}
                  {state.current.library?.syncedAt && (
                    <small>
                      {tr("上次同步 ")}
                      {new Date(state.current.library.syncedAt).toLocaleString(
                        locale(),
                      )}
                    </small>
                  )}
                  {state.current.outbox.length > 0 && (
                    <small>
                      {tr("等待同步")} · {state.current.outbox.length}
                    </small>
                  )}
                </div>
                <button
                  className="mobile-settings-row"
                  onClick={() => {
                    setReconnecting(true);
                    setError("");
                  }}
                >
                  <ScanLine size={19} />
                  <span>{tr("重新扫码授权（保留文件与笔记）")}</span>
                  <ChevronRight size={17} />
                </button>
                <details className="mobile-device-details">
                  <summary>{tr("连接详情与移除")}</summary>
                  <p>{c.origin}</p>
                  <button
                    className="danger"
                    onClick={() => void removeConnection()}
                  >
                    {tr("移除连接与手机缓存")}
                  </button>
                </details>
              </>
            )}
          </section>
          {(!c?.deviceId || reconnecting) && (
            <section className="mobile-pair">
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
              <p className="muted">
                {tr(
                  "安卓扫码使用 Google ML Kit，可能向 Google 发送设备与使用指标；也可粘贴配对链接。",
                )}{" "}
                <a href="/licenses/PRIVACY.md" target="_blank" rel="noreferrer">
                  {tr("隐私说明")}
                </a>
                {" · "}
                <a href="/licenses/index.html" target="_blank" rel="noreferrer">
                  {tr("第三方许可")}
                </a>
              </p>
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
            </section>
          )}
          {c?.deviceId && (
            <section className="mobile-settings-group">
              <h2>{tr("导入与分享")}</h2>{" "}
              <div className="mobile-ord-import">
                <label>
                  {tr("导入学习包到")}
                  <select
                    aria-label={tr("ORD 目标工作区")}
                    value={
                      ordTarget ||
                      state.current.library?.workspaces[0]?.id ||
                      ""
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
            </section>
          )}
          <section className="mobile-settings-group">
            <h2>{tr("偏好设置")}</h2>
            <div className="mobile-settings-row">
              <Sun size={19} />
              <span>{tr("深色模式")}</span>
              <input
                aria-label={tr("深色模式")}
                type="checkbox"
                checked={prefs.theme === "dark"}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    theme: e.target.checked ? "dark" : "light",
                  })
                }
              />
            </div>
            <div className="mobile-settings-row">
              <span>{tr("界面语言")}</span>
              <LanguageSelect compact />
            </div>
          </section>
          <p className="mobile-settings-about">
            Open Reading
            <br />
            <span>{tr("书籍在身边，思考留在字里行间。")}</span>
          </p>
        </main>
      )}
      {!doc && (
        <nav className="mobile-tabbar" aria-label={tr("主导航")}>
          {(
            [
              ["library", BookOpen, "书架"],
              ["notes", NotebookPen, "笔记"],
              ["settings", Settings, "设置"],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              aria-current={view === key ? "page" : undefined}
              onClick={() => setView(key)}
            >
              <Icon size={23} strokeWidth={view === key ? 2 : 1.6} />
              <span>{tr(label)}</span>
            </button>
          ))}
        </nav>
      )}
      {doc && showBookNotes && (
        <section
          className="mobile-sheet mobile-notes-sheet"
          role="dialog"
          aria-label={tr("本文件笔记")}
        >
          <header>
            <h3>{tr("本文件笔记")}</h3>
            <button
              aria-label={tr("关闭本书笔记")}
              onClick={() => setShowBookNotes(false)}
            >
              <X size={20} />
            </button>
          </header>
          <NotesCenter
            notes={notes.filter(
              (n: any) => n.workspaceDocumentId === doc.workspaceDocumentId,
            )}
            onOpen={(n) => {
              open(currentDoc, n.anchor);
              setShowBookNotes(false);
            }}
            onSave={saveLearning}
            onEdit={editNote}
          />
        </section>
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
    </div>
  );
}
