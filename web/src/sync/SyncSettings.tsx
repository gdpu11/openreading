import { tr, locale } from "../i18n";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "../api";
import { MobileDownload } from "./MobileDownload";
export function SyncSettings({ onError }: { onError: (e: any) => void }) {
  const [workspaces, setWorkspaces] = useState<any[]>([]),
    [devices, setDevices] = useState<any[]>([]),
    [grant, setGrant] = useState<any>(null),
    [status, setStatus] = useState<any>(null),
    [image, setImage] = useState(""),
    [busy, setBusy] = useState(false),
    [cloud, setCloud] = useState(false),
    [lan, setLan] = useState<any>(null),
    [origin, setOrigin] = useState(""),
    [port, setPort] = useState(53318);
  async function loadLAN() {
    const v = await api("/lan");
    setLan(v);
    setPort(v.port || 53318);
    setOrigin((previous) =>
      v.addresses.some((a: any) => a.origin === previous)
        ? previous
        : v.addresses[0]?.origin || "",
    );
  }
  const reload = () => api("/devices").then(setDevices).catch(onError);
  useEffect(() => {
    void api("/me")
      .then((v) => setCloud(v.serverMode))
      .catch(onError);
    void api("/workspaces")
      .then((v) => {
        setWorkspaces(v);
      })
      .catch(onError);
    void reload();
    void loadLAN().catch(onError);
  }, []);
  useEffect(() => {
    if (!grant) return;
    const update = () =>
      api("/pair/grants/" + grant.id)
        .then(setStatus)
        .catch(onError);
    void update();
    const timer = setInterval(update, 2000);
    return () => {
      clearInterval(timer);
      void api("/pair/grants/" + grant.id, "DELETE").catch(() => {});
    };
  }, [grant?.id]);
  async function generate() {
    setBusy(true);
    try {
      const next = await api("/pair/grants", "POST", {
        workspaceIds: workspaces.map((w) => w.id),
        syncScope: { mode: "manual", memberIds: [] },
        connectionOnly: true,
        ...(cloud ? {} : { origin }),
      });
      setGrant(next);
      setStatus(null);
      const payload = JSON.stringify({
        origin: next.origin,
        id: next.id,
        secret: next.secret,
        ...(next.certificateFingerprint
          ? { certificateFingerprint: next.certificateFingerprint }
          : {}),
      });
      const url = next.origin + "/mobile#pair=" + encodeURIComponent(payload);
      setImage(
        await QRCode.toDataURL(url, {
          width: 280,
          margin: 2,
          errorCorrectionLevel: "M",
        }),
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    setBusy(true);
    try {
      await api("/pair/grants/" + grant.id + "/approve", "POST", {});
      setStatus({ ...status, state: "approved" });
      await reload();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sync-settings">
      <MobileDownload onError={onError} />
      <h3>{tr("2. 配对与同步")}</h3>
      <p>
        {tr(
          "配对不会自动下载。手机可搜索获授权工作区的书籍并选择同步；也可在电脑书库选择单本、文件夹或整个工作区。",
        )}
      </p>
      {!cloud && (
        <div className="lan-controls">
          <p>
            {tr(
              "电脑就是书库服务器。手机与电脑连接同一 Wi-Fi 或局域网，扫码后可在手机选书，也可由电脑选择后同步，无需云端账号或自建服务器。",
            )}
          </p>
          <label>
            {tr("局域网端口")}
            <input
              aria-label={tr("局域网端口")}
              type="number"
              min={1024}
              max={65535}
              value={port}
              disabled={!lan || lan.enabled || busy}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </label>
          <button
            className="primary"
            disabled={
              busy || !lan || (!lan.enabled && (port < 1024 || port > 65535))
            }
            onClick={async () => {
              setBusy(true);
              setGrant(null);
              setImage("");
              try {
                await api("/lan", "POST", { enabled: !lan.enabled, port });
                await loadLAN();
              } catch (e) {
                onError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {lan?.enabled ? tr("关闭局域网同步") : tr("开启局域网同步")}
          </button>
          {lan?.error && <p role="alert">{tr(lan.error)}</p>}
          {lan?.enabled && (
            <>
              <label>
                {tr("手机连接地址")}
                <select
                  aria-label={tr("手机连接地址")}
                  value={origin}
                  onChange={(e) => {
                    setOrigin(e.target.value);
                    setGrant(null);
                    setImage("");
                  }}
                >
                  {lan.addresses.map((a: any) => (
                    <option key={a.origin} value={a.origin}>
                      {a.interface} · {a.origin}
                    </option>
                  ))}
                </select>
              </label>
              {!lan.addresses.length && (
                <p>
                  {tr(
                    "未发现局域网 IPv4 地址，请先连接 Wi-Fi 或有线网络，再刷新地址。",
                  )}
                </p>
              )}
              <button onClick={() => void loadLAN().catch(onError)}>
                {tr("刷新电脑地址")}
              </button>
              <p>
                {tr(
                  "电脑需要保持开机且应用运行。首次连接请允许防火墙和手机“本地网络”权限；访客 Wi-Fi 的设备隔离可能阻止连接。",
                )}
              </p>
            </>
          )}
        </div>
      )}
      {(cloud || lan?.enabled) && (
        <>
          <button
            className="primary"
            disabled={busy || !workspaces.length || (!cloud && !origin)}
            onClick={generate}
          >
            {tr("生成手机配对二维码")}
          </button>
          {grant && (
            <div className="pair-card">
              {image && (
                <img
                  className="pair-qr"
                  src={image}
                  alt={tr("手机配对二维码")}
                />
              )}
              <div>
                {status?.state === "claimed" ? (
                  <>
                    <h4>
                      {status.claimName}
                      {tr("请求连接")}
                    </h4>
                    <p>
                      {tr("请核对手机显示的确认码：")}
                      <strong>{status.fingerprint}</strong>
                    </p>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={approve}
                    >
                      {tr("确认授权此设备")}
                    </button>
                  </>
                ) : status?.state === "approved" ? (
                  <p role="status">
                    {tr("已配对。可以在手机搜索选书，或返回电脑书库选择同步范围。")}
                  </p>
                ) : status?.state === "expired" ? (
                  <p>{tr("二维码已过期，请重新生成。")}</p>
                ) : (
                  <>
                    <h4>{tr("用手机 Open Reading 扫码")}</h4>
                    <p>
                      {cloud
                        ? tr("可用系统相机扫码，在移动网页中试用。")
                        : tr(
                            "请在手机应用内扫码。连接直接指向这台电脑，二维码内含本机证书指纹。",
                          )}
                      {tr("二维码 3 分钟有效，只能配对一台设备。")}
                    </p>
                  </>
                )}
                <button
                  onClick={() => {
                    setGrant(null);
                    setImage("");
                  }}
                >
                  {tr("关闭二维码")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <h3>{tr("已授权设备")}</h3>
      <p>
        {tr(
          "授权有效期 90 天。撤销后立即停止联网同步，手机上已经下载的文件需在手机端移除。",
        )}
      </p>
      {devices.length === 0 ? (
        <p>{tr("还没有配对设备。")}</p>
      ) : (
        devices.map((d) => (
          <div className="device-entry" key={d.id}>
            <div className="device-row">
              <div>
                <strong>{d.name}</strong>
                <small>
                  {d.revokedAt
                    ? tr("已撤销")
                    : new Date(d.expiresAt * 1000).toLocaleDateString(
                        locale(),
                      ) + tr(" 到期")}
                </small>
              </div>
              {!d.revokedAt && (
                <div className="device-actions">
                  <button
                    onClick={() =>
                      api("/devices/" + d.id, "DELETE")
                        .then(reload)
                        .catch(onError)
                    }
                  >
                    {tr("撤销授权")}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
