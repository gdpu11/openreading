package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func deviceReq(c *testClient, token, method, path string, b any) *httptest.ResponseRecorder {
	origin := c.s.cfg.PublicOrigin
	if origin == "" {
		origin = "http://127.0.0.1:7318"
	}
	r := httptest.NewRequest(method, origin+path, strings.NewReader(js(b)))
	r.Header.Set("Origin", "capacitor://localhost")
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c.s.Handler().ServeHTTP(w, r)
	return w
}
func syncSetup(t *testing.T) (*testClient, M, M) {
	c := newClient(t, Config{PublicOrigin: "https://reader.example.invalid", AccessCode: strings.Repeat("c", 32)})
	ws := c.workspace("手机同步")
	var data bytes.Buffer
	form := multipart.NewWriter(&data)
	part, _ := form.CreateFormFile("files", "离线阅读.txt")
	part.Write([]byte("原文选区，用于电脑和手机的文件与笔记同步。"))
	form.Close()
	r := httptest.NewRequest("POST", "http://127.0.0.1:7318/api/workspaces/"+str(ws, "id")+"/imports", &data)
	r.Header.Set("Content-Type", form.FormDataContentType())
	r.Header.Set("X-CSRF-Token", c.csrf)
	r.AddCookie(c.cookie)
	rec := httptest.NewRecorder()
	c.s.Handler().ServeHTTP(rec, r)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	return c, ws, c.documents(ws)[0]
}
func claimDevice(t *testing.T, c *testClient, ws M) (string, M) {
	grant := c.ok("POST", "/api/pair/grants", M{"workspaceIds": []string{str(ws, "id")}})
	token := id() + id()
	rec := deviceReq(c, token, "POST", "/api/pair/claim", M{"id": grant["id"], "secret": grant["secret"], "token": token, "name": "测试手机"})
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	return token, grant
}
func approveDevice(t *testing.T, c *testClient, ws M) (string, M) {
	token, g := claimDevice(t, c, ws)
	d := c.ok("POST", "/api/pair/grants/"+str(g, "id")+"/approve", M{})
	return token, d
}
func TestSyncPairApprovalScopeAndRevocation(t *testing.T) {
	c, ws, doc := syncSetup(t)
	token, g := claimDevice(t, c, ws)
	if rec := deviceReq(c, token, "GET", "/api/sync/library", nil); rec.Code != 401 {
		t.Fatal("unapproved device allowed", rec.Code)
	}
	rec := deviceReq(c, id()+id(), "POST", "/api/pair/claim", M{"id": g["id"], "secret": g["secret"], "token": id() + id(), "name": "replay"})
	if rec.Code != 409 {
		t.Fatal("grant replay", rec.Code)
	}
	d := c.ok("POST", "/api/pair/grants/"+str(g, "id")+"/approve", M{})
	rec = deviceReq(c, token, "GET", "/api/sync/library", nil)
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var snapshot M
	json.Unmarshal(rec.Body.Bytes(), &snapshot)
	docs := arr(arr(snapshot, "workspaces")[0].(map[string]any), "documents")
	if len(docs) != 1 {
		t.Fatal(snapshot)
	}
	download := docs[0].(map[string]any)
	v := obj(download, "version")
	rec = deviceReq(c, token, "GET", "/api/sync/files/"+str(v, "id")+"?member="+str(doc, "id"), nil)
	if rec.Code != 200 || digest(rec.Body.Bytes()) != str(v, "contentHash") {
		t.Fatal("file integrity", rec.Code)
	}
	if rec = deviceReq(c, token, "GET", "/api/providers", nil); rec.Code != 403 {
		t.Fatal("device accessed admin API", rec.Code)
	}
	other := c.workspace("未授权")
	exec(c.s.db, "UPDATE workspace_documents SET workspace_id=? WHERE id=?", other["id"], doc["id"])
	if rec = deviceReq(c, token, "GET", "/api/sync/files/"+str(v, "id")+"?member="+str(doc, "id"), nil); rec.Code != 403 {
		t.Fatal("scope bypass", rec.Code)
	}
	c.ok("DELETE", "/api/devices/"+str(d, "id"), nil)
	if rec = deviceReq(c, token, "GET", "/api/sync/library", nil); rec.Code != 401 {
		t.Fatal("revoked credential accepted", rec.Code)
	}
	var raw string
	c.s.db.QueryRow("SELECT token_hash FROM paired_devices WHERE id=?", d["id"]).Scan(&raw)
	if raw == token || raw != digest([]byte(token)) {
		t.Fatal("plaintext device token stored")
	}
}
func TestSyncOfflineCommandsIdempotencyConflictAndRestart(t *testing.T) {
	c, ws, doc := syncSetup(t)
	token, _ := approveDevice(t, c, ws)
	// Phone snapshot also captures an imported file never opened on the PC.
	if rec := deviceReq(c, token, "GET", "/api/sync/library", nil); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	prepared := c.prepare(doc)
	sample := c.extraction(ws, doc, prepared, "", "原文选区，用于电脑和手机的文件与笔记同步。")
	op := M{"operationId": id(), "type": "create", "member": doc["id"], "anchor": sample.anchor, "artifact": M{"blocks": sample.artifact["blocks"]}, "body": "手机离线笔记"}
	// Exercise the actual decoded wire body, not a shared mutable map.
	var wg sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); results <- deviceReq(c, token, "POST", "/api/sync/commands", op) }()
	}
	wg.Wait()
	close(results)
	var created M
	for rec := range results {
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		var v M
		json.Unmarshal(rec.Body.Bytes(), &v)
		if created != nil && str(v, "messageId") != str(created, "messageId") {
			t.Fatal("duplicate operation created two messages")
		}
		created = v
	}
	threads := c.list("/api/documents/" + str(doc, "id") + "/threads")
	if len(threads) != 1 {
		t.Fatal("duplicate annotation", threads)
	}
	message := arr(threads[0].(map[string]any), "messages")[0].(map[string]any)
	op = M{"operationId": id(), "type": "edit", "member": doc["id"], "messageId": message["id"], "revision": message["revision"], "body": "手机更新"}
	for range 2 {
		if rec := deviceReq(c, token, "POST", "/api/sync/commands", op); rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
	}
	op["operationId"] = id()
	op["body"] = "另一个设备的旧版本"
	if rec := deviceReq(c, token, "POST", "/api/sync/commands", op); rec.Code != 409 {
		t.Fatal("stale note overwrote newer revision", rec.Code)
	}
	config := c.s.cfg
	c.s.Close()
	restarted := newClient(t, config)
	if rec := deviceReq(restarted, token, "GET", "/api/sync/library", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), "手机更新") {
		t.Fatal("restart lost paired device or notes", rec.Code, rec.Body.String())
	}
}
func TestSyncExpiryOriginAndConcurrentPairClaim(t *testing.T) {
	c, ws, _ := syncSetup(t)
	g := c.ok("POST", "/api/pair/grants", M{"workspaceIds": []string{str(ws, "id")}})
	exec(c.s.db, "UPDATE pairing_grants SET expires_at=? WHERE id=?", time.Now().Add(-time.Second).Unix(), g["id"])
	if rec := deviceReq(c, id()+id(), "POST", "/api/pair/claim", M{"id": g["id"], "secret": g["secret"], "name": "过期", "token": id() + id()}); rec.Code != 401 {
		t.Fatal("expired grant", rec.Code)
	}
	g = c.ok("POST", "/api/pair/grants", M{"workspaceIds": []string{str(ws, "id")}})
	results := make(chan int, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- deviceReq(c, "", "POST", "/api/pair/claim", M{"id": g["id"], "secret": g["secret"], "name": "手机", "token": id() + id()}).Code
		}()
	}
	wg.Wait()
	close(results)
	success := 0
	for status := range results {
		if status == 200 {
			success++
		} else if status != 409 {
			t.Fatal(status)
		}
	}
	if success != 1 {
		t.Fatal("two devices claimed same QR")
	}
	r := httptest.NewRequest("OPTIONS", "https://reader.example.invalid/api/sync/library", nil)
	r.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	c.s.Handler().ServeHTTP(rec, r)
	if rec.Code != 403 {
		t.Fatal("untrusted CORS origin")
	}
	r.Header.Set("Origin", "capacitor://localhost")
	rec = httptest.NewRecorder()
	c.s.Handler().ServeHTTP(rec, r)
	if rec.Code != 204 || rec.Header().Get("Access-Control-Allow-Origin") != "capacitor://localhost" || rec.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("native preflight", rec.Code)
	}
}

func TestSyncReauthorizationKeepsDeviceIdentityAndOperationReceipts(t *testing.T) {
	c, ws, _ := syncSetup(t)
	token, d := approveDevice(t, c, ws)
	c.ok("DELETE", "/api/devices/"+str(d, "id"), nil)
	grant := c.ok("POST", "/api/pair/grants", M{"workspaceIds": []string{str(ws, "id")}})
	if rec := deviceReq(c, token, "POST", "/api/pair/claim", M{"id": grant["id"], "secret": grant["secret"], "token": token, "name": "重新授权"}); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if rec := deviceReq(c, token, "GET", "/api/sync/library", nil); rec.Code != 401 {
		t.Fatal("re-authorized before PC confirmation")
	}
	status := deviceReq(c, token, "GET", "/api/pair/status?grant="+str(grant, "id"), nil)
	var pending M
	json.Unmarshal(status.Body.Bytes(), &pending)
	if status.Code != 200 || str(pending, "state") != "claimed" {
		t.Fatal("old approval satisfied a new pending grant", status.Body.String())
	}
	if status = deviceReq(c, token, "GET", "/api/pair/status?grant="+id(), nil); status.Code != 401 {
		t.Fatal("unrelated grant status exposed")
	}
	reauthorized := c.ok("POST", "/api/pair/grants/"+str(grant, "id")+"/approve", M{})
	if str(reauthorized, "id") != str(d, "id") {
		t.Fatal("reauthorization changed device identity")
	}
	if rec := deviceReq(c, token, "GET", "/api/sync/library", nil); rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
}
