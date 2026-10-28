import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronRight,
  Laptop,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { tr } from "../i18n";
import type { Connection } from "./storage";
import { request } from "./sync";
type Book = {
  id: string;
  title: string;
  format: string;
  workspaceId: string;
  workspaceName: string;
  selected: boolean;
};
type Catalog = {
  items: Book[];
  workspaces: { id: string; name: string }[];
  total: number;
  offset: number;
  hasMore: boolean;
  revision: string;
};
export function ComputerLibrary({
  connection,
  downloaded,
  onReceive,
  receiving,
  progress,
  syncError,
  onLibrary,
}: {
  connection: Connection;
  downloaded: Set<string>;
  onReceive: () => Promise<boolean>;
  receiving: boolean;
  progress: string;
  syncError: string;
  onLibrary: () => void;
}) {
  const [query, setQuery] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [format, setFormat] = useState(""),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [chosen, setChosen] = useState<Map<string, Book>>(new Map()),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [submitted, setSubmitted] = useState(0),
    [received, setReceived] = useState(false);
  const run = useRef(0),
    alive = useRef(true),
    savingRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      run.current++;
    };
  }, []);
  async function load(offset = 0) {
    const current = ++run.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        q: query.trim(),
        workspace,
        format,
        offset: String(offset),
      });
      const result: Catalog = await request(
        connection,
        "/sync/catalog?" + params,
      );
      if (!alive.current || current !== run.current) return;
      setCatalog((previous) => ({
        ...result,
        items:
          offset && previous
            ? [...previous.items, ...result.items]
            : result.items,
      }));
    } catch (e: any) {
      if (alive.current && current === run.current)
        setError(
          e.status === 404 ? "电脑端版本较旧，请更新电脑端后再选书" : e.message,
        );
    } finally {
      if (alive.current && current === run.current) setLoading(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => {
      clearTimeout(timer);
      run.current++;
    };
  }, [query, workspace, format, connection.origin, connection.token]);
  async function receive() {
    const ok = await onReceive();
    if (alive.current) setReceived(ok);
  }
  async function submit() {
    if (!catalog || !chosen.size || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await request(connection, "/sync/catalog/select", {
        memberIds: [...chosen.keys()],
        expectedRevision: catalog.revision,
      });
      if (!alive.current) return;
      setSubmitted(chosen.size);
      setReceived(false);
      setChosen(new Map());
      await receive();
      if (alive.current) void load();
    } catch (e: any) {
      if (alive.current) {
        setError(e.message);
        if (e.status === 409) {
          void load();
          setError("电脑同步清单已更新，勾选已保留，请核对后再次同步");
        }
      }
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }
  const busy = saving || receiving;
  return (
    <div className="mobile-computer-library">
      <div className="mobile-computer-search">
        <Search size={18} />
        <input
          aria-label={tr("搜索电脑书库")}
          placeholder={tr("搜索电脑上的书名")}
          value={query}
          maxLength={100}
          disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load();
          }}
        />
        {query && (
          <button
            aria-label={tr("清空搜索")}
            disabled={busy}
            onClick={() => setQuery("")}
          >
            <X size={16} />
          </button>
        )}
      </div>
      <div className="mobile-catalog-filters">
        <select
          aria-label={tr("筛选电脑工作区")}
          value={workspace}
          disabled={busy}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          <option value="">{tr("全部授权工作区")}</option>
          {catalog?.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <select
          aria-label={tr("筛选电脑书籍格式")}
          value={format}
          disabled={busy}
          onChange={(e) => setFormat(e.target.value)}
        >
          <option value="">{tr("全部格式")}</option>
          {[
            "epub",
            "pdf",
            "mobi",
            "azw3",
            "txt",
            "markdown",
            "docx",
            "html",
            "rtf",
          ].map((v) => (
            <option key={v} value={v}>
              {v.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <p className="mobile-catalog-intro">
        <Laptop size={14} />
        {tr("只浏览书目，勾选后才下载到手机")}
      </p>
      {submitted > 0 && (
        <div className="mobile-catalog-receipt" role="status">
          <strong>
            {tr(received ? "已接收所选书籍" : "已加入同步清单")} · {submitted}
          </strong>
          <p>
            {tr(
              busy
                ? progress
                : syncError ||
                    (received
                      ? "可以回书架离线阅读了"
                      : "可继续接收，已下载内容会保留"),
            )}
          </p>
          {received ? (
            <button onClick={onLibrary}>
              {tr("去书架阅读")}
              <ChevronRight size={16} />
            </button>
          ) : (
            <button disabled={busy} onClick={() => void receive()}>
              <RefreshCw size={16} className={busy ? "spinning" : ""} />
              {tr(busy ? "正在接收…" : "继续接收")}
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="mobile-catalog-error" role="alert">
          <p>{tr(error)}</p>
          <button disabled={busy || loading} onClick={() => void load()}>
            {tr("重新加载电脑书库")}
          </button>
        </div>
      )}
      <div className="mobile-catalog-count" aria-live="polite">
        {loading
          ? tr("正在搜索电脑书库…")
          : catalog
            ? `${catalog.total} ${tr("本书籍")}`
            : ""}
      </div>
      <div className="mobile-catalog-list" aria-busy={loading}>
        {catalog?.items.map((book) => (
          <label className="mobile-catalog-book" key={book.id}>
            <span className={"mobile-catalog-cover format-" + book.format}>
              <BookOpen size={23} />
              <small>{book.format === "markdown" ? "MD" : book.format.toUpperCase()}</small>
            </span>
            <span className="mobile-catalog-book-info">
              <strong>{book.title.replace(/\.[^.]+$/, "")}</strong>
              <small>
                {book.workspaceName} · {book.format.toUpperCase()}
              </small>
              <em>
                {tr(
                  downloaded.has(book.id)
                    ? "已在手机"
                    : book.selected
                      ? "已在同步清单"
                      : "在电脑上",
                )}
              </em>
            </span>
            <input
              type="checkbox"
              aria-label={tr("同步书籍") + " " + book.title}
              checked={chosen.has(book.id)}
              disabled={busy || (!chosen.has(book.id) && chosen.size >= 500)}
              onChange={(e) => {
                const checked = e.target.checked;
                setChosen((previous) => {
                  const next = new Map(previous);
                  if (checked) next.set(book.id, book);
                  else next.delete(book.id);
                  return next;
                });
              }}
            />
          </label>
        ))}
      </div>
      {!loading && !error && catalog?.total === 0 && (
        <div className="mobile-catalog-empty">
          <Search size={32} />
          <h3>{tr(query ? "没有匹配的书籍" : "这里还没有书籍")}</h3>
          <p>
            {tr(
              query
                ? "试试书名中的其他关键词"
                : "请在电脑端导入书籍，并确认手机获授权的工作区",
            )}
          </p>
        </div>
      )}
      {catalog?.hasMore && (
        <button
          className="mobile-catalog-more"
          disabled={loading || busy}
          onClick={() => void load(catalog.items.length)}
        >
          {tr(loading ? "正在加载…" : "加载更多书籍")}
        </button>
      )}
      <div className="mobile-catalog-selection">
        <div>
          <strong>
            {tr("已选")} {chosen.size} {tr("本")}
          </strong>
          <button
            disabled={!chosen.size || busy}
            onClick={() => setChosen(new Map())}
          >
            {tr("清空勾选")}
          </button>
        </div>
        <button
          className="primary"
          disabled={!chosen.size || busy || loading}
          onClick={() => void submit()}
        >
          {busy ? (
            <RefreshCw size={17} className="spinning" />
          ) : (
            <Check size={17} />
          )}{" "}
          {tr(busy ? "正在同步…" : "同步到手机")}
        </button>
      </div>
    </div>
  );
}
