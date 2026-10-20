package server

import (
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyncFileAndResourceRangesRemainScopedAndVisibleToNativeClients(t *testing.T) {
	c, ws, doc := syncSetup(t)
	token, _ := approveDevice(t, c, ws)
	prepared := c.prepare(doc)
	version := obj(prepared, "version")
	content, e := os.ReadFile(filepath.Join(c.s.cfg.DataDir, "blobs", str(version, "contentHash")))
	if e != nil {
		t.Fatal(e)
	}
	resource := []byte("a cached resource downloaded in separate byte ranges")
	hash := digest(resource)
	if e = os.WriteFile(filepath.Join(c.s.cfg.DataDir, "blobs", hash), resource, 0600); e != nil {
		t.Fatal(e)
	}
	manifest := id()
	entry := arr(doc, "bindings")[0].(map[string]any)
	if e = exec(c.s.db, "INSERT INTO manifests VALUES(?,?,?,?,?)", manifest, version["id"], entry["id"], js([]M{{"path": "image.bin", "blobHash": hash, "mime": "application/octet-stream"}}), now()); e != nil {
		t.Fatal(e)
	}
	for _, file := range []struct {
		path  string
		bytes []byte
	}{
		{"/api/sync/files/" + str(version, "id") + "?member=" + str(doc, "id"), content},
		{"/api/sync/resources/" + manifest + "?member=" + str(doc, "id") + "&path=image.bin", resource},
	} {
		for _, start := range []int{0, 7} {
			r := httptest.NewRequest("GET", "https://reader.example.invalid"+file.path, nil)
			r.Header.Set("Origin", "capacitor://localhost")
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, start+6))
			w := httptest.NewRecorder()
			c.s.Handler().ServeHTTP(w, r)
			if w.Code != 206 || w.Body.String() != string(file.bytes[start:start+7]) || w.Header().Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", start, start+6, len(file.bytes)) {
				t.Fatal(w.Code, w.Header(), w.Body.String())
			}
			if !strings.Contains(w.Header().Get("Access-Control-Expose-Headers"), "Content-Range") {
				t.Fatal("range header not visible to native WebView fetch")
			}
		}
	}
	r := httptest.NewRequest("OPTIONS", "https://reader.example.invalid/api/sync/files/version", nil)
	r.Header.Set("Origin", "capacitor://localhost")
	r.Header.Set("Access-Control-Request-Headers", "Authorization, Range")
	w := httptest.NewRecorder()
	c.s.Handler().ServeHTTP(w, r)
	if w.Code != 204 || !strings.Contains(w.Header().Get("Access-Control-Allow-Headers"), "Range") {
		t.Fatal("range preflight", w.Code, w.Header())
	}
}
