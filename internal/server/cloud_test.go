package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCloudRequiresExplicitHTTPSOriginAndAccessCode(t *testing.T) {
	for _, origin := range []string{"http://reader.example.invalid", "https://user:pass@example.com", "https://example.com/path", "https://example.com?key=value"} {
		if s, e := New(Config{DataDir: t.TempDir(), PublicOrigin: origin, AccessCode: strings.Repeat("c", 32)}); e == nil {
			s.Close()
			t.Fatal("invalid public origin accepted", origin)
		}
	}
	if s, e := New(Config{DataDir: t.TempDir(), PublicOrigin: "https://reader.example.invalid"}); e == nil {
		s.Close()
		t.Fatal("cloud without strong access code accepted")
	}
}
func TestCloudOriginSessionAndFilesystemBoundary(t *testing.T) {
	c := newClient(t, Config{PublicOrigin: "https://reader.example.invalid", AccessCode: strings.Repeat("c", 32)})
	request := func(method, target, origin string, b any, cookie *http.Cookie, csrf string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, target, strings.NewReader(js(b)))
		r.Header.Set("Origin", origin)
		r.Header.Set("X-CSRF-Token", csrf)
		r.Header.Set("X-Forwarded-Host", "reader.example.invalid")
		r.Header.Set("X-Forwarded-Proto", "https")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		rec := httptest.NewRecorder()
		c.s.Handler().ServeHTTP(rec, r)
		return rec
	}
	base := "https://reader.example.invalid"
	if r := request("GET", base+"/api/workspaces", "", nil, nil, ""); r.Code != 401 {
		t.Fatal("anonymous access", r.Code)
	}
	if r := request("POST", base+"/api/session", "https://evil.example", M{"code": c.s.PairCode()}, nil, ""); r.Code != 403 {
		t.Fatal("foreign origin login", r.Code)
	}
	if r := request("POST", base+"/api/session", base, M{"code": "wrong"}, nil, ""); r.Code != 401 {
		t.Fatal("wrong access code", r.Code)
	}
	rec := request("POST", base+"/api/session", base, M{"code": c.s.PairCode()}, nil, "")
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	cookie := rec.Result().Cookies()[0]
	if !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("insecure public session cookie")
	}
	var login M
	json.Unmarshal(rec.Body.Bytes(), &login)
	csrf := str(login, "csrf")
	if r := request("GET", "https://evil.example/api/workspaces", base, nil, cookie, csrf); r.Code != 403 {
		t.Fatal("forwarded header bypassed host allowlist", r.Code)
	}
	if r := request("POST", base+"/api/workspaces", base, M{"name": "rejected"}, cookie, "wrong"); r.Code != 403 {
		t.Fatal("CSRF accepted", r.Code)
	}
	if r := request("GET", base+"/api/me", base, nil, cookie, csrf); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	w := c.workspace("云端空间")
	for _, route := range []string{"/api/local-picker/sessions", "/api/workspaces/" + str(w, "id") + "/sources"} {
		r := request("POST", base+route, base, M{"path": "/etc"}, cookie, csrf)
		if r.Code != 403 || !strings.Contains(r.Body.String(), "REMOTE_IMPORT_ONLY") {
			t.Fatal("server filesystem exposed", route, r.Code)
		}
	}
}
func TestCloudUploadedDocumentsSurviveRestart(t *testing.T) {
	cfg := Config{PublicOrigin: "https://reader.example.invalid", AccessCode: strings.Repeat("c", 32), DataDir: t.TempDir()}
	c := newClient(t, cfg)
	w := c.workspace("个人阅读")
	var input bytes.Buffer
	form := multipart.NewWriter(&input)
	part, _ := form.CreateFormFile("files", "云端导入.txt")
	part.Write([]byte("上传的材料和阅读记录保存在独立持久卷。"))
	form.Close()
	r := httptest.NewRequest("POST", "https://reader.example.invalid/api/workspaces/"+str(w, "id")+"/imports", &input)
	r.AddCookie(c.cookie)
	r.Header.Set("Content-Type", form.FormDataContentType())
	r.Header.Set("Origin", cfg.PublicOrigin)
	r.Header.Set("X-CSRF-Token", c.csrf)
	rec := httptest.NewRecorder()
	c.s.Handler().ServeHTTP(rec, r)
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	docs := c.documents(w)
	if len(docs) != 1 {
		t.Fatal(docs)
	}
	c.prepare(docs[0])
	before := c.cookie
	code := c.s.PairCode()
	c.s.Close()
	other := newClient(t, cfg)
	if other.s.PairCode() != code || len(other.documents(w)) != 1 {
		t.Fatal("cloud access code or data changed on restart")
	}
	other.cookie = before
	if status, _ := other.req("GET", "/api/me", nil); status != 401 {
		t.Fatal("old session survived restart", status)
	}
}
