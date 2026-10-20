package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func importSyncFile(t *testing.T, c *testClient, ws M, name string, content []byte) M {
	t.Helper()
	var data bytes.Buffer
	form := multipart.NewWriter(&data)
	part, _ := form.CreateFormFile("files", name)
	part.Write(content)
	form.Close()
	r := httptest.NewRequest("POST", "http://127.0.0.1:7318/api/workspaces/"+str(ws, "id")+"/imports", &data)
	r.Header.Set("Content-Type", form.FormDataContentType())
	r.Header.Set("X-CSRF-Token", c.csrf)
	r.AddCookie(c.cookie)
	rec := httptest.NewRecorder()
	c.s.Handler().ServeHTTP(rec, r)
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	docs, err := all(c.s.db, "SELECT wd.*,d.format FROM workspace_documents wd JOIN documents d ON d.id=wd.document_id JOIN document_bindings b ON b.workspace_document_id=wd.id JOIN source_entries e ON e.id=b.source_entry_id WHERE wd.workspace_id=? AND e.relative_path=?", ws["id"], "01_"+name)
	if err != nil || len(docs) != 1 {
		t.Fatal(err, docs)
	}
	return docs[0]
}

func syncSnapshot(t *testing.T, c *testClient, token string) M {
	t.Helper()
	rec := deviceReq(c, token, "GET", "/api/sync/library", nil)
	var result M
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &result) != nil {
		t.Fatal(rec.Code, rec.Body.String())
	}
	return result
}

func snapshotIDs(snapshot M) map[string]bool {
	ids := map[string]bool{}
	for _, raw := range arr(snapshot, "workspaces") {
		for _, doc := range arr(raw.(map[string]any), "documents") {
			ids[str(doc.(map[string]any), "id")] = true
		}
	}
	return ids
}

func TestSyncFileScopeApprovalEnforcementAndUpdates(t *testing.T) {
	c, ws, txt := syncSetup(t)
	for _, name := range []string{"可靠接口.epub", "双栏与扫描混合.pdf"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "fixtures", name))
		if err != nil {
			t.Fatal(err)
		}
		importSyncFile(t, c, ws, name, data)
	}
	markdown := importSyncFile(t, c, ws, "选中的笔记.md", []byte("# 内容"))
	prepared := c.prepare(txt)
	version := obj(prepared, "version")
	sample := c.extraction(ws, txt, prepared, "", "原文选区，用于电脑和手机的文件与笔记同步。")
	token, device := approveDevice(t, c, ws)
	op := M{"operationId": id(), "type": "create", "member": txt["id"], "anchor": sample.anchor, "artifact": M{"blocks": sample.artifact["blocks"]}, "body": "私密笔记"}
	if rec := deviceReq(c, token, "POST", "/api/sync/commands", op); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	start := time.Now().Add(-time.Hour).UnixMilli()
	for _, doc := range []M{txt, markdown} {
		c.ok("POST", "/api/reading/events", M{"events": []M{{"id": id(), "member": doc["id"], "startedAt": start, "endedAt": start + 30000}}})
	}
	update := func(scope M) {
		c.ok("PUT", "/api/devices/"+str(device, "id")+"/scope", M{"workspaceIds": []any{ws["id"]}, "syncScope": scope})
	}
	update(M{"mode": "formats", "formats": []string{"pdf", "epub"}})
	snapshot := syncSnapshot(t, c, token)
	ids := snapshotIDs(snapshot)
	if len(ids) != 2 || ids[str(txt, "id")] || ids[str(markdown, "id")] || bytes.Contains([]byte(js(snapshot)), []byte("私密笔记")) {
		t.Fatal(snapshot)
	}
	if len(arr(obj(snapshot, "readingData"), "events")) != 0 {
		t.Fatal("reading data leaked", snapshot)
	}
	for _, path := range []string{
		"/api/sync/files/" + str(version, "id") + "?member=" + str(txt, "id"),
		"/api/sync/resources/" + id() + "?member=" + str(txt, "id") + "&path=cover.png",
		"/api/sync/documents/" + str(txt, "id") + "/ord",
	} {
		if rec := deviceReq(c, token, "GET", path, nil); rec.Code != 403 {
			t.Fatal("file scope bypass", path, rec.Code)
		}
	}
	if rec := deviceReq(c, token, "POST", "/api/sync/commands", op); rec.Code != 403 {
		t.Fatal("idempotent note replay bypassed new scope", rec.Code)
	}
	if rec := deviceReq(c, token, "GET", "/api/pair/catalog", nil); rec.Code == 200 {
		t.Fatal("phone read desktop catalog")
	}
	if rec := deviceReq(c, token, "POST", "/api/sync/reading/events", M{"events": []M{{"id": id(), "member": txt["id"], "startedAt": start, "endedAt": start + 10000}}}); rec.Code != 403 {
		t.Fatal("reading write bypass", rec.Code)
	}
	update(M{"mode": "manual", "memberIds": []any{markdown["id"]}})
	later := importSyncFile(t, c, ws, "新增笔记.md", []byte("以后新加的内容"))
	snapshot = syncSnapshot(t, c, token)
	ids = snapshotIDs(snapshot)
	if len(ids) != 1 || !ids[str(markdown, "id")] || len(arr(obj(snapshot, "readingData"), "events")) != 1 {
		t.Fatal("manual scope", snapshot)
	}
	update(M{"mode": "formats", "formats": []string{"markdown"}})
	ids = snapshotIDs(syncSnapshot(t, c, token))
	if len(ids) != 2 || !ids[str(later, "id")] {
		t.Fatal("new matching file excluded", ids)
	}
	// File selection is persisted across restarts; existing device tokens still work.
	cfg := c.s.cfg
	c.s.Close()
	c = newClient(t, cfg)
	ids = snapshotIDs(syncSnapshot(t, c, token))
	if len(ids) != 2 || ids[str(txt, "id")] {
		t.Fatal("restart lost scope", ids)
	}
	// Re-pairing replaces a prior scope, including explicit restoration to all files.
	grant := c.ok("POST", "/api/pair/grants", M{"workspaceIds": []any{ws["id"]}, "syncScope": M{"mode": "manual", "memberIds": []any{txt["id"]}}})
	if rec := deviceReq(c, token, "POST", "/api/pair/claim", M{"id": grant["id"], "secret": grant["secret"], "token": token, "name": "同一部手机"}); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	c.ok("POST", "/api/pair/grants/"+str(grant, "id")+"/approve", M{})
	ids = snapshotIDs(syncSnapshot(t, c, token))
	if len(ids) != 1 || !ids[str(txt, "id")] {
		t.Fatal("grant scope not transferred", ids)
	}
	update(M{"mode": "all"})
	if ids = snapshotIDs(syncSnapshot(t, c, token)); len(ids) != 5 {
		t.Fatal("all files", ids)
	}
}

func TestSyncScopeValidationAndLegacyDevices(t *testing.T) {
	c, ws, doc := syncSetup(t)
	token, device := approveDevice(t, c, ws)
	other := c.workspace("其他工作区")
	for _, scope := range []any{nil, "all", M{}, M{"mode": "formats", "formats": []string{}}, M{"mode": "formats", "formats": []string{"exe"}}, M{"mode": "manual", "memberIds": []any{}}, M{"mode": "manual", "memberIds": []any{id()}}, M{"mode": "manual", "memberIds": []any{123}}, M{"mode": "invalid"}} {
		b := M{"workspaceIds": []any{ws["id"]}, "syncScope": scope}
		for _, route := range []struct{ method, path string }{{"POST", "/api/pair/grants"}, {"PUT", "/api/devices/" + str(device, "id") + "/scope"}} {
			if status, _ := c.req(route.method, route.path, b); status != 400 {
				t.Fatal("invalid scope accepted", scope, status)
			}
		}
	}
	if status, _ := c.req("PUT", "/api/devices/"+str(device, "id")+"/scope", M{"workspaceIds": []any{other["id"]}, "syncScope": M{"mode": "manual", "memberIds": []any{doc["id"]}}}); status != 400 {
		t.Fatal("cross workspace file accepted", status)
	}
	if ids := snapshotIDs(syncSnapshot(t, c, token)); len(ids) != 1 {
		t.Fatal("invalid updates changed permissions", ids)
	}
	// Schema 4 devices have no scope row; upgrading retains their existing access.
	if e := exec(c.s.db, "DELETE FROM device_sync_scopes WHERE device_id=?", device["id"]); e != nil {
		t.Fatal(e)
	}
	if ids := snapshotIDs(syncSnapshot(t, c, token)); !ids[str(doc, "id")] {
		t.Fatal("legacy device lost access")
	}
	if e := exec(c.s.db, "INSERT INTO library_books(workspace_document_id,removed_at) VALUES(?,?) ON CONFLICT(workspace_document_id) DO UPDATE SET removed_at=excluded.removed_at", doc["id"], now()); e != nil {
		t.Fatal(e)
	}
	if status, _ := c.req("POST", "/api/pair/grants", M{"workspaceIds": []any{ws["id"]}, "syncScope": M{"mode": "manual", "memberIds": []any{doc["id"]}}}); status != 400 {
		t.Fatal("removed file selectable", status)
	}
}
