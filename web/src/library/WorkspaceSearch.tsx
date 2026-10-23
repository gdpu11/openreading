import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { api } from "../api";
import { tr } from "../i18n";
import { extractBookText, cacheSearchIndex } from "../readers/bookText";
export function WorkspaceSearch({
  workspace,
  onClose,
  onOpen,
}: {
  workspace: string;
  onClose: () => void;
  onOpen: (hit: any) => Promise<void>;
}) {
  const [query, setQuery] = useState(""),
    [items, setItems] = useState<any[]>([]),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [more, setMore] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const search = async (offset = 0) => {
    setError("");
    try {
      const result = await api(
        `/workspaces/${workspace}/search?q=${encodeURIComponent(query)}&offset=${offset}`,
      );
      setItems(offset ? [...items, ...result.items] : result.items);
      setMore(result.hasMore);
      setStatus(`${tr("已建立索引的书籍")} ${result.indexedBooks}`);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const index = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    const failures: string[] = [];
    try {
      const globalPreferences = await api("/preferences");
      let cursor = "",
        books: any[] = [];
      do {
        const result = await api(
          `/workspaces/${workspace}/documents?limit=500&cursor=${encodeURIComponent(cursor)}`,
          "GET",
          undefined,
          { signal: abort.signal },
        );
        books.push(...result.items);
        cursor = result.nextCursor;
      } while (cursor);
      for (let i = 0; i < books.length; i++) {
        abort.signal.throwIfAborted();
        const book = books[i],
          binding = book.bindings.find(
            (b: any) =>
              b.state === "active" &&
              b.sourceState === "active" &&
              b.bindingState === "active",
          ),
          title = book.bindings[0]?.relativePath || book.id;
        try {
          let prepared: any;
          if (binding)
            prepared = await api(
              `/documents/${book.documentId}/prepare`,
              "POST",
              {
                workspaceDocumentId: book.id,
                sourceEntryId: binding.id,
                purpose: "conversion",
              },
              { signal: abort.signal },
            );
          else {
            const versions = await api(
              `/documents/${book.documentId}/versions?workspaceDocumentId=${book.id}`,
            );
            if (!versions.length) throw Error("没有缓存");
            prepared = { version: versions[0] };
          }
          const doc = {
            ...prepared,
            workspaceDocumentId: book.id,
            format: book.format,
            title,
          };
          setStatus(`${i + 1}/${books.length} · ${title}`);
          const preferences = await api(`/documents/${book.id}/preferences`);
          const sections = await extractBookText(
            doc,
            preferences.data?.encoding || globalPreferences.encoding || "utf-8",
            abort.signal,
            (n) => setStatus(`${i + 1}/${books.length} · ${title} · ${n}`),
          );
          await cacheSearchIndex(doc, sections, abort.signal);
        } catch (e: any) {
          if (e.name === "AbortError") throw e;
          failures.push(title + ": " + e.message);
        }
      }
      setStatus(tr("索引已完成"));
      if (failures.length) setError(failures.join("\n"));
    } catch (e: any) {
      setError(
        e.name === "AbortError"
          ? tr("索引已停止，已完成的书籍保留")
          : e.message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="book-tools-panel"
      role="dialog"
      aria-label={tr("搜索整个书库")}
    >
      <header>
        <h3>{tr("搜索整个书库")}</h3>
        <button aria-label={tr("关闭阅读工具")} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <p>{tr("全文索引保存在本机。首次使用或原文更新后，请建立书库索引。")}</p>
      <div className="learning-search">
        <Search size={18} />
        <input
          aria-label={tr("书库全文关键词")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
        />
      </div>
      <button
        className="primary"
        disabled={!query.trim()}
        onClick={() => void search()}
      >
        {tr("搜索全文")}
      </button>
      <button disabled={busy} onClick={() => void index()}>
        {tr("建立或更新书库索引")}
      </button>
      {busy && (
        <button onClick={() => controller.current?.abort()}>
          {tr("停止索引")}
        </button>
      )}
      <p role="status">{status}</p>
      {error && (
        <p role="alert" style={{ whiteSpace: "pre-wrap" }}>
          {tr(error)}
        </p>
      )}
      {items.map((hit, i) => (
        <button
          className="search-hit"
          key={i}
          onClick={() =>
            void onOpen({
              ...hit,
              locator: { ...hit.locator, search: query },
            }).catch((e) => setError(e.message))
          }
        >
          <small>
            {hit.title} · {hit.label}
          </small>
          <p>{hit.snippet}</p>
        </button>
      ))}
      {more && (
        <button onClick={() => void search(items.length)}>
          {tr("加载更多")}
        </button>
      )}
    </section>
  );
}
