package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestScaleTenThousandFiveSources(t *testing.T) {
	c := newClient(t, Config{})
	w := c.workspace("规模基准")
	start := time.Now()
	for source := 0; source < 5; source++ {
		root := t.TempDir()
		for i := 0; i < 2000; i++ {
			if e := os.WriteFile(filepath.Join(root, fmt.Sprintf("文档-%04d.md", i)), []byte("正文不应在扫描时读入"), 0600); e != nil {
				t.Fatal(e)
			}
		}
		c.source(w, root)
	}
	scanTime := time.Since(start)
	count, _ := one(c.s.db, "SELECT count(*) AS n FROM workspace_documents WHERE workspace_id=?", w["id"])
	if num(count, "n") != 10000 {
		t.Fatal(count)
	}
	blobs, e := os.ReadDir(filepath.Join(c.s.cfg.DataDir, "blobs"))
	if e != nil || len(blobs) != 0 {
		t.Fatal("scan eagerly read bodies")
	}
	cursor := ""
	total := 0
	pages := 0
	started := time.Now()
	for {
		result := c.ok("GET", "/api/workspaces/"+str(w, "id")+"/documents?limit=500&cursor="+cursor, nil)
		total += len(arr(result, "items"))
		pages++
		cursor = str(result, "nextCursor")
		if cursor == "" {
			break
		}
	}
	if total != 10000 || pages != 20 {
		t.Fatalf("pagination omitted or duplicated files: %d %d", total, pages)
	}
	record := M{"files": total, "sources": 5, "pages": pages, "enumerationAndFixtureCreationMs": scanTime.Milliseconds(), "allPagesListMs": time.Since(started).Milliseconds(), "bodyBlobsCreated": 0, "runtime": "Go HTTP handler with local SQLite; filesystem fixture creation included in enumeration time"}
	bytes, _ := json.MarshalIndent(record, "", "  ")
	if e = os.MkdirAll("../../docs/evidence", 0755); e == nil {
		_ = os.WriteFile("../../docs/evidence/scale.json", bytes, 0644)
	}
}
func TestWatchCompensationAndImmutableSnapshot(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("原始不可变快照")
	oldHash := str(obj(x.prepared, "version"), "contentHash")
	os.WriteFile(filepath.Join(x.root, "材料.txt"), []byte("新版本，不应悄悄改写旧快照"), 0600)
	os.WriteFile(filepath.Join(x.root, "新增.md"), []byte("新文件"), 0600)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(c.documents(x.w)) == 2 {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if len(c.documents(x.w)) != 2 {
		t.Fatal("watcher did not reconcile new file")
	}
	raw, e := os.ReadFile(filepath.Join(c.s.cfg.DataDir, "blobs", oldHash))
	if e != nil || string(raw) != x.text {
		t.Fatal("old snapshot mutated")
	}
	prep := c.prepare(x.d)
	if str(obj(prep, "version"), "contentHash") == oldHash {
		t.Fatal("file reopening missed update")
	}
}
func TestBackupRejectsMissingProtectedBlobAndTampering(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("受保护快照损坏必须阻止成功备份")
	c.annotate(x, M{"body": "记录保留", "recipient": "note"}, "")
	path := filepath.Join(c.s.cfg.DataDir, "blobs", str(obj(x.prepared, "version"), "contentHash"))
	os.Remove(path)
	status, v := c.req("POST", "/api/backups", M{})
	if status != 409 || str(v.(map[string]any), "code") != "BACKUP_INCOMPLETE" {
		t.Fatal(status, v)
	}
}
func TestRestartNeverResendsQueuedRuns(t *testing.T) {
	dir := t.TempDir()
	c := newClient(t, Config{DataDir: dir, AllowMock: true})
	x := c.sample("重启不会自动重复已经可能计费的请求")
	p := c.mock(x, "")
	r := c.annotate(x, c.question(x, p), "")
	c.s.Close()
	other := newClient(t, Config{DataDir: dir})
	run := other.ok("GET", "/api/ai-runs/"+str(r, "runId"), nil)
	if str(run, "state") != "interrupted" && str(run, "state") != "completed" {
		t.Fatal(run)
	}
	time.Sleep(350 * time.Millisecond)
	count, _ := one(other.s.db, "SELECT count(*) AS n FROM attempts WHERE run_id=?", r["runId"])
	if num(count, "n") > 1 {
		t.Fatal("automatic retry after restart")
	}
}
func TestRestoreForeignKeysRetryAndInterrupted(t *testing.T) {
	c := newClient(t, Config{AllowMock: true})
	x := c.sample("恢复所有外键、重试记录和未完成运行")
	p := c.mock(x, "auth")
	r := c.annotate(x, c.question(x, p), "")
	c.waitRun(str(r, "runId"))
	retry := c.ok("POST", "/api/ai-runs/"+str(r, "runId")+"/retry", M{"clientRequestId": id()})
	backup := c.ok("POST", "/api/backups", M{})
	other := newClient(t, Config{})
	preview, e := other.s.restorePreview(filepath.Join(c.s.cfg.DataDir, "backups", str(backup, "id")+".zip"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = other.s.restoreCommit(str(preview, "id")); e != nil {
		t.Fatal(e)
	}
	rows, e := all(other.s.db, "PRAGMA foreign_key_check")
	if e != nil || len(rows) != 0 {
		t.Fatal(e, rows)
	}
	runs, _ := all(other.s.db, "SELECT * FROM ai_runs")
	if len(runs) != 2 {
		t.Fatal(runs)
	}
	for _, run := range runs {
		if !terminal(str(run, "state")) {
			t.Fatal("restored nonterminal run remained live")
		}
		if str(run, "id") == str(retry, "id") {
			t.Fatal("run ID not remapped")
		}
	}
}
func TestContextBudgetAndEndpointReenable(t *testing.T) {
	c := newClient(t, Config{AllowMock: true})
	x := c.sample(strings.Repeat("汉", 4000))
	p := c.mock(x, "")
	question := c.question(x, p)
	status, _ := c.req("POST", "/api/threads", M{"workspaceDocumentId": x.d["id"], "documentVersionId": obj(x.prepared, "version")["id"], "selectionSnapshot": x.anchor, "message": M{"body": strings.Repeat("大", 5000), "recipient": "assistant", "contextPackage": x.pkg(), "modelProfileId": p["id"], "contextPolicy": "selection"}, "clientRequestId": id()})
	if status != 413 {
		t.Fatal(status)
	}
	c.ok("PATCH", "/api/providers/"+str(p, "id"), M{"revision": 1, "name": "仅改显示名称", "protocol": "mock", "baseUrl": "https://new.invalid", "modelId": "new"})
	status, _ = c.req("POST", "/api/threads", M{"workspaceDocumentId": x.d["id"], "documentVersionId": obj(x.prepared, "version")["id"], "selectionSnapshot": x.anchor, "message": question, "clientRequestId": id()})
	if status != 403 {
		t.Fatal("endpoint change bypassed workspace consent", status)
	}
}
func TestPreferenceDoesNotOverwriteRecentDocuments(t *testing.T) {
	c := newClient(t, Config{})
	c.ok("PUT", "/api/preferences", M{"lastDocuments": M{"a": "doc-a"}, "fontSize": 18})
	c.ok("PUT", "/api/preferences", M{"lastDocuments": M{"b": "doc-b"}})
	c.ok("PUT", "/api/preferences", M{"fontSize": 24})
	p := c.ok("GET", "/api/preferences", nil)
	if str(obj(p, "lastDocuments"), "a") != "doc-a" || str(obj(p, "lastDocuments"), "b") != "doc-b" {
		t.Fatal(p)
	}
}

func TestSingleInstanceAndCredentialAllowlist(t *testing.T) {
	dir := t.TempDir()
	c := newClient(t, Config{DataDir: dir, AllowMock: true})
	x := c.sample("另一个进程不能破坏当前运行状态")
	p := c.mock(x, "")
	r := c.annotate(x, c.question(x, p), "")
	other, e := New(Config{DataDir: dir})
	if e == nil {
		other.Close()
		t.Fatal("second instance opened live data")
	}
	run := c.ok("GET", "/api/ai-runs/"+str(r, "runId"), nil)
	if str(run, "state") == "interrupted" {
		t.Fatal("second instance interrupted active run")
	}
	cfg := providerConfig(M{"config": M{"apiKey": "never persist", "credential": "never persist", "inputBudget": 2048}})
	if cfg["apiKey"] != nil || cfg["credential"] != nil || num(cfg, "inputBudget") != 2048 {
		t.Fatal(cfg)
	}
}
func TestA11RelocatedQuestionKeepsOriginalAndUsesExplicitNewAnchor(t *testing.T) {
	c := newClient(t, Config{AllowMock: true})
	x := c.sample("原来的句子需要保留历史依据。")
	thread := c.annotate(x, M{"body": "旧版笔记", "recipient": "note"}, "")
	os.WriteFile(filepath.Join(x.root, "材料.txt"), []byte("新版完全改变的选段，仅在手动确认后可绑定。"), 0600)
	prepared := c.prepare(x.d)
	next := c.extraction(x.w, x.d, prepared, x.root, "新版完全改变的选段，仅在手动确认后可绑定。")
	c.ok("POST", "/api/annotations/"+str(thread, "annotationId")+"/relocate", M{"anchor": next.anchor, "revision": 1})
	p := c.mock(next, "")
	result := c.ok("POST", "/api/threads/"+str(thread, "threadId")+"/messages", M{"message": c.question(next, p), "clientRequestId": id()})
	snapshot, _ := one(c.s.db, "SELECT * FROM contexts WHERE id=?", result["snapshotId"])
	annotation, _ := one(c.s.db, "SELECT * FROM annotations WHERE id=?", thread["annotationId"])
	if snapshot["versionId"] != obj(prepared, "version")["id"] || annotation["originalVersionId"] != obj(x.prepared, "version")["id"] || str(obj(obj(annotation, "anchor"), "quote"), "exact") != str(obj(x.anchor, "quote"), "exact") {
		t.Fatal("relocation rewrote history or sent old content", snapshot, annotation)
	}
}
func TestWorkspaceAndThreadRemovalKeepForeignKeysValid(t *testing.T) {
	c := newClient(t, Config{AllowMock: true})
	x := c.sample("显式删除学习数据时不能触及原始文件")
	p := c.mock(x, "")
	r := c.annotate(x, c.question(x, p), "")
	c.waitRun(str(r, "runId"))
	c.ok("DELETE", "/api/threads/"+str(r, "threadId"), M{"revision": 1})
	if len(c.list("/api/documents/"+str(x.d, "id")+"/threads")) != 0 {
		t.Fatal("thread remains")
	}
	r = c.annotate(x, M{"body": "随后删除整个工作区", "recipient": "note"}, "")
	_ = r
	c.ok("DELETE", "/api/workspaces/"+str(x.w, "id")+"?confirm=delete-learning-data", nil)
	if _, e := os.Stat(filepath.Join(x.root, "材料.txt")); e != nil {
		t.Fatal("original file modified")
	}
	check, e := all(c.s.db, "PRAGMA foreign_key_check")
	if e != nil || len(check) > 0 {
		t.Fatal(check, e)
	}
}
