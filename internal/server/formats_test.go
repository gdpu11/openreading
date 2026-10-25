package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func formatFixture(t *testing.T, kind string) []byte {
	t.Helper()
	entries := map[string]string{}
	switch kind {
	case "docx":
		entries = map[string]string{"[Content_Types].xml": "<Types/>", "word/document.xml": "<document/>"}
	case "cbz":
		entries = map[string]string{"page1.png": "test-image"}
	default:
		return []byte("original book content")
	}
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for name, value := range entries {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(value))
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestAdditionalFormatsSnapshotsAnchorsAndORD(t *testing.T) {
	for _, kind := range []string{"mobi", "azw3", "fb2", "docx", "html", "rtf", "cbz", "cbr"} {
		t.Run(kind, func(t *testing.T) {
			c := newClient(t, Config{})
			root := t.TempDir()
			original := formatFixture(t, kind)
			if err := os.WriteFile(filepath.Join(root, "book."+kind), original, 0600); err != nil {
				t.Fatal(err)
			}
			w := c.workspace(kind)
			c.source(w, root)
			docs := c.documents(w)
			if len(docs) != 1 || str(docs[0], "format") != kind {
				t.Fatalf("missing source format: %v", docs)
			}
			d := docs[0]
			prepared := c.prepare(d)
			version := obj(prepared, "version")
			filtered := c.ok("GET", "/api/workspaces/"+str(w, "id")+"/documents?format="+kind, nil)
			if len(arr(filtered, "items")) != 1 {
				t.Fatal("format filter lost book")
			}
			r := httptest.NewRequest("GET", "http://127.0.0.1:7318/api/versions/"+str(version, "id")+"/content?workspaceDocumentId="+str(d, "id"), nil)
			r.AddCookie(c.cookie)
			rec := httptest.NewRecorder()
			c.s.Handler().ServeHTTP(rec, r)
			if kind == "html" && rec.Header().Get("Content-Type") != "text/plain; charset=utf-8" {
				t.Fatal("imported HTML must not execute on the app origin")
			}
			if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), original) {
				t.Fatal("original bytes changed")
			}
			x := c.extraction(w, d, prepared, root, "quoted text")
			validate := func(a M) error {
				var decoded M
				_ = json.Unmarshal([]byte(js(a)), &decoded)
				return c.s.validateAnchor(c.s.db, str(d, "id"), str(version, "id"), decoded)
			}
			if err := validate(x.anchor); err == nil {
				t.Fatal("missing native anchor accepted")
			}
			x.anchor["selectors"] = append(x.anchor["selectors"].([]M), M{"type": "epub", "cfi": "epubcfi(/6/2!/4/2:0)", "href": "section-0.xhtml"})
			if err := validate(x.anchor); err != nil {
				t.Fatal(err)
			}
			x.anchor["targetKind"] = "page"
			x.anchor["quote"] = M{"exact": "", "visible": ""}
			x.anchor["selectors"] = []M{{"type": "epub", "cfi": "epubcfi(/6/2!/4/2:0)", "href": "section-0.xhtml"}}
			if err := validate(x.anchor); err != nil {
				t.Fatal(err)
			}
			c.ok("POST", "/api/threads", M{"clientRequestId": id(), "workspaceDocumentId": d["id"], "documentVersionId": version["id"], "selectionSnapshot": x.anchor, "message": M{"body": "format note", "recipient": "note"}})
			path := exportTestORD(t, c, x)
			p, err := c.s.readORD(path)
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(p.dir)
			receiver := newClient(t, Config{})
			other := receiver.workspace("Received")
			got, err := receiver.s.importORD(str(other, "id"), id(), path)
			if err != nil {
				t.Fatal(err)
			}
			threads, err := receiver.s.threadData(receiver.s.db, "WHERE a.workspace_document_id=?", got["workspaceDocumentId"])
			if err != nil || len(threads) != 1 {
				t.Fatal("ORD lost notes", err)
			}
			if err := receiver.s.validateAnchor(receiver.s.db, str(got, "workspaceDocumentId"), str(threads[0], "originalVersionId"), obj(threads[0], "anchor")); err != nil {
				t.Fatal(err)
			}
			if p.book.Format != kind {
				t.Fatal("ORD changed original format")
			}
			z, err := zip.OpenReader(path)
			if err != nil {
				t.Fatal(err)
			}
			defer z.Close()
			found := false
			for _, f := range z.File {
				if f.Name == "blobs/"+str(version, "contentHash") {
					r, _ := f.Open()
					data, _ := io.ReadAll(r)
					r.Close()
					found = bytes.Equal(data, original)
				}
			}
			if !found {
				t.Fatal("ORD lost original book bytes")
			}
		})
	}
}

func TestBookFormatAliases(t *testing.T) {
	for name, expected := range map[string]string{"book.kepub": "epub", "book.AZW": "mobi", "book.prc": "mobi", "book.KF8": "azw3", "book.fb2.zip": "fb2", "book.fbz": "fb2", "book.htm": "html", "book.xhtml": "html", "book.doc": "", "book.kfx": ""} {
		if actual := format(name); actual != expected {
			t.Errorf("%s: %s != %s", name, actual, expected)
		}
	}
}
