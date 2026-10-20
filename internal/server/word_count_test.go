package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBookWordCountCache(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("中文 hello world")
	oldVersion := str(obj(x.prepared, "version"), "id")
	endpoint := func(version string) string {
		return "/api/versions/" + version + "/word-count?workspaceDocumentId=" + str(x.d, "id") + "&rule=body-mixed-v1&encoding=utf-8"
	}
	url := endpoint(oldVersion)
	if c.ok("GET", url, nil)["statistics"] != nil {
		t.Fatal("unexpected cache")
	}
	for _, body := range []M{{}, {"count": nil}, {"count": -1}, {"count": 1.5}, {"count": 2, "pages": 1, "textPages": 1}} {
		if code, _ := c.req("PUT", url, body); code != 400 {
			t.Fatal("accepted invalid count", code, body)
		}
	}
	for _, auth := range []bool{false, true} {
		method := "GET"
		if auth {
			method = "PUT"
		}
		req := httptest.NewRequest(method, "http://127.0.0.1:7318"+url, strings.NewReader(`{"count":4}`))
		if auth {
			req.AddCookie(c.cookie)
		} // No CSRF token.
		rec := httptest.NewRecorder()
		c.s.Handler().ServeHTTP(rec, req)
		expected := 401
		if auth {
			expected = 403
		}
		if rec.Code != expected {
			t.Fatal("cache bypassed authentication", rec.Code)
		}
	}
	c.ok("PUT", url, M{"count": 4})
	if obj(c.ok("GET", url, nil), "statistics")["count"] != float64(4) {
		t.Fatal("count not cached")
	}
	// Different decoding must not reuse a UTF-8 count.
	if c.ok("GET", strings.Replace(url, "utf-8", "gb18030", 1), nil)["statistics"] != nil {
		t.Fatal("encoding cache collision")
	}
	if code, _ := c.req("GET", strings.Replace(url, "body-mixed-v1", "../../bad", 1), nil); code != 400 {
		t.Fatal("invalid rule allowed")
	}
	other := c.sample("A different book")
	if code, _ := c.req("GET", strings.Replace(url, str(x.d, "id"), str(other.d, "id"), 1), nil); code != 404 {
		t.Fatal("wrong member accepted", code)
	}
	// A changed source produces a new version; the old immutable version keeps its count.
	if e := os.WriteFile(filepath.Join(x.root, "材料.txt"), []byte("A new longer book body"), 0600); e != nil {
		t.Fatal(e)
	}
	updated := c.prepare(x.d)
	newVersion := str(obj(updated, "version"), "id")
	if oldVersion == newVersion {
		t.Fatal("fixture did not change version")
	}
	if c.ok("GET", endpoint(newVersion), nil)["statistics"] != nil {
		t.Fatal("reused stale count")
	}
	if obj(c.ok("GET", url, nil), "statistics")["count"] != float64(4) {
		t.Fatal("lost historical count")
	}
}
