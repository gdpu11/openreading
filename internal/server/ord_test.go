package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func exportTestORD(t *testing.T, c *testClient, x *sample) string {
	t.Helper()
	path, _, e := c.s.exportORD(str(x.d, "id"), str(obj(x.prepared, "version"), "id"), str(x.prepared, "resourceManifestId"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.Remove(path) })
	return path
}
func ordEntries(t *testing.T, path string) map[string][]byte {
	t.Helper()
	z, e := zip.OpenReader(path)
	if e != nil {
		t.Fatal(e)
	}
	defer z.Close()
	files := map[string][]byte{}
	for _, f := range z.File {
		r, e := f.Open()
		if e != nil {
			t.Fatal(e)
		}
		files[f.Name], e = io.ReadAll(r)
		r.Close()
		if e != nil {
			t.Fatal(e)
		}
	}
	return files
}
func rewriteORD(t *testing.T, path string, mutate func(map[string][]byte)) string {
	t.Helper()
	files := ordEntries(t, path)
	mutate(files)
	dest := filepath.Join(t.TempDir(), "mutated.ord")
	f, e := os.Create(dest)
	if e != nil {
		t.Fatal(e)
	}
	z := zip.NewWriter(f)
	for name, b := range files {
		w, _ := z.Create(name)
		w.Write(b)
	}
	z.Close()
	f.Close()
	return dest
}
func mutateORDBook(t *testing.T, path string, mutate func(*ordBook)) string {
	return rewriteORD(t, path, func(files map[string][]byte) {
		var b ordBook
		var m ordManifest
		json.Unmarshal(files["book.json"], &b)
		mutate(&b)
		files["book.json"] = []byte(js(b))
		json.Unmarshal(files["manifest.json"], &m)
		m.BookHash = digest(files["book.json"])
		files["manifest.json"] = []byte(js(m))
	})
}
func (c *testClient) uploadORD(path, workspace, key, token string) (int, M) {
	c.t.Helper()
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	part, _ := form.CreateFormFile("file", "分享的书.ord")
	f, e := os.Open(path)
	if e != nil {
		c.t.Fatal(e)
	}
	io.Copy(part, f)
	f.Close()
	form.WriteField("clientRequestId", key)
	form.Close()
	prefix := "/api"
	if token != "" {
		prefix += "/sync"
	}
	r := httptest.NewRequest("POST", "http://127.0.0.1:7318"+prefix+"/workspaces/"+workspace+"/ord", &buf)
	r.Header.Set("Content-Type", form.FormDataContentType())
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Origin", "capacitor://localhost")
	} else {
		r.AddCookie(c.cookie)
		r.Header.Set("X-CSRF-Token", c.csrf)
	}
	rec := httptest.NewRecorder()
	c.s.Handler().ServeHTTP(rec, r)
	var result M
	json.Unmarshal(rec.Body.Bytes(), &result)
	return rec.Code, result
}

func TestORDPortableBookNotesResourcesAndIsolation(t *testing.T) {
	c := newClient(t, Config{AllowMock: true})
	x := c.sample("从原文中形成自己的理解。旧版材料与标注需要一起保留。")
	created := c.annotate(x, M{"body": "不应分享的旧编辑内容", "recipient": "note"}, "")
	c.ok("PATCH", "/api/messages/"+str(created, "messageId"), M{"body": "最终学习笔记", "revision": 1})
	c.ok("PATCH", "/api/threads/"+str(created, "threadId"), M{"learningState": "已理解", "revision": 1})
	threads, _ := c.s.threadData(c.s.db, "WHERE a.workspace_document_id=?", x.d["id"])
	c.ok("PATCH", "/api/annotations/"+str(threads[0], "id"), M{"style": M{"color": "#b8d8c6", "underline": true}, "revision": 1})
	c.ok("PUT", "/api/drafts/"+str(x.d, "id")+":new", M{"workspaceDocumentId": x.d["id"], "body": "未发送的私密草稿", "revision": 0})
	// Same global document in a different workspace must not share its notes.
	otherWS := c.workspace("不能泄露的另一个工作区")
	c.source(otherWS, x.root)
	d2 := c.documents(otherWS)[0]
	p2 := c.prepare(d2)
	x2 := c.extraction(otherWS, d2, p2, x.root, x.text)
	c.annotate(x2, M{"body": "另一个工作区的私密笔记", "recipient": "note"}, "")
	private := c.sample("另一本书绝不能进入学习包。")
	c.annotate(private, M{"body": "另一本书的秘密笔记", "recipient": "note"}, "")
	p := c.mock(x, "")
	q := c.annotate(x, c.question(x, p), "")
	c.waitRun(str(q, "runId"))
	c.ok("POST", "/api/providers", M{"name": "私密模型配置", "protocol": "openai", "baseUrl": "https://example.invalid", "modelId": "private", "apiKey": "MUST-NOT-EXPORT-SECRET"})
	// A saved image belongs to the old snapshot and must survive without its folder.
	image := []byte("image-resource-bytes")
	hash := digest(image)
	os.WriteFile(filepath.Join(c.s.cfg.DataDir, "blobs", hash), image, 0600)
	exec(c.s.db, "UPDATE manifests SET resources_json=? WHERE id=?", js([]M{{"path": "images/a.png", "blobHash": hash, "mime": "image/png"}}), x.prepared["resourceManifestId"])
	oldVersion := str(obj(x.prepared, "version"), "id")
	time.Sleep(2 * time.Millisecond)
	os.WriteFile(filepath.Join(x.root, "材料.txt"), []byte("新版原文可以继续阅读，旧笔记仍定位旧版本。"), 0600)
	x.prepared = c.prepare(x.d)
	relocated := c.extraction(x.w, x.d, x.prepared, x.root, "新版原文可以继续阅读，旧笔记仍定位旧版本。")
	c.ok("POST", "/api/annotations/"+str(threads[0], "id")+"/relocate", M{"anchor": relocated.anchor, "revision": 2})
	c.ok("PUT", "/api/documents/"+str(x.d, "id")+"/reading-state", M{"versionId": obj(x.prepared, "version")["id"], "locator": M{"scrollTop": 123}})
	path := exportTestORD(t, c, x)
	files := ordEntries(t, path)
	for name, data := range files {
		for _, secret := range []string{"MUST-NOT-EXPORT-SECRET", "未发送的私密草稿", "不应分享的旧编辑内容", "另一个工作区的私密笔记", "另一本书的秘密笔记", x.root, c.s.cfg.DataDir} {
			if strings.Contains(string(data), secret) {
				t.Fatalf("privacy leak in %s: %s", name, secret)
			}
		}
	}
	var b ordBook
	json.Unmarshal(files["book.json"], &b)
	if len(b.Tables["versions"]) != 2 || len(b.Tables["annotations"]) != 2 || len(b.Tables["messages"]) != 3 {
		t.Fatal("incomplete export", b.Tables)
	}
	// Receiver has a separate DB and no source directory or provider config.
	receiver := newClient(t, Config{})
	w := receiver.workspace("接收的书")
	key := id()
	code, got := receiver.uploadORD(path, str(w, "id"), key, "")
	if code != 200 {
		t.Fatal(code, got)
	}
	docs := receiver.documents(w)
	if len(docs) != 1 {
		t.Fatal(docs)
	}
	prepared := receiver.prepare(docs[0])
	if str(obj(prepared, "version"), "contentHash") != str(obj(x.prepared, "version"), "contentHash") {
		t.Fatal("current book changed")
	}
	imported, _ := receiver.s.threadData(receiver.s.db, "WHERE a.workspace_document_id=?", got["workspaceDocumentId"])
	if len(imported) != 2 || str(imported[0], "id") == str(threads[0], "id") {
		t.Fatal("notes missing or identities reused", imported)
	}
	found := false
	for _, a := range imported {
		anchor := obj(a, "anchor")
		if e := receiver.s.validateAnchor(receiver.s.db, str(got, "workspaceDocumentId"), str(a, "originalVersionId"), anchor); e != nil {
			t.Fatal(e)
		}
		if str(anchor, "documentVersionId") == oldVersion {
			t.Fatal("embedded IDs not remapped")
		}
		for _, resolution := range a["resolutions"].([]M) {
			if str(resolution, "method") == "manual" {
				if e := receiver.s.validateAnchor(receiver.s.db, str(got, "workspaceDocumentId"), str(resolution, "targetVersionId"), obj(obj(resolution, "selector"), "anchor")); e != nil {
					t.Fatal("relocated anchor invalid", e)
				}
			}
		}
		for _, m := range a["messages"].([]M) {
			if str(m, "body") == "最终学习笔记" {
				found = true
				if str(a, "learningState") != "已理解" || str(obj(a, "style"), "color") != "#b8d8c6" {
					t.Fatal("learning state or style lost")
				}
			}
		}
	}
	if !found {
		t.Fatal("saved note omitted")
	}
	img, e := os.ReadFile(filepath.Join(receiver.s.cfg.DataDir, "blobs", hash))
	if e != nil || !bytes.Equal(image, img) {
		t.Fatal("image missing", e)
	}
	if n, _ := one(receiver.s.db, "SELECT count(*) n FROM ai_runs"); num(n, "n") != 0 {
		t.Fatal("import queued paid AI")
	}
	if n, _ := one(receiver.s.db, "SELECT count(*) n FROM providers"); num(n, "n") != 0 {
		t.Fatal("provider config leaked")
	}
	replay, e := receiver.s.importORD(str(w, "id"), key, path)
	if e != nil || js(replay) != js(got) {
		t.Fatal("lost acknowledgement duplicated import", replay, e)
	}
	again, e := receiver.s.importORD(str(w, "id"), id(), path)
	if e != nil || again["workspaceDocumentId"] == got["workspaceDocumentId"] || len(receiver.documents(w)) != 2 {
		t.Fatal("new import did not create isolated copy", e)
	}
	// Import copies are primary data and remain protected against cache clearing.
	clear := receiver.ok("GET", "/api/cache/preview", nil)
	if num(clear, "files") != 0 {
		t.Fatal("imported book became evictable", clear)
	}
	receiver.ok("PATCH", "/api/messages/"+str(imported[0]["messages"].([]M)[0], "id"), M{"body": "接收者继续学习", "revision": 2})
	originals, _ := c.s.threadData(c.s.db, "WHERE a.workspace_document_id=?", x.d["id"])
	if strings.Contains(js(originals), "接收者继续学习") {
		t.Fatal("recipient overwrote sender")
	}
}

func TestORDRejectCorruptAndUnsafeArchivesAtomically(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("验证导入数据错误时，不得留下半本书或半条笔记。")
	c.annotate(x, M{"body": "已保存笔记", "recipient": "note"}, "")
	path := exportTestORD(t, c, x)
	other := newClient(t, Config{})
	w := other.workspace("接收")
	cases := map[string]string{
		"tampered-book": rewriteORD(t, path, func(f map[string][]byte) { f["book.json"] = []byte("{}") }),
		"tampered-content": rewriteORD(t, path, func(f map[string][]byte) {
			for k := range f {
				if strings.HasPrefix(k, "blobs/") {
					f[k] = []byte("篡改原文")
					break
				}
			}
		}),
		"traversal":     rewriteORD(t, path, func(f map[string][]byte) { f["../escape"] = []byte("escape") }),
		"unknown-table": mutateORDBook(t, path, func(b *ordBook) { b.Tables["providers"] = []M{} }),
		"foreign-key":   mutateORDBook(t, path, func(b *ordBook) { b.Tables["threads"][0]["annotation_id"] = id() }),
		"anchor-range": mutateORDBook(t, path, func(b *ordBook) {
			var a M
			json.Unmarshal([]byte(str(b.Tables["annotations"][0], "anchor_json")), &a)
			a["workspaceDocumentId"] = id()
			b.Tables["annotations"][0]["anchor_json"] = js(a)
		}),
		"unknown-field":       mutateORDBook(t, path, func(b *ordBook) { b.Tables["versions"][0]["unexpected"] = true }),
		"missing-manifest":    mutateORDBook(t, path, func(b *ordBook) { b.ManifestID = id() }),
		"wrong-artifact-hash": mutateORDBook(t, path, func(b *ordBook) { b.Tables["artifacts"][0]["blocks_json"] = `[{"id":"body","text":"替换文字"}]` }),
	}
	for name, p := range cases {
		t.Run(name, func(t *testing.T) {
			if _, e := other.s.importORD(str(w, "id"), id(), p); e == nil {
				t.Fatal("unsafe package accepted")
			}
			if len(other.documents(w)) != 0 {
				t.Fatal("partial database commit")
			}
			roots, _ := os.ReadDir(filepath.Join(other.s.cfg.DataDir, "imports"))
			if len(roots) != 0 {
				t.Fatal("failed import left primary files")
			}
		})
	}
	// Duplicate ZIP entries and inflated metadata are rejected before extraction.
	for _, duplicate := range []bool{true, false} {
		f, _ := os.Create(filepath.Join(t.TempDir(), "invalid.ord"))
		z := zip.NewWriter(f)
		if duplicate {
			z.Create("manifest.json")
			z.Create("manifest.json")
		} else {
			h := &zip.FileHeader{Name: "book.json", Method: zip.Store, UncompressedSize64: uint64(ordMaxBytes + 1)}
			z.CreateRaw(h)
		}
		z.Close()
		f.Close()
		if _, e := other.s.readORD(f.Name()); e == nil {
			t.Fatal("unsafe ZIP accepted")
		}
	}
}

func TestORDScopedMobileRoundTripAndConcurrentReplay(t *testing.T) {
	c := newClient(t, Config{})
	x := c.sample("授权手机只能在自己的工作区分享和导入学习包。")
	c.annotate(x, M{"body": "手机可见的标注笔记", "recipient": "note"}, "")
	path := exportTestORD(t, c, x)
	allowed := c.workspace("已授权")
	denied := c.workspace("未授权")
	token := id() + id()
	exec(c.s.db, "INSERT INTO paired_devices(id,name,token_hash,workspace_ids_json,created_at,expires_at) VALUES(?,?,?,?,?,?)", id(), "手机", digest([]byte(token)), js([]string{str(allowed, "id")}), now(), time.Now().Add(time.Hour).Unix())
	code, result := c.uploadORD(path, str(denied, "id"), id(), token)
	if code != 403 {
		t.Fatal("unauthorized import", code, result)
	}
	code, result = c.uploadORD(path, str(allowed, "id"), id(), token)
	if code != 200 {
		t.Fatal(code, result)
	}
	request := func(member, version, manifest string) int {
		r := httptest.NewRequest("GET", "http://127.0.0.1:7318/api/sync/documents/"+member+"/ord?versionId="+version+"&manifestId="+manifest, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		c.s.Handler().ServeHTTP(rec, r)
		return rec.Code
	}
	if code = request(str(x.d, "id"), str(obj(x.prepared, "version"), "id"), str(x.prepared, "resourceManifestId")); code != 403 {
		t.Fatal("unauthorized export", code)
	}
	if code = request(str(result, "workspaceDocumentId"), str(result, "versionId"), str(result, "resourceManifestId")); code != 200 {
		t.Fatal("scoped mobile export", code)
	}
	const n = 4
	key := id()
	var wg sync.WaitGroup
	out := make(chan M, n)
	errors := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); r, e := c.s.importORD(str(allowed, "id"), key, path); out <- r; errors <- e }()
	}
	wg.Wait()
	close(out)
	close(errors)
	for e := range errors {
		if e != nil {
			t.Fatal(e)
		}
	}
	first := ""
	for r := range out {
		if first == "" {
			first = str(r, "workspaceDocumentId")
		}
		if first != str(r, "workspaceDocumentId") {
			t.Fatal("concurrent retry duplicated import")
		}
	}
	if len(c.documents(allowed)) != 2 {
		t.Fatal("unexpected copies")
	}
}
