import { useState, type ReactNode, type HTMLAttributes } from "react";
import {
  Folder,
  FolderPlus,
  Search,
  RefreshCw,
  Upload,
  Star,
  BookCheck,
  Trash2,
} from "lucide-react";
import { tr } from "../i18n";
import type { ReaderPreferences } from "../readers/types";
import {
  DocumentFormatFilter,
  type DocumentFormat,
} from "./DocumentFormatFilter";
import { BookFilters } from "./BookFilters";
import { BookCover } from "./BookCover";
import type { BookFilter } from "./BookContextMenu";
import { DocumentSort } from "./DocumentSort";
export function LibraryShelf({
  books,
  cursor,
  search,
  onSearch,
  sort,
  onSort,
  sourceManager,
  sourceCount,
  refresh,
  importFiles,
  addSource,
  loadMore,
  open,
  filter,
  onFilter,
  bookMenuProps,
  format,
  onFormat,
}: {
  format: DocumentFormat;
  onFormat: (format: DocumentFormat) => void;
  filter: BookFilter;
  onFilter: (filter: BookFilter) => void;
  bookMenuProps: (book: any) => HTMLAttributes<HTMLElement>;
  books: any[];
  cursor: string;
  search: string;
  onSearch: (value: string) => void;
  sort: ReaderPreferences["documentSort"];
  onSort: (value: ReaderPreferences["documentSort"]) => void;
  sourceManager: ReactNode;
  sourceCount: number;
  refresh: () => Promise<void>;
  importFiles: () => void;
  addSource: () => void;
  loadMore: () => void;
  open: (book: any) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <section className="desktop-library">
      <div className="library-heading">
        <div>
          <h1>{tr("书库")}</h1>
          <p>{tr("独立窗口阅读，多本书并排对照。")}</p>
        </div>
        <button className="primary" onClick={importFiles}>
          <Upload size={16} />
          {tr("导入阅读资料")}
        </button>
      </div>
      <div className="library-toolbar">
        <label className="library-search">
          <Search size={17} />
          <input
            type="search"
            aria-label={tr("搜索文件名")}
            placeholder={tr("搜索书籍或文件")}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>
        <div className="library-tools">
          <details
            className="library-sources"
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.open = false;
            }}
          >
            <summary>
              <Folder size={16} />
              {tr("来源")} <span>{sourceCount}</span>
            </summary>
            <div className="library-sources-panel">
              <h3>{tr("已连接来源")}</h3>
              {sourceManager}
              <button className="secondary" onClick={addSource}>
                <FolderPlus size={15} />
                {tr("添加文件夹")}
              </button>
            </div>
          </details>
          <button
            title={tr("刷新来源")}
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                await refresh();
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <RefreshCw size={16} className={refreshing ? "spinning" : ""} />
            <span>{tr("刷新")}</span>
          </button>
          <DocumentSort value={sort} onChange={onSort} />
          <DocumentFormatFilter value={format} onChange={onFormat} />
        </div>
      </div>
      <BookFilters value={filter} onChange={onFilter} />
      <div className="library-count">
        {books.length}
        {cursor ? "+" : ""} {tr("本资料")}
      </div>
      <div className="library-grid">
        {books.map((book) => {
          const title =
            book.bindings[0]?.relativePath?.split("/").pop() || tr("历史文档");
          return (
            <button
              className="library-book"
              key={book.id}
              title={title}
              {...bookMenuProps(book)}
              onClick={() => {
                if (!book.removedAt) open(book);
              }}
            >
              <BookCover book={book} title={title} />
              <span className="library-book-status">
                {!!book.favorite && (
                  <span aria-label={tr("已收藏")} title={tr("已收藏")}>
                    <Star size={12} fill="currentColor" />
                  </span>
                )}
                {!!book.finishedAt && (
                  <span aria-label={tr("已读完")} title={tr("已读完")}>
                    <BookCheck size={12} />
                  </span>
                )}
                {!!book.removedAt && (
                  <span aria-label={tr("已删除")} title={tr("已删除")}>
                    <Trash2 size={12} />
                  </span>
                )}
              </span>
              <strong>{title}</strong>
              <small>
                {book.bindings[0]?.sourceLabel} · {book.format.toUpperCase()}
              </small>
            </button>
          );
        })}
      </div>
      {!books.length && (
        <div className="library-empty">
          <h2>
            {tr(
              search
                ? "没有找到匹配的书籍"
                : filter === "all"
                  ? "书库还是空的"
                  : "此分类暂无书籍",
            )}
          </h2>
          <p>
            {tr(
              search
                ? "换个关键词试试。"
                : filter === "removed"
                  ? "删除的书籍会保留在这里，右键即可恢复。"
                  : filter === "all"
                    ? "导入文件或连接资料文件夹，开始阅读。"
                    : "右键点击书籍，可以收藏或标记为已读完。",
            )}
          </p>
          {!search && filter === "all" && (
            <button className="secondary" onClick={addSource}>
              <FolderPlus size={16} />
              {tr("添加文件夹")}
            </button>
          )}
        </div>
      )}
      {cursor && (
        <button className="load-more" onClick={loadMore}>
          {tr("加载更多")}
        </button>
      )}
    </section>
  );
}
