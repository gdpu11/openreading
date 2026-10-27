import { bookFormats } from "../formats";
import { useState } from "react";
import { tr } from "../i18n";
import {
  syncFileSelected,
  selectSyncFiles,
  type SyncScope,
  type SyncSelection,
  type SyncFile,
} from "./selection";
export type { SyncScope, SyncSelection, SyncFile } from "./selection";
const formats = bookFormats.map(([kind]) => kind);
const formatName = (format: string) =>
  format === "markdown" ? "Markdown" : format.toUpperCase();
export const validSelection = (value: SyncSelection) =>
  value.workspaceIds.length > 0 &&
  (value.syncScope.mode === "all" ||
    (value.syncScope.mode === "formats"
      ? !!value.syncScope.formats?.length
      : true));

export function SyncScopePicker({
  workspaces,
  files,
  value,
  onChange,
  disabled = false,
}: {
  workspaces: { id: string; name: string }[];
  files: SyncFile[];
  value: SyncSelection;
  onChange: (value: SyncSelection) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("");
  const { workspaceIds, syncScope: scope } = value;
  const available = files.filter((f) => workspaceIds.includes(f.workspaceId));
  const visible = available.filter(
    (f) =>
      (!filter || f.format === filter) &&
      f.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const members = scope.memberIds || [];
  const selected = available.filter((f) => syncFileSelected(value, f));
  const changeScope = (syncScope: SyncScope) =>
    onChange({ ...value, syncScope });
  return (
    <fieldset className="sync-scope" disabled={disabled}>
      <legend>{tr("允许这部手机同步的工作区")}</legend>
      <div role="group" aria-label={tr("允许这部手机同步的工作区")}>
        {workspaces.map((ws) => (
          <label className="sync-workspace" key={ws.id}>
            <input
              type="checkbox"
              checked={workspaceIds.includes(ws.id)}
              onChange={(e) => {
                const ids = e.target.checked
                  ? [...workspaceIds, ws.id]
                  : workspaceIds.filter((id) => id !== ws.id);
                onChange({
                  workspaceIds: ids,
                  syncScope: {
                    ...scope,
                    workspaceIds: scope.workspaceIds?.filter((id) =>
                      ids.includes(id),
                    ),
                    folders: scope.folders?.filter((folder) =>
                      ids.includes(folder.workspaceId),
                    ),
                    excludedMemberIds: scope.excludedMemberIds?.filter((id) =>
                      files.some(
                        (f) => f.id === id && ids.includes(f.workspaceId),
                      ),
                    ),
                    memberIds: members.filter((id) =>
                      files.some(
                        (f) => f.id === id && ids.includes(f.workspaceId),
                      ),
                    ),
                  },
                });
              }}
            />
            {ws.name}
          </label>
        ))}
      </div>
      {!workspaces.length && <p>{tr("请先创建工作区并导入文件。")}</p>}
      <label className="sync-scope-mode">
        {tr("文件选择方式")}
        <select
          value={scope.mode}
          onChange={(e) =>
            changeScope({
              mode: e.target.value as SyncScope["mode"],
              formats: scope.formats || formats,
              memberIds: scope.memberIds || [],
            })
          }
        >
          <option value="all">{tr("全部文件")}</option>
          <option value="formats">{tr("按文件类型")}</option>
          <option value="manual">{tr("手动勾选文件")}</option>
        </select>
      </label>
      {scope.mode === "formats" && (
        <div className="sync-format-options">
          {formats.map((format) => (
            <label className="sync-workspace" key={format}>
              <input
                type="checkbox"
                checked={!!scope.formats?.includes(format)}
                onChange={(e) =>
                  changeScope({
                    ...scope,
                    formats: e.target.checked
                      ? [...(scope.formats || []), format]
                      : scope.formats?.filter((f) => f !== format),
                  })
                }
              />
              {formatName(format)}
            </label>
          ))}
        </div>
      )}
      {scope.mode === "manual" && (
        <>
          <div className="sync-file-tools">
            <input
              aria-label={tr("搜索同步文件")}
              placeholder={tr("搜索文件名")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label={tr("筛选文件类型")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">{tr("全部类型")}</option>
              {formats.map((f) => (
                <option key={f} value={f}>
                  {formatName(f)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onChange(selectSyncFiles(value, visible, true))}
            >
              {tr("勾选当前列表")}
            </button>
            <button
              type="button"
              onClick={() => onChange(selectSyncFiles(value, visible, false))}
            >
              {tr("取消勾选当前列表")}
            </button>
          </div>
          <div className="sync-file-list">
            {visible.map((file) => (
              <label className="sync-workspace" key={file.id}>
                <input
                  type="checkbox"
                  checked={syncFileSelected(value, file)}
                  onChange={(e) =>
                    onChange(selectSyncFiles(value, [file], e.target.checked))
                  }
                />
                <span>
                  {file.title}
                  <small>
                    {workspaces.find((w) => w.id === file.workspaceId)?.name} ·{" "}
                    {formatName(file.format)}
                  </small>
                </span>
              </label>
            ))}
            {!visible.length && <p>{tr("没有符合条件的文件")}</p>}
          </div>
        </>
      )}
      <p className="sync-scope-summary" role="status">
        {tr("当前选中 {0} 个文件").replace("{0}", String(selected.length))}
        {scope.mode === "manual" &&
        !scope.workspaceIds?.length &&
        !scope.folders?.length
          ? tr("；后续新增文件需手动勾选。")
          : tr("；后续新增的符合条件的文件也会同步。")}
      </p>
    </fieldset>
  );
}
