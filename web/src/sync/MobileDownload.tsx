import { tr, locale, useLanguage } from "../i18n";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "../api";

type Installers = {
  androidAvailable: boolean;
  androidBytes: number;
  iosURL: string;
  localLibrary: boolean;
  share?: {
    addresses: { interface: string; url: string }[];
    expiresAt: number;
  };
};
export function MobileDownload({ onError }: { onError: (e: any) => void }) {
  const [language] = useLanguage();
  const [data, setData] = useState<Installers>();
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState("");
  const [address, setAddress] = useState("");
  const [editIOS, setEditIOS] = useState(false);
  const [iosURL, setIOSURL] = useState("");
  const addresses = data?.share?.addresses || [];
  const url =
    addresses.find((a) => a.url === address)?.url || addresses[0]?.url || "";
  const installURL = url ? url + "?lang=" + language : "";
  async function load() {
    const next = await api<Installers>("/mobile-app");
    setData(next);
    return next;
  }
  useEffect(() => {
    void load()
      .then((v) => setIOSURL(v.iosURL))
      .catch(onError);
  }, []);
  useEffect(() => {
    if (!data?.share) return;
    const timer = setInterval(() => void load().catch(onError), 15000);
    return () => clearInterval(timer);
  }, [!!data?.share]);
  useEffect(() => {
    let cancelled = false;
    setImage("");
    if (url)
      void QRCode.toDataURL(installURL, {
        width: 240,
        margin: 2,
        errorCorrectionLevel: "M",
      })
        .then((v) => {
          if (!cancelled) setImage(v);
        })
        .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [installURL]);
  async function share() {
    setBusy(true);
    try {
      setData(await api<Installers>("/mobile-app/share", "POST", {}));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mobile-download" aria-label={tr("扫码下载手机端")}>
      <h3>{tr("1. 扫码下载手机端")}</h3>
      <p>{tr("先安装 Open Reading，再用应用内的扫码功能连接这台电脑。")}</p>
      <div className="installer-platforms">
        <div>
          <strong>Android</strong>
          <p>
            {data?.androidAvailable
              ? tr(
                  `APK 已就绪 · ${(data.androidBytes / 1024 / 1024).toFixed(1)} MB · Android 8 及以上`,
                )
              : tr("当前电脑尚未提供 APK 安装包")}
          </p>
        </div>
        <div>
          <strong>iPhone / iPad</strong>
          <p>
            {data?.iosURL
              ? data.iosURL.includes("testflight.apple.com")
                ? tr("通过 TestFlight 安装测试版")
                : tr("通过 App Store 安装")
              : tr("真机版尚未开放安装，等待 TestFlight / App Store 链接")}
          </p>
        </div>
      </div>
      {data?.localLibrary ? (
        <>
          {!data.share && (
            <button
              className="primary"
              disabled={busy || (!data.androidAvailable && !data.iosURL)}
              onClick={share}
            >
              {tr("生成下载二维码")}
            </button>
          )}
          {data.share && (
            <div className="pair-card">
              {image && (
                <img
                  className="pair-qr"
                  src={image}
                  alt={tr("手机应用下载二维码")}
                />
              )}
              <div className="installer-instructions">
                <h4>{tr("用手机系统相机扫码下载")}</h4>
                <p>
                  {tr(
                    "安卓打开下载页后点击“下载安卓 APK”；iPhone 使用页面中的 iOS 安装入口。安装后，再扫描下方的配对二维码。",
                  )}
                </p>
                {addresses.length > 1 && (
                  <label>
                    {tr("下载地址")}
                    <select
                      aria-label={tr("手机应用下载地址")}
                      value={url}
                      onChange={(e) => setAddress(e.target.value)}
                    >
                      {addresses.map((a) => (
                        <option key={a.url} value={a.url}>
                          {a.interface} · {new URL(a.url).hostname}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p className="installer-link">
                  {installURL || tr("未发现局域网地址，请检查电脑网络。")}
                </p>
                <p>
                  {tr("与电脑连接同一 Wi-Fi 或局域网。有效至")}{" "}
                  {new Date(data.share.expiresAt * 1000).toLocaleTimeString(
                    locale(),
                    { hour: "2-digit", minute: "2-digit" },
                  )}
                  {tr("，电脑需保持运行。下载不授权访问书库。")}
                </p>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      setData(
                        await api<Installers>("/mobile-app/share", "DELETE"),
                      );
                    } catch (e) {
                      onError(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {tr("停止安装包分享")}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p>{tr("请在电脑客户端的本机书库中生成下载二维码。")}</p>
      )}
      <button className="installer-config" onClick={() => setEditIOS(!editIOS)}>
        {editIOS ? tr("收起 iOS 安装配置") : tr("配置 iOS 安装链接")}
      </button>
      {editIOS && (
        <form
          className="installer-ios-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              setData(
                await api<Installers>("/mobile-app/ios", "PUT", {
                  url: iosURL.trim(),
                }),
              );
              setEditIOS(false);
            } catch (e) {
              onError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {tr("TestFlight 或 App Store 链接")}
            <input
              type="url"
              aria-label={tr("iOS 安装链接")}
              placeholder="https://testflight.apple.com/join/…"
              value={iosURL}
              onChange={(e) => setIOSURL(e.target.value)}
            />
          </label>
          <p>
            {tr(
              "填写 Open Reading 已发布的真机安装链接。留空表示暂未开放；模拟器包和 APK 不能安装在 iPhone 上。",
            )}
          </p>
          <button className="secondary" disabled={busy}>
            {tr("保存 iOS 安装链接")}
          </button>
        </form>
      )}
    </section>
  );
}
