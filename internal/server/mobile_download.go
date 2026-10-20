package server

import (
	"database/sql"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// This temporary HTTP listener serves installers only. The library continues
// using the separate authenticated, certificate-pinned HTTPS sync listener.
type mobileDownload struct {
	server  *http.Server
	timer   *time.Timer
	token   string
	port    int
	expires time.Time
}

func validIOSInstallURL(raw string) bool {
	if raw == "" {
		return true
	}
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if u.Host == "testflight.apple.com" {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		return len(parts) == 2 && parts[0] == "join" && len(parts[1]) == 8 && strings.IndexFunc(parts[1], func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') }) < 0
	}
	if u.Host == "apps.apple.com" {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		last := parts[len(parts)-1]
		if !strings.HasPrefix(last, "id") {
			return false
		}
		_, e = strconv.ParseUint(strings.TrimPrefix(last, "id"), 10, 64)
		return e == nil && strings.Contains(u.Path, "/app/")
	}
	return false
}
func (s *Server) iosInstallURL() string {
	row, _ := one(s.db, "SELECT data_json FROM preferences WHERE id='mobile-install'")
	value := str(obj(row, "data"), "iosURL")
	if validIOSInstallURL(value) {
		return value
	}
	return ""
}
func (s *Server) mobileDownloadInfo() M {
	info := M{"androidAvailable": false, "androidBytes": 0, "iosURL": s.iosInstallURL(), "localLibrary": s.cfg.PublicOrigin == ""}
	if st, e := os.Stat(s.cfg.AndroidAPK); e == nil && st.Mode().IsRegular() && st.Size() > 0 {
		info["androidAvailable"], info["androidBytes"] = true, st.Size()
	}
	s.downloadMu.Lock()
	defer s.downloadMu.Unlock()
	if d := s.download; d != nil && time.Now().Before(d.expires) {
		addresses := []M{}
		for _, a := range lanAddresses(d.port) {
			addresses = append(addresses, M{"interface": a["interface"], "url": strings.Replace(str(a, "origin"), "https://", "http://", 1) + "/install/" + d.token})
		}
		info["share"] = M{"addresses": addresses, "expiresAt": d.expires.Unix()}
	}
	return info
}
func (s *Server) stopMobileDownload() {
	s.downloadMu.Lock()
	d := s.download
	s.download = nil
	if d != nil && d.timer != nil {
		d.timer.Stop()
	}
	s.downloadMu.Unlock()
	if d != nil {
		_ = d.server.Close()
	}
}
func (s *Server) mobileDownloadRoutes() {
	s.route("GET /api/mobile-app", func(w http.ResponseWriter, r *http.Request) error { return send(w, s.mobileDownloadInfo()) })
	s.route("PUT /api/mobile-app/ios", func(w http.ResponseWriter, r *http.Request) error {
		var b struct {
			URL string `json:"url"`
		}
		if e := decode(r, &b); e != nil {
			return e
		}
		b.URL = strings.TrimSpace(b.URL)
		if !validIOSInstallURL(b.URL) {
			return problem(400, "IOS_INSTALL_URL", "请输入有效的 TestFlight 邀请链接或 App Store 应用链接", false)
		}
		if e := s.transaction(func(tx *sql.Tx) error {
			return exec(tx, "INSERT INTO preferences(id,data_json) VALUES('mobile-install',?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json", js(M{"iosURL": b.URL}))
		}); e != nil {
			return e
		}
		return send(w, s.mobileDownloadInfo())
	})
	s.route("DELETE /api/mobile-app/share", func(w http.ResponseWriter, r *http.Request) error {
		s.stopMobileDownload()
		return send(w, s.mobileDownloadInfo())
	})
	s.route("POST /api/mobile-app/share", func(w http.ResponseWriter, r *http.Request) error {
		if s.cfg.PublicOrigin != "" {
			return problem(409, "LOCAL_LIBRARY_REQUIRED", "请在电脑本机书库分享手机安装包", false)
		}
		info := s.mobileDownloadInfo()
		if info["androidAvailable"] != true && str(info, "iosURL") == "" {
			return problem(409, "INSTALLER_UNAVAILABLE", "当前客户端未包含手机安装包，也未配置 iOS 安装链接", false)
		}
		if len(lanAddresses(0)) == 0 {
			return problem(409, "LAN_ADDRESS", "请先连接 Wi-Fi 或有线局域网", false)
		}
		s.downloadMu.Lock()
		defer s.downloadMu.Unlock()
		if s.ctx.Err() != nil {
			return problem(503, "SERVER_STOPPING", "电脑服务正在关闭", true)
		}
		if d := s.download; d == nil || !time.Now().Before(d.expires) {
			if d != nil {
				d.timer.Stop()
				_ = d.server.Close()
			}
			listener, e := net.Listen("tcp4", "0.0.0.0:0")
			if e != nil {
				return problem(409, "INSTALLER_PORT", "无法开启安装包分享，请检查电脑防火墙", true)
			}
			d := &mobileDownload{token: id(), port: listener.Addr().(*net.TCPAddr).Port, expires: time.Now().Add(30 * time.Minute)}
			d.server = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.serveMobileDownload(d, w, r) }), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 1 << 16}
			s.download = d
			d.timer = time.AfterFunc(time.Until(d.expires), func() {
				s.downloadMu.Lock()
				if s.download == d {
					s.download = nil
				}
				s.downloadMu.Unlock()
				_ = d.server.Close()
			})
			go func() { _ = d.server.Serve(listener) }()
		}
		// Avoid reacquiring downloadMu through mobileDownloadInfo.
		d := s.download
		addresses := []M{}
		for _, a := range lanAddresses(d.port) {
			addresses = append(addresses, M{"interface": a["interface"], "url": strings.Replace(str(a, "origin"), "https://", "http://", 1) + "/install/" + d.token})
		}
		info["share"] = M{"addresses": addresses, "expiresAt": d.expires.Unix()}
		return send(w, info)
	})
}
func (s *Server) serveMobileDownload(d *mobileDownload, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
	host, port, e := net.SplitHostPort(r.Host)
	ip := net.ParseIP(host)
	peer, _, _ := net.SplitHostPort(r.RemoteAddr)
	peerIP := net.ParseIP(peer)
	allowed := ip != nil && ip.IsLoopback()
	for _, a := range lanAddresses(d.port) {
		if str(a, "origin") == "https://"+r.Host {
			allowed = true
			break
		}
	}
	if e != nil || port != strconv.Itoa(d.port) || !allowed || peerIP == nil || (!lanIPv4(peerIP) && !peerIP.IsLoopback()) {
		http.Error(w, "仅允许局域网下载", 403)
		return
	}
	if !time.Now().Before(d.expires) {
		http.Error(w, "下载二维码已过期，请在电脑重新生成", 410)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(405)
		return
	}
	base := "/install/" + d.token
	switch r.URL.Path {
	case base:
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.Method == "HEAD" {
			return
		}
		st, err := os.Stat(s.cfg.AndroidAPK)
		data := M{"APK": err == nil && st.Mode().IsRegular() && st.Size() > 0, "APKURL": base + "/Open-Reading.apk", "IOS": s.iosInstallURL(), "IPhone": strings.Contains(r.UserAgent(), "iPhone") || strings.Contains(r.UserAgent(), "iPad")}
		data["Lang"] = "en"
		if r.URL.Query().Get("lang") == "zh" {
			data["Lang"] = "zh-CN"
		}
		data["Text"] = func(zh, en string) string {
			if data["Lang"] == "zh-CN" {
				return zh
			}
			return en
		}
		_ = mobileInstallPage.Execute(w, data)
	case base + "/Open-Reading.apk":
		f, e := os.Open(s.cfg.AndroidAPK)
		if e != nil {
			http.Error(w, "安卓安装包暂不可用", 404)
			return
		}
		defer f.Close()
		st, e := f.Stat()
		if e != nil || !st.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.android.package-archive")
		w.Header().Set("Content-Disposition", `attachment; filename="Open-Reading-android.apk"`)
		http.ServeContent(w, r, "Open-Reading-android.apk", st.ModTime(), f)
	default:
		http.NotFound(w, r)
	}
}

var mobileInstallPage = template.Must(template.New("install").Parse(`<!doctype html><html lang="{{.Lang}}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{call .Text "安装 Open Reading" "Install Open Reading"}}</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:36px 22px;font:16px/1.7 system-ui;background:#fff;color:#171717}main{max-width:480px;margin:auto}h1{font-size:30px;margin-bottom:0}h2{font-size:21px}section{padding:20px 0;border-bottom:1px solid #ddd}p{color:#666}a{display:block;padding:14px 18px;border-radius:12px;background:#171717;color:#fff;text-align:center;text-decoration:none}small{display:block;margin-top:14px;color:#666}@media(prefers-color-scheme:dark){body{background:#000;color:#eee}a{background:#eee;color:#000}p,small{color:#aaa}section{border-color:#333}}</style><main><nav style="display:flex;gap:12px"><a style="padding:4px 10px" href="?lang=en">English</a><a style="padding:4px 10px" href="?lang=zh">中文</a></nav><h1>Open Reading</h1><p>{{call .Text "安装手机端，把电脑上的书和笔记带在身边。" "Install the mobile app to take your books and notes with you."}}</p>{{if .IPhone}}<small>{{call .Text "你正在使用 iPhone / iPad，请查看 iOS 安装入口。" "You are using an iPhone or iPad. See the iOS installation section."}}</small>{{end}}<section><h2>Android</h2>{{if .APK}}<a href="{{.APKURL}}" download>{{call .Text "下载安卓 APK" "Download Android APK"}}</a><small>{{call .Text "Android 8 及以上。下载后打开安装包，并按系统提示允许本次安装。安装完成后，在应用内扫描电脑的配对二维码。" "Requires Android 8 or later. Open the downloaded APK and allow this installation when prompted. Then scan the computer’s pairing QR code inside the app."}}</small>{{else}}<p>{{call .Text "这台电脑暂未提供安卓安装包。" "This computer does not have an Android installer available."}}</p>{{end}}</section><section><h2>iPhone / iPad</h2>{{if .IOS}}<a href="{{.IOS}}" rel="noreferrer">{{call .Text "安装 iOS 应用" "Install iOS app"}}</a><small>{{call .Text "TestFlight 邀请会引导你安装测试版；App Store 链接会打开应用详情。" "A TestFlight invitation guides you through installing the preview. An App Store link opens the app listing."}}</small>{{else}}<p>{{call .Text "iOS 真机版尚未开放安装。请等待开发者提供 TestFlight 或 App Store 链接，APK 无法安装在 iPhone 上。" "iOS installation is not available yet. Wait for a TestFlight or App Store link. APK files cannot be installed on an iPhone."}}</p>{{end}}</section><small>{{call .Text "手机与电脑需在同一 Wi-Fi 或局域网。二维码 30 分钟有效；电脑需保持开机且 Open Reading 正在运行。这个下载页仅提供应用安装包，不会授权访问书籍和笔记。" "Connect your phone and computer to the same Wi-Fi or LAN. The QR code is valid for 30 minutes; keep the computer on and Open Reading running. This page only provides installers and does not grant access to books or notes."}}</small></main></html>`))
