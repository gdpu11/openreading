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
	var empty M
	raw := deviceReq(c, token, "GET", "/api/sync/reading", nil)
	json.Unmarshal(raw.Body.Bytes(), &empty)
	if raw.Code != 200 || len(arr(empty, "events")) != 0 || len(arr(empty, "memberIds")) != 1 || arr(empty, "memberIds")[0] != doc["id"] {
		t.Fatal("lightweight scope must include unread books", empty)
	}
	start := time.Now().Add(-time.Hour).UnixMilli()
	event := M{"id": id(), "member": doc["id"], "startedAt": start, "endedAt": start + 30000, "words": 150}
	c.ok("POST", "/api/reading/events", M{"events": []M{event}})
	c.ok("POST", "/api/reading/events", M{"events": []M{event}})
	c.ok("POST", "/api/reading/events", M{"events": []M{{"id": event["id"], "member": doc["id"], "startedAt": start, "endedAt": start + 30000}}})
	if status, _ := c.req("POST", "/api/reading/events", M{"events": []M{{"id": event["id"], "member": doc["id"], "startedAt": start, "endedAt": start + 30000, "words": 151}}}); status != 409 {
		t.Fatal("mutable word receipt", status)
	}
	if len(arr(c.ok("GET", "/api/reading", nil), "events")) != 1 {
		t.Fatal("duplicate receipt counted")
	}
	changed := M{"id": event["id"], "member": doc["id"], "startedAt": start, "endedAt": start + 31000}
	if status, _ := c.req("POST", "/api/reading/events", M{"events": []M{changed}}); status != 409 {
		t.Fatal("mutable receipt", status)
	}
	good := M{"id": id(), "member": doc["id"], "startedAt": start + 30000, "endedAt": start + 60000, "words": 150}
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
	hidden := M{"id": id(), "member": private, "startedAt": start, "endedAt": start + 20000, "words": 100}
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
	for _, raw := range arr(response, "events") {
		if num(raw.(map[string]any), "words") != 150 {
			t.Fatal("phone lost measured words", raw)
		}
	}
	if len(arr(response, "memberIds")) != 1 || arr(response, "memberIds")[0] != doc["id"] {
		t.Fatal("reading scope disclosed another workspace", response)
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
	if pace := c.ok("GET", "/api/reading/pace", nil); num(pace, "words") != 300 || num(pace, "milliseconds") != 60000 {
		t.Fatal("restore duplicated measurements or lost words", pace)
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
	for _, event := range persisted["events"].([]M) {
		if num(event, "words") == 0 {
			t.Fatal("restart lost word counts", event)
		}
	}
}

func TestReadingPaceThresholdAndReceiptUpgrade(t *testing.T) {
	c, _, doc := syncSetup(t)
	start := time.Now().Add(-3 * time.Hour).UnixMilli()
	legacy := M{"id": id(), "member": doc["id"], "startedAt": start - 60000, "endedAt": start - 30000}
	c.ok("POST", "/api/reading/events", M{"events": []M{legacy}})
	if pace := c.ok("GET", "/api/reading/pace", nil); num(pace, "words") != 0 || num(pace, "milliseconds") != 0 {
		t.Fatal("invented old words", pace)
	}
	legacy["words"] = 250
	c.ok("POST", "/api/reading/events", M{"events": []M{legacy}})
	var samples []M
	for i := 0; i < 59; i++ {
		samples = append(samples, M{"id": id(), "member": doc["id"], "startedAt": start + int64(i)*60000, "endedAt": start + int64(i+1)*60000, "words": 500})
	}
	c.ok("POST", "/api/reading/events", M{"events": samples})
	if pace := c.ok("GET", "/api/reading/pace", nil); num(pace, "speed") != 300 || pace["learned"] != false {
		t.Fatal("learned before one hour", pace)
	}
	last := M{"id": id(), "member": doc["id"], "startedAt": start + 59*60000, "endedAt": start + 60*60000, "words": 500}
	c.ok("POST", "/api/reading/events", M{"events": []M{last}})
	if pace := c.ok("GET", "/api/reading/pace", nil); num(pace, "speed") != 500 || pace["learned"] != true || num(pace, "words") != 30250 {
		t.Fatal("personal speed not learned", pace)
	}
	overlap := M{"id": id(), "member": doc["id"], "startedAt": start, "endedAt": start + 60000, "words": 500}
	c.ok("POST", "/api/reading/events", M{"events": []M{overlap}})
	if pace := c.ok("GET", "/api/reading/pace", nil); num(pace, "words") != 30250 {
		t.Fatal("overlapping devices double counted", pace)
	}
	for _, words := range []any{-1, 1.5, "100", nil, 100001} {
		bad := M{"id": id(), "member": doc["id"], "startedAt": start, "endedAt": start + 30000, "words": words}
		if status, _ := c.req("POST", "/api/reading/events", M{"events": []M{bad}}); status != 400 {
			t.Fatal("invalid word count accepted", words, status)
		}
	}
}
