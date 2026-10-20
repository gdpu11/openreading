import { useEffect, useState } from "react";
import { api } from "../api";
import { tr } from "../i18n";
export function DeleteBookDialog({
  book,
  close,
  done,
}: {
  book: any;
  close: () => void;
  done: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<any>(null),
    [mode, setMode] = useState("library"),
    [file, setFile] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    api(`/documents/${book.id}/deletion-preview`, "GET", undefined, {
      signal: abort.signal,
    })
      .then((p) => {
        setPreview(p);
        setFile(p.files[0]?.sourceEntryId || "");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [book.id]);
  return (
    <div className="modal-backdrop">
      <section
        className="modal book-operation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tr("删除书籍")}
      >
        <h2>{tr("删除书籍")}</h2>
        <p className="book-operation-title">
          {book.bindings[0]?.relativePath?.split("/").pop()}
        </p>
        <label className="operation-choice">
          <input
            type="radio"
            name="delete-mode"
            checked={mode === "library"}
            onChange={() => setMode("library")}
          />
          <span>
            {tr("仅从当前书库移除")}
            <small>
              {tr("保留原始文件、笔记和阅读记录，可在已删除中恢复。")}
            </small>
          </span>
        </label>
        <label className="operation-choice">
          <input
            type="radio"
            name="delete-mode"
            checked={mode === "original"}
            disabled={!preview?.files.length}
            onChange={() => setMode("original")}
          />
          <span>
            {tr("删除原始文件")}
            <small>
              {tr("永久删除所选原始文件，并移出当前书库；笔记和已有快照保留。")}
            </small>
          </span>
        </label>
        {preview && !preview.files.length && (
          <small>
            {tr("原始文件不可用，或当前不是本机书库，只能移出书库。")}
          </small>
        )}
        {mode === "original" && (
          <>
            <select
              aria-label={tr("要删除的原始文件")}
              value={file}
              onChange={(e) => setFile(e.target.value)}
            >
              {preview.files.map((f: any) => (
                <option key={f.sourceEntryId} value={f.sourceEntryId}>
                  {f.sourceLabel} / {f.relativePath}
                </option>
              ))}
            </select>
            <p className="error">
              {tr("原始文件删除后，恢复书库不会还原原始文件。")}
            </p>
            <small>{tr("其他书库若连接同一文件，也会失去原始来源。")}</small>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {tr(error)}
          </p>
        )}
        <div className="modal-actions">
          <button disabled={busy} onClick={close}>
            {tr("取消")}
          </button>
          <button
            className={mode === "original" ? "primary danger" : "primary"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const selected = preview?.files.find(
                  (f: any) => f.sourceEntryId === file,
                );
                await api(
                  `/documents/${book.id}?mode=${mode}`,
                  "DELETE",
                  mode === "original"
                    ? {
                        confirm: "delete-original",
                        sourceEntryId: file,
                        fingerprint: selected?.fingerprint,
                      }
                    : undefined,
                );
                await done();
                close();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {tr(
              busy
                ? "正在删除…"
                : mode === "original"
                  ? "删除原始文件"
                  : "移出当前书库",
            )}
          </button>
        </div>
      </section>
    </div>
  );
}
