package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMobileInstallURLs(t *testing.T) {
	for _, u := range []string{"", "https://testflight.apple.com/join/Abc123XY", "https://apps.apple.com/cn/app/open-reading/id1234567890"} {
		if !validIOSInstallURL(u) {
			t.Errorf("valid URL rejected: %s", u)
		}
	}
	for _, u := range []string{"http://testflight.apple.com/join/Abc123XY", "javascript:alert(1)", "https://testflight.apple.com.evil.test/join/Abc123XY", "https://evil.test/app/id123", "https://user@testflight.apple.com/join/Abc123XY", "https://apps.apple.com/app/id123?next=evil", "https://testflight.apple.com/join/../Abc123XY"} {
		if validIOSInstallURL(u) {
			t.Errorf("unsafe URL accepted: %s", u)
		}
	}
}
func TestMobileDownloadInstallerIsolation(t *testing.T) {
	apk := filepath.Join(t.TempDir(), "preview.apk")
	bytes := []byte("PK\x03\x04local-test-apk-only")
	if e := os.WriteFile(apk, bytes, 0600); e != nil {
		t.Fatal(e)
	}
	c := newClient(t, Config{AndroidAPK: apk})
	info := c.ok("GET", "/api/mobile-app", nil)
	if info["androidAvailable"] != true || str(info, "iosURL") != "" {
		t.Fatal(info)
	}
	c.ok("PUT", "/api/mobile-app/ios", M{"url": "https://testflight.apple.com/join/Abc123XY"})
	if status, _ := c.req("PUT", "/api/mobile-app/ios", M{"url": "https://evil.test/app"}); status != 400 {
		t.Fatal(status)
	}
	if got := str(c.ok("GET", "/api/mobile-app", nil), "iosURL"); got != "https://testflight.apple.com/join/Abc123XY" {
		t.Fatal(got)
	}
	// The admin API always requires a session and CSRF, even before sharing.
	for _, method := range []string{"POST", "DELETE"} {
		r := httptest.NewRequest(method, "http://127.0.0.1:7318/api/mobile-app/share", nil)
		w := httptest.NewRecorder()
		c.s.Handler().ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatal(w.Code)
		}
		r.AddCookie(c.cookie)
		w = httptest.NewRecorder()
		c.s.Handler().ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
	if len(lanAddresses(0)) == 0 {
		t.Skip("No LAN interface in this test environment")
	}
	c.ok("POST", "/api/mobile-app/share", M{})
	c.s.downloadMu.Lock()
	d := c.s.download
	c.s.downloadMu.Unlock()
	root := "http://127.0.0.1:" + strconv.Itoa(d.port)
	base := "/install/" + d.token
	get := func(path, ua string) (int, string, http.Header) {
		t.Helper()
		r, _ := http.NewRequest("GET", root+path, nil)
		r.Header.Set("User-Agent", ua)
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		b, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(b), response.Header
	}
	code, body, _ := get(base+"?lang=zh", "iPhone")
	if code != 200 || !strings.Contains(body, "安装 iOS 应用") || !strings.Contains(body, "testflight.apple.com/join/Abc123XY") || !strings.Contains(body, "正在使用 iPhone") {
		t.Fatal(code, body)
	}
	code, body, _ = get(base, "Android")
	if code != 200 || !strings.Contains(body, "Download Android APK") || !strings.Contains(body, `lang="en"`) {
		t.Fatal(code, body)
	}
	code, body, h := get(base+"/Open-Reading.apk", "Android")
	if code != 200 || body != string(bytes) || h.Get("Content-Type") != "application/vnd.android.package-archive" || h.Get("Content-Disposition") == "" {
		t.Fatal(code, body, h)
	}
	r, _ := http.NewRequest("GET", root+base+"/Open-Reading.apk", nil)
	r.Header.Set("Range", "bytes=0-3")
	response, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 206 || string(b) != string(bytes[:4]) {
		t.Fatal(response.StatusCode, string(b))
	}
	for _, path := range []string{"/api/session", "/api/workspaces", "/api/sync/library", "/library.sqlite", "/install/wrong/Open-Reading.apk", base + "/../library.sqlite"} {
		code, _, _ = get(path, "")
		if code != 404 {
			t.Fatalf("Unexpected accessible route %s: %d", path, code)
		}
	}
	for _, test := range []struct{ host, peer string }{{"evil.example:" + strconv.Itoa(d.port), "127.0.0.1:1234"}, {"127.0.0.1:" + strconv.Itoa(d.port), "8.8.8.8:1234"}} {
		req := httptest.NewRequest("GET", root+base, nil)
		req.Host = test.host
		req.RemoteAddr = test.peer
		w := httptest.NewRecorder()
		c.s.serveMobileDownload(d, w, req)
		if w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
	c.ok("PUT", "/api/mobile-app/ios", M{"url": ""})
	_, body, _ = get(base+"?lang=zh", "iPhone")
	if !strings.Contains(body, "iOS 真机版尚未开放安装") || strings.Contains(body, `href="https://testflight.apple.com`) {
		t.Fatal(body)
	}
	expired := *d
	expired.expires = time.Now().Add(-time.Second)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", root+base, nil)
	req.RemoteAddr = "127.0.0.1:2345"
	c.s.serveMobileDownload(&expired, w, req)
	if w.Code != 410 {
		t.Fatal(w.Code)
	}
	c.ok("DELETE", "/api/mobile-app/share", nil)
	if _, e := http.Get(root + base); e == nil {
		t.Fatal("Listener still running after stop")
	}
	if c.s.lanInfo()["enabled"] == true {
		t.Fatal("Installer unexpectedly enabled library sync")
	}
}

func TestMobileDownloadLifetime(t *testing.T) {
	if len(lanAddresses(0)) == 0 {
		t.Skip("No LAN interface")
	}
	apk := filepath.Join(t.TempDir(), "preview.apk")
	if e := os.WriteFile(apk, []byte("test-apk"), 0600); e != nil {
		t.Fatal(e)
	}
	c := newClient(t, Config{AndroidAPK: apk})
	c.ok("POST", "/api/mobile-app/share", M{})
	c.s.downloadMu.Lock()
	first := c.s.download
	c.s.downloadMu.Unlock()
	c.ok("POST", "/api/mobile-app/share", M{})
	c.s.downloadMu.Lock()
	if c.s.download != first {
		t.Fatal("Repeated share unexpectedly rotated active QR")
	}
	first.timer.Reset(time.Millisecond)
	c.s.downloadMu.Unlock()
	deadline := time.Now().Add(time.Second)
	for {
		c.s.downloadMu.Lock()
		done := c.s.download == nil
		c.s.downloadMu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Expired share not cleared")
		}
		time.Sleep(time.Millisecond)
	}
	c.ok("POST", "/api/mobile-app/share", M{})
	c.s.downloadMu.Lock()
	next := c.s.download
	c.s.downloadMu.Unlock()
	if next.token == first.token {
		t.Fatal("Expired token was reused")
	}
	if e := c.s.Close(); e != nil {
		t.Fatal(e)
	}
	client := &http.Client{Timeout: time.Second}
	if _, e := client.Get("http://127.0.0.1:" + strconv.Itoa(next.port) + "/install/" + next.token); e == nil {
		t.Fatal("Download survives application shutdown")
	}
}
