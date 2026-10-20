package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestA19UnopenedImportedCopySurvivesFreshRestore(t *testing.T) {
	c := newClient(t, Config{})
	w := c.workspace("导入副本")
	var input bytes.Buffer
	form := multipart.NewWriter(&input)
	part, _ := form.CreateFormFile("files", "尚未打开.txt")
	part.Write([]byte("导入成功的副本即使未打开也不能在备份中遗漏"))
	form.Close()
	req := httptest.NewRequest("POST", "http://127.0.0.1:7318/api/workspaces/"+str(w, "id")+"/imports", &input)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("X-CSRF-Token", c.csrf)
	req.AddCookie(c.cookie)
	rec := httptest.NewRecorder()
	c.s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var imported M
	json.Unmarshal(rec.Body.Bytes(), &imported)
	documents := c.documents(w)
	if len(documents) != 1 {
		t.Fatal(documents)
	}
	backup := c.ok("POST", "/api/backups", M{})
	if num(backup, "offlineVersions") != 1 {
		t.Fatal("unopened import omitted", backup)
	}
	src, _ := one(c.s.db, "SELECT root FROM sources WHERE id=?", imported["id"])
	os.RemoveAll(str(src, "root"))
	other := newClient(t, Config{})
	preview, e := other.s.restorePreview(filepath.Join(c.s.cfg.DataDir, "backups", str(backup, "id")+".zip"))
	if e != nil {
		t.Fatal(e)
	}
	result, e := other.s.restoreCommit(str(preview, "id"))
	if e != nil {
		t.Fatal(e)
	}
	docs := other.documents(M{"id": result["workspaceIds"].([]string)[0]})
	versions := other.list("/api/documents/" + str(docs[0], "documentId") + "/versions?workspaceDocumentId=" + str(docs[0], "id"))
	status, content := other.req("GET", "/api/versions/"+str(versions[0].(map[string]any), "id")+"/content?workspaceDocumentId="+str(docs[0], "id"), nil)
	if status != 200 || content != "导入成功的副本即使未打开也不能在备份中遗漏" {
		t.Fatal(status, content)
	}
}
