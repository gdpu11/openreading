package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMultiBrowserPairingKeepsSessionsIndependent(t *testing.T) {
	first := newClient(t, Config{})
	code := first.s.PairCode()
	type login struct {
		status int
		cookie *http.Cookie
		csrf   string
	}
	pair := func(s *Server, code string) login {
		r := httptest.NewRequest("POST", "http://127.0.0.1:7318/api/session", strings.NewReader(js(M{"code": code})))
		r.Header.Set("Origin", "http://127.0.0.1:7318")
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, r)
		result := login{status: rec.Code}
		var body M
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		result.csrf = str(body, "csrf")
		if cookies := rec.Result().Cookies(); len(cookies) == 1 {
			result.cookie = cookies[0]
		}
		return result
	}
	const browsers = 8
	results := make(chan login, browsers)
	for i := 0; i < browsers; i++ {
		go func() { results <- pair(first.s, code) }()
	}
	cookies, tokens := map[string]bool{first.cookie.Value: true}, map[string]bool{first.csrf: true}
	for i := 0; i < browsers; i++ {
		result := <-results
		if result.status != 200 || result.cookie == nil || result.csrf == "" {
			t.Fatalf("additional browser could not pair: status=%d", result.status)
		}
		if cookies[result.cookie.Value] || tokens[result.csrf] {
			t.Fatal("browsers shared authentication or CSRF tokens")
		}
		if !result.cookie.HttpOnly || result.cookie.SameSite != http.SameSiteStrictMode {
			t.Fatal("session cookie protections were lost")
		}
		cookies[result.cookie.Value], tokens[result.csrf] = true, true
		other := &testClient{t: t, s: first.s, cookie: result.cookie, csrf: result.csrf}
		other.ok("GET", "/api/me", nil)
		other.workspace("多浏览器共享资料")
		other.csrf = first.csrf
		if status, _ := other.req("POST", "/api/workspaces", M{"name": "wrong csrf"}); status != 403 {
			t.Fatalf("accepted a different browser's CSRF token: %d", status)
		}
	}
	if len(first.list("/api/workspaces")) != browsers {
		t.Fatal("existing browser session stopped seeing the shared library")
	}
	if pair(first.s, "wrong-code").status != 401 {
		t.Fatal("invalid pairing code accepted")
	}
	first.ok("GET", "/api/me", nil)
	if code == "" || first.s.PairCode() != code {
		t.Fatal("pairing code was consumed during this server lifetime")
	}
	cfg := first.s.cfg
	if err := first.s.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { restarted.Close() })
	if restarted.PairCode() == code || pair(restarted, code).status != 401 {
		t.Fatal("restart did not invalidate the old pairing code")
	}
	first.s = restarted
	if status, _ := first.req("GET", "/api/me", nil); status != 401 {
		t.Fatal("old browser session survived the process restart")
	}
	if pair(restarted, restarted.PairCode()).status != 200 {
		t.Fatal("new pairing code did not work after restart")
	}
}
