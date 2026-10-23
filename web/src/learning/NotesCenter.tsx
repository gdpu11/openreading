import { saveExport } from "../ord";
import { Capacitor } from "@capacitor/core";
import { useState } from "react";
import {
  Search,
  ArrowUpRight,
  Check,
  RotateCcw,
  Download,
  Tag,
  BookOpen,
} from "lucide-react";
import { tr } from "../i18n";

export function noteText(note: any) {
  return [
    note.title,
    note.anchor?.quote?.visible,
    ...(note.tags || []),
    ...(note.messages || []).map((m: any) => m.body),
  ].join("\n");
}
export function notesMarkdown(
  notes: any[],
  base = window.openReadingDesktop || Capacitor.isNativePlatform()
    ? "openreading://read"
    : location.origin + "/",
) {
  return notes
    .map((n: any) => {
      const link = `${base}?workspace=${encodeURIComponent(n.workspaceId || n.anchor.workspaceId || "")}&book=${encodeURIComponent(n.workspaceDocumentId)}&thread=${encodeURIComponent(n.threadId)}`;
      return `## ${n.title || tr("阅读笔记")}\n\n<!-- openreading:${n.threadId} -->\n[${tr("返回原文")}](${link}) · ${n.anchor?.displayLocation?.label || ""}\n\n${(n.tags || []).map((t: string) => "#" + t).join(" ")}\n\n> ${(n.anchor?.quote?.visible || "").replace(/\n/g, "\n> ")}\n\n${(n.messages || []).map((m: any) => `### ${m.role === "assistant" ? tr("小阅") : tr("我的理解")}\n\n${m.body}`).join("\n\n")}`;
    })
    .join("\n\n---\n\n");
}
export async function downloadNotes(notes: any[]) {
  await saveExport(
    new Blob([notesMarkdown(notes)], { type: "text/markdown;charset=utf-8" }),
    "Open-Reading-notes",
    "md",
  );
}
export function NotesCenter({
  notes,
  onOpen,
  onSave,
  onAsk,
  onEdit,
}: {
  notes: any[];
  onOpen: (n: any) => Promise<void> | void;
  onSave: (n: any, changes: any) => Promise<void>;
  onAsk?: (notes: any[]) => void;
  onEdit?: (note: any, message: any) => void;
}) {
  const [query, setQuery] = useState(""),
    [tag, setTag] = useState(""),
    [mode, setMode] = useState("all"),
    [revealed, setRevealed] = useState<string[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const tags = [...new Set<string>(notes.flatMap((n) => n.tags || []))].sort();
  const due = (n: any) => !!n.dueAt && Date.parse(n.dueAt) <= Date.now();
  const visible = notes.filter(
    (n) =>
      (!query ||
        noteText(n).toLocaleLowerCase().includes(query.toLocaleLowerCase())) &&
      (!tag || n.tags?.includes(tag)) &&
      (mode === "review" ? due(n) : mode === "all" || n.learningState === mode),
  );
  const save = async (n: any, changes: any) => {
    setBusy(n.threadId);
    setError("");
    try {
      await onSave(n, { revision: n.learningRevision || 0, ...changes });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="notes-center" aria-label={tr("笔记与复习")}>
      <div className="learning-heading">
        <div>
          <small>{tr("让阅读留下来")}</small>
          <h1>{tr("笔记与复习")}</h1>
        </div>
        <button
          onClick={() =>
            void downloadNotes(visible).catch((e) => setError(e.message))
          }
        >
          <Download size={17} />
          {tr("导出当前结果")}
        </button>
      </div>
      <div className="learning-search">
        <Search size={18} />
        <input
          aria-label={tr("搜索笔记与讨论")}
          placeholder={tr("搜索划线、笔记与 AI 回答")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="learning-filters">
        {[
          ["all", "全部"],
          ["review", `今日复习 (${notes.filter(due).length})`],
          ["待理解", "待理解"],
          ["已理解", "已理解"],
          ["待复习", "待复习"],
        ].map(([key, text]) => (
          <button
            key={key}
            aria-pressed={mode === key}
            onClick={() => setMode(key)}
          >
            {tr(text)}
          </button>
        ))}
        <select
          aria-label={tr("标签筛选")}
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        >
          <option value="">{tr("全部标签")}</option>
          {tags.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      {onAsk && selected.length > 0 && (
        <button
          className="primary"
          onClick={() =>
            onAsk(notes.filter((n) => selected.includes(n.threadId)))
          }
        >
          {tr("用所选笔记问小阅")} ({selected.length})
        </button>
      )}
      {error && <p role="alert">{tr(error)}</p>}
      {!visible.length && (
        <div className="learning-empty">
          <BookOpen size={32} />
          <h3>
            {tr(mode === "review" ? "今天的复习已完成" : "还没有匹配的笔记")}
          </h3>
          <p>
            {tr(
              mode === "review"
                ? "把值得记住的笔记加入复习，在这里回顾。"
                : "阅读时留下划线和自己的理解。",
            )}
          </p>
        </div>
      )}
      {visible.map((n) => {
        const show = mode !== "review" || revealed.includes(n.threadId);
        return (
          <article className="learning-card" key={n.threadId}>
            <div className="learning-card-meta">
              <span>
                {n.title?.split("/").pop()} · {n.anchor?.displayLocation?.label}
              </span>
              {onAsk && (
                <input
                  type="checkbox"
                  aria-label={tr("选择笔记") + " " + n.threadId}
                  checked={selected.includes(n.threadId)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, n.threadId]
                        : selected.filter((id) => id !== n.threadId),
                    )
                  }
                />
              )}
            </div>
            <button className="learning-quote" onClick={() => void onOpen(n)}>
              <blockquote>
                {n.anchor?.quote?.visible || tr("页级笔记")}
              </blockquote>
              <ArrowUpRight size={16} />
            </button>
            {!show ? (
              <button
                className="review-reveal"
                onClick={() => setRevealed([...revealed, n.threadId])}
              >
                {tr("先回想一下，再查看理解")}
              </button>
            ) : (
              <div className="learning-messages">
                {n.messages?.map((m: any) => (
                  <div key={m.id}>
                    <small>
                      {tr(m.role === "assistant" ? "小阅" : "我的理解")}
                    </small>
                    <p>{m.body}</p>
                    {onEdit && m.role === "user" && m.recipient === "note" && (
                      <button onClick={() => onEdit(n, m)}>
                        {tr("修改笔记")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="learning-tags">
              {(n.tags || []).map((t: string) => (
                <button key={t} onClick={() => setTag(t)}>
                  #{t}
                </button>
              ))}
              <button
                disabled={!!busy}
                onClick={() => {
                  const value = window.prompt(
                    tr("用逗号分隔标签"),
                    (n.tags || []).join(", "),
                  );
                  if (value !== null)
                    void save(n, {
                      tags: value
                        .split(/[,，]/)
                        .map((v) => v.trim())
                        .filter(Boolean),
                    });
                }}
              >
                <Tag size={14} />
                {tr("标签")}
              </button>
            </div>
            <div className="learning-card-actions">
              {mode === "review" && show ? (
                <>
                  {[
                    ["again", "再想想"],
                    ["good", "记住了"],
                    ["easy", "很熟悉"],
                  ].map(([outcome, text]) => (
                    <button
                      key={outcome}
                      disabled={!!busy}
                      onClick={() => void save(n, { outcome })}
                    >
                      <Check size={14} />
                      {tr(text)}
                    </button>
                  ))}
                </>
              ) : (
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void save(n, { outcome: n.dueAt ? "pause" : "schedule" })
                  }
                >
                  <RotateCcw size={14} />
                  {tr(n.dueAt ? "暂停复习" : "加入复习")}
                </button>
              )}
              <span>{n.dueAt && new Date(n.dueAt).toLocaleDateString()}</span>
            </div>
          </article>
        );
      })}
    </section>
  );
}
