package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLibraryBookActions(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("正文 Chinese English words and notes")
	otherWorkspace := c.workspace("另一个书库")
	c.source(otherWorkspace, x.root)
	otherMember := c.documents(otherWorkspace)[0]
	if str(otherMember, "documentId") != str(x.d, "documentId") {
		t.Fatal("shared source fixture did not share document identity")
	}
	thread := c.annotate(x, M{"body": "需要保留的笔记", "recipient": "note"}, "")
	member := str(x.d, "id")
	url := "/api/documents/" + member
	list := func(filter string) []any {
		return arr(c.ok("GET", "/api/workspaces/"+str(x.w, "id")+"/documents?filter="+filter, nil), "items")
	}
	if len(list("favorites")) != 0 || len(list("finished")) != 0 {
		t.Fatal("new book has flags")
	}
	c.ok("PATCH", url, M{"favorite": true})
	c.ok("PATCH", url, M{"finished": true})
	if len(list("favorites")) != 1 || len(list("finished")) != 1 {
		t.Fatal("flags not filterable")
	}
	metadata := c.ok("GET", url, nil)
	if num(metadata, "favorite") != 1 || str(metadata, "finishedAt") == "" {
		t.Fatal(metadata)
	}
	if num(c.ok("GET", "/api/documents/"+str(otherMember, "id"), nil), "favorite") != 0 {
		t.Fatal("flags leaked to another workspace")
	}
	for _, invalid := range []M{{}, {"favorite": "true"}, {"favorite": true, "finished": false}, {"state": "deleted"}, {"restore": false}} {
		if code, _ := c.req("PATCH", url, invalid); code != 400 {
			t.Fatal("invalid update accepted", invalid, code)
		}
	}
	// Repeated deletion is harmless and never touches source files or learning data.
	c.ok("DELETE", url, nil)
	c.ok("DELETE", url, nil)
	if len(list("all")) != 0 || len(list("favorites")) != 0 || len(list("finished")) != 0 || len(list("removed")) != 1 {
		t.Fatal("removed book still visible")
	}
	if _, e := os.Stat(filepath.Join(x.root, "材料.txt")); e != nil {
		t.Fatal("source file was deleted", e)
	}
	if _, e := one(c.s.db, "SELECT id FROM threads WHERE id=?", thread["threadId"]); e != nil {
		t.Fatal("notes were deleted", e)
	}
	if _, e := one(c.s.db, "SELECT id FROM versions WHERE id=?", obj(x.prepared, "version")["id"]); e != nil {
		t.Fatal("snapshot was deleted", e)
	}
	// A source refresh must retain the explicit removal marker.
	binding := arr(x.d, "bindings")[0].(map[string]any)
	c.scan(str(binding, "sourceId"))
	if len(list("all")) != 0 {
		t.Fatal("scan resurrected removed book")
	}
	// Also preserve missing/unavailable books so users can clean and restore them.
	if e := os.Remove(filepath.Join(x.root, "材料.txt")); e != nil {
		t.Fatal(e)
	}
	c.scan(str(binding, "sourceId"))
	c.ok("PATCH", url, M{"restore": true})
	if len(list("all")) != 1 || len(list("removed")) != 0 {
		t.Fatal("restore failed")
	}
	c.ok("PATCH", url, M{"favorite": false})
	c.ok("PATCH", url, M{"finished": false})
	if len(list("favorites")) != 0 || len(list("finished")) != 0 {
		t.Fatal("flags did not clear")
	}
	c.ok("DELETE", url, nil)
	if len(list("all")) != 0 || len(list("removed")) != 1 {
		t.Fatal("missing book could not be removed")
	}
	if code, _ := c.req("PATCH", "/api/documents/nonexistent", M{"favorite": true}); code != 404 {
		t.Fatal("unknown member allowed")
	}
	if code, _ := c.req("GET", "/api/workspaces/"+str(x.w, "id")+"/documents?filter=invalid", nil); code != 400 {
		t.Fatal("unknown filter allowed")
	}
	c.ok("PATCH", url, M{"favorite": true})
	c.ok("PATCH", url, M{"finished": true})
	// Backup/restore remaps metadata with its workspace member, including removals.
	backup, e := c.s.backup()
	if e != nil {
		t.Fatal(e)
	}
	plan, e := c.s.restorePreview(filepath.Join(c.s.cfg.DataDir, "backups", str(backup, "id")+".zip"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = c.s.restoreCommit(str(plan, "id")); e != nil {
		t.Fatal(e)
	}
	rows, e := all(c.s.db, "SELECT * FROM library_books WHERE removed_at<>''")
	if e != nil || len(rows) != 2 || num(rows[0], "favorite") != 1 || str(rows[0], "finishedAt") == "" {
		t.Fatal("removal metadata lost in backup", rows, e)
	}

}
