package server

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func TestReadingReceiptsScopeBackupAndRestart(t *testing.T) {
	c, ws, doc := syncSetup(t)
	token, _ := approveDevice(t, c, ws)
	start := time.Now().Add(-time.Hour).UnixMilli()
	event := M{"id": id(), "member": doc["id"], "startedAt": start, "endedAt": start + 30000}
	c.ok("POST", "/api/reading/events", M{"events": []M{event}})
	c.ok("POST", "/api/reading/events", M{"events": []M{event}})
	if len(arr(c.ok("GET", "/api/reading", nil), "events")) != 1 {
		t.Fatal("duplicate receipt counted")
	}
	changed := M{"id": event["id"], "member": doc["id"], "startedAt": start, "endedAt": start + 31000}
	if status, _ := c.req("POST", "/api/reading/events", M{"events": []M{changed}}); status != 409 {
		t.Fatal("mutable receipt", status)
	}
	good := M{"id": id(), "member": doc["id"], "startedAt": start + 30000, "endedAt": start + 60000}
	bad := M{"id": id(), "member": doc["id"], "startedAt": start, "endedAt": start + 60001}
	if status, _ := c.req("POST", "/api/reading/events", M{"events": []M{good, bad}}); status != 400 {
		t.Fatal("invalid interval", status)
	}
	if len(arr(c.ok("GET", "/api/reading", nil), "events")) != 1 {
		t.Fatal("batch not atomic")
	}
	if r := deviceReq(c, token, "POST", "/api/sync/reading/events", M{"events": []M{good}}); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	other := c.workspace("不向手机公开")
	private := id()
	if e := exec(c.s.db, "INSERT INTO workspace_documents(id,workspace_id,document_id) VALUES(?,?,?)", private, other["id"], doc["documentId"]); e != nil {
		t.Fatal(e)
	}
	hidden := M{"id": id(), "member": private, "startedAt": start, "endedAt": start + 20000}
	c.ok("POST", "/api/reading/events", M{"events": []M{hidden}})
	global := arr(c.ok("GET", "/api/reading", nil), "events")
	if len(global) != 3 {
		t.Fatal("desktop must include reading events from every workspace", global)
	}
	bookHistory := arr(c.ok("GET", "/api/reading/documents/"+str(doc, "id"), nil), "events")
	if len(bookHistory) != 2 {
		t.Fatal("book reading history must exclude other workspace documents", bookHistory)
	}
	for _, raw := range bookHistory {
		if str(raw.(map[string]any), "member") != str(doc, "id") {
			t.Fatal("another book leaked into cumulative reading time", raw)
		}
	}
	if status, _ := c.req("GET", "/api/reading/documents/"+id(), nil); status != 404 {
		t.Fatal("unknown book reading history", status)
	}
	seen := map[string]bool{}
	for _, raw := range global {
		seen[str(raw.(map[string]any), "member")] = true
	}
	if !seen[str(doc, "id")] || !seen[private] {
		t.Fatal("desktop reading data omitted a workspace", seen)
	}
	if r := deviceReq(c, token, "POST", "/api/sync/reading/events", M{"events": []M{hidden}}); r.Code != 403 {
		t.Fatal("phone scope write", r.Code)
	}
	var response M
	r := deviceReq(c, token, "GET", "/api/sync/reading", nil)
	json.Unmarshal(r.Body.Bytes(), &response)
	if r.Code != 200 || len(arr(response, "events")) != 2 {
		t.Fatal("phone scope read", r.Code, response)
	}
	c.ok("PUT", "/api/reading/goal", M{"minutes": 20})
	if num(c.ok("GET", "/api/reading", nil), "goalMinutes") != 20 {
		t.Fatal("goal not saved")
	}
	if status, _ := c.req("PUT", "/api/reading/goal", M{"minutes": 1.2}); status != 400 {
		t.Fatal("fractional goal")
	}
	backup, e := c.s.backup()
	if e != nil {
		t.Fatal(e)
	}
	preview, e := c.s.restorePreview(filepath.Join(c.s.cfg.DataDir, "backups", str(backup, "id")+".zip"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = c.s.restoreCommit(str(preview, "id")); e != nil {
		t.Fatal(e)
	}
	if len(arr(c.ok("GET", "/api/reading", nil), "events")) != 6 {
		t.Fatal("backup reading records lost")
	}
	cfg := c.s.cfg
	c.s.Close()
	reopened, e := New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Close()
	persisted, e := reopened.readingData(reopened.db, nil)
	if e != nil || len(persisted["events"].([]M)) != 6 || num(persisted, "goalMinutes") != 20 {
		t.Fatal("restart lost reading data", persisted, e)
	}
}
