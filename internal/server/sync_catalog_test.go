package server

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func phoneCatalog(t *testing.T, c *testClient, token, query string) M {
	t.Helper()
	rec := deviceReq(c, token, "GET", "/api/sync/catalog"+query, nil)
	var result M
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &result) != nil {
		t.Fatal(rec.Code, rec.Body.String())
	}
	return result
}
func TestPhoneCatalogMetadataSelectionAndScope(t *testing.T) {
	c, ws, first := syncSetup(t)
	second := importSyncFile(t, c, ws, "100% 学习.md", []byte("secret book contents"))
	other := c.workspace("Private workspace")
	hidden := importSyncFile(t, c, other, "hidden-book.md", []byte("do not leak"))
	token, device := approveDevice(t, c, ws)
	c.ok("PUT", "/api/devices/"+str(device, "id")+"/scope", M{"workspaceIds": []any{ws["id"]}, "syncScope": M{"mode": "manual", "memberIds": []any{first["id"]}}})
	before, _ := one(c.s.db, "SELECT COUNT(*) AS count FROM versions")
	catalog := phoneCatalog(t, c, token, "?q="+url.QueryEscape("100%"))
	if num(catalog, "total") != 1 || len(arr(catalog, "items")) != 1 {
		t.Fatal(catalog)
	}
	item := arr(catalog, "items")[0].(map[string]any)
	if item["id"] != second["id"] || item["selected"] != false || strings.Contains(js(catalog), "secret book contents") || strings.Contains(js(catalog), "hidden-book") || strings.Contains(js(catalog), c.s.cfg.DataDir) {
		t.Fatal(catalog)
	}
	after, _ := one(c.s.db, "SELECT COUNT(*) AS count FROM versions")
	if before["count"] != after["count"] {
		t.Fatal("browsing prepared snapshots")
	}
	beforeIDs := snapshotIDs(syncSnapshot(t, c, token))
	if beforeIDs[str(second, "id")] {
		t.Fatal("browsing selected a book")
	}
	for _, query := range []string{"?workspace=" + str(other, "id"), "?format=executable", "?offset=-1"} {
		rec := deviceReq(c, token, "GET", "/api/sync/catalog"+query, nil)
		if rec.Code < 400 {
			t.Fatal(rec.Code, rec.Body.String())
		}
	}
	rec := deviceReq(c, token, "POST", "/api/sync/catalog/select", M{"memberIds": []any{second["id"], hidden["id"]}, "expectedRevision": catalog["revision"]})
	if rec.Code != 403 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if snapshotIDs(syncSnapshot(t, c, token))[str(second, "id")] {
		t.Fatal("unauthorized mixed batch partially committed")
	}
	rec = deviceReq(c, token, "POST", "/api/sync/catalog/select", M{"memberIds": []any{second["id"], second["id"]}, "expectedRevision": catalog["revision"]})
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	ids := snapshotIDs(syncSnapshot(t, c, token))
	if len(ids) != 2 || !ids[str(first, "id")] || !ids[str(second, "id")] {
		t.Fatal(ids)
	}
	if rec = deviceReq(c, token, "POST", "/api/sync/catalog/select", M{"memberIds": []any{second["id"]}, "expectedRevision": catalog["revision"]}); rec.Code != 409 {
		t.Fatal("stale write", rec.Code, rec.Body.String())
	}
	c.ok("DELETE", "/api/devices/"+str(device, "id"), nil)
	if rec = deviceReq(c, token, "GET", "/api/sync/catalog", nil); rec.Code != 401 {
		t.Fatal(rec.Code)
	}
}
func TestPhoneSelectionPreservesFormatRulesAndExclusions(t *testing.T) {
	c, ws, txt := syncSetup(t)
	md := importSyncFile(t, c, ws, "paper.md", []byte("# first"))
	token, device := approveDevice(t, c, ws)
	c.ok("PUT", "/api/devices/"+str(device, "id")+"/scope", M{"workspaceIds": []any{ws["id"]}, "syncScope": M{"mode": "formats", "formats": []string{"markdown"}}})
	catalog := phoneCatalog(t, c, token, "")
	rec := deviceReq(c, token, "POST", "/api/sync/catalog/select", M{"memberIds": []any{txt["id"]}, "expectedRevision": catalog["revision"]})
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	later := importSyncFile(t, c, ws, "later.md", []byte("# later"))
	ids := snapshotIDs(syncSnapshot(t, c, token))
	for _, m := range []M{txt, md, later} {
		if !ids[str(m, "id")] {
			t.Fatal(ids)
		}
	}
	d, _ := one(c.s.db, "SELECT scope_json AS sync_scope_json FROM device_sync_scopes WHERE device_id=?", device["id"])
	if str(obj(d, "syncScope"), "mode") != "formats" {
		t.Fatal(d)
	}
	// PC saving the format grant must retain explicit phone picks.
	c.ok("PUT", "/api/devices/"+str(device, "id")+"/scope", M{"workspaceIds": []any{ws["id"]}, "syncScope": obj(d, "syncScope")})
	if !snapshotIDs(syncSnapshot(t, c, token))[str(txt, "id")] {
		t.Fatal("PC lost phone selection")
	}
	// Choosing an excluded book clears only that exclusion, keeping folder/workspace rules.
	c.ok("PUT", "/api/devices/"+str(device, "id")+"/scope", M{"workspaceIds": []any{ws["id"]}, "syncScope": M{"mode": "manual", "memberIds": []any{}, "workspaceIds": []any{ws["id"]}, "excludedMemberIds": []any{txt["id"], md["id"]}}})
	catalog = phoneCatalog(t, c, token, "")
	rec = deviceReq(c, token, "POST", "/api/sync/catalog/select", M{"memberIds": []any{txt["id"]}, "expectedRevision": catalog["revision"]})
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	ids = snapshotIDs(syncSnapshot(t, c, token))
	if !ids[str(txt, "id")] || ids[str(md, "id")] || !ids[str(later, "id")] {
		t.Fatal(ids)
	}

}

func TestPhoneCatalogConcurrentSelectionAndPagination(t *testing.T) {
	c, ws, first := syncSetup(t)
	second := importSyncFile(t, c, ws, "second.md", []byte("# second"))
	third := importSyncFile(t, c, ws, "third.md", []byte("# third"))
	token, device := approveDevice(t, c, ws)
	c.ok("PUT", "/api/devices/"+str(device, "id")+"/scope", M{"workspaceIds": []any{ws["id"]}, "syncScope": M{"mode": "manual", "memberIds": []any{first["id"]}}})
	catalog := phoneCatalog(t, c, token, "")
	paged := phoneCatalog(t, c, token, "?offset=1")
	if num(catalog, "total") != 3 || len(arr(paged, "items")) != 2 {
		t.Fatal(catalog, paged)
	}
	results := make(chan int, 2)
	for _, member := range []any{second["id"], third["id"]} {
		go func(member any) {
			results <- deviceReq(c, token, "POST", "/api/sync/catalog/select", M{"memberIds": []any{member}, "expectedRevision": catalog["revision"]}).Code
		}(member)
	}
	a, b := <-results, <-results
	if !((a == 200 && b == 409) || (a == 409 && b == 200)) {
		t.Fatal(a, b)
	}
	if ids := snapshotIDs(syncSnapshot(t, c, token)); len(ids) != 2 || !ids[str(first, "id")] {
		t.Fatal(ids)
	}
}
