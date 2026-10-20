package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOriginalFileDeletion(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("Original book text and notes")
	thread := c.annotate(x, M{"body": "Keep this note", "recipient": "note"}, "")
	url := "/api/documents/" + str(x.d, "id")
	file := filepath.Join(x.root, "材料.txt")
	preview := c.ok("GET", url+"/deletion-preview", nil)
	files := arr(preview, "files")
	if len(files) != 1 {
		t.Fatal(preview)
	}
	original := files[0].(map[string]any)
	request := M{"confirm": "delete-original", "sourceEntryId": original["sourceEntryId"], "fingerprint": original["fingerprint"]}
	for _, b := range []M{nil, {}, {"sourceEntryId": original["sourceEntryId"]}} {
		if code, _ := c.req("DELETE", url+"?mode=original", b); code != 400 {
			t.Fatal("confirmation missing", code)
		}
	}
	// A forged entry must not delete a different book's original.
	y := c.sample("A different original")
	if code, _ := c.req("DELETE", "/api/documents/"+str(y.d, "id")+"?mode=original", request); code != 409 {
		t.Fatal("foreign entry accepted", code)
	}
	if e := os.WriteFile(file, []byte("Changed since preview"), 0600); e != nil {
		t.Fatal(e)
	}
	if code, _ := c.req("DELETE", url+"?mode=original", request); code != 409 {
		t.Fatal("stale confirmation accepted", code)
	}
	if _, e := os.Stat(file); e != nil {
		t.Fatal("changed original removed", e)
	}
	files = arr(c.ok("GET", url+"/deletion-preview", nil), "files")
	request["fingerprint"] = files[0].(map[string]any)["fingerprint"]
	c.ok("DELETE", url+"?mode=original", request)
	if _, e := os.Stat(file); !os.IsNotExist(e) {
		t.Fatal("original still exists", e)
	}
	if _, e := os.Stat(filepath.Join(y.root, "材料.txt")); e != nil {
		t.Fatal("unrelated original deleted", e)
	}
	if _, e := one(c.s.db, "SELECT id FROM threads WHERE id=?", thread["threadId"]); e != nil {
		t.Fatal("note deleted", e)
	}
	if _, e := one(c.s.db, "SELECT id FROM versions WHERE id=?", obj(x.prepared, "version")["id"]); e != nil {
		t.Fatal("snapshot deleted", e)
	}
	if str(c.ok("GET", url, nil), "removedAt") == "" {
		t.Fatal("book not removed")
	}
	c.ok("PATCH", url, M{"restore": true})
	if _, e := os.Stat(file); !os.IsNotExist(e) {
		t.Fatal("restore recreated original", e)
	}
}
func TestOriginalDeletionRejectsSymlinkReplacement(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("Original")
	url := "/api/documents/" + str(x.d, "id")
	f := arr(c.ok("GET", url+"/deletion-preview", nil), "files")[0].(map[string]any)
	outside := filepath.Join(t.TempDir(), "outside.txt")
	os.WriteFile(outside, []byte("Do not delete"), 0600)
	original := filepath.Join(x.root, "材料.txt")
	os.Remove(original)
	if e := os.Symlink(outside, original); e != nil {
		t.Fatal(e)
	}
	if code, _ := c.req("DELETE", url+"?mode=original", M{"confirm": "delete-original", "sourceEntryId": f["sourceEntryId"], "fingerprint": f["fingerprint"]}); code != 409 {
		t.Fatal(code)
	}
	if _, e := os.Stat(outside); e != nil {
		t.Fatal("outside file touched", e)
	}
	if len(arr(c.ok("GET", url+"/deletion-preview", nil), "files")) != 0 {
		t.Fatal("unsafe original offered")
	}
}
func TestOriginalDeletionLocalOnly(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("Original")
	c.s.cfg.PublicOrigin = "https://openread.example"
	// Test the file operation itself; hosted origin/session behavior is covered elsewhere.
	if e := c.s.deleteBookOriginal(nil); e == nil {
		t.Fatal("hosted deletion allowed")
	}
	if _, e := os.Stat(filepath.Join(x.root, "材料.txt")); e != nil {
		t.Fatal(e)
	}
}
func TestConversionDoesNotMarkBookRead(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("Conversion source")
	if e := exec(c.s.db, "UPDATE workspace_documents SET last_opened='' WHERE id=?", x.d["id"]); e != nil {
		t.Fatal(e)
	}
	binding := arr(x.d, "bindings")[0].(map[string]any)
	c.ok("POST", "/api/documents/"+str(x.d, "documentId")+"/prepare", M{"workspaceDocumentId": x.d["id"], "sourceEntryId": binding["id"], "purpose": "conversion"})
	row, _ := one(c.s.db, "SELECT last_opened FROM workspace_documents WHERE id=?", x.d["id"])
	if str(row, "lastOpened") != "" {
		t.Fatal("conversion changed recent reading", row)
	}
}

func TestOriginalDeletionRestoresFileOnDatabaseFailure(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("Keep the complete original on failed database commit")
	endpoint := "/api/documents/" + str(x.d, "id")
	preview := arr(c.ok("GET", endpoint+"/deletion-preview", nil), "files")[0].(map[string]any)
	if e := exec(c.s.db, "CREATE TRIGGER fail_original_removal BEFORE INSERT ON library_books BEGIN SELECT RAISE(ABORT,'injected write failure'); END"); e != nil {
		t.Fatal(e)
	}
	code, _ := c.req("DELETE", endpoint+"?mode=original", M{"confirm": "delete-original", "sourceEntryId": preview["sourceEntryId"], "fingerprint": preview["fingerprint"]})
	if code != 500 {
		t.Fatal("database failure not reported", code)
	}
	bytes, e := os.ReadFile(filepath.Join(x.root, "材料.txt"))
	if e != nil || string(bytes) != "Keep the complete original on failed database commit" {
		t.Fatal("original lost on failed removal", string(bytes), e)
	}
	staged, _ := filepath.Glob(filepath.Join(x.root, ".openreading-delete-*.tmp"))
	if len(staged) != 0 {
		t.Fatal("restored original left staged copies", staged)
	}
	if str(c.ok("GET", endpoint, nil), "removedAt") != "" {
		t.Fatal("failed operation changed library state")
	}
	row, e := one(c.s.db, "SELECT state FROM source_entries WHERE id=?", preview["sourceEntryId"])
	if e != nil || str(row, "state") != "active" {
		t.Fatal("source state did not roll back", row, e)
	}
}
