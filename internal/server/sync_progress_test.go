package server

import (
	"encoding/json"
	"testing"
)

func TestSyncProgressWaitsForPhoneReceiptAndRejectsOldScope(t *testing.T) {
	c, ws, book := syncSetup(t)
	token, device := approveDevice(t, c, ws)
	key := str(device, "id")
	save := func() string {
		return str(c.ok("PUT", "/api/devices/"+key+"/scope", M{"workspaceIds": []any{ws["id"]}, "syncScope": M{"mode": "manual", "memberIds": []any{book["id"]}}}), "revision")
	}
	revision := save()
	p := c.ok("GET", "/api/devices/"+key+"/sync-progress", nil)
	if str(p, "phase") != "waiting" || num(p, "lastSeenAt") != 0 {
		t.Fatal(p)
	}
	snapshot := deviceReq(c, token, "GET", "/api/sync/library", nil)
	if snapshot.Code != 200 {
		t.Fatal(snapshot.Code, snapshot.Body.String())
	}
	var library M
	json.Unmarshal(snapshot.Body.Bytes(), &library)
	if str(library, "scopeRevision") != revision {
		t.Fatal("missing snapshot revision")
	}
	p = c.ok("GET", "/api/devices/"+key+"/sync-progress", nil)
	if str(p, "phase") == "completed" || num(p, "total") != 1 || num(p, "lastSeenAt") == 0 {
		t.Fatal("manifest is not a phone receipt", p)
	}
	report := M{"revision": revision, "phase": "downloading", "done": 0, "total": 1, "title": "离线阅读.txt", "received": 5, "bytes": 10}
	if r := deviceReq(c, token, "POST", "/api/sync/progress", report); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	p = c.ok("GET", "/api/devices/"+key+"/sync-progress", nil)
	if str(p, "phase") != "downloading" || num(p, "received") != 5 {
		t.Fatal(p)
	}
	report["phase"] = "saving"
	report["received"] = 10
	report["message"] = "正在校验并保存到手机"
	if r := deviceReq(c, token, "POST", "/api/sync/progress", report); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	p = c.ok("GET", "/api/devices/"+key+"/sync-progress", nil)
	if str(p, "phase") != "saving" || num(p, "done") != 0 {
		t.Fatal("100% downloaded bytes must not count as a completed book", p)
	}

	report["phase"] = "completed"
	if r := deviceReq(c, token, "POST", "/api/sync/progress", report); r.Code != 400 {
		t.Fatal("accepted incomplete receipt", r.Code)
	}
	report["done"] = 1
	if r := deviceReq(c, token, "POST", "/api/sync/progress", report); r.Code != 200 {
		t.Fatal(r.Code, r.Body.String())
	}
	p = c.ok("GET", "/api/devices/"+key+"/sync-progress", nil)
	if str(p, "phase") != "completed" {
		t.Fatal(p)
	}
	newRevision := save()
	c.s.queueSync(key, M{"revision": revision})
	if newRevision == revision {
		t.Fatal("scope revision reused")
	}
	if r := deviceReq(c, token, "POST", "/api/sync/progress", report); r.Code != 409 {
		t.Fatal("old receipt overwrote new task", r.Code)
	}
	p = c.ok("GET", "/api/devices/"+key+"/sync-progress", nil)
	if str(p, "phase") != "waiting" || str(p, "revision") != newRevision {
		t.Fatal(p)
	}
	if r := deviceReq(c, token, "GET", "/api/devices/"+key+"/sync-progress", nil); r.Code != 403 {
		t.Fatal("phone accessed desktop diagnostics", r.Code)
	}
	c.ok("DELETE", "/api/devices/"+key, nil)
	if r := deviceReq(c, token, "POST", "/api/sync/progress", report); r.Code != 401 {
		t.Fatal("revoked phone reported progress", r.Code)
	}
}
