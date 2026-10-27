import { useEffect, useRef, useState } from "react";
import { Check, FolderSync, Smartphone, X } from "lucide-react";
import { api } from "../api";
import { tr } from "../i18n";
import {
  manualSyncSelection,
  selectSyncFiles,
  selectSyncFolder,
  selectSyncWorkspace,
  syncFileSelected,
  type SyncFile,
  type SyncFolder,
  type SyncSelection,
} from "./selection";

type SyncRequest = {
  memberId?: string;
  folder?: SyncFolder;
  wholeWorkspace?: boolean;
};
const empty = (): SyncSelection => ({
  workspaceIds: [],
  syncScope: { mode: "manual", memberIds: [] },
});

export function useLibrarySync(
  workspaceId: string,
  onError: (e: any) => void,
  onNotice: (message: string) => void,
) {
  const [active, setActive] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [files, setFiles] = useState<SyncFile[]>([]),
    [devices, setDevices] = useState<any[]>([]),
    [deviceId, setDeviceId] = useState(""),
    [value, setValue] = useState<SyncSelection>(empty);
  const sequence = useRef(0),
    request = useRef<SyncRequest>({});
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  function close() {
    if (busy) return;
    ++sequence.current;
    setActive(false);
  }
  useEffect(() => {
    ++sequence.current;
    setActive(false);
    setValue(empty());
    return () => {
      ++sequence.current;
    };
  }, [workspaceId]);
  const prepare = (device: any, catalog: SyncFile[]) => {
    let next = manualSyncSelection(
      {
        workspaceIds: device.workspaceIds,
        syncScope: { mode: "all", ...device.syncScope },
      },
      catalog,
    );
    next.workspaceIds = [...new Set([...next.workspaceIds, workspaceId])];
    if (request.current.memberId) {
      const file = catalog.find((f) => f.id === request.current.memberId);
      if (!file) throw Error("书籍已移除，请刷新书库后重试");
      next = selectSyncFiles(next, [file], true);
    }
    if (request.current.folder)
      next = selectSyncFolder(next, request.current.folder, catalog);
    if (request.current.wholeWorkspace)
      next = selectSyncWorkspace(next, workspaceId, catalog, true);
    return next;
  };
  async function open(nextRequest: SyncRequest = {}) {
    if (busy || !workspaceId) return;
    const turn = ++sequence.current;
    request.current = nextRequest;
    setActive(true);
    setLoading(true);
    setDevices([]);
    setFiles([]);
    try {
      const [allDevices, catalog] = await Promise.all([
        api("/devices"),
        api<SyncFile[]>("/pair/catalog"),
      ]);
      if (turn !== sequence.current || currentWorkspace.current !== workspaceId)
        return;
      const connected = allDevices.filter(
        (d: any) => !d.revokedAt && d.expiresAt > Date.now() / 1000,
      );
      setDevices(connected);
      setFiles(catalog);
      const device =
        connected.find((d: any) => d.id === deviceId) || connected[0];
      setDeviceId(device?.id || "");
      setValue(device ? prepare(device, catalog) : empty());
    } catch (e) {
      if (turn === sequence.current) onError(e);
    } finally {
      if (turn === sequence.current) setLoading(false);
    }
  }
  async function save() {
    const device = devices.find((d) => d.id === deviceId);
    if (!device || busy || loading) return;
    const workspace = workspaceId;
    setBusy(true);
    try {
      await api(`/devices/${encodeURIComponent(deviceId)}/scope`, "PUT", {
        ...value,
        expectedRevision: device.syncScope?.revision || "",
      });
      if (currentWorkspace.current === workspace) {
        setActive(false);
        onNotice("同步范围已发送，手机将在连接电脑时接收所选书籍。");
      }
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return {
    active,
    loading,
    busy,
    files,
    devices,
    deviceId,
    value,
    open,
    close,
    save,
    changeDevice(id: string) {
      const device = devices.find((d) => d.id === id);
      if (!device || busy) return;
      setDeviceId(id);
      setValue(prepare(device, files));
    },
    selected(book: { id: string }) {
      const file = files.find((f) => f.id === book.id);
      return !!file && syncFileSelected(value, file);
    },
    selectFiles(ids: string[], checked: boolean) {
      if (busy || loading || !deviceId) return;
      setValue((v) =>
        selectSyncFiles(
          v,
          files.filter((f) => ids.includes(f.id)),
          checked,
        ),
      );
    },
    selectWorkspace(checked: boolean) {
      if (!busy)
        setValue((v) => selectSyncWorkspace(v, workspaceId, files, checked));
    },
    selectFolder(folder: SyncFolder) {
      if (!busy) setValue((v) => selectSyncFolder(v, folder, files));
    },
    removeFolder(folder: SyncFolder) {
      if (!busy)
        setValue((v) => ({
          ...v,
          syncScope: {
            ...v.syncScope,
            folders: v.syncScope.folders?.filter(
              (f) => f.sourceId !== folder.sourceId || f.path !== folder.path,
            ),
          },
        }));
    },
  };
}
export type LibrarySyncController = ReturnType<typeof useLibrarySync>;

export function LibrarySyncControls({
  sync,
  workspace,
  sources,
  books,
  onPair,
}: {
  sync: LibrarySyncController;
  workspace: { id: string; name: string };
  sources: any[];
  books: any[];
  onPair: () => void;
}) {
  if (!sync.active) return null;
  const available = sync.files.filter((f) => f.workspaceId === workspace.id);
  const selected = available.filter((f) => syncFileSelected(sync.value, f));
  const folders = new Map<string, SyncFolder & { label: string }>();
  for (const source of sources.filter((s) => s.state === "active")) {
    folders.set(JSON.stringify([source.id, ""]), {
      sourceId: source.id,
      path: "",
      workspaceId: workspace.id,
      label: source.label,
    });
    for (const file of available)
      for (const binding of file.bindings || []) {
        if (binding.sourceId !== source.id) continue;
        const parts = binding.relativePath.split("/");
        for (let length = 1; length < parts.length; length++) {
          const path = parts.slice(0, length).join("/");
          folders.set(JSON.stringify([source.id, path]), {
            sourceId: source.id,
            path,
            workspaceId: workspace.id,
            label: source.label + " / " + path,
          });
        }
      }
  }
  return (
    <section className="library-sync-panel" aria-label={tr("选择手机同步书籍")}>
      <div className="library-sync-heading">
        <Smartphone size={21} />
        <div>
          <strong>{tr("把想读的书带到手机")}</strong>
          <p>
            {tr("连接不会自动下载。勾选后点击“开始同步”，只发送给所选设备。")}
          </p>
        </div>
        <button
          disabled={sync.busy}
          className="icon"
          aria-label={tr("退出同步选择")}
          onClick={sync.close}
        >
          <X size={18} />
        </button>
      </div>
      {sync.loading ? (
        <p role="status">{tr("正在加载同步范围…")}</p>
      ) : !sync.devices.length ? (
        <div className="library-sync-empty">
          <p>{tr("还没有可用的配对设备。先连接手机，再回来选择书籍。")}</p>
          <button className="primary" onClick={onPair}>
            {tr("配对手机")}
          </button>
        </div>
      ) : (
        <>
          <fieldset disabled={sync.busy}>
            <label>
              {tr("同步到")}
              <select
                aria-label={tr("同步到手机")}
                value={sync.deviceId}
                onChange={(e) => sync.changeDevice(e.target.value)}
              >
                {sync.devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="library-sync-workspace">
              <input
                type="checkbox"
                checked={
                  !!sync.value.syncScope.workspaceIds?.includes(workspace.id)
                }
                onChange={(e) => sync.selectWorkspace(e.target.checked)}
              />
              {tr("同步整个工作区")}
              <small>{workspace.name}</small>
            </label>
            <label>
              <FolderSync size={16} />
              <select
                aria-label={tr("添加同步文件夹")}
                value=""
                onChange={(e) => {
                  const folder = folders.get(e.target.value);
                  if (folder) sync.selectFolder(folder);
                }}
              >
                <option value="">{tr("添加整个文件夹…")}</option>
                {[...folders].map(([key, folder]) => (
                  <option value={key} key={key}>
                    {folder.label}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          {!!sync.value.syncScope.folders?.some(
            (f) => f.workspaceId === workspace.id,
          ) && (
            <div className="library-sync-folders">
              {sync.value.syncScope.folders
                .filter((f) => f.workspaceId === workspace.id)
                .map((folder) => {
                  const name =
                    folders.get(JSON.stringify([folder.sourceId, folder.path]))
                      ?.label ||
                    folder.path ||
                    tr("文件夹");
                  return (
                    <span key={JSON.stringify([folder.sourceId, folder.path])}>
                      <FolderSync size={13} />
                      {name}
                      <button
                        disabled={sync.busy}
                        aria-label={tr("移除文件夹规则 ") + name}
                        onClick={() => sync.removeFolder(folder)}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  );
                })}
            </div>
          )}
          <div className="library-sync-actions">
            <span role="status">
              {tr("本工作区已选 {0} 本").replace(
                "{0}",
                String(selected.length),
              )}
            </span>
            <button
              disabled={sync.busy}
              onClick={() =>
                sync.selectFiles(
                  books.filter((b) => !b.removedAt).map((b) => b.id),
                  true,
                )
              }
            >
              {tr("勾选已显示书籍")}
            </button>
            <button
              disabled={sync.busy}
              onClick={() => sync.selectWorkspace(false)}
            >
              {tr("清空本工作区")}
            </button>
            <button
              className="primary"
              disabled={sync.busy}
              onClick={() => void sync.save()}
            >
              <Check size={15} />
              {tr(sync.busy ? "正在发送…" : "开始同步")}
            </button>
          </div>
          <small className="library-sync-note">
            {tr(
              "文件夹和整个工作区包含后续新增书籍；取消单本可排除它。取消同步不会删除手机已有文件和笔记。",
            )}
          </small>
        </>
      )}
    </section>
  );
}
