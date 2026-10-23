import { useEffect, useRef, useState } from "react";
import type { Captured, OutlineItem, Prepared, ReaderAdapter } from "./types";
import { api, uid } from "../api";
import { tr } from "../i18n";
import {
  Search,
  Bookmark,
  List,
  History,
  Volume2,
  ScanText,
  X,
  ArrowLeft,
  ArrowRight,
  MessageCircle,
} from "lucide-react";
import {
  extractBookText,
  findInSections,
  cacheSearchIndex,
  type TextSection,
  type SearchHit,
} from "./bookText";
export function localReadingVoice(
  voices: SpeechSynthesisVoice[],
  language: string,
) {
  const local = voices.filter((voice) => voice.localService);
  return (
    local.find(
      (voice) => voice.lang.toLowerCase() === language.toLowerCase(),
    ) ||
    local.find((voice) =>
      voice.lang
        .toLowerCase()
        .startsWith(language.split("-")[0].toLowerCase() + "-"),
    )
  );
}
export function BookTools({
  doc,
  reader,
  outline = [],
  encoding = "utf-8",
  mobile = false,
  onAsk,
  onError,
}: {
  doc: Prepared;
  reader: React.RefObject<ReaderAdapter | null>;
  outline?: OutlineItem[];
  encoding?: string;
  mobile?: boolean;
  onAsk?: (s: Captured) => void;
  onError: (message: string) => void;
}) {
  const [panel, setPanel] = useState(""),
    [query, setQuery] = useState(""),
    [sections, setSections] = useState<TextSection[]>([]),
    [hits, setHits] = useState<SearchHit[]>([]),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [marks, setMarks] = useState<any[]>([]),
    [history, setHistory] = useState<any[]>([]),
    [speaking, setSpeaking] = useState(false),
    [rate, setRate] = useState(1),
    [ocr, setOCR] = useState(""),
    [error, setError] = useState(""),
    [activeHit, setActiveHit] = useState(-1);
  const controller = useRef<AbortController | null>(null),
    searchRun = useRef(0),
    currentBook = useRef(doc.version.id),
    speechRun = useRef(0);
  currentBook.current = doc.version.id;
  useEffect(() => {
    window.speechSynthesis?.getVoices();
    setPanel("");
    setSections([]);
    setHits([]);
    setHistory([]);
    setOCR("");
    setError("");
    setSpeaking(false);
    setBusy(false);
    setActiveHit(-1);
    return () => {
      controller.current?.abort();
      speechRun.current++;
      window.speechSynthesis?.cancel();
    };
  }, [doc.workspaceDocumentId, doc.version.id, encoding]);
  const perform = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setError(e.message);
        onError(e.message);
      }
    }
  };
  const go = async (locator: any) => {
    const old = reader.current?.getLocation();
    await reader.current?.navigateLocation(locator);
    if (old && Object.keys(old).length)
      setHistory((v) => [...v.slice(-49), old]);
  };
  const search = async () => {
    if (!query.trim() || busy) return;
    const run = ++searchRun.current,
      version = doc.version.id;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    await perform(async () => {
      const indexed = sections.length
        ? sections
        : await extractBookText(doc, encoding, abort.signal, setProgress);
      abort.signal.throwIfAborted();
      if (run !== searchRun.current || currentBook.current !== version) return;
      setSections(indexed);
      setHits(findInSections(indexed, query));
      setActiveHit(-1);
      if (!mobile) await cacheSearchIndex(doc, indexed, abort.signal);
    });
    if (run === searchRun.current && currentBook.current === version)
      setBusy(false);
  };
  const openBookmarks = () => {
    setPanel("bookmarks");
    void perform(async () =>
      setMarks(await api(`/documents/${doc.workspaceDocumentId}/bookmarks`)),
    );
  };
  const readAloud = () => {
    if (!window.speechSynthesis) {
      setError(tr("此设备不支持朗读"));
      return;
    }
    const run = ++speechRun.current;
    window.speechSynthesis.cancel();
    const text = reader.current?.sectionText() || ocr;
    if (!text.trim()) {
      setError(tr("此页没有文字，请先使用 OCR"));
      return;
    }
    const language = /[\u3400-\u9fff]/.test(text) ? "zh-CN" : "en-US";
    const voice = localReadingVoice(
      window.speechSynthesis.getVoices(),
      language,
    );
    if (!voice) {
      setError(tr("本机语音暂不可用，请稍后重试或安装对应语言的系统语音。"));
      return;
    }
    const sentences =
      text.match(/[\s\S]{1,220}[。！？.!?\n]|[\s\S]{1,220}/g) || [];
    let i = 0;
    setSpeaking(true);
    const next = () => {
      if (run !== speechRun.current) return;
      if (i >= sentences.length) {
        setSpeaking(false);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(sentences[i++]);
      utterance.lang = language;
      utterance.voice = voice;
      utterance.rate = rate;
      utterance.onend = next;
      utterance.onerror = (event) => {
        if (
          run !== speechRun.current ||
          event.error === "canceled" ||
          event.error === "interrupted"
        )
          return;
        setSpeaking(false);
        setError(tr("朗读失败，请检查系统语音设置"));
      };
      window.speechSynthesis.speak(utterance);
    };
    next();
  };
  const close = () => {
    setPanel("");
    controller.current?.abort();
    setBusy(false);
  };
  const location = reader.current?.getLocation();
  const currentChapter = outline.findIndex((item) =>
    item.locator.href
      ? item.locator.href.split("#")[0] === location?.href?.split("#")[0]
      : item.locator.pageIndex !== undefined &&
        item.locator.pageIndex === location?.pageIndex,
  );
  const controls: [string, any, string, () => void][] = [
    ["search", Search, "全书搜索", () => setPanel("search")],
    ...(mobile
      ? ([["outline", List, "目录", () => setPanel("outline")]] as [
          string,
          any,
          string,
          () => void,
        ][])
      : []),
    ["bookmarks", Bookmark, "书签", openBookmarks],
    [
      "history",
      History,
      "位置历史",
      () => {
        setHistory(reader.current?.getHistory() || []);
        setPanel("history");
      },
    ],
    ["speech", Volume2, "朗读", () => setPanel("speech")],
    ...(doc.format === "pdf"
      ? ([["ocr", ScanText, "识别本页文字", () => setPanel("ocr")]] as [
          string,
          any,
          string,
          () => void,
        ][])
      : []),
  ];
  return (
    <div className={"book-tools" + (mobile ? " mobile-book-tools" : "")}>
      {controls.map(([key, Icon, label, action]) => (
        <button
          key={key}
          aria-label={tr(label)}
          title={tr(label)}
          onClick={action}
        >
          <Icon size={18} />
          {mobile && (
            <span>
              {tr(
                label === "识别本页文字"
                  ? "识别"
                  : label === "全书搜索"
                    ? "搜索"
                    : label === "位置历史"
                      ? "历史"
                      : label,
              )}
            </span>
          )}
        </button>
      ))}
      {onAsk && (
        <button
          aria-label={tr("问本节")}
          title={tr("把当前页或章节作为提问材料")}
          onClick={() =>
            void perform(async () => {
              const captured = await reader.current?.captureSection();
              if (!captured) throw Error("当前页没有可选文字");
              onAsk(captured);
            })
          }
        >
          <MessageCircle size={18} />
          {mobile && <span>{tr("问本节")}</span>}
        </button>
      )}
      {panel && (
        <section
          className="book-tools-panel"
          role="dialog"
          aria-label={tr(
            controls.find(([key]) => key === panel)?.[2] || "阅读工具",
          )}
        >
          <header>
            <h3>
              {tr(controls.find(([key]) => key === panel)?.[2] || "阅读工具")}
            </h3>
            <button aria-label={tr("关闭阅读工具")} onClick={close}>
              <X size={19} />
            </button>
          </header>
          {error && <p role="alert">{tr(error)}</p>}
          {panel === "search" && (
            <>
              <p className="muted">{tr("搜索整本书，扫描页需先识别文字。")}</p>
              <div className="learning-search">
                <Search size={17} />
                <input
                  autoFocus
                  aria-label={tr("全书关键词")}
                  placeholder={tr("输入关键词")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void search();
                  }}
                />
              </div>
              <button
                className="primary"
                disabled={busy || !query.trim()}
                onClick={() => void search()}
              >
                {busy ? tr("正在搜索…") + " " + progress : tr("搜索整本书")}
              </button>
              <p role="status">
                {tr("匹配结果")} {hits.length}
                {hits.length === 1000 ? "+" : ""}
              </p>
              {hits.length > 0 && (
                <div className="book-tools">
                  <button
                    aria-label={tr("上一个结果")}
                    onClick={() => {
                      const at = (activeHit - 1 + hits.length) % hits.length;
                      setActiveHit(at);
                      void perform(() => go(hits[at].locator));
                    }}
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <span>
                    {activeHit + 1}/{hits.length}
                  </span>
                  <button
                    aria-label={tr("下一个结果")}
                    onClick={() => {
                      const at = (activeHit + 1) % hits.length;
                      setActiveHit(at);
                      void perform(() => go(hits[at].locator));
                    }}
                  >
                    <ArrowRight size={16} />
                  </button>
                </div>
              )}
              {hits.map((hit, i) => (
                <button
                  className="search-hit"
                  key={i}
                  onClick={() =>
                    void perform(async () => {
                      setActiveHit(i);
                      await go(hit.locator);
                    })
                  }
                >
                  <small>{hit.label}</small>
                  <p>{hit.snippet}</p>
                </button>
              ))}
            </>
          )}
          {panel === "outline" && (
            <>
              {outline.length ? (
                outline.map((o, i) => (
                  <button
                    aria-current={i === currentChapter ? "location" : undefined}
                    className="search-hit"
                    key={i}
                    onClick={() =>
                      void perform(async () => {
                        await go(o.locator);
                        close();
                      })
                    }
                  >
                    {o.label}
                  </button>
                ))
              ) : (
                <p>{tr("本书没有目录")}</p>
              )}
            </>
          )}
          {panel === "history" && (
            <>
              {history.length ? (
                [...history].reverse().map((loc, i) => (
                  <button
                    className="search-hit"
                    key={i}
                    onClick={() =>
                      void perform(async () => {
                        await reader.current?.navigateLocation(loc);
                        close();
                      })
                    }
                  >
                    {loc.pageIndex !== undefined
                      ? `${loc.pageIndex + 1}`
                      : loc.href ||
                        loc.cfi ||
                        `${Math.round(loc.scrollTop || 0)}px`}
                  </button>
                ))
              ) : (
                <p>{tr("从目录、搜索或书签跳转后，可在这里返回原位置。")}</p>
              )}
            </>
          )}
          {panel === "bookmarks" && (
            <>
              <button
                className="primary"
                onClick={() =>
                  void perform(async () => {
                    const title = window.prompt(
                      tr("书签名称"),
                      doc.title.replace(/\.[^.]+$/, ""),
                    );
                    if (!title?.trim()) return;
                    await api(
                      `/documents/${doc.workspaceDocumentId}/bookmarks`,
                      "POST",
                      {
                        title,
                        versionId: doc.version.id,
                        locator: reader.current?.getLocation(),
                        clientRequestId: uid(),
                      },
                    );
                    setMarks(
                      await api(
                        `/documents/${doc.workspaceDocumentId}/bookmarks`,
                      ),
                    );
                  })
                }
              >
                {tr("收藏当前位置")}
              </button>
              {marks.map((m) => (
                <div className="learning-card" key={m.id}>
                  <button
                    className="search-hit"
                    onClick={() =>
                      void perform(async () => {
                        if (m.versionId !== doc.version.id)
                          throw Error("书签属于历史版本，请先切换到对应版本");
                        await go(m.locator);
                        close();
                      })
                    }
                  >
                    {m.title}
                  </button>
                  <button
                    onClick={() =>
                      void perform(async () => {
                        await api(
                          `/documents/${doc.workspaceDocumentId}/bookmarks/${m.id}`,
                          "DELETE",
                        );
                        setMarks(
                          await api(
                            `/documents/${doc.workspaceDocumentId}/bookmarks`,
                          ),
                        );
                      })
                    }
                  >
                    {tr("删除书签")}
                  </button>
                </div>
              ))}
            </>
          )}
          {panel === "speech" && (
            <>
              <p>{tr("朗读当前页或章节，使用系统已安装的语音。")}</p>
              <label>
                {tr("语速")}
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={rate}
                  onChange={(e) => setRate(Number(e.target.value))}
                />
                {rate}×
              </label>
              <button className="primary" onClick={readAloud}>
                {tr(speaking ? "重新朗读" : "开始朗读")}
              </button>
              <button onClick={() => window.speechSynthesis?.pause()}>
                {tr("暂停")}
              </button>
              <button onClick={() => window.speechSynthesis?.resume()}>
                {tr("继续")}
              </button>
              <button
                onClick={() => {
                  speechRun.current++;
                  window.speechSynthesis?.cancel();
                  setSpeaking(false);
                }}
              >
                {tr("停止")}
              </button>
            </>
          )}
          {panel === "ocr" && (
            <>
              <p>
                {tr(
                  "在本机识别当前 PDF 页；识别结果可复制或保存为独立笔记，不改写原文件。",
                )}
              </p>
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void perform(async () => {
                    const locator = reader.current!.getLocation();
                    const image = await reader.current!.pageImage();
                    const desktop = window.openReadingDesktop;
                    if (!desktop?.recognizePage)
                      throw Error(
                        "OCR 需要桌面端，本机需安装 Tesseract 或使用 macOS 视觉识别",
                      );
                    const text = await desktop.recognizePage(image);
                    setOCR(text);
                    if (!text.trim()) throw Error("本页没有识别到文字");
                    await api(
                      `/documents/${doc.workspaceDocumentId}/recognized-pages`,
                      "PUT",
                      {
                        versionId: doc.version.id,
                        pageIndex: locator.pageIndex,
                        text,
                      },
                    );
                    setSections([]);
                  }).finally(() => setBusy(false));
                }}
              >
                {tr(busy ? "正在识别…" : "识别本页")}
              </button>
              <textarea
                aria-label={tr("OCR 识别结果")}
                value={ocr}
                onChange={(e) => setOCR(e.target.value)}
              />
              <button
                disabled={!ocr}
                onClick={() =>
                  void perform(async () => {
                    await navigator.clipboard.writeText(ocr);
                  })
                }
              >
                {tr("复制文字")}
              </button>
              {ocr && (
                <button
                  onClick={() => {
                    const blob = new Blob([ocr], {
                        type: "text/plain;charset=utf-8",
                      }),
                      url = URL.createObjectURL(blob),
                      a = document.createElement("a");
                    a.href = url;
                    a.download = doc.title + "-OCR.txt";
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  {tr("保存识别文本")}
                </button>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
