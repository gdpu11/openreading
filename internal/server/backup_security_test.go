package server

import (
	"archive/zip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBackupRejectsUntrustedBlobReferences(t *testing.T) {
	c := newClient(t, Config{})
	c.sample("Original safe snapshot")
	backup, e := c.s.backup()
	if e != nil {
		t.Fatal(e)
	}
	input, e := zip.OpenReader(filepath.Join(c.s.cfg.DataDir, "backups", str(backup, "id")+".zip"))
	if e != nil {
		t.Fatal(e)
	}
	defer input.Close()
	files := map[string][]byte{}
	for _, f := range input.File {
		r, e := f.Open()
		if e != nil {
			t.Fatal(e)
		}
		b, e := io.ReadAll(r)
		r.Close()
		if e != nil {
			t.Fatal(e)
		}
		files[f.Name] = b
	}
	for _, change := range []M{{"blob_ref": "../private-file"}, {"blob_ref": strings.Repeat("a", 64)}, {"content_hash": strings.Repeat("z", 64), "blob_ref": strings.Repeat("z", 64)}, {"size": -1}} {
		t.Run(js(change), func(t *testing.T) {
			var tables map[string][]M
			json.Unmarshal(files["data.json"], &tables)
			if len(tables["versions"]) == 0 {
				t.Fatal("fixture has no version")
			}
			for k, v := range change {
				tables["versions"][0][k] = v
			}
			data, _ := json.Marshal(tables)
			var manifest backupManifest
			json.Unmarshal(files["manifest.json"], &manifest)
			manifest.DataHash = digest(data)
			malicious := filepath.Join(t.TempDir(), "malicious.zip")
			out, e := os.Create(malicious)
			if e != nil {
				t.Fatal(e)
			}
			z := zip.NewWriter(out)
			for name, b := range files {
				if name == "data.json" {
					b = data
				}
				if name == "manifest.json" {
					b = []byte(js(manifest))
				}
				w, e := z.Create(name)
				if e != nil {
					t.Fatal(e)
				}
				if _, e = w.Write(b); e != nil {
					t.Fatal(e)
				}
			}
			if e = z.Close(); e != nil {
				t.Fatal(e)
			}
			out.Close()
			if _, e = c.s.restorePreview(malicious); e == nil {
				t.Fatal("untrusted backup file reference accepted")
			}
		})
	}
}
func TestSnapshotReadRejectsCorruptedStoredReference(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("Safe body")
	sentinel := filepath.Join(c.s.cfg.DataDir, "private-sentinel.txt")
	os.WriteFile(sentinel, []byte("NOT-FOR-DOCUMENT-READERS"), 0600)
	version := str(obj(x.prepared, "version"), "id")
	if e := exec(c.s.db, "UPDATE versions SET blob_ref='../private-sentinel.txt' WHERE id=?", version); e != nil {
		t.Fatal(e)
	}
	code, data := c.req("GET", "/api/versions/"+version+"/content?workspaceDocumentId="+str(x.d, "id"), nil)
	if code != 400 || strings.Contains(js(data), "NOT-FOR-DOCUMENT-READERS") {
		t.Fatal("corrupt snapshot leaked file", code, data)
	}
}
