import { useEffect, useState } from "react";
import { api } from "../api";
import { tr } from "../i18n";
export function BackupSettings() {
  const [policy, setPolicy] = useState<any>(null),
    [backups, setBackups] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    Promise.all([api("/backup-policy"), api("/automatic-backups")])
      .then(([p, b]) => {
        setPolicy(p);
        setBackups(b);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="backup-policy">
      <h3>{tr("自动备份")}</h3>
      {error && <p role="alert">{tr(error)}</p>}
      {policy && (
        <>
          <label>
            {tr("开启自动备份")}
            <input
              type="checkbox"
              checked={policy.enabled}
              onChange={(e) => {
                setSaved(false);
                setPolicy({ ...policy, enabled: e.target.checked });
              }}
            />
          </label>
          <label>
            {tr("间隔（小时）")}
            <input
              type="number"
              min={1}
              max={168}
              value={policy.intervalHours}
              onChange={(e) => {
                setSaved(false);
                setPolicy({ ...policy, intervalHours: Number(e.target.value) });
              }}
            />
          </label>
          <label>
            {tr("保留份数")}
            <input
              type="number"
              min={1}
              max={30}
              value={policy.keep}
              onChange={(e) => {
                setSaved(false);
                setPolicy({ ...policy, keep: Number(e.target.value) });
              }}
            />
          </label>
          <p>
            {tr(
              "应用运行时定期制作完整备份；只有新备份成功后才清理多余的自动备份。手动备份保留。",
            )}
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setPolicy(await api("/backup-policy", "PUT", policy));
                setSaved(true);
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {tr(saved ? "已保存" : "保存备份设置")}
          </button>
          {policy.lastSuccess && (
            <small>
              {tr("上次成功备份")}{" "}
              {new Date(policy.lastSuccess).toLocaleString()}
            </small>
          )}
          {policy.lastError && <p role="alert">{tr(policy.lastError)}</p>}
          {backups.map((b) => (
            <a key={b.id} href={`/api/backups/${b.id}/download`} download>
              {new Date(b.createdAt).toLocaleString()} ·{" "}
              {Math.round(b.bytes / 1024)} KB
            </a>
          ))}
        </>
      )}
    </div>
  );
}
