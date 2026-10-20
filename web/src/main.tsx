import {
  DocumentFormatFilter,
  type DocumentFormat,
} from "./library/DocumentFormatFilter";
import { DeleteBookDialog } from "./library/DeleteBookDialog";
import { ConversionDialog } from "./conversion/ConversionDialog";
import {
  useBookContextMenu,
  type BookFilter,
  type BookAction,
} from "./library/BookContextMenu";
import { BookFilters } from "./library/BookFilters";
import { LibraryShelf } from "./library/LibraryShelf";
import { DocumentSort } from "./library/DocumentSort";
import { tr, locale } from "./i18n";
import { DesktopStats } from "./reading/DesktopStats";
import { LanguageSelect } from "./i18n/LanguageSelect";
import { copyText } from "./clipboard";
import { getLanguage, useLanguage, setLanguage } from "./i18n";
import { useDesktopReading } from "./reading/desktop";
import { PDF_ZOOM_LEVELS } from "./readers/pdfZoom";
import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  CalendarDays,
  FolderPlus,
  Plus,
  Search,
  Settings,
  MessageSquare,
  ArrowUp,
  ArrowLeft,
  ChevronRight,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Highlighter,
  Sparkles,
  Download,
  Upload,
  Check,
  RotateCw,
  RefreshCw,
  Copy,
  X,
  BookMarked,
  Sun,
  Moon,
  Folder,
  ExternalLink,
  StopCircle,
  MoreHorizontal,
  Maximize,
  Minimize,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, ApiError, setCSRF, uid, localDraft } from "./api";
import { Reader } from "./readers/Reader";
import type { Anchor } from "./readers/anchors";
import type {
  Captured,
  Prepared,
  ReaderAdapter,
  ReaderPreferences,
  OutlineItem,
} from "./readers/types";
import "./style.css";
import {
  ModelSettings,
  modelsFor,
  modelChoice,
  resolveModelChoice,
} from "./settings/ModelSettings";
import { ordPath, ordForm, ordResponse, saveORD } from "./ord";
import { SyncSettings } from "./sync/SyncSettings";
import { Capacitor } from "@capacitor/core";
const defaults: ReaderPreferences = {
  language: getLanguage(),
  documentSort: "default",
  readingSpeed: 300,
  fontSize: 18,
  lineHeight: 1.9,
  fontFamily: "system-ui",
  theme: "light",
  pdfScale: 1,
  pdfSpread: false,
  epubSpread: false,
  pdfRotation: 0,
  epubFlow: "scrolled-doc",
  encoding: "utf-8",
  leftWidth: 246,
  rightWidth: 370,
};
const desktop = window.openReadingDesktop;
const readerTarget = desktop?.readerTarget;
const desktopLibrary = !!desktop && !readerTarget;
function App() {
  useLanguage();
  const [ready, setReady] = useState(false),
    [login, setLogin] = useState(false),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [ordBusy, setOrdBusy] = useState(false),
    [toast, setToast] = useState(""),
    [workspaces, setWorkspaces] = useState<any[]>([]),
    [workspace, setWorkspace] = useState<any>(null),
    [documents, setDocuments] = useState<any[]>([]),
    [cursor, setCursor] = useState(""),
    [bookFilter, setBookFilter] = useState<BookFilter>("all"),
    [fileFormat, setFileFormat] = useState<DocumentFormat>("all"),
    [deletingBook, setDeletingBook] = useState<any>(null),
    [convertingBook, setConvertingBook] = useState<any>(null),
    [sources, setSources] = useState<any[]>([]),
    [doc, setDoc] = useState<Prepared | null>(null),
    [member, setMember] = useState<any>(null),
    [threads, setThreads] = useState<any[]>([]),
    [activeThread, setActiveThread] = useState<string | null>(null),
    [navigateThread, setNavigateThread] = useState(readerTarget?.threadId),
    [selection, setSelection] = useState<Captured | null>(null),
    [toolbarPosition, setToolbarPosition] = useState({ left: 0, top: 0 }),
    [composing, setComposing] = useState(false),
    [draft, setDraft] = useState(""),
    [draftReady, setDraftReady] = useState(false),
    [recipient, setRecipient] = useState<"note" | "assistant">("note"),
    [saveState, setSaveState] = useState("已保存"),
    [pending, setPending] = useState(false),
    [providers, setProviders] = useState<any[]>([]),
    [model, setModel] = useState(""),
    [policy, setPolicy] = useState("nearby"),
    [preview, setPreview] = useState<any>(null),
    [showPreview, setShowPreview] = useState(false),
    [showSettings, setShowSettings] = useState(false),
    [sourceModal, setSourceModal] = useState(false),
    [newWS, setNewWS] = useState(false),
    [wsName, setWsName] = useState(""),
    [search, setSearch] = useState(""),
    [insideSearch, setInsideSearch] = useState(""),
    [outline, setOutline] = useState<OutlineItem[]>([]),
    [navTab, setNavTab] = useState(readerTarget ? "outline" : "files"),
    [notesMode, setNotesMode] = useState(false),
    [statsMode, setStatsMode] = useState(false),
    [readingFullscreen, setReadingFullscreen] = useState(false),
    [fullscreenChromeHidden, setFullscreenChromeHidden] = useState(false),
    [progressContainer, setProgressContainer] = useState<HTMLDivElement | null>(
      null,
    ),
    [timerContainer, setTimerContainer] = useState<HTMLDivElement | null>(null),
    [wordCountContainer, setWordCountContainer] =
      useState<HTMLSpanElement | null>(null),
    [pageNumberContainer, setPageNumberContainer] =
      useState<HTMLDivElement | null>(null),
    [pdfControlsContainer, setPdfControlsContainer] =
      useState<HTMLDivElement | null>(null),
    [notes, setNotes] = useState<any[]>([]),
    [filter, setFilter] = useState("全部"),
    [leftOpen, setLeftOpen] = useState(!readerTarget),
    [rightOpen, setRightOpen] = useState(false),
    [prefs, setPrefs] = useState(defaults),
    [change, setChange] = useState(""),
    [history, setHistory] = useState<any[] | null>(null),
    [rebind, setRebind] = useState(false),
    [overlap, setOverlap] = useState<string[] | null>(null),
    [allowMock, setAllowMock] = useState(false),
    [serverMode, setServerMode] = useState(false);
  const reader = useRef<ReaderAdapter>(null),
    sendKey = useRef(uid()),
    draftRevision = useRef(0),
    draftLoaded = useRef(false),
    docRef = useRef(doc),
    openSequence = useRef(0),
    currentWorkspace = useRef(workspace),
    fileInput = useRef<HTMLInputElement>(null),
    composer = useRef<HTMLTextAreaElement>(null),
    toolbar = useRef<HTMLDivElement>(null),
    progressTimer = useRef<any>(null);
  useEffect(() => desktop?.onThread(setNavigateThread), []);
  useEffect(() => {
    if (
      navigateThread &&
      threads.some((t) => t.threadId === navigateThread) &&
      reader.current
    ) {
      pickThread([navigateThread]);
      setNavigateThread(undefined);
    }
  }, [navigateThread, threads, doc]);
  const documentRequest = useRef(0);
  const reading = useDesktopReading(ready && !login);
  const readingMain = useRef<HTMLElement>(null);
  useEffect(() => {
    const changed = () =>
      setReadingFullscreen(document.fullscreenElement === readingMain.current);
    document.addEventListener("fullscreenchange", changed);
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        document.fullscreenElement === readingMain.current
      ) {
        event.preventDefault();
        void document.exitFullscreen().catch(() => {});
      }
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    setFullscreenChromeHidden(false);
    if (!readingFullscreen || !readingMain.current) return;
    const main = readingMain.current;
    let timer: ReturnType<typeof setTimeout>;
    const scheduleHide = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const active = document.activeElement;
        // Keep search, layout and page-number controls available while editing.
        if (
          active instanceof Element &&
          main.contains(active) &&
          active.matches("input, textarea, select, [contenteditable='true']")
        ) {
          scheduleHide();
          return;
        }
        setFullscreenChromeHidden(true);
      }, 10000);
    };
    const reveal = () => {
      setFullscreenChromeHidden(false);
      scheduleHide();
    };
    const pointer = (event: PointerEvent) => {
      const bounds = main.getBoundingClientRect();
      if (
        event.clientY <= bounds.top + 60 ||
        event.clientY >= bounds.bottom - 48 ||
        (event.type === "pointerdown" && event.pointerType === "touch")
      )
        reveal();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Tab") reveal();
    };
    const focus = (event: FocusEvent) => {
      if (
        (event.target as Element)?.closest(
          ".document-bar, .reading-footer, .page-tools",
        )
      )
        reveal();
    };
    main.addEventListener("pointermove", pointer, { passive: true });
    main.addEventListener("pointerdown", pointer, { passive: true });
    document.addEventListener("keydown", keyboard);
    main.addEventListener("focusin", focus);
    scheduleHide();
    return () => {
      clearTimeout(timer);
      main.removeEventListener("pointermove", pointer);
      main.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", keyboard);
      main.removeEventListener("focusin", focus);
    };
  }, [readingFullscreen]);
  async function exitReadingFullscreen() {
    if (document.fullscreenElement === readingMain.current)
      await document.exitFullscreen();
  }
  async function toggleReadingFullscreen() {
    try {
      if (document.fullscreenElement === readingMain.current)
        await document.exitFullscreen();
      else await readingMain.current?.requestFullscreen();
    } catch {
      setError("无法进入全屏阅读，请重试或使用窗口的全屏按钮。");
    }
  }
  docRef.current = doc;
  currentWorkspace.current = workspace;
  useLayoutEffect(() => {
    const el = toolbar.current;
    if (!selection || composing || !el) return;
    const container = el.parentElement!;
    const position = () => {
      const above = selection.rect.top - el.offsetHeight - 8;
      setToolbarPosition({
        left: Math.max(
          8,
          Math.min(
            selection.rect.left,
            container.clientWidth - el.offsetWidth - 8,
          ),
        ),
        top: Math.max(
          8,
          Math.min(
            above >= 8
              ? above
              : (selection.rect.bottom ?? selection.rect.top) + 8,
            container.clientHeight - el.offsetHeight - 8,
          ),
        ),
      });
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(container);
    return () => observer.disconnect();
  }, [
    selection?.rect.left,
    selection?.rect.top,
    selection?.rect.bottom,
    selection?.rect.visible,
    composing,
  ]);
  const notify = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(""), 5000);
  };
  const fail = (e: any) => {
    if (e instanceof ApiError && e.status === 401) setLogin(true);
    setError(e.message || "本地服务暂时不可用，请保留草稿");
  };
  const boot = async () => {
    try {
      const me = await api("/me");
      setCSRF(me.csrf);
      setAllowMock(me.allowMock);
      setServerMode(!!me.serverMode);
      setLogin(false);
      const [ws, p, prov] = await Promise.all([
        api("/workspaces"),
        api("/preferences"),
        api("/providers"),
      ]);
      setWorkspaces(ws);
      if (p.language === "en" || p.language === "zh") setLanguage(p.language);
      setPrefs({
        ...defaults,
        language: getLanguage(),
        ...Object.fromEntries(
          Object.keys(defaults)
            .filter((k) => p[k] !== undefined)
            .map((k) => [k, p[k]]),
        ),
      });
      setProviders(prov);
      setWorkspace(
        ws.find(
          (x: any) =>
            x.id === (readerTarget?.workspaceId || p.activeWorkspaceId),
        ) ||
          ws[0] ||
          null,
      );
      setReady(true);
    } catch (e: any) {
      if (e.status === 401) setLogin(true);
      else fail(e);
    }
  };
  useEffect(() => {
    void api("/health")
      .then((v) => setServerMode(!!v.serverMode))
      .catch(() => {});
    void boot();
  }, []);
  useEffect(() => {
    if (readerTarget) return;
    const media = matchMedia("(max-width:1180px)");
    const apply = () => setLeftOpen(!media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  const loadDocuments = useCallback(
    async (more = false) => {
      if (!workspace) return;
      const id = workspace.id;
      const request = ++documentRequest.current;
      const result = await api(
        "/workspaces/" +
          id +
          "/documents?q=" +
          encodeURIComponent(search) +
          "&format=" +
          fileFormat +
          "&filter=" +
          bookFilter +
          "&sort=" +
          (prefs.documentSort || "default") +
          "&cursor=" +
          (more ? cursor : ""),
      );
      if (
        currentWorkspace.current?.id !== id ||
        documentRequest.current !== request
      )
        return;
      setDocuments((v) => (more ? [...v, ...result.items] : result.items));
      setCursor(result.nextCursor);
    },
    [workspace?.id, search, cursor, prefs.documentSort, bookFilter, fileFormat],
  );
  const changeBook = async (book: any, action: BookAction) => {
    try {
      if (action === "delete") {
        setDeletingBook(book);
        return;
      }
      if (action === "convert") {
        setConvertingBook(book);
        return;
      }
      await api(
        `/documents/${book.id}`,
        "PATCH",
        action === "favorite"
          ? { favorite: !book.favorite }
          : action === "finished"
            ? { finished: !book.finishedAt }
            : { restore: true },
      );
      await loadDocuments();
      notify(
        action === "restore"
          ? "已恢复到书库"
          : action === "favorite"
            ? book.favorite
              ? "已取消收藏"
              : "已收藏"
            : book.finishedAt
              ? "已标记为未读"
              : "已标记为已读完",
      );
    } catch (e) {
      fail(e);
    }
  };
  const { bookMenuProps, menu: bookContextMenu } =
    useBookContextMenu(changeBook);
  const loadSources = async () => {
    if (workspace)
      setSources(await api("/workspaces/" + workspace.id + "/sources"));
  };
  const loadThreads = useCallback(async () => {
    if (!doc) return;
    const id = doc.workspaceDocumentId;
    const t = await api("/documents/" + id + "/threads");
    if (docRef.current?.workspaceDocumentId === id) setThreads(t);
  }, [doc?.workspaceDocumentId]);
  useEffect(() => {
    if (!workspace) return;
    ++openSequence.current;
    setDoc(null);
    setMember(null);
    setThreads([]);
    setSelection(null);
    setComposing(false);
    setActiveThread(null);
    setDraft("");
    setDraftReady(false);
    setNotesMode(false);
    setStatsMode(false);
    draftLoaded.current = false;
    void loadDocuments().catch(fail);
    void loadSources().catch(fail);
    if (!readerTarget)
      void api("/preferences", "PUT", {
        activeWorkspaceId: workspace.id,
      }).catch(fail);
  }, [workspace?.id]);
  useEffect(() => {
    if (!workspace) return;
    const timer = setTimeout(() => loadDocuments().catch(fail), 200);
    return () => clearTimeout(timer);
  }, [search, prefs.documentSort, bookFilter, fileFormat]);
  useEffect(() => {
    if (doc) void loadThreads().catch(fail);
  }, [doc?.workspaceDocumentId]);
  useEffect(() => {
    if (doc && prefs.documentSort === "recent")
      void loadDocuments().catch(fail);
  }, [doc?.workspaceDocumentId]);
  const updatePref = (patch: Partial<ReaderPreferences>) => {
    if (patch.language) setLanguage(patch.language);
    const next = { ...prefs, ...patch };
    setPrefs(next);
    void api("/preferences", "PUT", patch).catch(fail);
  };
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
  }, [prefs.theme]);
  const open = async (d: any, version?: any, initialAnchor?: Anchor) => {
    if (
      desktop &&
      !version &&
      !initialAnchor &&
      (desktopLibrary || d.id !== readerTarget?.memberId)
    ) {
      try {
        await flushProgress().catch(() => {});
        await desktop.openBook(workspace.id, d.id);
      } catch (e) {
        fail(e);
      }
      return;
    }
    const sequence = ++openSequence.current;
    const openingWorkspace = workspace?.id;
    try {
      setError("");
      // Persist the previous book before the next prepare records its opening
      // time, so a delayed save cannot move the previous book ahead in recents.
      await flushProgress().catch(() => {});
      let prepared;
      if (version) {
        prepared = {
          version,
          format: d.format,
          historical: true,
          resourceManifestId: version.manifestId,
          artifactId: version.artifactId,
        };
      } else {
        const binding = d.bindings.find(
          (x: any) =>
            x.state === "active" &&
            x.sourceState === "active" &&
            x.bindingState === "active",
        );
        if (binding) {
          try {
            prepared = await api(
              "/documents/" + d.documentId + "/prepare",
              "POST",
              { workspaceDocumentId: d.id, sourceEntryId: binding.id },
            );
          } catch (e: any) {
            if (e.code !== "SOURCE_UNAVAILABLE") throw e;
          }
        }
        if (!prepared) {
          const versions = await api(
            "/documents/" +
              d.documentId +
              "/versions?workspaceDocumentId=" +
              d.id,
          );
          if (!versions.length)
            throw Error("源文件不可用，尚无缓存快照。请连接来源后重开");
          prepared = {
            version: versions[0],
            format: d.format,
            historical: true,
            resourceManifestId: versions[0].manifestId,
          };
          setChange("unavailable");
        }
      }
      const title = d.bindings[0]?.relativePath?.split("/").pop() || "历史文档";
      if (prepared.historical) {
        const lease = await api(
          "/versions/" + prepared.version.id + "/lease",
          "POST",
          { workspaceDocumentId: d.id },
        );
        prepared.leaseId = lease.id;
      }
      if (
        sequence !== openSequence.current ||
        currentWorkspace.current?.id !== openingWorkspace
      )
        return;
      const current = docRef.current;
      const changed =
        current?.workspaceDocumentId !== d.id ||
        current?.version.id !== prepared.version.id ||
        !!current?.historical !== !!prepared.historical ||
        current?.resourceManifestId !== prepared.resourceManifestId;
      if (changed) {
        if (current?.workspaceDocumentId !== d.id) setThreads([]);
        setSelection(null);
        setComposing(false);
        setActiveThread(null);
        setDraft("");
        setDraftReady(false);
        draftLoaded.current = false;
      }
      setMember(d);
      setChange(prepared.historical && !version ? "unavailable" : "");
      if (initialAnchor) {
        prepared.initialAnchor = initialAnchor;
        const native = initialAnchor.selectors.find(
          (s) => s.type === "pdf" || s.type === "epub",
        );
        prepared.readingState = {
          locator:
            native?.type === "pdf"
              ? { pageIndex: native.pageIndex }
              : native?.type === "epub"
                ? { cfi: native.cfi }
                : {},
        };
      }
      setDoc({ ...prepared, workspaceDocumentId: d.id, title });
      setNotesMode(false);
      setStatsMode(false);
      setRightOpen(false);
      if (window.innerWidth <= 1180) setLeftOpen(false);
      void api("/preferences", "PUT", {
        ...(!readerTarget ? { activeWorkspaceId: workspace.id } : {}),
        lastDocuments: { [workspace.id]: d.id },
      }).catch(fail);
    } catch (e) {
      fail(e);
    }
  };
  useEffect(() => {
    if (!readerTarget || workspace?.id !== readerTarget.workspaceId) return;
    let alive = true;
    void api("/documents/" + readerTarget.memberId)
      .then((d) => {
        if (d.workspaceId !== workspace.id) throw Error("书籍不属于当前工作区");
        if (alive) return open(d);
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [workspace?.id]);
  useEffect(() => {
    document.title =
      readerTarget && doc ? doc.title + " — Open Reading" : "Open Reading";
  }, [doc?.title]);
  useEffect(() => {
    if (!desktopLibrary || !workspace) return;
    const refresh = () => {
      void loadDocuments().catch(fail);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [workspace?.id, search, prefs.documentSort, bookFilter, fileFormat]);
  useEffect(() => {
    if (desktop || !workspace || !documents.length || doc) return;
    let ignore = false;
    const sequence = openSequence.current;
    api("/preferences").then((p) => {
      if (ignore || docRef.current || sequence !== openSequence.current) return;
      const d =
        documents.find((x) => x.id === p.lastDocuments?.[workspace.id]) ||
        documents
          .filter((x) => x.lastOpened)
          .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))[0];
      if (d) void open(d);
    });
    return () => {
      ignore = true;
    };
  }, [workspace?.id, documents.length]);
  useEffect(() => {
    if (!doc || !member) return;
    const timer = setInterval(async () => {
      try {
        if (doc.leaseId)
          await api("/leases/" + doc.leaseId + "/renew", "POST", {
            workspaceDocumentId: doc.workspaceDocumentId,
          });
        if (doc.historical) return;
        const v = await api(
          "/documents/" +
            member.documentId +
            "/change?workspaceDocumentId=" +
            member.id +
            "&versionId=" +
            doc.version.id +
            "&sourceEntryId=" +
            doc.sourceEntryId,
        );
        if (docRef.current?.version.id === doc.version.id)
          setChange(v.state === "unchanged" ? "" : v.state);
      } catch {
        /* Offline saving is displayed by draft retry. */
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [doc?.version.id, doc?.workspaceDocumentId]);
  const draftID = doc
    ? doc.workspaceDocumentId + ":" + (activeThread || "new")
    : "";
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    setDraftReady(false);
    draftLoaded.current = false;
    draftRevision.current = 0;
    setDraft("");
    Promise.all([
      api(
        "/drafts/" +
          encodeURIComponent(draftID) +
          "?workspaceDocumentId=" +
          doc.workspaceDocumentId,
      ),
      localDraft(draftID),
      localDraft("operation:" + draftID),
    ])
      .then(async ([server, local, operation]) => {
        if (!alive) return;
        if (operation) {
          sendKey.current = operation.key;
          try {
            const saved = await api(
              "/requests/" +
                operation.key +
                "?scope=" +
                encodeURIComponent(operation.scope),
            );
            if (!alive) return;
            await localDraft("operation:" + draftID, null);
            await localDraft(draftID, null);
            sendKey.current = uid();
            setDraft("");
            setSelection(null);
            setActiveThread(saved.threadId);
            setComposing(true);
            void loadThreads();
            draftLoaded.current = true;
            setDraftReady(true);
            return;
          } catch (e: any) {
            if (e.status !== 404) {
              setSaveState("上次发送状态待确认 · 草稿已保留");
            } else {
              sendKey.current = operation.key;
            }
          }
        }
        const d =
          local &&
          Date.parse(local.updatedAt) >
            Date.parse(server.updatedAt || "1970-01-01")
            ? local
            : server;
        setDraft(d.body || "");
        if (
          d.selection?.anchor.workspaceDocumentId === doc.workspaceDocumentId &&
          d.selection.anchor.documentVersionId === doc.version.id
        ) {
          setSelection(d.selection);
          setComposing(true);
        }
        draftRevision.current = server.revision || 0;
        draftLoaded.current = true;
        setDraftReady(true);
      })
      .catch(async () => {
        const d = await localDraft(draftID);
        if (alive) {
          setDraft(d?.body || "");
          draftLoaded.current = true;
          setDraftReady(true);
          setSaveState("等待保存");
        }
      });
    return () => {
      alive = false;
    };
  }, [draftID, doc?.version.id, doc?.resourceManifestId, doc?.historical]);
  useEffect(() => {
    if (!doc || !draftLoaded.current) return;
    const payload = {
      workspaceDocumentId: doc.workspaceDocumentId,
      threadId: activeThread,
      body: draft,
      selection,
      revision: draftRevision.current,
      updatedAt: new Date().toISOString(),
    };
    void localDraft(draftID, payload).catch(() => {});
    if (!draft) {
      return;
    }
    setSaveState("正在保存草稿");
    const timer = setTimeout(() => {
      api("/drafts/" + encodeURIComponent(draftID), "PUT", payload)
        .then((d) => {
          draftRevision.current = d.revision;
          setSaveState("草稿已保存");
        })
        .catch((e) => {
          setSaveState(
            e.code === "REVISION_CONFLICT"
              ? "草稿冲突，请复制保留后重新载入"
              : "等待保存 · 草稿已在此浏览器保留",
          );
        });
    }, 650);
    return () => clearTimeout(timer);
  }, [draft, selection, draftID, draftReady]);
  useEffect(() => {
    const retry = () => {
      if (draft && !pending && doc)
        api("/drafts/" + encodeURIComponent(draftID), "PUT", {
          workspaceDocumentId: doc.workspaceDocumentId,
          threadId: activeThread,
          body: draft,
          selection,
          revision: draftRevision.current,
        })
          .then((d) => {
            draftRevision.current = d.revision;
            setSaveState("草稿已保存");
          })
          .catch(() => setSaveState("等待保存"));
    };
    const timer = setInterval(retry, 12000);
    return () => clearInterval(timer);
  }, [draft, draftID, pending]);
  const pendingProgress = useRef<{ path: string; body: any } | null>(null);
  const flushProgress = async () => {
    clearTimeout(progressTimer.current);
    const pending = pendingProgress.current;
    if (!pending) return;
    await api(pending.path, "PUT", pending.body, { keepalive: true });
    if (pendingProgress.current === pending) pendingProgress.current = null;
  };
  const progress = (locator: any) => {
    if (!doc) return;
    clearTimeout(progressTimer.current);
    pendingProgress.current = {
      path: "/documents/" + doc.workspaceDocumentId + "/reading-state",
      body: { versionId: doc.version.id, locator },
    };
    progressTimer.current = setTimeout(() => {
      void flushProgress().catch(() => {});
    }, 400);
  };
  useEffect(() => {
    if (!desktop) return;
    return desktop.onClosing(async () => {
      window.dispatchEvent(new Event("pagehide"));
      const saves: Promise<unknown>[] = [flushProgress(), reading.flush()];
      if (doc && draftLoaded.current) {
        const payload = {
          workspaceDocumentId: doc.workspaceDocumentId,
          threadId: activeThread,
          body: draft,
          selection,
          revision: draftRevision.current,
          updatedAt: new Date().toISOString(),
        };
        // Keep an offline copy even if the server is unavailable or revision conflicts.
        saves.push(localDraft(draftID, payload));
        if (draft)
          saves.push(
            api("/drafts/" + encodeURIComponent(draftID), "PUT", payload, {
              keepalive: true,
            }),
          );
      }
      await Promise.allSettled(saves);
    });
  }, [doc, draftID, draft, selection, activeThread, reading.flush]);
  const selectedThread = threads.find((t) => t.threadId === activeThread);
  const annotationAnchor =
    selection?.anchor ||
    selectedThread?.resolutions?.find(
      (r: any) =>
        r.targetVersionId === doc?.version.id && r.state === "resolved",
    )?.selector?.anchor ||
    selectedThread?.anchor;
  const prepareContext = async () => {
    if (!doc || !annotationAnchor || !reader.current)
      throw Error("请先选择原文或打开一条批注");
    const contextPackage = await reader.current.extractContext(
      annotationAnchor,
      policy as any,
    );
    return { ...contextPackage, policy };
  };
  const previewContext = async () => {
    try {
      const contextPackage = await prepareContext();
      const result = await api("/contexts/preview", "POST", {
        workspaceDocumentId: doc!.workspaceDocumentId,
        anchor: annotationAnchor,
        threadId: activeThread,
        body: draft,
        contextPackage,
        ...resolveModelChoice(model, providers),
        contextPolicy: policy,
      });
      setPreview(result);
      setShowPreview(true);
    } catch (e) {
      fail(e);
    }
  };
  const submit = async (highlight = false) => {
    if (pending || !doc || (!highlight && (!draftReady || !draft.trim())))
      return;
    setPending(true);
    setError("");
    const savedDoc = doc;
    try {
      let contextPackage;
      if (!highlight && recipient === "assistant")
        contextPackage = await prepareContext();
      const message = highlight
        ? undefined
        : {
            body: draft,
            recipient,
            contextPackage,
            ...resolveModelChoice(model, providers),
            contextPolicy: policy,
          };
      let result;
      if (selection) {
        const request = {
          workspaceDocumentId: doc.workspaceDocumentId,
          documentVersionId: doc.version.id,
          selectionSnapshot: selection.anchor,
          style: { color: "#e8cb76" },
          message,
          clientRequestId: sendKey.current,
          draftId: draftID,
        };
        await localDraft("operation:" + draftID, {
          scope: "create-thread",
          key: sendKey.current,
          request,
        });
        result = await api("/threads", "POST", request);
      } else if (activeThread) {
        const request = {
          message,
          clientRequestId: sendKey.current,
          draftId: draftID,
        };
        await localDraft("operation:" + draftID, {
          scope: "message:" + activeThread,
          key: sendKey.current,
          request,
        });
        result = await api(
          "/threads/" + activeThread + "/messages",
          "POST",
          request,
        );
      } else throw Error("请先选择一段原文");
      sendKey.current = uid();
      await localDraft("operation:" + draftID, null);
      await localDraft(draftID, null);
      if (
        docRef.current?.workspaceDocumentId === savedDoc.workspaceDocumentId
      ) {
        setDraft("");
        setSelection(null);
        setComposing(true);
        setActiveThread(result.threadId);
        draftRevision.current = 0;
        setSaveState("已保存");
        await loadThreads();
        setRightOpen(true);
      }
    } catch (e) {
      fail(e);
      setSaveState("尚未保存 · 草稿已保留");
    } finally {
      setPending(false);
    }
  };
  const pickThread = async (ids: string[]) => {
    if (ids.length > 1) {
      setOverlap(ids);
      return;
    }
    setActiveThread(ids[0]);
    setComposing(true);
    setSelection(null);
    setRightOpen(true);
  };
  const jump = async (t: any) => {
    try {
      let anchor = t.anchor as Anchor;
      const mapped = t.resolutions?.find(
        (r: any) =>
          r.targetVersionId === doc?.version.id && r.state === "resolved",
      );
      if (mapped?.selector?.anchor) anchor = mapped.selector.anchor;
      if (anchor.documentVersionId !== doc?.version.id) {
        const resolution = t.resolutions?.find(
          (r: any) =>
            r.targetVersionId === doc?.version.id && r.state === "resolved",
        );
        if (resolution?.selector?.anchor) anchor = resolution.selector.anchor;
        else {
          const versions = await api(
            "/documents/" +
              member.documentId +
              "/versions?workspaceDocumentId=" +
              member.id,
          );
          const v = versions.find(
            (v: any) => v.id === anchor.documentVersionId,
          );
          if (v) {
            await open(
              member,
              {
                ...v,
                manifestId: anchor.resourceManifestId,
                artifactId: anchor.extractionArtifactId,
              },
              anchor,
            );
          }
          return;
        }
      }
      await reader.current?.navigateTo(anchor);
    } catch (e) {
      fail(e);
    }
  };
  const jumpSource = async (source: any) => {
    try {
      const anchor = source.anchor;
      if (!anchor)
        throw Error("此历史来源没有精确定位器，请查看该回答的固定上下文");
      if (source.documentVersionId === doc?.version.id) {
        await reader.current?.navigateTo(anchor);
        return;
      }
      const versions = await api(
        "/documents/" +
          member.documentId +
          "/versions?workspaceDocumentId=" +
          member.id,
      );
      const version = versions.find(
        (v: any) => v.id === source.documentVersionId,
      );
      if (!version) throw Error("原始来源版本不可用");
      await open(
        member,
        {
          ...version,
          manifestId: source.resourceManifestId,
          artifactId: source.extractionArtifactId,
        },
        anchor,
      );
    } catch (e) {
      fail(e);
    }
  };
  const review = async () => {
    try {
      setNotesMode(true);
      setStatsMode(false);
      setNotes(await api("/workspaces/" + workspace.id + "/notes"));
    } catch (e) {
      fail(e);
    }
  };
  const exportNotes = async () => {
    try {
      const result = await api("/exports", "POST", {
        workspaceId: workspace.id,
      });
      download(
        result.content,
        `Open-Reading-笔记-${workspace.name}.md`,
        "text/markdown",
      );
      notify("笔记已导出");
    } catch (e) {
      fail(e);
    }
  };
  const refresh = async () => {
    try {
      const jobs = await Promise.all(
        sources
          .filter((s) => s.state === "active")
          .map((s) => api("/sources/" + s.id + "/scan", "POST", {})),
      );
      for (const j of jobs) await waitScan(j.id);
      await loadDocuments();
      notify("来源已复核");
    } catch (e) {
      fail(e);
    }
  };
  const exportBook = async () => {
    if (!doc || ordBusy) return;
    setOrdBusy(true);
    try {
      const response = await fetch(
        "/api" +
          ordPath(
            doc.workspaceDocumentId,
            doc.version.id,
            doc.resourceManifestId,
          ),
      );
      await saveORD(await ordResponse(response), doc.title);
      notify("ORD 已导出，包含原文、标注和已保存笔记");
    } catch (e) {
      fail(e);
    } finally {
      setOrdBusy(false);
    }
  };
  const importFiles = async (files: FileList | null) => {
    if (!files || !workspace || ordBusy) return;
    const selected = Array.from(files);
    setOrdBusy(true);
    try {
      let imported = 0,
        annotations = 0;
      for (const file of selected.filter((f) => /\.ord$/i.test(f.name))) {
        const result = await api(
          "/workspaces/" + workspace.id + "/ord",
          "POST",
          ordForm(file),
        );
        imported++;
        annotations += result.annotations;
      }
      const originals = selected.filter((f) => !/\.ord$/i.test(f.name));
      let partial = false;
      if (originals.length) {
        const data = new FormData();
        originals.forEach((f) => data.append("files", f));
        const result = await api(
          "/workspaces/" + workspace.id + "/imports",
          "POST",
          data,
        );
        await waitScan(result.scan.id);
        partial = result.files.some((f: any) => f.error);
      }
      notify(
        partial
          ? "部分文件未导入，请检查格式与 200 MB 上限"
          : imported
            ? `已导入 ${imported} 本 ORD 学习包、${annotations} 条标注，原文和笔记已保存在当前工作区`
            : "文件副本已导入",
      );
    } catch (e) {
      fail(e);
    } finally {
      await Promise.all([loadDocuments(), loadSources()]).catch(fail);
      setOrdBusy(false);
    }
  };
  const createWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const ws = await api("/workspaces", "POST", { name: wsName });
      setWorkspaces((v) => [...v, ws]);
      setWorkspace(ws);
      setNewWS(false);
      setWsName("");
    } catch (e) {
      fail(e);
    }
  };
  const resizePanel = (
    side: "leftWidth" | "rightWidth",
    event: React.PointerEvent,
  ) => {
    const start = event.clientX,
      width = prefs[side];
    let current = width;
    const move = (e: PointerEvent) => {
      current = Math.max(
        200,
        Math.min(
          600,
          width + (e.clientX - start) * (side === "rightWidth" ? -1 : 1),
        ),
      );
      setPrefs((p) => ({ ...p, [side]: current }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      updatePref({ [side]: current });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const sourceManager = (
    <div className="sources">
      {sources
        .filter((s) => s.state !== "removed")
        .map((s) => (
          <div className="source-item" key={s.id}>
            <Folder size={15} />
            <span>{s.label}</span>
            {s.state !== "active" && (
              <button
                title={tr("重新连接来源")}
                onClick={async () => {
                  const path = prompt(tr("输入重新连接的本机目录绝对路径"));
                  if (!path) return;
                  try {
                    const job = await api(
                      "/sources/" + s.id + "/reconnect",
                      "POST",
                      { path },
                    );
                    await waitScan(job.id);
                    await loadSources();
                    await loadDocuments();
                    notify("来源已重新连接");
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                <RefreshCw size={12} />
              </button>
            )}
            <button
              title={tr("移除来源 ") + s.label}
              onClick={async () => {
                if (
                  confirm(
                    tr("解除来源绑定并保留笔记和快照？原始资料不会修改。"),
                  )
                ) {
                  await api("/sources/" + s.id, "DELETE");
                  await loadSources();
                  await loadDocuments();
                }
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
    </div>
  );
  if (login)
    return (
      <div className="login">
        <LanguageSelect />
        <div className="logo large">
          <BookOpen size={30} />
        </div>
        <h1>Open Reading</h1>
        <p>{tr("在自己的材料里，读懂每一个问题。")}</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const s = await api("/session", "POST", { code: code.trim() });
              setCSRF(s.csrf);
              await boot();
            } catch (e) {
              fail(e);
            }
          }}
        >
          <label>
            {serverMode ? tr("访问码") : tr("本机配对码")}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              type={serverMode ? "password" : "text"}
              placeholder={
                serverMode
                  ? tr("输入此阅读空间的访问码")
                  : tr("粘贴启动终端中的配对码")
              }
              autoFocus
            />
          </label>
          <button className="primary">
            {tr("进入阅读空间")}
            <ChevronRight size={16} />
          </button>
        </form>
        <small>
          {serverMode
            ? tr("私人阅读空间 · 使用访问码登录")
            : tr("同一配对码支持多个浏览器 · 服务重启后换新码")}
          <br />
          {serverMode
            ? tr("通过 HTTPS 连接 · 学习记录保存在你的云端空间")
            : tr("仅连接本机服务 · 学习记录保存在你的电脑")}
        </small>
        {error && <p className="error">{tr(error)}</p>}
      </div>
    );
  if (!ready)
    return (
      <div className="login">
        {tr("正在连接本机阅读空间…")}
        {tr(error)}
      </div>
    );
  return (
    <div
      className={"app" + (readerTarget ? " reader-window" : "")}
      style={
        {
          "--left-width": prefs.leftWidth + "px",
          "--right-width": prefs.rightWidth + "px",
        } as React.CSSProperties
      }
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void importFiles(e.dataTransfer.files);
      }}
    >
      <aside className="workspace-rail">
        <a className="logo" title="Open Reading">
          <BookOpen size={24} />
        </a>
        <div className="rail-divider" />
        {workspaces.map((w) => (
          <button
            key={w.id}
            title={w.name}
            aria-label={tr("切换工作区 ") + w.name}
            className={
              "workspace-icon " +
              (!statsMode && workspace?.id === w.id ? "active" : "")
            }
            onClick={() => {
              setStatsMode(false);
              setWorkspace(w);
            }}
          >
            {Array.from(String(w.name))[0]}
          </button>
        ))}
        <button
          title={tr("新建工作区")}
          aria-label={tr("新建工作区")}
          className="rail-add"
          onClick={() => setNewWS(true)}
        >
          <Plus size={19} />
        </button>
        <div className="rail-bottom">
          <button
            title={tr("切换主题")}
            onClick={() =>
              updatePref({ theme: prefs.theme === "dark" ? "light" : "dark" })
            }
          >
            {prefs.theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <button
            title={tr("设置")}
            aria-label={tr("设置")}
            onClick={() => setShowSettings(true)}
          >
            <Settings size={20} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="workspace-heading">
            <span className="eyebrow">OPEN READING</span>
            <button
              className="workspace-title"
              onClick={() => {
                setDoc(null);
                setNotesMode(false);
                setStatsMode(false);
              }}
            >
              {statsMode
                ? tr("全部工作区")
                : workspace?.name || tr("我的阅读空间")}
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="top-actions">
            <span className="local-status">
              <span />
              {serverMode ? tr("云端私人阅读空间") : tr("本机 · 离线笔记可用")}
            </span>
            <button
              className={statsMode ? "active-text" : ""}
              onClick={() => {
                setStatsMode(true);
                setNotesMode(false);
              }}
            >
              <CalendarDays size={16} />
              {tr("阅读数据")}
            </button>
            <button
              className={notesMode ? "active-text" : ""}
              onClick={review}
              disabled={!workspace}
            >
              <BookMarked size={16} />
              {tr("笔记与复习")}
            </button>
            <button
              title={tr("阅读设置")}
              onClick={() => setShowSettings(true)}
            >
              <Settings size={18} />
            </button>
          </div>
        </header>
        <div className={"body-shell" + (statsMode ? " stats-mode" : "")}>
          {statsMode && (
            <div className="global-reading-stats">
              <DesktopStats
                flush={reading.flush}
                notice={reading.error}
                onClose={() => setStatsMode(false)}
              />
            </div>
          )}
          {!desktopLibrary && (
            <aside className={"navigator " + (!leftOpen ? "collapsed" : "")}>
              <div className="nav-tabs">
                <button
                  className={navTab === "files" ? "active" : ""}
                  onClick={() => setNavTab("files")}
                >
                  {tr("文件")}
                </button>
                <button
                  className={navTab === "outline" ? "active" : ""}
                  onClick={() => setNavTab("outline")}
                >
                  {tr("目录")}
                </button>
                <button
                  title={tr("收起文件栏")}
                  onClick={() => setLeftOpen(false)}
                >
                  <PanelLeftClose size={16} />
                </button>
              </div>
              {navTab === "files" ? (
                <>
                  <div className="searchbox">
                    <Search size={15} />
                    <input
                      aria-label={tr("搜索文件名")}
                      placeholder={tr("搜索文件名")}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <kbd>⌕</kbd>
                  </div>
                  <div className="nav-section-label">
                    {tr("已连接来源")}{" "}
                    <span>
                      {sources.filter((s) => s.state === "active").length}
                    </span>
                    <div className="source-actions">
                      <button title={tr("刷新来源")} onClick={refresh}>
                        <RefreshCw size={13} />
                      </button>
                      <DocumentSort
                        value={prefs.documentSort}
                        onChange={(value) =>
                          updatePref({ documentSort: value })
                        }
                      />
                      <DocumentFormatFilter
                        value={fileFormat}
                        onChange={setFileFormat}
                      />
                    </div>
                  </div>
                  {sourceManager}
                  <div className="nav-section-label">
                    {tr("资料")}{" "}
                    <span>
                      {documents.length}
                      {cursor ? "+" : ""}
                    </span>
                  </div>
                  <BookFilters
                    compact
                    value={bookFilter}
                    onChange={setBookFilter}
                  />
                  <div className="file-list">
                    {documents.map((d) => {
                      const b = d.bindings[0];
                      const name =
                        b?.relativePath?.split("/").pop() || "历史文件";
                      return (
                        <button
                          className={
                            "file-item " +
                            (doc?.workspaceDocumentId === d.id
                              ? "selected"
                              : "")
                          }
                          key={d.id}
                          {...bookMenuProps(d)}
                          onClick={() => open(d)}
                        >
                          <FileText size={16} />
                          <div>
                            <span>{name}</span>
                            <small>
                              {b?.sourceLabel} ·{" "}
                              {b?.relativePath?.includes("/")
                                ? b.relativePath.slice(0, -name.length)
                                : d.format.toUpperCase()}
                              {b?.state === "missing"
                                ? tr(" · 源文件不可用")
                                : ""}
                            </small>
                          </div>
                          {doc?.workspaceDocumentId === d.id && (
                            <span className="file-current" />
                          )}
                        </button>
                      );
                    })}
                    {cursor && (
                      <button
                        className="load-more"
                        onClick={() => loadDocuments(true)}
                      >
                        {tr("加载更多")}
                      </button>
                    )}
                    {!documents.length && (
                      <p className="nav-empty">
                        {serverMode
                          ? tr("导入文件开始阅读。")
                          : tr("连接资料文件夹，或导入文件开始阅读。")}
                      </p>
                    )}
                  </div>
                  <div className="nav-bottom">
                    <button
                      onClick={() =>
                        serverMode
                          ? fileInput.current?.click()
                          : setSourceModal(true)
                      }
                      disabled={!workspace}
                    >
                      <FolderPlus size={16} />
                      {serverMode ? tr("导入文件") : tr("添加文件夹")}
                    </button>
                    <button
                      title={tr("导入文件或 ORD 学习包")}
                      onClick={() => fileInput.current?.click()}
                      disabled={!workspace}
                    >
                      <Upload size={16} />
                    </button>
                  </div>
                </>
              ) : (
                <div className="outline">
                  {outline.length ? (
                    outline.map((o, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          const loc = o.locator;
                          if (loc.heading !== undefined) {
                            document
                              .querySelectorAll(
                                ".prose h1,.prose h2,.prose h3,.prose h4",
                              )
                              [loc.heading]?.scrollIntoView({
                                block: "start",
                                behavior: "smooth",
                              });
                          } else
                            void reader.current?.navigateTo({
                              selectors:
                                loc.pageIndex !== undefined
                                  ? [
                                      {
                                        type: "pdf",
                                        pageIndex: loc.pageIndex,
                                        quads: [],
                                      },
                                    ]
                                  : [
                                      {
                                        type: "epub",
                                        cfi: loc.href,
                                        href: loc.href,
                                      },
                                    ],
                              quote: {
                                exact: "",
                                visible: "",
                                prefix: "",
                                suffix: "",
                              },
                              targetKind: "page",
                            } as Anchor);
                        }}
                      >
                        {o.label}
                      </button>
                    ))
                  ) : (
                    <p className="nav-empty">{tr("打开文档后显示目录")}</p>
                  )}
                </div>
              )}
              <div
                className="panel-resize"
                onPointerDown={(e) => resizePanel("leftWidth", e)}
              />
            </aside>
          )}
          <main
            className="reading-main"
            ref={readingMain}
            data-chrome-hidden={fullscreenChromeHidden || undefined}
          >
            {!desktopLibrary && !leftOpen && (notesMode || !doc) && (
              <button
                className="reopen-left reopen-left-floating"
                title={tr("展开文件栏")}
                onClick={() => setLeftOpen(true)}
              >
                <PanelLeftOpen size={18} />
              </button>
            )}
            {notesMode ? (
              <div className="notes-page">
                <div className="page-title">
                  <div>
                    <span className="eyebrow">YOUR LEARNING TRAIL</span>
                    <h1>{tr("笔记与复习")}</h1>
                    <p>{tr("把读过的内容，变成自己的理解。")}</p>
                  </div>
                  <button className="secondary" onClick={exportNotes}>
                    <Download size={16} />
                    {tr("导出 Markdown")}
                  </button>
                </div>
                <div className="filter-tabs">
                  {["全部", "待理解", "已理解", "待复习"].map((f) => (
                    <button
                      className={filter === f ? "active" : ""}
                      onClick={() => setFilter(f)}
                      key={f}
                    >
                      {tr(f)}
                    </button>
                  ))}
                </div>
                {notes
                  .filter(
                    (n) => filter === "全部" || n.learningState === filter,
                  )
                  .map((n) => (
                    <button
                      className="note-summary"
                      key={n.threadId}
                      onClick={async () => {
                        const d = documents.find(
                          (d) => d.id === n.workspaceDocumentId,
                        );
                        if (d) {
                          if (desktopLibrary)
                            await desktop!.openBook(
                              workspace.id,
                              d.id,
                              n.threadId,
                            );
                          else {
                            await open(d);
                            setNavigateThread(n.threadId);
                          }
                        }
                      }}
                    >
                      <small>
                        {n.title} · {n.anchor.displayLocation.label}
                      </small>
                      <blockquote>
                        {n.anchor.quote.visible || tr("页级笔记")}
                      </blockquote>
                      <span>
                        {tr(n.learningState)} · {n.messages?.length || 0}
                        {tr("条讨论")}
                      </span>
                    </button>
                  ))}
                {!notes.length && (
                  <div className="empty">
                    <BookMarked size={40} />
                    <h2>{tr("让理解留下来")}</h2>
                    <p>{tr("阅读时选择原文，留下第一条笔记。")}</p>
                  </div>
                )}
              </div>
            ) : doc ? (
              <>
                <div className="document-bar">
                  {readerTarget && (
                    <button
                      title={tr("显示书库")}
                      onClick={() => desktop?.showLibrary()}
                    >
                      <BookOpen size={19} />
                    </button>
                  )}
                  {!leftOpen && (
                    <button
                      className="reopen-left"
                      title={tr("展开文件栏")}
                      onClick={() => setLeftOpen(true)}
                    >
                      <PanelLeftOpen size={18} />
                    </button>
                  )}
                  <div className="document-breadcrumb">
                    <FileText size={15} />
                    <span>
                      {sources.find(
                        (s) => s.id === member?.bindings[0]?.sourceId,
                      )?.label || tr("阅读")}
                    </span>
                    <ChevronRight size={13} />
                    <div className="document-title">
                      <strong>{doc.title}</strong>
                      <div
                        className="document-progress"
                        ref={setProgressContainer}
                      />
                    </div>
                    {doc.historical && (
                      <span className="badge">{tr("历史快照")}</span>
                    )}
                  </div>
                  <div className="document-timer" ref={setTimerContainer} />
                  <div className="document-actions">
                    {readerTarget && (
                      <button
                        title={tr("阅读设置")}
                        onClick={() => setShowSettings(true)}
                      >
                        <Settings size={18} />
                      </button>
                    )}
                    <button
                      title={
                        readingFullscreen
                          ? tr("退出全屏阅读（Esc）")
                          : tr("全屏阅读")
                      }
                      aria-label={
                        readingFullscreen ? tr("退出全屏阅读") : tr("全屏阅读")
                      }
                      onClick={toggleReadingFullscreen}
                    >
                      {readingFullscreen ? (
                        <Minimize size={17} />
                      ) : (
                        <Maximize size={17} />
                      )}
                    </button>
                    {(doc.format === "pdf" || doc.format === "epub") && (
                      <select
                        aria-label={tr("页面布局")}
                        title={tr("双页在宽窗口中并排显示，窄窗口自动使用单页")}
                        value={
                          doc.format === "pdf"
                            ? prefs.pdfSpread
                              ? "double"
                              : "single"
                            : prefs.epubFlow !== "paginated"
                              ? "scroll"
                              : prefs.epubSpread
                                ? "double"
                                : "single"
                        }
                        onChange={(e) => {
                          const value = e.target.value;
                          updatePref(
                            doc.format === "pdf"
                              ? { pdfSpread: value === "double", pdfScale: 1 }
                              : {
                                  epubSpread: value === "double",
                                  epubFlow:
                                    value === "scroll"
                                      ? "scrolled-doc"
                                      : "paginated",
                                },
                          );
                        }}
                      >
                        {doc.format === "epub" && (
                          <option value="scroll">{tr("章节滚动")}</option>
                        )}
                        <option value="single">{tr("单页")}</option>
                        <option value="double">{tr("一屏双页")}</option>
                      </select>
                    )}
                    <div className="in-doc-search">
                      <Search size={14} />
                      <input
                        aria-label={tr("当前文档搜索")}
                        placeholder={tr("文档内查找")}
                        value={insideSearch}
                        onChange={(e) => setInsideSearch(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === "Enter")
                            notify(
                              `当前页或章节找到 ${(await reader.current?.search(insideSearch)) || 0} 处`,
                            );
                        }}
                      />
                    </div>
                    {doc.format === "pdf" && (
                      <>
                        <select
                          aria-label={tr("PDF 缩放")}
                          value={prefs.pdfScale}
                          onChange={(e) =>
                            updatePref({ pdfScale: Number(e.target.value) })
                          }
                        >
                          {Array.from(
                            new Set([...PDF_ZOOM_LEVELS, prefs.pdfScale]),
                          )
                            .sort((a, b) => a - b)
                            .map((n) => (
                              <option key={n} value={n}>
                                {Number((n * 100).toFixed(2))}%
                              </option>
                            ))}
                        </select>
                        <button
                          title={tr("旋转 PDF")}
                          onClick={() =>
                            updatePref({
                              pdfRotation: (prefs.pdfRotation + 90) % 360,
                            })
                          }
                        >
                          <RotateCw size={16} />
                        </button>
                      </>
                    )}
                    <button
                      title={tr("导出本书 ORD（原文、标注与已保存笔记）")}
                      aria-label={tr("导出本书 ORD")}
                      disabled={ordBusy}
                      onClick={() => void exportBook()}
                    >
                      <Download size={17} />
                    </button>
                    <button
                      title={tr("历史版本")}
                      onClick={async () =>
                        setHistory(
                          await api(
                            "/documents/" +
                              member.documentId +
                              "/versions?workspaceDocumentId=" +
                              member.id,
                          ),
                        )
                      }
                    >
                      <MoreHorizontal size={18} />
                    </button>
                    <button
                      title={tr("展开讨论")}
                      onClick={() => {
                        if (readingFullscreen)
                          void exitReadingFullscreen().then(() =>
                            setRightOpen(true),
                          );
                        else setRightOpen((v) => !v);
                      }}
                    >
                      <MessageSquare size={17} />
                    </button>
                  </div>
                </div>
                {change && (
                  <div className="change-banner">
                    {change === "changed"
                      ? tr("发现新版本，当前阅读和问答仍使用原快照。")
                      : tr("源文件不可用，历史快照和讨论仍保留。")}
                    <button
                      onClick={
                        change === "changed"
                          ? () => open(member)
                          : () => setSourceModal(true)
                      }
                    >
                      {change === "changed"
                        ? tr("切换到新版本")
                        : tr("连接来源")}
                    </button>
                    <button onClick={() => setChange("")}>
                      <X size={13} />
                    </button>
                  </div>
                )}
                <div className="reader-wrap">
                  <Reader
                    key={doc.workspaceDocumentId + ":" + doc.version.id}
                    ref={reader}
                    doc={doc}
                    preferences={prefs}
                    onPdfScaleChange={(scale, persist) => {
                      setPrefs((current) => ({ ...current, pdfScale: scale }));
                      if (persist)
                        void api(
                          "/preferences",
                          "PUT",
                          { pdfScale: scale },
                          { keepalive: true },
                        ).catch(fail);
                    }}
                    progressContainer={progressContainer}
                    timerContainer={timerContainer}
                    wordCountContainer={wordCountContainer}
                    pageNumberContainer={pageNumberContainer}
                    pdfControlsContainer={pdfControlsContainer}
                    activityEnabled={
                      !statsMode &&
                      !showSettings &&
                      !sourceModal &&
                      !newWS &&
                      !showPreview &&
                      !history
                    }
                    onReading={reading.record}
                    annotations={threads}
                    onSelect={(s) => {
                      if (
                        docRef.current?.workspaceDocumentId !==
                          doc.workspaceDocumentId ||
                        docRef.current?.version.id !== doc.version.id
                      )
                        return;
                      setSelection(s);
                      if (s) setComposing(false);
                    }}
                    onPickThread={pickThread}
                    onSelectionPosition={(rect) => {
                      if (
                        docRef.current?.workspaceDocumentId !==
                          doc.workspaceDocumentId ||
                        docRef.current?.version.id !== doc.version.id
                      )
                        return;
                      setSelection((current) => {
                        if (
                          !current ||
                          (current.rect.left === rect.left &&
                            current.rect.top === rect.top &&
                            current.rect.bottom === rect.bottom &&
                            current.rect.visible === rect.visible)
                        )
                          return current;
                        return { ...current, rect };
                      });
                    }}
                    onProgress={progress}
                    onOutline={setOutline}
                    onResolved={loadThreads}
                    onError={(text) => setError(text)}
                  />
                  {selection &&
                    selection.rect.visible !== false &&
                    !composing && (
                      <div
                        ref={toolbar}
                        className="selection-toolbar"
                        style={toolbarPosition}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        <button
                          title={tr("保存划线")}
                          onClick={() => submit(true)}
                        >
                          <Highlighter size={16} />
                        </button>
                        <button
                          onClick={() => {
                            void exitReadingFullscreen();
                            reader.current?.clearNativeSelection();
                            setComposing(true);
                            setActiveThread(null);
                            setRecipient("note");
                            setRightOpen(true);
                          }}
                        >
                          <MessageSquare size={15} />
                          {tr("评论")}
                        </button>
                        <button
                          onClick={() => {
                            void exitReadingFullscreen();
                            reader.current?.clearNativeSelection();
                            setComposing(true);
                            setActiveThread(null);
                            setRecipient("assistant");
                            setRightOpen(true);
                          }}
                        >
                          <Sparkles size={15} />
                          {tr("问小阅")}
                        </button>
                        <button
                          title={tr("复制选段")}
                          onClick={async (event) => {
                            try {
                              await copyText(
                                selection.anchor.quote.visible,
                                event.currentTarget,
                              );
                              notify("已复制选段");
                            } catch (e) {
                              fail(e);
                            }
                          }}
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          title={tr("取消选区")}
                          onClick={() => setSelection(null)}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    )}
                </div>
                <footer className="reading-footer">
                  <span>
                    {doc.format.toUpperCase()}
                    {tr("· 不可变版本")} {doc.version.contentHash?.slice(0, 8)}
                    <span
                      className="reading-word-count"
                      ref={setWordCountContainer}
                    />
                  </span>
                  {doc.format === "pdf" && (
                    <div
                      className="reading-page-tools"
                      ref={setPdfControlsContainer}
                    />
                  )}
                  <span>
                    {tr(saveState)}
                    <Check size={12} />
                  </span>
                </footer>
                <div
                  className="reading-page-number"
                  ref={setPageNumberContainer}
                />
              </>
            ) : desktopLibrary && workspace ? (
              <LibraryShelf
                books={documents}
                filter={bookFilter}
                format={fileFormat}
                onFormat={setFileFormat}
                onFilter={setBookFilter}
                bookMenuProps={bookMenuProps}
                cursor={cursor}
                search={search}
                onSearch={setSearch}
                sort={prefs.documentSort}
                onSort={(value) => updatePref({ documentSort: value })}
                sourceManager={sourceManager}
                sourceCount={
                  sources.filter((s) => s.state !== "removed").length
                }
                refresh={refresh}
                importFiles={() => fileInput.current?.click()}
                addSource={() => setSourceModal(true)}
                loadMore={() => {
                  void loadDocuments(true).catch(fail);
                }}
                open={open}
              />
            ) : (
              <div className="welcome">
                <div className="welcome-heading">
                  <span className="eyebrow">A QUIET PLACE TO UNDERSTAND</span>
                  <h1>
                    {workspace
                      ? tr("留一点时间，读懂它。")
                      : tr("欢迎来到 Open Reading。")}
                  </h1>
                  <p>
                    {tr("连接你的资料，在原文旁留下问题与理解。")}
                    <br />
                    {tr("下次回来，继续从这里开始。")}
                  </p>
                </div>
                <div className="welcome-art">
                  <div className="book-spine" />
                  <div className="book-paper">
                    <span>READ. THINK. CONNECT.</span>
                    <div />
                    <div />
                    <div className="marked-line" />
                    <div />
                    <div />
                  </div>
                  <div className="art-note">
                    <Sparkles size={18} />
                    <span>{tr("“这段话，我理解了吗？”")}</span>
                  </div>
                </div>
                {!workspace ? (
                  <button className="primary" onClick={() => setNewWS(true)}>
                    <Plus size={16} />
                    {tr("创建第一个工作区")}
                  </button>
                ) : (
                  <div className="welcome-actions">
                    <button
                      className="primary"
                      onClick={() =>
                        serverMode
                          ? fileInput.current?.click()
                          : setSourceModal(true)
                      }
                    >
                      <FolderPlus size={17} />
                      {serverMode ? tr("导入阅读资料") : tr("连接资料文件夹")}
                    </button>
                    <button
                      className="secondary"
                      onClick={() => fileInput.current?.click()}
                    >
                      <Upload size={16} />
                      {tr("导入文件 / ORD 学习包")}
                    </button>
                  </div>
                )}
                <div className="welcome-formats">
                  Markdown <span>·</span> TXT <span>·</span> PDF <span>·</span>{" "}
                  EPUB <span>·</span>
                  {tr("ORD 学习包")}
                </div>
                <div className="welcome-foot">
                  <span>
                    <Folder size={16} />
                    {tr("原始资料只读连接")}
                  </span>
                  <span>
                    <MessageSquare size={16} />
                    {tr("讨论与原文一起保存")}
                  </span>
                  <span>
                    <BookOpen size={16} />
                    {tr("断网也能阅读和记笔记")}
                  </span>
                </div>
              </div>
            )}
          </main>
          {doc && !notesMode && (
            <aside className={"discussion " + (!rightOpen ? "collapsed" : "")}>
              <div
                className="panel-resize left"
                onPointerDown={(e) => resizePanel("rightWidth", e)}
              />
              <div className="discussion-header">
                <span>
                  <MessageSquare size={17} />
                  {tr("原文旁的讨论")}
                  <small>{threads.length}</small>
                </span>
                <button
                  title={tr("收起讨论")}
                  onClick={() => setRightOpen(false)}
                >
                  <PanelRightClose size={16} />
                </button>
              </div>
              <div className="discussion-tabs">
                <button
                  className={!activeThread ? "active" : ""}
                  onClick={() => {
                    setActiveThread(null);
                    setComposing(false);
                    setSelection(null);
                  }}
                >
                  {tr("全部批注")}
                </button>
                <select
                  aria-label={tr("按学习状态筛选")}
                  value={tr(filter)}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  {["全部", "待理解", "已理解", "待复习"].map((x) => (
                    <option key={x} value={x}>
                      {tr(x)}
                    </option>
                  ))}
                </select>
                <button
                  title={tr("按最近更新排序")}
                  onClick={() => setThreads((v) => [...v].reverse())}
                >
                  ↕
                </button>
              </div>
              <div className="thread-list">
                {threads
                  .filter(
                    (t) =>
                      (!activeThread || t.threadId === activeThread) &&
                      (filter === "全部" || t.learningState === filter),
                  )
                  .map((t) => (
                    <ThreadCard
                      key={t.threadId}
                      thread={t}
                      active={activeThread === t.threadId}
                      onSelect={() => pickThread([t.threadId])}
                      onJump={() => jump(t)}
                      onCitation={jumpSource}
                      onDeleted={() => {
                        setActiveThread(null);
                        setComposing(false);
                        void loadThreads();
                      }}
                      onError={fail}
                      onRefresh={loadThreads}
                      currentVersion={doc.version.id}
                      onRelocate={
                        selection
                          ? async () => {
                              await api(
                                "/annotations/" + t.id + "/relocate",
                                "POST",
                                {
                                  anchor: selection.anchor,
                                  revision: t.revision,
                                },
                              );
                              setSelection(null);
                              await loadThreads();
                            }
                          : undefined
                      }
                    />
                  ))}
                {!threads.length && (
                  <div className="thread-empty">
                    <div>
                      <MessageSquare size={26} />
                    </div>
                    <h3>{tr("从一段原文开始")}</h3>
                    <p>
                      {tr("选中你想理解的文字，")}
                      <br />
                      {tr("记笔记，或和小阅聊一聊。")}
                    </p>
                    <span>{tr("你的问题，会留在原文旁边。")}</span>
                  </div>
                )}
              </div>
              {(composing || activeThread) && (
                <div className="composer">
                  <div className="composer-heading">
                    <span>
                      {recipient === "assistant" ? (
                        <>
                          <Sparkles size={14} />
                          {tr("发给小阅")}
                        </>
                      ) : (
                        <>
                          <MessageSquare size={14} />
                          {tr("记笔记")}
                        </>
                      )}
                    </span>
                    <button
                      onClick={() => {
                        setComposing(false);
                        setSelection(null);
                        setActiveThread(null);
                      }}
                      title={tr("关闭输入")}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {selection && (
                    <blockquote>
                      {selection.anchor.quote.visible || tr("页级笔记")}
                    </blockquote>
                  )}
                  <textarea
                    autoFocus
                    disabled={!draftReady}
                    ref={composer}
                    aria-label={tr("评论输入")}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      sendKey.current = uid();
                    }}
                    placeholder={
                      !draftReady
                        ? tr("正在恢复草稿…")
                        : recipient === "assistant"
                          ? tr("向小阅提问，回答将保存在这条线程…")
                          : tr("写下自己的理解或问题…")
                    }
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <div className="recipient-options">
                    <button
                      className={recipient === "note" ? "selected" : ""}
                      onClick={() => setRecipient("note")}
                    >
                      {tr("记笔记")}
                    </button>
                    <button
                      className={recipient === "assistant" ? "selected" : ""}
                      onClick={() => setRecipient("assistant")}
                    >
                      <Sparkles size={12} />
                      {tr("@ 小阅")}
                    </button>
                  </div>
                  {recipient === "assistant" && (
                    <>
                      <div className="quick-prompts">
                        {["通俗解释", "举个例子", "翻译", "如何应用"].map(
                          (q) => (
                            <button
                              disabled={!draftReady}
                              key={q}
                              onClick={() => {
                                setDraft(tr(q) + " " + tr("这段内容"));
                                sendKey.current = uid();
                              }}
                            >
                              {tr(q)}
                            </button>
                          ),
                        )}
                      </div>
                      <select
                        aria-label={tr("选择模型")}
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                      >
                        <option value="">{tr("选择模型")}</option>
                        {providers.map((p) => (
                          <optgroup label={p.name} key={p.id}>
                            {modelsFor(p).map((id) => (
                              <option
                                value={modelChoice(p, id)}
                                key={id}
                                disabled={
                                  (!p.credentialBound &&
                                    p.protocol !== "mock") ||
                                  !(p.enabledWorkspaceIds ?? []).includes(
                                    workspace?.id,
                                  )
                                }
                              >
                                {p.protocol === "mock" ? tr("[模拟] ") : ""}
                                {id}
                                {!(p.enabledWorkspaceIds ?? []).includes(
                                  workspace?.id,
                                )
                                  ? tr(" · 工作区未启用")
                                  : !p.credentialBound && p.protocol !== "mock"
                                    ? tr(" · 待绑定密钥")
                                    : ""}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <div className="context-options">
                        <select
                          aria-label={tr("上下文范围")}
                          value={policy}
                          onChange={(e) => setPolicy(e.target.value)}
                        >
                          <option value="selection">{tr("仅选段")}</option>
                          <option value="nearby">{tr("选段与附近内容")}</option>
                        </select>
                        <button onClick={previewContext}>
                          {tr("预览发送内容")}
                        </button>
                      </div>
                    </>
                  )}
                  <div className="composer-footer">
                    <span>{tr(saveState)}</span>
                    <button
                      className="primary"
                      disabled={
                        pending ||
                        !draftReady ||
                        !draft.trim() ||
                        (recipient === "assistant" && !model)
                      }
                      onClick={() => submit()}
                      aria-label={tr("发送评论")}
                    >
                      {pending
                        ? tr("保存中")
                        : recipient === "assistant"
                          ? tr("发送给小阅")
                          : tr("保存笔记")}
                      <ArrowUp size={15} />
                    </button>
                  </div>
                </div>
              )}
              <div className="discussion-foot">
                <span className="tiny-dot" />
                {serverMode ? tr("笔记保存在云端空间") : tr("笔记保存在本机")}
                {tr("· 模型仅接收所选范围")}
              </div>
            </aside>
          )}
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".md,.markdown,.txt,.pdf,.epub,.ord"
        hidden
        onChange={(e) => {
          void importFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {error && (
        <div className="error-toast" role="alert">
          {tr(error)}
          <button onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {deletingBook && (
        <DeleteBookDialog
          book={deletingBook}
          close={() => setDeletingBook(null)}
          done={async () => {
            await loadDocuments();
            notify("删除操作已完成");
          }}
        />
      )}
      {convertingBook && workspace && (
        <ConversionDialog
          book={convertingBook}
          workspaceId={workspace.id}
          close={() => setConvertingBook(null)}
          done={async () => {
            await Promise.all([loadDocuments(), loadSources()]);
            notify("转换文件已保存");
          }}
        />
      )}
      {bookContextMenu}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {tr(toast)}
        </div>
      )}
      {newWS && (
        <Modal title={tr("新建工作区")} close={() => setNewWS(false)}>
          <form onSubmit={createWorkspace}>
            <label>
              {tr("工作区名称")}
              <input
                autoFocus
                value={wsName}
                onChange={(e) => setWsName(e.target.value)}
                placeholder={tr("例如：后端技术、论文阅读")}
                maxLength={60}
              />
            </label>
            <p className="muted">
              {tr("每个工作区有独立的阅读进度、批注和问答上下文。")}
            </p>
            <button className="primary" disabled={!wsName.trim()}>
              {tr("创建工作区")}
            </button>
          </form>
        </Modal>
      )}
      {sourceModal && workspace && !serverMode && (
        <SourceModal
          workspace={workspace}
          close={() => setSourceModal(false)}
          onDone={async () => {
            await loadSources();
            await loadDocuments();
            setSourceModal(false);
          }}
          onError={fail}
        />
      )}
      {showSettings && (
        <SettingsModal
          preferences={prefs}
          updatePref={updatePref}
          workspace={workspace}
          allowMock={allowMock}
          providers={providers}
          reloadProviders={async () => setProviders(await api("/providers"))}
          reloadWorkspaces={async () => {
            const ws = await api("/workspaces");
            setWorkspaces(ws);
            setWorkspace(
              ws.find((w: any) => w.id === workspace?.id) || ws[0] || null,
            );
          }}
          close={() => setShowSettings(false)}
          onError={fail}
          onNotice={notify}
        />
      )}
      {showPreview && (
        <Modal
          title={tr("本次发送内容预览")}
          close={() => setShowPreview(false)}
          wide
        >
          <p className="muted">
            {preview?.estimatedTokens}
            {tr("tokens（保守估算） ·")} {preview?.effectiveConfig?.name} ·{" "}
            {preview?.effectiveConfig?.modelId} ·{" "}
            {preview?.effectiveConfig?.baseUrl}
            {tr("。有效历史包含在下面；材料不会扩大到其他文件。")}
          </p>
          {preview?.omissions?.length > 0 && (
            <p>
              {tr("省略：")}
              {preview.omissions.join("、")}
            </p>
          )}
          {preview?.messages?.map((m: any, i: number) => (
            <div className="context-preview" key={i}>
              <strong>{m.role}</strong>
              <pre>{m.content}</pre>
            </div>
          ))}
        </Modal>
      )}
      {history && (
        <Modal title={tr("文档版本")} close={() => setHistory(null)}>
          <button
            className="secondary"
            onClick={() => {
              setHistory(null);
              setRebind(true);
            }}
          >
            <RefreshCw size={14} />
            {tr("重新绑定改名或移动后的文件")}
          </button>
          {history.map((v) => (
            <button
              className="history-version"
              key={v.id}
              onClick={() => {
                void open(member, v);
                setHistory(null);
              }}
            >
              <span>{new Date(v.createdAt).toLocaleString(locale())}</span>
              <code>{v.contentHash.slice(0, 12)}</code>
              <small>
                {Math.round(v.size / 1024)}
                {tr("KB · 打开历史快照")}
              </small>
            </button>
          ))}
        </Modal>
      )}
      {rebind && member && (
        <RebindModal
          member={member}
          workspace={workspace}
          close={() => setRebind(false)}
          onError={fail}
          done={async () => {
            await loadDocuments();
            setRebind(false);
            notify("已确认恢复原文档身份，历史批注保持原版本");
          }}
        />
      )}
      {overlap && (
        <Modal title={tr("此处有多条批注")} close={() => setOverlap(null)}>
          {overlap.map((id: string) => (
            <button
              className="history-version"
              key={id}
              onClick={() => {
                void pickThread([id]);
                setOverlap(null);
              }}
            >
              {threads.find((t) => t.threadId === id)?.anchor.quote.visible}
            </button>
          ))}
        </Modal>
      )}
    </div>
  );
}
function ThreadCard({
  thread: t,
  active,
  onSelect,
  onJump,
  onCitation,
  onDeleted,
  onError,
  onRefresh,
  currentVersion,
  onRelocate,
}: any) {
  const [editing, setEditing] = useState<any>(null),
    [edit, setEdit] = useState("");
  const unresolved =
    t.originalVersionId !== currentVersion &&
    !t.resolutions?.some(
      (r: any) =>
        r.targetVersionId === currentVersion && r.state === "resolved",
    );
  const displayAnchor =
    t.resolutions?.find(
      (r: any) =>
        r.targetVersionId === currentVersion && r.state === "resolved",
    )?.selector?.anchor || t.anchor;
  return (
    <section className={"thread-card " + (active ? "active" : "")}>
      <div className="thread-meta">
        <span>{displayAnchor.displayLocation.label}</span>
        <select
          aria-label={tr("学习状态")}
          value={t.learningState}
          onChange={async (e) => {
            try {
              await api("/threads/" + t.threadId, "PATCH", {
                revision: t.threadRevision,
                learningState: e.target.value,
              });
              await onRefresh();
            } catch (e) {
              onError(e);
            }
          }}
        >
          {["待理解", "已理解", "待复习"].map((x) => (
            <option key={x} value={x}>
              {tr(x)}
            </option>
          ))}
        </select>
      </div>
      <button className="quote-button" onClick={onJump}>
        <blockquote>{displayAnchor.quote.visible || tr("页级笔记")}</blockquote>
      </button>
      {unresolved && (
        <div className="unresolved">
          {tr("待重新定位 · 原文已更新")}
          <button onClick={onJump}>{tr("查看原版本")}</button>
        </div>
      )}
      {active && onRelocate && (
        <button onClick={() => onRelocate().catch(onError)}>
          {tr("绑定到新选段")}
        </button>
      )}
      {t.messages?.map((m: any) => (
        <div className={"message " + m.role} key={m.id}>
          <div className="message-header">
            <span
              className={
                m.role === "assistant" ? "assistant-avatar" : "user-avatar"
              }
            >
              {m.role === "assistant" ? <Sparkles size={13} /> : tr("我")}
            </span>
            <strong>
              {m.role === "assistant" ? tr("小阅") : tr("我的笔记")}
            </strong>
            <time>
              {new Date(m.createdAt).toLocaleTimeString(locale(), {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            {m.role !== "assistant" && (
              <button
                title={tr("编辑笔记")}
                onClick={() => {
                  setEditing(m);
                  setEdit(m.body);
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          </div>
          {editing?.id === m.id ? (
            <div className="edit-message">
              <textarea
                value={edit}
                onChange={(e) => setEdit(e.target.value)}
              />
              <button
                onClick={async () => {
                  try {
                    await api("/messages/" + m.id, "PATCH", {
                      body: edit,
                      revision: m.revision,
                    });
                    setEditing(null);
                    await onRefresh();
                  } catch (e) {
                    onError(e);
                  }
                }}
              >
                {tr("保存修改")}
              </button>
              <button onClick={() => setEditing(null)}>{tr("取消")}</button>
            </div>
          ) : m.role === "assistant" ? (
            <RunMessage
              message={m}
              run={m.run}
              onError={onError}
              onRefresh={onRefresh}
              onJump={onJump}
              onCitation={onCitation}
            />
          ) : (
            <p className="note-body">{m.body}</p>
          )}
        </div>
      ))}
      <div className="thread-actions">
        <button
          title={tr("删除批注")}
          onClick={async () => {
            if (!confirm(tr("删除这条批注与全部讨论？已导出的备份不受影响。")))
              return;
            try {
              await api("/threads/" + t.threadId, "DELETE", {
                revision: t.threadRevision,
              });
              onDeleted();
            } catch (e) {
              onError(e);
            }
          }}
        >
          <X size={12} />
        </button>
        <button onClick={onSelect}>
          <MessageSquare size={13} />
          {active ? tr("继续讨论") : tr("打开讨论")}
        </button>
        <button
          title={tr("划线颜色")}
          onClick={async () => {
            try {
              await api("/annotations/" + t.id, "PATCH", {
                revision: t.revision,
                style: {
                  color: t.style?.color === "#b8d8c6" ? "#e8cb76" : "#b8d8c6",
                },
              });
              await onRefresh();
            } catch (e) {
              onError(e);
            }
          }}
        >
          <Highlighter size={13} />
        </button>
        <button
          title={tr("下划线样式")}
          onClick={async () => {
            try {
              await api("/annotations/" + t.id, "PATCH", {
                revision: t.revision,
                style: { ...t.style, underline: !t.style?.underline },
              });
              await onRefresh();
            } catch (e) {
              onError(e);
            }
          }}
        >
          U
        </button>
        <button onClick={onJump}>
          {tr("回到原文")}
          <ChevronRight size={12} />
        </button>
      </div>
    </section>
  );
}
function RunMessage({
  message,
  run,
  onError,
  onRefresh,
  onJump,
  onCitation,
}: any) {
  const [text, setText] = useState(message.body),
    [state, setState] = useState(run?.state || "completed"),
    [usage, setUsage] = useState(run?.usage),
    [error, setError] = useState(run?.errorMessage || ""),
    [sources, setSources] = useState<any[]>([]),
    lastSeq = useRef(0);
  const [contextDetails, setContextDetails] = useState<any>(null);
  useEffect(() => {
    if (!run) return;
    let events: EventSource | undefined,
      closed = false;
    api("/ai-runs/" + run.id)
      .then((r) => {
        if (closed) return;
        setText(r.body);
        setState(r.state);
        setSources(r.sources || []);
        setUsage(r.usage);
        setError(r.errorMessage || "");
        lastSeq.current = r.lastSeq;
        events = new EventSource(
          "/api/ai-runs/" + run.id + "/events?afterSeq=" + lastSeq.current,
        );
        events.onmessage = (e) => {
          const event = JSON.parse(e.data);
          if (event.type === "snapshot") {
            if (event.payload.lastSeq < lastSeq.current) return;
            setText(event.payload.body);
            setState(event.payload.state);
            setError(event.payload.errorMessage || "");
            lastSeq.current = event.payload.lastSeq;
            if (
              !["queued", "preparing", "generating"].includes(
                event.payload.state,
              )
            )
              events?.close();
            return;
          }
          if (event.seq <= lastSeq.current) return;
          lastSeq.current = event.seq;
          if (event.type === "text_delta")
            setText((x: string) => x + event.payload.text);
          if (event.type === "status") setState(event.payload.state);
          if (event.type === "usage") setUsage(event.payload);
          if (event.type === "error") setError(event.payload.message);
          if (event.type === "done") {
            setState(event.payload.state);
            events?.close();
          }
        };
        events.onerror = () => {
          /* Native EventSource reconnects to the same run; never sends a question. */
        };
      })
      .catch(onError);
    return () => {
      closed = true;
      events?.close();
    };
  }, [run?.id]);
  const active = ["queued", "preparing", "generating"].includes(state);
  const labels: any = {
    queued: "排队中",
    preparing: "准备上下文",
    generating: "正在回答",
    completed: "已完成",
    canceled: "已停止",
    failed: "失败",
    interrupted: "已中断",
    truncated: "回答未完成",
  };
  const citationText = text.replace(/\[(S\d+)\]/g, (all: string, id: string) =>
    sources.some((s) => s.localLabel === id) ? all : all + tr("（无效来源）"),
  );
  return (
    <div className="assistant-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: () => <span>{tr("远程图片已阻断")}</span>,
          a: ({ children, href }) => (
            <a
              href={/^https?:\/\//.test(href || "") ? href : undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {citationText || tr("正在准备回答…")}
      </ReactMarkdown>
      {sources.length > 0 && (
        <div className="citations">
          {sources.map((s) => (
            <button
              key={s.localLabel}
              onClick={() => onCitation(s)}
              title={s.text}
            >
              <FileText size={11} />
              {s.localLabel} · {s.locator?.label || tr("选段")}
            </button>
          ))}
        </div>
      )}
      <div className="run-status">
        {run && (
          <button
            onClick={() =>
              api("/ai-runs/" + run.id)
                .then(setContextDetails)
                .catch(onError)
            }
          >
            {tr("本次上下文")}
          </button>
        )}
        {run?.protocol === "mock" && (
          <strong className="mock-badge">{tr("模拟回答")}</strong>
        )}
        <span>{tr(labels[state] || state)}</span>
        {active ? (
          <button
            onClick={() =>
              api("/ai-runs/" + run.id + "/cancel", "POST", {}).catch(onError)
            }
          >
            <StopCircle size={12} />
            {tr("停止")}
          </button>
        ) : (
          run && (
            <button
              onClick={() =>
                api("/ai-runs/" + run.id + "/retry", "POST", {
                  clientRequestId: uid(),
                })
                  .then(onRefresh)
                  .catch(onError)
              }
            >
              {tr("重新生成")}
            </button>
          )
        )}
        <small>
          {usage?.total_tokens != null
            ? tr(`${usage.total_tokens} tokens（实际）`)
            : tr("用量未知")}
        </small>
      </div>
      {error && <p className="error">{tr(error)}</p>}
      {contextDetails && (
        <Modal
          title={tr("此回答固定的上下文")}
          close={() => setContextDetails(null)}
          wide
        >
          <p className="muted">
            {contextDetails.config.name} · {contextDetails.config.modelId} ·{" "}
            {contextDetails.config.baseUrl}
            <br />
            {tr("上下文哈希")}
            {contextDetails.contentHash}
            <br />
            {tr("实际尝试")}
            {contextDetails.attempts.length}{" "}
            {tr("次；历史回答不会随当前设置或原文变化。")}
          </p>
          {contextDetails.messages.map((m: any, i: number) => (
            <div className="context-preview" key={i}>
              <strong>{m.role}</strong>
              <pre>{m.content}</pre>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}
function Modal({ title, close, children, wide = false }: any) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className={"modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={tr(title)}
      >
        <header>
          <h2>{tr(title)}</h2>
          <button aria-label={tr("关闭")} onClick={close}>
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function RebindModal({ member, workspace, close, onError, done }: any) {
  const [query, setQuery] = useState(""),
    [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    let alive = true;
    api(
      "/workspaces/" +
        workspace.id +
        "/documents?q=" +
        encodeURIComponent(query),
    )
      .then((v) => {
        if (alive)
          setItems(
            v.items.filter(
              (d: any) => d.id !== member.id && d.format === member.format,
            ),
          );
      })
      .catch(onError);
    return () => {
      alive = false;
    };
  }, [query]);
  return (
    <Modal title={tr("确认文档重新绑定")} close={close}>
      <p className="muted">
        {tr(
          "选择改名或移动后的文件。只有已连接来源中的文件可选；有独立学习记录的目标会拒绝合并。原始锚点与问答依据不会改写。",
        )}
      </p>
      <label>
        {tr("查找目标文件")}
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {items.flatMap((d) =>
        d.bindings
          .filter(
            (b: any) =>
              b.state === "active" &&
              b.bindingState === "active" &&
              b.sourceState === "active",
          )
          .map((b: any) => (
            <button
              className="history-version"
              key={b.id}
              onClick={async () => {
                if (!confirm(tr("确认此文件是原文档移动或改名后的版本？")))
                  return;
                try {
                  await api(
                    "/documents/" + member.documentId + "/rebind",
                    "POST",
                    { workspaceDocumentId: member.id, sourceEntryId: b.id },
                  );
                  await done();
                } catch (e) {
                  onError(e);
                }
              }}
            >
              <span>{b.relativePath}</span>
              <small>
                {b.sourceLabel} ·{" "}
                {member.bindings.some(
                  (old: any) => old.fileIdentity === b.fileIdentity,
                )
                  ? tr("文件标识匹配，等待你的确认")
                  : tr("由你确认原文件身份")}
              </small>
            </button>
          )),
      )}
    </Modal>
  );
}
function SourceModal({ workspace, close, onDone, onError }: any) {
  const [path, setPath] = useState(""),
    [token, setToken] = useState(""),
    [entries, setEntries] = useState<any[]>([]),
    [parent, setParent] = useState(""),
    [state, setState] = useState(""),
    [ignore, setIgnore] = useState("");
  const browse = async (p: string, t = token) => {
    try {
      const v = await api(
        "/local-picker/entries?token=" + t + "&path=" + encodeURIComponent(p),
      );
      setPath(v.path);
      setEntries(v.entries);
      setParent(v.parent);
    } catch (e) {
      onError(e);
    }
  };
  useEffect(() => {
    api("/local-picker/sessions", "POST", {})
      .then((s) => {
        setToken(s.token);
        void browse(s.initialPath, s.token);
      })
      .catch(onError);
  }, []);
  return (
    <Modal title={tr("连接资料文件夹")} close={close}>
      <p className="muted">
        {tr("只读连接本机目录。登记时仅扫描文件信息，打开时才保存快照。")}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void browse(path);
        }}
      >
        <label>
          {tr("本机绝对路径")}
          <input
            aria-label={tr("文件夹路径")}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <button className="secondary">{tr("浏览此路径")}</button>
      </form>
      <div className="directory-picker">
        <button onClick={() => browse(parent)}>
          <ArrowLeft size={14} />
          {tr("上级目录")}
        </button>
        {entries.map((e) => (
          <button key={e.path} onClick={() => browse(e.path)}>
            <Folder size={15} />
            {e.name}
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
      <label>
        {tr("额外忽略的目录名（逗号分隔）")}
        <input
          value={ignore}
          onChange={(e) => setIgnore(e.target.value)}
          placeholder={tr("例如：build,archive")}
        />
      </label>
      <div className="modal-footer">
        <span>{tr(state) || tr("支持连续添加多个来源")}</span>
        <button
          className="primary"
          disabled={!!state}
          onClick={async () => {
            try {
              setState("正在扫描…");
              const s = await api(
                "/workspaces/" + workspace.id + "/sources",
                "POST",
                {
                  path,
                  ignore: ignore
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                },
              );
              await waitScan(s.scan.id, setState);
              await onDone();
            } catch (e) {
              setState("");
              onError(e);
            }
          }}
        >
          <FolderPlus size={16} />
          {tr("连接此文件夹")}
        </button>
      </div>
    </Modal>
  );
}
function SettingsModal({
  preferences: p,
  updatePref,
  workspace,
  allowMock,
  providers,
  reloadProviders,
  reloadWorkspaces,
  close,
  onError,
  onNotice,
}: any) {
  const [tab, setTab] = useState("reading"),
    [restore, setRestore] = useState<any>(null),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={tr("设置")} close={close} wide>
      <div className="settings-tabs">
        {[
          ["reading", "阅读偏好"],
          ["models", "模型与隐私"],
          ["data", "备份与恢复"],
          ["sync", "手机与同步"],
        ].map(([id, name]) => (
          <button
            className={tab === id ? "active" : ""}
            key={id}
            onClick={() => setTab(id)}
          >
            {tr(name)}
          </button>
        ))}
      </div>
      {tab === "reading" ? (
        <div className="settings-grid">
          <label>
            {tr("Language / 语言")}
            <select
              aria-label={tr("Language / 语言")}
              value={p.language || "en"}
              onChange={(e) => updatePref({ language: e.target.value })}
            >
              <option value="en">English</option>
              <option value="zh">{tr("中文")}</option>
            </select>
          </label>
          <label>
            {tr("阅读速度（字/词每分钟）")}
            <input
              aria-label={tr("阅读速度（字/词每分钟）")}
              type="number"
              min="50"
              max="2000"
              key={p.readingSpeed || 300}
              defaultValue={p.readingSpeed || 300}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (n >= 50 && n <= 2000) updatePref({ readingSpeed: n });
                else e.target.value = String(p.readingSpeed || 300);
              }}
            />
          </label>
          <label>
            {tr("字号")}{" "}
            <input
              aria-label={tr("阅读字号")}
              type="range"
              min="14"
              max="30"
              value={p.fontSize}
              onChange={(e) => updatePref({ fontSize: Number(e.target.value) })}
            />
            {p.fontSize}px
          </label>
          <label>
            {tr("行距")}{" "}
            <input
              aria-label={tr("阅读行距")}
              type="range"
              min="1.3"
              max="2.5"
              step=".1"
              value={p.lineHeight}
              onChange={(e) =>
                updatePref({ lineHeight: Number(e.target.value) })
              }
            />
            {p.lineHeight}
          </label>
          <label>
            {tr("字体")}
            <select
              aria-label={tr("阅读字体")}
              value={p.fontFamily}
              onChange={(e) => updatePref({ fontFamily: e.target.value })}
            >
              <option value="system-ui">{tr("系统无衬线")}</option>
              <option value="serif">{tr("衬线字体")}</option>
              <option value="monospace">{tr("等宽字体")}</option>
            </select>
          </label>
          <label>
            {tr("主题")}
            <select
              value={p.theme}
              onChange={(e) => updatePref({ theme: e.target.value })}
            >
              <option value="light">{tr("纯白 · 浅色")}</option>
              <option value="dark">{tr("纯黑 · 深色")}</option>
            </select>
          </label>
          <label>
            {tr("EPUB 阅读模式")}
            <select
              aria-label={tr("EPUB 阅读模式")}
              value={
                p.epubFlow !== "paginated"
                  ? "scrolled-doc"
                  : p.epubSpread
                    ? "double"
                    : "paginated"
              }
              onChange={(e) =>
                updatePref({
                  epubFlow:
                    e.target.value === "double" ? "paginated" : e.target.value,
                  epubSpread: e.target.value === "double",
                })
              }
            >
              <option value="scrolled-doc">{tr("章节滚动")}</option>
              <option value="paginated">{tr("分页")}</option>
              <option value="double">{tr("一屏双页")}</option>
            </select>
          </label>
          <label>
            {tr("TXT 编码")}
            <select
              value={p.encoding}
              onChange={(e) => updatePref({ encoding: e.target.value })}
            >
              <option value="utf-8">UTF-8</option>
              <option value="gb18030">GB18030 / GBK</option>
              <option value="big5">Big5</option>
              <option value="utf-16le">UTF-16 LE</option>
            </select>
          </label>
        </div>
      ) : tab === "sync" ? (
        <SyncSettings onError={onError} />
      ) : tab === "models" ? (
        <ModelSettings
          providers={providers}
          workspace={workspace}
          allowMock={allowMock}
          reloadProviders={reloadProviders}
          onNotice={onNotice}
        />
      ) : (
        <>
          {workspace && (
            <div className="settings-actions">
              <button
                className="secondary"
                onClick={async () => {
                  const name = prompt(tr("新的工作区名称"), workspace.name);
                  if (!name?.trim()) return;
                  try {
                    await api("/workspaces/" + workspace.id, "PATCH", {
                      name: name.trim(),
                      revision: workspace.revision,
                    });
                    await reloadWorkspaces();
                    onNotice("工作区名称已更新");
                  } catch (e) {
                    onError(e);
                  }
                }}
              >
                {tr("重命名工作区")}
              </button>
              <button
                onClick={async () => {
                  try {
                    const preview = await api(
                      "/workspaces/" + workspace.id + "/deletion-preview",
                    );
                    if (
                      !confirm(
                        tr(
                          `删除“${preview.name}”及其 ${preview.annotations} 条批注、问答和进度？原始文件不会删除，共享缓存与导入副本会保留。`,
                        ),
                      )
                    )
                      return;
                    await api(
                      "/workspaces/" +
                        workspace.id +
                        "?confirm=delete-learning-data",
                      "DELETE",
                    );
                    await reloadWorkspaces();
                    close();
                  } catch (e) {
                    onError(e);
                  }
                }}
              >
                {tr("删除当前工作区")}
              </button>
            </div>
          )}
          <p>
            {tr(
              "完整备份包含已缓存文档、受保护版本、批注、问答和提取产物。未打开的原始资料不自动打包；API Key 不进入备份。",
            )}
          </p>
          <div className="settings-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const v = await api("/backups", "POST", {});
                  const response = await fetch(
                    "/api/backups/" + v.id + "/download",
                  );
                  if (!response.ok) throw Error("备份下载失败");
                  const blob = await response.blob();
                  downloadBlob(blob, "openreading-backup.zip");
                  onNotice("完整备份已验证并下载");
                } catch (e) {
                  onError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Download size={16} />
              {busy ? tr("正在制作备份…") : tr("创建完整备份")}
            </button>
            <label className="file-button secondary">
              <Upload size={16} />
              {tr("预览恢复 ZIP")}
              <input
                hidden
                type="file"
                accept=".zip"
                onChange={async (e) => {
                  if (!e.target.files?.[0]) return;
                  const data = new FormData();
                  data.append("file", e.target.files[0]);
                  try {
                    setRestore(await api("/restores/preview", "POST", data));
                  } catch (e) {
                    onError(e);
                  }
                }}
              />
            </label>
            <button
              className="secondary"
              onClick={() =>
                api("/cache/preview")
                  .then((v) => {
                    if (
                      confirm(
                        tr(
                          `清理 ${v.files} 个普通缓存，共 ${Math.round(v.bytes / 1024)} KB？已保存笔记和受保护版本会保留。`,
                        ),
                      )
                    )
                      api("/cache/clear", "POST", {})
                        .then(() => onNotice("普通缓存已清理"))
                        .catch(onError);
                  })
                  .catch(onError)
              }
            >
              {tr("清理普通缓存")}
            </button>
          </div>
          {restore && (
            <div className="restore-preview">
              <h3>{tr("恢复预览")}</h3>
              <p>
                {restore.workspaces}
                {tr("个工作区，")}
                {restore.versions}
                {tr("个文档版本，")}
                {restore.blobs}
                {tr("个快照资源。哈希校验通过。")}
              </p>
              <p>
                {tr("可离线打开")}
                {restore.offlineDocuments}
                {tr("份文档；另有")} {restore.uncachedDocuments}
                {tr("份未缓存文档需要重新连接。")}
              </p>
              <p>
                {tr(
                  "恢复为新工作区，原机器来源需要重新连接。非终态回答标为中断；模型凭据保持未绑定。",
                )}
              </p>
              <button
                className="primary"
                onClick={() =>
                  api("/restores/" + restore.id + "/commit", "POST", {})
                    .then(() => {
                      onNotice("恢复完成，请刷新工作区列表");
                      location.reload();
                    })
                    .catch(onError)
                }
              >
                {tr("确认恢复为新工作区")}
              </button>
            </div>
          )}
          <p className="muted">
            {tr(
              "恢复不会写回资料目录。恢复后可离线打开备份中的快照；没有快照的文件需要重新连接。",
            )}
          </p>
        </>
      )}
    </Modal>
  );
}
async function waitScan(id: string, progress?: (s: string) => void) {
  for (let i = 0; i < 1000; i++) {
    const j = await api("/scans/" + id);
    progress?.(`已扫描 ${j.processed} / ${j.discovered} 份文件`);
    if (j.state === "completed") return j;
    if (j.state === "failed" || j.state === "canceled")
      throw Error("扫描未完成，已有数据保留");
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error("扫描仍在后台执行，可稍后刷新");
}
function download(content: string, name: string, type: string) {
  downloadBlob(new Blob([content], { type }), name);
}
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
if (
  Capacitor.isNativePlatform() ||
  location.pathname === "/mobile" ||
  location.pathname === "/mobile/"
) {
  void import("./mobile/MobileApp").then(({ MobileApp }) =>
    createRoot(document.getElementById("root")!).render(<MobileApp />),
  );
} else {
  createRoot(document.getElementById("root")!).render(<App />);
}
