package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestProviderModelsShareCredentialAndFreezeSelection(t *testing.T) {
	received := make(chan M, 4)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b M
		json.NewDecoder(r.Body).Decode(&b)
		b["auth"] = r.Header.Get("Authorization")
		received <- b
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"模型选择正确 [S1]\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer up.Close()
	c := newClient(t, Config{})
	x := c.sample("多平台模型选择需要固定到本次问答的上下文快照。")
	p := c.ok("POST", "/api/providers", M{"name": "多模型平台", "protocol": "openai", "baseUrl": up.URL, "modelId": "alpha", "models": []string{"alpha", "beta"}, "apiKey": "local-test-only", "platformId": "custom"})
	c.ok("POST", "/api/workspaces/"+str(x.w, "id")+"/providers/"+str(p, "id")+"/enable", M{})
	q := c.question(x, p)
	q["modelId"] = "beta"
	r := c.annotate(x, q, "")
	run := c.waitRun(str(r, "runId"))
	captured := <-received
	if str(run, "state") != "completed" || str(captured, "model") != "beta" || str(captured, "auth") != "Bearer local-test-only" {
		t.Fatal(run, captured)
	}
	snapshot, _ := one(c.s.db, "SELECT * FROM contexts WHERE id=?", r["snapshotId"])
	if str(obj(snapshot, "config"), "modelId") != "beta" {
		t.Fatal("selected model not frozen", snapshot)
	}
	// Older clients omit modelId and continue to use the provider's default.
	legacy := c.annotate(x, c.question(x, p), "")
	c.waitRun(str(legacy, "runId"))
	if str(<-received, "model") != "alpha" {
		t.Fatal("legacy default changed")
	}
	q["modelId"] = "unconfigured"
	status, v := c.req("POST", "/api/threads", M{"workspaceDocumentId": x.d["id"], "documentVersionId": obj(x.prepared, "version")["id"], "selectionSnapshot": x.anchor, "message": q, "clientRequestId": id()})
	if status != 400 || str(v.(M), "code") != "INVALID_MODEL" {
		t.Fatal(status, v)
	}
	select {
	case <-received:
		t.Fatal("invalid model was sent upstream")
	default:
	}
	c.ok("DELETE", "/api/workspaces/"+str(x.w, "id")+"/providers/"+str(p, "id")+"/enable", M{})
	preview := M{"workspaceDocumentId": x.d["id"], "anchor": x.anchor, "contextPackage": x.pkg(), "modelProfileId": p["id"], "modelId": "alpha", "contextPolicy": "selection", "body": "解释"}
	if status, _ := c.req("POST", "/api/contexts/preview", preview); status != 403 {
		t.Fatal("disabled provider accepted", status)
	}
	c.ok("DELETE", "/api/providers/"+str(p, "id"), M{"revision": 1})
	if len(c.list("/api/providers")) != 0 {
		t.Fatal("deleted provider still listed")
	}
	if str(c.ok("GET", "/api/ai-runs/"+str(r, "runId"), nil), "body") == "" {
		t.Fatal("deletion removed historical answer")
	}
	// Archive and models survive backup/restore without bringing credentials back.
	backup := c.ok("POST", "/api/backups", M{})
	other := newClient(t, Config{})
	pv, e := other.s.restorePreview(filepath.Join(c.s.cfg.DataDir, "backups", str(backup, "id")+".zip"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = other.s.restoreCommit(str(pv, "id")); e != nil {
		t.Fatal(e)
	}
	if len(other.list("/api/providers")) != 0 {
		t.Fatal("archived provider restored into selector")
	}
	rows, e := all(other.s.db, "PRAGMA foreign_key_check")
	if e != nil || len(rows) != 0 {
		t.Fatal(e, rows)
	}
	restored, _ := one(other.s.db, "SELECT config_json FROM providers LIMIT 1")
	models, _ := normalizedModels(obj(restored, "config"), "")
	if len(models) != 2 {
		t.Fatal("model list lost in backup", restored)
	}
}

func TestProviderDiscoveryAndEndpointCredentialIsolation(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/models" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("incorrect discovery request", r.Method, r.URL, r.Header.Get("Authorization"))
		}
		fmt.Fprint(w, `{"data":[{"id":"b"},{"id":"a"},{"id":"b"}]}`)
	}))
	defer up.Close()
	c := newClient(t, Config{})
	platforms := c.list("/api/provider-platforms")
	if len(platforms) < 5 {
		t.Fatal(platforms)
	}
	draft := M{"protocol": "openai", "baseUrl": up.URL + "/chat/completions/", "apiKey": "test-key"}
	discovered := c.ok("POST", "/api/provider-models", draft)
	if js(discovered["models"]) != `["a","b"]` || len(c.list("/api/providers")) != 0 {
		t.Fatal("discovery unexpectedly persisted draft", discovered)
	}
	b := M{"protocol": "openai", "baseUrl": up.URL, "name": "旧配置", "modelId": "a", "apiKey": "test-key"}
	p := c.ok("POST", "/api/providers", b)
	b["id"] = p["id"]
	b["apiKey"] = ""
	b["revision"] = 1
	kept := c.ok("PATCH", "/api/providers/"+str(p, "id"), b)
	if kept["credentialBound"] != true {
		t.Fatal("blank edit dropped credential")
	}
	c.ok("POST", "/api/provider-models", b)
	// Never reuse an existing key with a new endpoint, including unsaved discovery.
	b["baseUrl"] = "https://different.invalid/v1"
	status, v := c.req("POST", "/api/provider-models", b)
	if status != 400 || str(v.(M), "code") != "CREDENTIAL_MISSING" {
		t.Fatal(status, v)
	}
	b["revision"] = 2
	changed := c.ok("PATCH", "/api/providers/"+str(p, "id"), b)
	if changed["credentialBound"] != false || calls.Load() != 2 {
		t.Fatal(changed, calls.Load())
	}
	legacy := c.list("/api/providers")[0].(M)
	if js(legacy["models"]) != `["a"]` {
		t.Fatal("legacy model not exposed", legacy)
	}
	for _, url := range []string{"http://remote.invalid/v1", "https://user:password@example.com/v1", "https://example.com/v1?key=secret"} {
		if status, _ := c.req("POST", "/api/provider-models", M{"protocol": "openai", "baseUrl": url, "apiKey": "test-key"}); status != 400 {
			t.Fatal("unsafe endpoint accepted", url, status)
		}
	}
	if strings.Contains(js(c.list("/api/providers")), "test-key") {
		t.Fatal("API key leaked")
	}
}

func TestProviderRemovalWaitsForRunningAnswer(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		fmt.Fprint(w, `{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}`)
	}))
	defer up.Close()
	c := newClient(t, Config{})
	x := c.sample("删除平台时保留尚在运行的答案。")
	p := c.ok("POST", "/api/providers", M{"name": "运行中", "protocol": "openai", "baseUrl": up.URL, "modelId": "one", "apiKey": "test-key", "streaming": false})
	c.ok("POST", "/api/workspaces/"+str(x.w, "id")+"/providers/"+str(p, "id")+"/enable", M{})
	r := c.annotate(x, c.question(x, p), "")
	<-started
	status, v := c.req("DELETE", "/api/providers/"+str(p, "id"), M{"revision": 1})
	close(release)
	if status != 409 || str(v.(M), "code") != "PROVIDER_BUSY" {
		t.Fatal(status, v)
	}
	c.waitRun(str(r, "runId"))
	c.ok("DELETE", "/api/providers/"+str(p, "id"), M{"revision": 1})
	if status, _ := c.req("PATCH", "/api/providers/"+str(p, "id"), M{"name": "复活", "protocol": "openai", "baseUrl": up.URL, "modelId": "one", "revision": 2}); status != 404 {
		t.Fatal("archived provider edited", status)
	}
}
