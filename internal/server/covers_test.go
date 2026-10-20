package server

import (
	"archive/zip"
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestLibraryCoverPreviews(t *testing.T) {
	for _, mode := range []string{"epub2", "epub3", "wrapper", "external"} {
		t.Run(mode, func(t *testing.T) {
			c := newClient(t, Config{})
			w := c.workspace("封面书库")
			root := t.TempDir()
			var picture bytes.Buffer
			img := image.NewRGBA(image.Rect(0, 0, 20, 30))
			img.Set(0, 0, color.RGBA{255, 0, 0, 255})
			_ = png.Encode(&picture, img)
			book := filepath.Join(root, "cover.epub")
			f, e := os.Create(book)
			if e != nil {
				t.Fatal(e)
			}
			z := zip.NewWriter(f)
			meta := ""
			props := ""
			href := "images/front%20image.png"
			switch mode {
			case "epub2":
				meta = `<metadata><meta name="cover" content="image"/></metadata>`
			case "epub3":
				props = ` properties="cover-image"`
			case "external":
				href = "https://example.invalid/cover.png"
				props = ` properties="cover-image"`
			}
			files := map[string]string{
				"mimetype":               "application/epub+zip",
				"META-INF/container.xml": `<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>`,
				"OPS/package.opf":        `<package>` + meta + `<manifest><item id="image" href="` + href + `" media-type="image/png"` + props + `/><item id="front" href="front.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="front"/></spine></package>`,
				"OPS/front.xhtml":        `<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="images/front%20image.png"/></svg></body></html>`,
			}
			if mode == "external" {
				files["OPS/front.xhtml"] = `<html><body>no cover</body></html>`
			}
			for name, body := range files {
				entry, _ := z.Create(name)
				_, _ = entry.Write([]byte(body))
			}
			entry, _ := z.Create("OPS/images/front image.png")
			_, _ = entry.Write(picture.Bytes())
			_ = z.Close()
			_ = f.Close()
			c.source(w, root)
			docs := arr(c.ok("GET", "/api/workspaces/"+str(w, "id")+"/documents", nil), "items")
			if len(docs) != 1 {
				t.Fatal(docs)
			}
			member := docs[0].(map[string]any)
			endpoint := "http://127.0.0.1:7318/api/documents/" + str(member, "id") + "/cover"
			request := func(cookie bool, tag string) *httptest.ResponseRecorder {
				r := httptest.NewRequest("GET", endpoint, nil)
				if cookie {
					r.AddCookie(c.cookie)
				}
				if tag != "" {
					r.Header.Set("If-None-Match", tag)
				}
				rec := httptest.NewRecorder()
				c.s.Handler().ServeHTTP(rec, r)
				return rec
			}
			if request(false, "").Code != 401 {
				t.Fatal("cover bypassed session")
			}
			res := request(true, "")
			if mode == "external" {
				if res.Code != 404 {
					t.Fatal(res.Code)
				}
				return
			}
			if res.Code != 200 || res.Header().Get("Content-Type") != "image/png" || !bytes.Equal(res.Body.Bytes(), picture.Bytes()) {
				t.Fatal(res.Code, res.Body.String())
			}
			if request(true, res.Header().Get("ETag")).Code != http.StatusNotModified {
				t.Fatal("cover cache validation failed")
			}

			thumbnailURL := endpoint[:len(endpoint)-len("cover")] + "thumbnail"
			thumbnailRequest := func(method string, data []byte, tag string, csrf bool) *httptest.ResponseRecorder {
				req := httptest.NewRequest(method, thumbnailURL, bytes.NewReader(data))
				req.AddCookie(c.cookie)
				req.Header.Set("Content-Type", "image/jpeg")
				req.Header.Set("If-Match", tag)
				if csrf {
					req.Header.Set("X-CSRF-Token", c.csrf)
				}
				result := httptest.NewRecorder()
				c.s.Handler().ServeHTTP(result, req)
				return result
			}
			missing := thumbnailRequest("GET", nil, "", false)
			if missing.Code != 404 || missing.Header().Get("ETag") == "" {
				t.Fatal("missing thumbnail has no source revision")
			}
			var preview bytes.Buffer
			_ = jpeg.Encode(&preview, img, nil)
			if thumbnailRequest("PUT", preview.Bytes(), missing.Header().Get("ETag"), false).Code != 403 {
				t.Fatal("thumbnail write bypassed CSRF")
			}
			if thumbnailRequest("PUT", preview.Bytes(), "stale", true).Code != 412 {
				t.Fatal("stale thumbnail accepted")
			}
			if thumbnailRequest("PUT", []byte("<svg/>"), missing.Header().Get("ETag"), true).Code != 400 {
				t.Fatal("active markup accepted as thumbnail")
			}
			if put := thumbnailRequest("PUT", preview.Bytes(), missing.Header().Get("ETag"), true); put.Code != 200 {
				t.Fatal(put.Code, put.Body.String())
			}
			cached := thumbnailRequest("GET", nil, "", false)
			if cached.Code != 200 || !bytes.Equal(cached.Body.Bytes(), preview.Bytes()) {
				t.Fatal("persistent thumbnail unavailable")
			}
			rows, _ := all(c.s.db, "SELECT id FROM versions")
			if len(rows) != 0 {
				t.Fatal("shelf preview captured a reading snapshot")
			}
			m, _ := c.s.member(c.s.db, str(member, "id"))
			if str(m, "lastOpened") != "" {
				t.Fatal("shelf preview changed recent reading")
			}
		})
	}
}
func TestPDFCoverRangeAndSnapshotFallback(t *testing.T) {
	c := newClient(t, Config{})
	w := c.workspace("PDF 预览")
	root := t.TempDir()
	b := []byte("%PDF-1.7\npreview test document\n%%EOF")
	file := filepath.Join(root, "sample.pdf")
	if e := os.WriteFile(file, b, 0600); e != nil {
		t.Fatal(e)
	}
	c.source(w, root)
	docs := arr(c.ok("GET", "/api/workspaces/"+str(w, "id")+"/documents", nil), "items")
	member := docs[0].(map[string]any)
	read := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "http://127.0.0.1:7318/api/documents/"+str(member, "id")+"/cover", nil)
		r.AddCookie(c.cookie)
		r.Header.Set("Range", "bytes=0-7")
		rec := httptest.NewRecorder()
		c.s.Handler().ServeHTTP(rec, r)
		return rec
	}
	r := read()
	if r.Code != 206 || r.Body.String() != string(b[:8]) || r.Header().Get("Content-Type") != "application/pdf" {
		t.Fatal(r.Code, r.Body.String())
	}
	binding := arr(member, "bindings")[0].(map[string]any)
	c.ok("POST", "/api/documents/"+str(member, "documentId")+"/prepare", M{"workspaceDocumentId": member["id"], "sourceEntryId": binding["id"]})
	if e := os.Remove(file); e != nil {
		t.Fatal(e)
	}
	if r = read(); r.Code != 206 || r.Body.String() != string(b[:8]) {
		t.Fatal("cached snapshot cover unavailable", r.Code)
	}
}
