package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testClient struct {
	t      *testing.T
	s      *Server
	cookie *http.Cookie
	csrf   string
}

func newClient(t *testing.T, cfg Config) *testClient {
	t.Helper()
	if cfg.DataDir == "" {
		cfg.DataDir = t.TempDir()
	}
	s, e := New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	c := &testClient{t: t, s: s}
	rec := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "http://127.0.0.1:7318/api/session", strings.NewReader(js(M{"code": s.PairCode()})))
	s.Handler().ServeHTTP(rec, r)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	c.cookie = rec.Result().Cookies()[0]
	var b M
	json.Unmarshal(rec.Body.Bytes(), &b)
	c.csrf = str(b, "csrf")
	return c
}
func (c *testClient) req(method, path string, b any) (int, any) {
	c.t.Helper()
	r := httptest.NewRequest(method, "http://127.0.0.1:7318"+path, strings.NewReader(js(b)))
	r.AddCookie(c.cookie)
	r.Header.Set("X-CSRF-Token", c.csrf)
	rec := httptest.NewRecorder()
	c.s.Handler().ServeHTTP(rec, r)
	var result any
	if e := json.Unmarshal(rec.Body.Bytes(), &result); e != nil {
		result = rec.Body.String()
	}
	return rec.Code, result
}
func (c *testClient) ok(method, path string, b any) M {
	c.t.Helper()
	status, v := c.req(method, path, b)
	if status != 200 {
		c.t.Fatalf("%s %s: %d %v", method, path, status, v)
	}
	m, ok := v.(map[string]any)
	if !ok {
		c.t.Fatalf("not object: %v", v)
	}
	return m
}
func (c *testClient) list(path string) []any {
	c.t.Helper()
	status, v := c.req("GET", path, nil)
	if status != 200 {
		c.t.Fatalf("GET %s: %d %v", path, status, v)
	}
	return v.([]any)
}
func (c *testClient) scan(sourceID string) {
	c.t.Helper()
	j := c.ok("POST", "/api/sources/"+sourceID+"/scan", M{})
	for i := 0; i < 2000; i++ {
		j = c.ok("GET", "/api/scans/"+str(j, "id"), nil)
		if str(j, "state") == "completed" {
			return
		}
		if str(j, "state") == "failed" {
			c.t.Fatal(j)
		}
		time.Sleep(10 * time.Millisecond)
	}
	c.t.Fatal("scan timeout")
}
func (c *testClient) workspace(name string) M {
	return c.ok("POST", "/api/workspaces", M{"name": name})
}
func (c *testClient) source(w M, path string) M {
	v := c.ok("POST", "/api/workspaces/"+str(w, "id")+"/sources", M{"path": path})
	c.scan(str(v, "id"))
	return v
}
func (c *testClient) documents(w M) []M {
	v := c.ok("GET", "/api/workspaces/"+str(w, "id")+"/documents", nil)
	r := []M{}
	for _, d := range arr(v, "items") {
		r = append(r, d.(map[string]any))
	}
	return r
}
func (c *testClient) prepare(d M) M {
	bindings := arr(d, "bindings")
	return c.ok("POST", "/api/documents/"+str(d, "documentId")+"/prepare", M{"workspaceDocumentId": d["id"], "sourceEntryId": bindings[0].(map[string]any)["id"]})
}
func TestM1SourcesIdentitySnapshots(t *testing.T) {
	c := newClient(t, Config{})
	w1, w2 := c.workspace("技术"), c.workspace("论文")
	root := t.TempDir()
	for i := 0; i < 5; i++ {
		p := filepath.Join(root, fmt.Sprint(i))
		os.Mkdir(p, 0700)
		os.WriteFile(filepath.Join(p, "同名.md"), []byte(fmt.Sprintf("内容 %d", i)), 0600)
		c.source(w1, p)
	}
	d1 := c.documents(w1)
	if len(d1) != 5 {
		t.Fatal(d1)
	}
	c.source(w2, filepath.Join(root, "0"))
	d2 := c.documents(w2)
	var same M
	for _, d := range d1 {
		if d["documentId"] == d2[0]["documentId"] {
			same = d
		}
	}
	if same == nil {
		t.Fatal("same physical file not reused")
	}
	a, b := c.prepare(same), c.prepare(d2[0])
	if obj(a, "version")["id"] != obj(b, "version")["id"] {
		t.Fatal("snapshot not reused")
	}
	if same["id"] == d2[0]["id"] {
		t.Fatal("workspace membership merged")
	}
	status, _ := c.req("POST", "/api/documents/"+str(d2[0], "documentId")+"/prepare", M{"workspaceDocumentId": d2[0]["id"], "sourceEntryId": arr(same, "bindings")[0].(map[string]any)["id"]})
	if status != 404 {
		t.Fatalf("cross workspace binding accepted: %d", status)
	}
	if _, e := safeFile(root, "../outside.txt"); e == nil {
		t.Fatal("traversal accepted")
	}
	os.Symlink("/etc/passwd", filepath.Join(root, "escape.txt"))
	if _, e := safeFile(root, "escape.txt"); e == nil {
		t.Fatal("symlink escape accepted")
	}
}
