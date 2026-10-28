import { useEffect, useRef, useState } from "react";
import { Check, FolderSync, Smartphone, RefreshCw, X } from "lucide-react";
import { api, ApiError } from "../api";
import { tr } from "../i18n";
import QRCode from "qrcode";
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
    request = useRef<SyncRequest>({}),
    saving = useRef(false);
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
    if (!device || saving.current || busy || loading) return;
    const workspace = workspaceId;
    const turn = sequence.current;
    saving.current = true;
    setBusy(true);
    try {
      const saved = await api(
        `/devices/${encodeURIComponent(deviceId)}/scope`,
        "PUT",
        {
          ...value,
          expectedRevision: device.syncScope?.revision || "",
        },
      );
      if (currentWorkspace.current === workspace && turn === sequence.current) {
        setDevices((all) =>
          all.map((d) =>
            d.id === deviceId
              ? {
                  ...d,
                  ...value,
                  syncScope: { ...value.syncScope, revision: saved.revision },
                }
              : d,
          ),
        );
        onNotice("同步任务已保存，下面会显示手机连接与接收进度。");
      }
    } catch (e) {
      if (turn !== sequence.current || currentWorkspace.current !== workspace)
        return;
      if (e instanceof ApiError && e.code === "SYNC_SCOPE_CHANGED") {
        try {
          const allDevices = await api("/devices");
          if (
            turn !== sequence.current ||
            currentWorkspace.current !== workspace
          )
            return;
          const connected = allDevices.filter(
            (d: any) => !d.revokedAt && d.expiresAt > Date.now() / 1000,
          );
          setDevices(connected);
          const fresh = connected.find((d: any) => d.id === deviceId);
          // A new revision must be paired with that revision's entire scope.
          // Keeping stale checks would silently restore revoked workspaces.
          setValue(
            fresh
              ? manualSyncSelection(
                  {
                    workspaceIds: fresh.workspaceIds,
                    syncScope: { mode: "all", ...fresh.syncScope },
                  },
                  files,
                )
              : empty(),
          );
          onNotice(
            "同步清单已在其他窗口更新，已载入最新清单，请重新核对勾选。",
          );
        } catch (reloadError) {
          onError(reloadError);
        }
      } else onError(e);
    } finally {
      saving.current = false;
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
          <SyncTransferStatus
            deviceId={sync.deviceId}
            revision={
              sync.devices.find((d) => d.id === sync.deviceId)?.syncScope
                ?.revision || ""
            }
            onPair={onPair}
          />
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

type TransferProgress = {
  phase: string;
  done: number;
  total: number;
  title?: string;
  received: number;
  bytes: number;
  message?: string;
  lastSeenAt: number;
  updatedAt: number;
};
function SyncTransferStatus({
  deviceId,
  revision,
  onPair,
}: {
  deviceId: string;
  revision: string;
  onPair: () => void;
}) {
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState("");
  const [lan, setLan] = useState<any>(null);
  const [qr, setQr] = useState("");
  const [now, setNow] = useState(Date.now());
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    let active = true,
      busy = false;
    setProgress(null);
    setQr("");
    setError("");
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await api<TransferProgress>(
          `/devices/${encodeURIComponent(deviceId)}/sync-progress`,
        );
        if (active) {
          setProgress(next);
          setNow(Date.now());
          setError("");
        }
      } catch {
        if (active) setError("暂时无法获取手机同步状态，请稍后重试");
      } finally {
        busy = false;
      }
    };
    void poll();
    void api("/lan")
      .then((v) => {
        if (active) setLan(v);
      })
      .catch(() => {});
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [deviceId, revision]);
  const online = !!progress?.lastSeenAt && now - progress.lastSeenAt < 45000;
  const active = [
    "preparing",
    "checking",
    "sending",
    "downloading",
    "saving",
  ].includes(progress?.phase || "");
  const stalled = active && now - (progress?.updatedAt || 0) > 45000;
  const labels: Record<string, string> = {
    waiting: "等待手机接收",
    preparing: "正在准备书籍与笔记",
    checking: "手机正在检查已下载书籍",
    sending: "正在发送书籍，等待手机确认",
    downloading: "手机正在接收书籍",
    saving: "手机正在校验并保存书籍",
    completed: online ? "手机已确认接收完成" : "上次同步已完成",
    failed: "同步已中断，可继续接收",
  };
  const origin = lan?.enabled
    ? lan?.addresses?.find((a: any) => a.interface === "en0")?.origin ||
      lan?.addresses?.[0]?.origin
    : undefined;
  const sizeText = (bytes: number) =>
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1048576
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1048576).toFixed(1)} MB`;
  async function connect() {
    setConnecting(true);
    try {
      const next = await api("/lan");
      setLan(next);
      const address =
        next.addresses?.find((a: any) => a.interface === "en0")?.origin ||
        next.addresses?.[0]?.origin;
      if (!next.enabled || !address) {
        onPair();
        return;
      }
      const payload = {
        origin: address,
        certificateFingerprint: next.certificateFingerprint,
      };
      setQr(
        await QRCode.toDataURL(
          address +
            "/mobile#connect=" +
            encodeURIComponent(JSON.stringify(payload)),
          { width: 220, margin: 2 },
        ),
      );
    } catch {
      setError("无法生成连接二维码，请检查局域网同步是否开启");
    } finally {
      setConnecting(false);
    }
  }
  return (
    <div className="sync-transfer-status" aria-label={tr("手机接收进度")}>
      <div className="sync-transfer-heading">
        <strong>
          {tr(
            stalled
              ? "传输暂时停住，等待手机继续"
              : labels[progress?.phase || "waiting"] || "等待手机接收",
          )}
        </strong>
        <span>
          {tr(
            online
              ? "手机已连接"
              : progress?.lastSeenAt
                ? "手机当前离线"
                : "暂未连接到手机",
          )}
        </span>
      </div>
      {progress?.phase === "completed" && (
        <p>
          {tr("完成时间：")}
          {new Date(progress.updatedAt).toLocaleString()}
        </p>
      )}
      {progress && progress.total > 0 && (
        <>
          <progress
            aria-label={tr("书籍接收进度")}
            max={progress.total}
            value={
              progress.done +
              (progress.phase === "downloading" && progress.bytes > 0
                ? Math.min(progress.received / progress.bytes, 0.99)
                : 0)
            }
          />
          <p>
            {tr("已接收 {0}/{1} 本")
              .replace("{0}", String(progress.done))
              .replace("{1}", String(progress.total))}
          </p>
        </>
      )}
      {progress?.title && (
        <p>
          {progress.title}
          {progress.bytes > 0 &&
            ` · ${Math.floor((progress.received * 100) / progress.bytes)}% · ${sizeText(progress.received)} / ${sizeText(progress.bytes)}`}
        </p>
      )}
      {progress?.message && <p role="alert">{progress.message}</p>}
      {(!online || stalled) && progress?.phase !== "completed" && (
        <p>
          {tr(
            "请保持手机应用打开。若电脑换过网络，请更新手机连接地址；同一 Wi-Fi 下也可能存在设备隔离或 VPN 阻断。",
          )}
        </p>
      )}
      {origin && (
        <p className="sync-current-address">
          {tr("当前电脑地址：")}
          {origin}
        </p>
      )}
      <button disabled={connecting} onClick={() => void connect()}>
        <RefreshCw size={14} />
        {tr("更新手机连接")}
      </button>
      {qr && (
        <div className="sync-reconnect-qr">
          <img src={qr} alt={tr("更新电脑地址二维码")} />
          <p>
            {tr(
              "手机更新到最新版后，在设置中点“更新电脑连接”扫码。校验同一台电脑后更新地址，书籍、笔记和同步选择都会保留。",
            )}
          </p>
        </div>
      )}
      {error && <p role="alert">{tr(error)}</p>}
    </div>
  );
}
