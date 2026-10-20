# 电脑即服务器：局域网手机同步

Open Reading 1.3.0 默认使用本机书库。Mac / Windows 自己提供同步服务，书籍、原文快照和笔记保存在电脑原来的数据目录，不需要迁入云端，不需要域名、个人服务器或互联网。

## 使用

1. 电脑打开 Open Reading。在本机书库里连接资料文件夹，或导入书籍。
2. 手机与电脑连接同一 Wi-Fi / 局域网（电脑可以有线接同一路由器）。
3. 电脑设置 → 手机与同步 → 开启局域网同步。默认端口 53318，可在开启前更换。
4. 如果电脑有多个网卡，选择手机所在网络的地址。勾选工作区，生成二维码。
5. 在手机 Open Reading 应用内扫码。两端核对确认码，再由电脑确认授权。
6. 手机下载原文、已有快照、标注与笔记；首次同步也会捕获还没在电脑打开过的关联文件。离开网络后可离线阅读和记笔记，重新回到电脑网络时回传。

电脑需要保持开机，应用需要运行；退出应用或关闭局域网同步后停止连接，手机已下载文件和未同步笔记仍在。电脑重新启动后会恢复之前开启的同步端口，设备授权和本机证书保持不变。电脑 IP 变化时，在设置刷新地址后重新扫码；相同证书的电脑允许更新地址并保留手机文件和待同步操作。另一台电脑不能沿用此连接。

初次连接请允许 Windows / macOS 防火墙以及 iPhone 的“本地网络”访问。访客 Wi-Fi、AP 设备隔离、部分 VPN 可能阻止同网设备互访。地址列表暂支持 RFC1918 / 链路本地 IPv4，不支持仅有 IPv6 的局域网；没有外网自动发现、NAT 穿透或唤醒电脑功能。

局域网扫码需使用 Android / iOS 原生应用。普通手机浏览器不提供电脑证书指纹校验能力，因此不作为局域网直连入口。可选 HTTPS 公网实例的移动网页试用保留，二者无需混用。

## 数据与权限

电脑管理界面继续仅监听 127.0.0.1。局域网通过独立 TLS 端口开放 `/api/pair/claim`、`/api/pair/status` 和 `/api/sync/`，不开放登录、模型配置、服务器目录、整库备份和设备管理。设备只获得电脑确认的工作区权限，可撤销，默认 90 天有效。

每个本机数据目录生成独立证书和私钥，保存在 `.lan-identity.json`（0600），不进入书籍导出、备份或 Git。二维码携带证书 SHA-256，Android / iOS 原生桥接只向指定私有 IPv4 地址和匹配证书发送同步请求；每次请求都校验证书，不跟随重定向，不全局关闭 TLS 校验。无公共 CA、无云端证书注册、无需用户安装根证书。

书籍使用不可变快照，电脑重新打开并捕获原文更新后，手机同步新快照。旧笔记保留旧版本定位；Markdown 的外部图片需要先在电脑阅读器捕获，已有资源快照随书籍同步。手机笔记使用持久队列和稳定操作编号，断线后可重放，冲突保留双方内容。ORD 的联网导入导出在局域网同样可用；离线阅读和笔记不受电脑暂时不可达影响。

实现采用 [Android 的请求级 SSLSocketFactory / TrustManager](https://developer.android.com/privacy-and-security/security-ssl)、[Apple 手工服务器信任校验](https://developer.apple.com/documentation/foundation/performing-manual-server-trust-authentication)，并声明 [iOS 本地网络用途](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)。当前 Android 目标 SDK 36，通过 INTERNET 获得本地网络访问；若升级到 SDK 37，需要按 [Android 本地网络权限规则](https://developer.android.com/privacy-and-security/local-network-permission)补充运行时授权。

## 验证口径

- Go 实际 TLS 监听：局域网配对、电脑确认、关联目录未打开文件下载、手机笔记回传、撤销、禁止公网来源、伪造 Host / 管理 Cookie 不能越过局域网接口限制、端口关闭和重启恢复。
- Android 生产 TLS 桥接源码在 JVM 中使用测试用 Capacitor / Base64 适配运行，实际连接 Go 局域网服务器；正确证书接受、错误证书拒绝。
- iOS 生产信任委托在 macOS Security / URLSession 中实际连接同一服务器，正确证书接受、错误证书拒绝。iOS 工程另由 GitHub 构建验证，不能等同实体 iPhone 验收。
- 浏览器端到端使用模拟 Capacitor 插件与原生存储、真实局域网 TLS 请求，验证电脑界面生成二维码、手机扫码逻辑、断开电脑同步后的离线阅读/笔记、重连回传以及 ORD 分享。
- 实体 Android / iPhone 的相机、局域网权限弹窗、系统防火墙行为仍需实机确认；iPhone 真机安装依旧需要个人 Apple Developer Team 签名。
