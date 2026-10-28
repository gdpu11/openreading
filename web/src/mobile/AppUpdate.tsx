import { useEffect, useState } from "react";
import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import { ArrowUpCircle } from "lucide-react";
import { tr } from "../i18n";
import type { Connection } from "./storage";
import { request } from "./sync";

type Version = { versionCode: number; versionName: string };
type Update = Version & { available: boolean; bytes: number; sha256: string };
const Updater = registerPlugin<{
  info(): Promise<Version>;
  download(options: {
    origin: string;
    fingerprint: string;
    token: string;
    sha256: string;
    bytes: number;
    versionCode: number;
  }): Promise<void>;
  install(options: {
    versionCode: number;
  }): Promise<{ needsPermission: boolean }>;
  addListener(
    event: "progress",
    callback: (v: { percent: number }) => void,
  ): Promise<PluginListenerHandle>;
}>("AppUpdate");
export function AppUpdate({
  connection: c,
  onPair,
}: {
  connection: Connection | null;
  onPair: () => void;
}) {
  const available =
    Capacitor.getPlatform() === "android" &&
    Capacitor.isPluginAvailable("AppUpdate");
  const [current, setCurrent] = useState<Version | null>(null),
    [update, setUpdate] = useState<Update | null>(null);
  const [busy, setBusy] = useState(false),
    [percent, setPercent] = useState<number | null>(null),
    [downloaded, setDownloaded] = useState(false);
  const [message, setMessage] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (!available) return;
    void Updater.info()
      .then(setCurrent)
      .catch((e) => setError(e.message));
    const listener = Updater.addListener("progress", (v) =>
      setPercent(v.percent),
    );
    return () => {
      void listener.then((l) => l.remove());
    };
  }, [available]);
  const check = async () => {
    if (!c?.deviceId || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    setUpdate(null);
    setDownloaded(false);
    setPercent(null);
    try {
      const v: Update = await request(c, "/sync/app-update");
      if (!v.available) setMessage("电脑尚未提供升级包，请先更新电脑端");
      else if (
        !Number.isSafeInteger(v.versionCode) ||
        v.versionCode < 1 ||
        !Number.isSafeInteger(v.bytes) ||
        v.bytes < 1 ||
        v.bytes > 210 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(v.sha256)
      )
        throw Error("电脑提供的升级信息无效");
      else if (v.versionCode <= (current?.versionCode || 0))
        setMessage("当前已是电脑提供的最新版本");
      else setUpdate(v);
    } catch (e: any) {
      setError(e.status === 404 ? "电脑端版本较旧，请先更新电脑端" : e.message);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    if (!c || !update || busy) return;
    setBusy(true);
    setError("");
    setPercent(0);
    try {
      await Updater.download({
        origin: c.origin,
        fingerprint: c.certificateFingerprint || "",
        token: c.token,
        sha256: update.sha256,
        bytes: update.bytes,
        versionCode: update.versionCode,
      });
      setDownloaded(true);
      setMessage("下载并校验完成，可以安装新版本");
    } catch (e: any) {
      setError(e.message);
      setPercent(null);
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    if (!update || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await Updater.install({ versionCode: update.versionCode });
      setMessage(
        r.needsPermission
          ? "请允许 Open Reading 安装应用，返回后再点“安装新版本”"
          : "已打开系统安装页，请确认更新；完成后重新打开应用",
      );
    } catch (e: any) {
      setError(e.message);
      setDownloaded(false);
      setPercent(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mobile-settings-group mobile-update-page">
      <ArrowUpCircle size={40} />
      <h2>Open Reading</h2>
      <p>
        {tr("当前版本")}
        {current ? ` ${current.versionName} · ${current.versionCode}` : " —"}
      </p>
      <p>
        {tr(
          "从已配对电脑获取升级，电脑需开机并开启同步。覆盖安装会保留书籍、笔记和配对，请勿卸载原应用。",
        )}
      </p>
      {!available ? (
        <p>{tr("此版本暂不支持应用内升级，请先扫码安装新版安卓应用。")}</p>
      ) : !c?.deviceId ? (
        <button className="primary" onClick={onPair}>
          {tr("先连接电脑")}
        </button>
      ) : (
        <>
          <button disabled={busy || !current} onClick={() => void check()}>
            {tr(busy && percent === null ? "正在检查…" : "检查更新")}
          </button>
          {update && (
            <div className="mobile-update-release">
              <strong>
                {tr("发现新版本")} {update.versionName} · {update.versionCode}
              </strong>
              <p>{(update.bytes / 1024 / 1024).toFixed(1)} MB</p>
              {percent !== null && (
                <div role="status">
                  <progress max={100} value={percent} />
                  <p>
                    {tr(busy ? "正在下载并校验" : "下载进度")} {percent}%
                  </p>
                </div>
              )}
              <button
                className="primary"
                disabled={busy}
                onClick={() => void (downloaded ? install() : download())}
              >
                {tr(
                  downloaded ? "安装新版本" : busy ? "正在下载…" : "下载升级包",
                )}
              </button>
            </div>
          )}
        </>
      )}
      {message && <p role="status">{tr(message)}</p>}
      {error && (
        <p role="alert" className="mobile-update-error">
          {error}
        </p>
      )}
    </section>
  );
}
