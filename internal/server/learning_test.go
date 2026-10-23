package server

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLearningReviewBookmarksAndFreshRestore(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("保存值得复习的材料，保留书签和自己的理解。")
	created := c.annotate(x, M{"body": "这是一条学习笔记", "recipient": "note"}, "")
	thread := str(created, "threadId")
	member := str(x.d, "id")
	version := str(obj(x.prepared, "version"), "id")
	metadata := c.ok("PUT", "/api/threads/"+thread+"/learning", M{"revision": 0, "tags": []string{"并发", "并发", "系统"}, "outcome": "schedule"})
	if len(arr(metadata, "tags")) != 2 || num(metadata, "revision") != 1 {
		t.Fatal(metadata)
	}
	if status, _ := c.req("PUT", "/api/threads/"+thread+"/learning", M{"revision": 0, "tags": []string{"覆盖"}}); status != 409 {
		t.Fatal("stale update accepted", status)
	}
	metadata = c.ok("PUT", "/api/threads/"+thread+"/learning", M{"revision": 1, "outcome": "good"})
	due, e := time.Parse(time.RFC3339Nano, str(metadata, "dueAt"))
	if e != nil || time.Until(due) < 47*time.Hour {
		t.Fatal(metadata, e)
	}
	c.ok("PUT", "/api/documents/"+member+"/preferences", M{"fontSize": 24})
	command := M{"clientRequestId": id(), "title": "关键结论", "versionId": version, "locator": M{"scrollTop": 120}}
	mark := c.ok("POST", "/api/documents/"+member+"/bookmarks", command)
	again := c.ok("POST", "/api/documents/"+member+"/bookmarks", command)
	if mark["id"] != again["id"] || len(c.list("/api/documents/"+member+"/bookmarks")) != 1 {
		t.Fatal("bookmark replay duplicated")
	}
	backup := c.ok("POST", "/api/backups", M{})
	receiver := newClient(t, Config{})
	preview, e := receiver.s.restorePreview(filepath.Join(c.s.cfg.DataDir, "backups", str(backup, "id")+".zip"))
	if e != nil {
		t.Fatal(e)
	}
	result, e := receiver.s.restoreCommit(str(preview, "id"))
	if e != nil {
		t.Fatal(e)
	}
	documents := receiver.documents(M{"id": result["workspaceIds"].([]string)[0]})
	newMember := str(documents[0], "id")
	if newMember == member {
		t.Fatal("member was not remapped")
	}
	marks := receiver.list("/api/documents/" + newMember + "/bookmarks")
	if len(marks) != 1 {
		t.Fatal(marks)
	}
	restored := marks[0].(map[string]any)
	if restored["workspaceDocumentId"] != newMember || restored["versionId"] == version {
		t.Fatal("bookmark scope not remapped", restored)
	}
	prefs := receiver.ok("GET", "/api/documents/"+newMember+"/preferences", nil)
	if num(obj(prefs, "data"), "fontSize") != 24 {
		t.Fatal(prefs)
	}
	notes := receiver.list("/api/documents/" + newMember + "/threads")
	note := notes[0].(map[string]any)
	if num(note, "learningRevision") != 2 || len(arr(note, "tags")) != 2 || str(note, "dueAt") == "" {
		t.Fatal(note)
	}
}

func TestSearchOnlyCompleteCurrentSnapshotsAndWorkspaceScope(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("原文里的幂等概念")
	other := c.sample("其他工作区")
	member := str(x.d, "id")
	version := str(obj(x.prepared, "version"), "id")
	index := M{"versionId": version, "replace": true, "sections": []M{{"position": 0, "label": "一", "locator": M{"pageIndex": 0}, "text": "这里有幂等概念"}, {"position": 1, "label": "二", "locator": M{"pageIndex": 1}, "text": "再看一次幂等"}}}
	c.ok("PUT", "/api/documents/"+member+"/search-index", index)
	route := "/api/workspaces/" + str(x.w, "id") + "/search?q=幂等"
	if len(arr(c.ok("GET", route, nil), "items")) != 0 {
		t.Fatal("partial index exposed")
	}
	index["complete"] = true
	c.ok("PUT", "/api/documents/"+member+"/search-index", index)
	if len(arr(c.ok("GET", route, nil), "items")) != 2 {
		t.Fatal("whole-book hits missing")
	}
	if len(arr(c.ok("GET", "/api/workspaces/"+str(other.w, "id")+"/search?q=幂等", nil), "items")) != 0 {
		t.Fatal("cross workspace text leaked")
	}
	index["versionId"] = obj(other.prepared, "version")["id"]
	if status, _ := c.req("PUT", "/api/documents/"+member+"/search-index", index); status == 200 {
		t.Fatal("cross document version accepted")
	}
	os.WriteFile(filepath.Join(x.root, "材料.txt"), []byte("更新后的原文"), 0600)
	c.prepare(x.d)
	if len(arr(c.ok("GET", route, nil), "items")) != 0 {
		t.Fatal("old snapshot returned as current")
	}
}

func TestSelectedNotesAreScopedAndFrozenInContext(t *testing.T) {
	c := newClient(t, Config{AllowMock: true})
	x := c.sample("从原文形成自己的理解，明确区分笔记与材料。")
	note := c.annotate(x, M{"body": "我对这个观点的理解", "recipient": "note"}, "")
	p := c.mock(x, "")
	pkg := x.pkg()
	pkg["noteIds"] = []string{str(note, "threadId")}
	request := M{"workspaceDocumentId": x.d["id"], "anchor": x.anchor, "body": "比较一下", "contextPackage": pkg, "modelProfileId": p["id"], "contextPolicy": "nearby"}
	preview := c.ok("POST", "/api/contexts/preview", request)
	if !strings.Contains(js(preview), "我对这个观点的理解") {
		t.Fatal(preview)
	}
	other := c.sample("另一个工作区的隐私材料")
	private := c.annotate(other, M{"body": "不能跨工作区发送", "recipient": "note"}, "")
	pkg["noteIds"] = []string{str(private, "threadId")}
	if status, _ := c.req("POST", "/api/contexts/preview", request); status != 403 {
		t.Fatal("cross workspace notes accepted", status)
	}
}

func TestAutomaticBackupKeepsManualAndPreservesCopiesOnFailure(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("自动备份的受保护原文")
	c.annotate(x, M{"body": "重要笔记", "recipient": "note"}, "")
	c.ok("PUT", "/api/backup-policy", M{"enabled": true, "keep": 1, "intervalHours": 24})
	c.s.automaticBackup()
	policy, _ := c.s.backupPolicy()
	if str(policy, "lastSuccess") == "" {
		t.Fatal(policy)
	}
	previous := str(policy, "lastBackupId")
	manual := c.ok("POST", "/api/backups", M{})
	if _, e := os.Stat(filepath.Join(c.s.cfg.DataDir, "backups", str(manual, "id")+".zip")); e != nil {
		t.Fatal(e)
	}
	os.Remove(filepath.Join(c.s.cfg.DataDir, "blobs", str(obj(x.prepared, "version"), "contentHash")))
	policy["lastAttempt"] = ""
	c.s.storeBackupPolicy(policy)
	c.s.automaticBackup()
	after, _ := c.s.backupPolicy()
	if str(after, "lastError") == "" {
		t.Fatal("failed backup reported success", after)
	}
	if _, e := os.Stat(filepath.Join(c.s.cfg.DataDir, "backups", previous+".zip")); e != nil {
		t.Fatal("prior backup removed on failure", e)
	}
	if status, _ := c.req("GET", "/api/backups/"+previous+"/download", nil); status != 200 {
		t.Fatal("automatic backup cannot download", status)
	}
}

func TestArticleImportRejectsPrivateAndCredentialURLs(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "https://user:secret@example.com", "http://example.com:8080"} {
		if _, e := publicArticleURL(raw); e == nil {
			t.Fatal("invalid URL accepted", raw)
		}
	}
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "::1", "fd00::1", "::ffff:127.0.0.1"} {
		if publicArticleIP(net.ParseIP(raw)) {
			t.Fatal("private address accepted", raw)
		}
	}
	if !publicArticleIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("public address rejected")
	}
}

func TestLearningDataTravelsInORDAndDeviceCommandsReplay(t *testing.T) {
	c, ws, d := syncSetup(t)
	x := c.extraction(ws, d, c.prepare(d), "", "原文选区，用于电脑和手机的文件与笔记同步。")
	created := c.annotate(x, M{"body": "需要复习", "recipient": "note"}, "")
	thread := str(created, "threadId")
	member := str(x.d, "id")
	token, _ := approveDevice(t, c, x.w)
	op := M{"operationId": id(), "type": "learning", "member": member, "threadId": thread, "revision": 0, "tags": []string{"同步"}, "outcome": "schedule"}
	for i := 0; i < 2; i++ {
		r := deviceReq(c, token, "POST", "/api/sync/commands", op)
		if r.Code != 200 {
			t.Fatal(r.Code, r.Body.String())
		}
	}
	notes := c.list("/api/documents/" + member + "/threads")
	if num(notes[0].(map[string]any), "learningRevision") != 1 {
		t.Fatal("replay changed revision", notes)
	}
	c.ok("PUT", "/api/documents/"+member+"/preferences", M{"fontSize": 22})
	c.ok("POST", "/api/documents/"+member+"/bookmarks", M{"clientRequestId": id(), "title": "书签", "versionId": obj(x.prepared, "version")["id"], "locator": M{"scrollTop": 8}})
	path := exportTestORD(t, c, x)
	other := c.workspace("接收学习包")
	imported, e := c.s.importORD(str(other, "id"), id(), path)
	if e != nil {
		t.Fatal(e)
	}
	newMember := str(imported, "workspaceDocumentId")
	restored := c.list("/api/documents/" + newMember + "/threads")
	if len(arr(restored[0].(map[string]any), "tags")) != 1 {
		t.Fatal(restored)
	}
	if len(c.list("/api/documents/"+newMember+"/bookmarks")) != 1 {
		t.Fatal("bookmarks omitted from ORD")
	}
	prefs := c.ok("GET", "/api/documents/"+newMember+"/preferences", nil)
	if num(obj(prefs, "data"), "fontSize") != 22 {
		t.Fatal(prefs)
	}
	op["operationId"] = id()
	op["member"] = newMember
	if r := deviceReq(c, token, "POST", "/api/sync/commands", op); r.Code != 403 {
		t.Fatal("device wrote outside scope", r.Code)
	}
}
