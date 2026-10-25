package server

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/xml"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Previewing a shelf never prepares a document or changes last_opened.
func (s *Server) coverFile(member string) (*os.File, string, error) {
	m, e := s.member(s.db, member)
	if e != nil {
		return nil, "", e
	}
	format := str(m, "format")
	if readingFormat(format) != "epub" && format != "pdf" {
		return nil, "", problem(404, "COVER_UNAVAILABLE", "此文档没有封面", false)
	}
	entries, e := all(s.db, `SELECT e.relative_path,s.root FROM document_bindings b JOIN source_entries e ON e.id=b.source_entry_id JOIN sources s ON s.id=e.source_id WHERE b.workspace_document_id=? AND b.state='active' AND e.state='active' AND s.state='active' ORDER BY e.relative_path`, member)
	if e != nil {
		return nil, "", e
	}
	for _, entry := range entries {
		if f, err := safeFile(str(entry, "root"), str(entry, "relativePath")); err == nil {
			return f, format, nil
		}
	}
	v, e := one(s.db, "SELECT v.blob_ref,v.content_hash FROM versions v JOIN workspace_documents wd ON wd.document_id=v.document_id WHERE wd.id=? ORDER BY v.created_at DESC LIMIT 1", member)
	if e != nil {
		return nil, "", problem(404, "COVER_UNAVAILABLE", "封面暂不可用", false)
	}
	if !validBlobReference(str(v, "contentHash"), str(v, "blobRef")) {
		return nil, "", problem(404, "COVER_UNAVAILABLE", "封面暂不可用", false)
	}
	f, e := os.Open(filepath.Join(s.cfg.DataDir, "blobs", str(v, "blobRef")))
	return f, format, e
}

func epubCover(f *os.File, size int64) ([]byte, string, error) {
	z, e := zip.NewReader(f, size)
	if e != nil || len(z.File) > 10000 {
		return nil, "", fmt.Errorf("invalid EPUB archive")
	}
	files := map[string]*zip.File{}
	for _, item := range z.File {
		files[item.Name] = item
	}
	read := func(name string, limit uint64) ([]byte, error) {
		item := files[name]
		if item == nil || item.UncompressedSize64 > limit {
			return nil, fmt.Errorf("cover entry unavailable")
		}
		r, e := item.Open()
		if e != nil {
			return nil, e
		}
		defer r.Close()
		b, e := io.ReadAll(io.LimitReader(r, int64(limit)+1))
		if uint64(len(b)) > limit {
			return nil, fmt.Errorf("cover too large")
		}
		return b, e
	}
	resolve := func(base, href string) string {
		u, e := url.Parse(href)
		if e != nil || u.IsAbs() || u.Host != "" || strings.HasPrefix(u.Path, "/") {
			return ""
		}
		name := path.Clean(path.Join(path.Dir(base), u.Path))
		if name == ".." || strings.HasPrefix(name, "../") {
			return ""
		}
		return name
	}
	tokens := func(b []byte, visit func(xml.StartElement)) error {
		d := xml.NewDecoder(bytes.NewReader(b))
		for {
			t, e := d.Token()
			if e == io.EOF {
				return nil
			}
			if e != nil {
				return e
			}
			if el, ok := t.(xml.StartElement); ok {
				visit(el)
			}
		}
	}
	attr := func(el xml.StartElement, key string) string {
		for _, a := range el.Attr {
			if a.Name.Local == key {
				return a.Value
			}
		}
		return ""
	}
	container, e := read("META-INF/container.xml", 2<<20)
	if e != nil {
		return nil, "", e
	}
	opf := ""
	if e = tokens(container, func(el xml.StartElement) {
		if el.Name.Local == "rootfile" && opf == "" {
			opf = resolve("container.xml", attr(el, "full-path"))
		}
	}); e != nil {
		return nil, "", e
	}
	pkg, e := read(opf, 2<<20)
	if e != nil {
		return nil, "", e
	}
	type item struct{ id, href, media, properties string }
	var manifest []item
	var spine []string
	var guides []string
	meta := ""
	e = tokens(pkg, func(el xml.StartElement) {
		switch el.Name.Local {
		case "meta":
			if attr(el, "name") == "cover" {
				meta = attr(el, "content")
			}
		case "item":
			manifest = append(manifest, item{attr(el, "id"), attr(el, "href"), attr(el, "media-type"), attr(el, "properties")})
		case "itemref":
			spine = append(spine, attr(el, "idref"))
		case "reference":
			if attr(el, "type") == "cover" {
				guides = append(guides, resolve(opf, attr(el, "href")))
			}
		}
	})
	if e != nil {
		return nil, "", e
	}
	var candidates []string
	for _, i := range manifest {
		if i.id == meta || strings.Contains(" "+i.properties+" ", " cover-image ") {
			candidates = append(candidates, resolve(opf, i.href))
		}
	}
	candidates = append(candidates, guides...)
	if len(spine) > 0 {
		for _, i := range manifest {
			if i.id == spine[0] {
				candidates = append(candidates, resolve(opf, i.href))
			}
		}
	}
	for _, i := range manifest {
		if strings.HasPrefix(i.media, "image/") && strings.Contains(strings.ToLower(i.href), "cover") {
			candidates = append(candidates, resolve(opf, i.href))
		}
	}
	// XHTML/SVG cover pages often wrap a raster image. Never serve active markup.
	for n := 0; n < len(candidates) && n < 30; n++ {
		name := candidates[n]
		b, err := read(name, 16<<20)
		if err != nil {
			continue
		}
		kind := http.DetectContentType(b)
		if kind == "image/jpeg" || kind == "image/png" || kind == "image/gif" {
			cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
			if err == nil && cfg.Width > 0 && cfg.Height > 0 && int64(cfg.Width)*int64(cfg.Height) <= 40000000 {
				return b, kind, nil
			}
			continue
		}
		if len(b) <= 2<<20 {
			_ = tokens(b, func(el xml.StartElement) {
				href := ""
				if el.Name.Local == "img" {
					href = attr(el, "src")
				}
				if el.Name.Local == "image" {
					href = attr(el, "href")
				}
				if href != "" && len(candidates) < 30 {
					candidates = append(candidates, resolve(name, href))
				}
			})
		}
	}
	return nil, "", fmt.Errorf("no raster cover")
}
func coverTag(info os.FileInfo) string {
	return fmt.Sprintf("\"%x-%x\"", info.ModTime().UnixNano(), info.Size())
}
func (s *Server) thumbnail(w http.ResponseWriter, r *http.Request) error {
	f, _, e := s.coverFile(r.PathValue("m"))
	if e != nil {
		return e
	}
	info, e := f.Stat()
	f.Close()
	if e != nil {
		return e
	}
	tag := coverTag(info)
	w.Header().Set("ETag", tag)
	key := sha256.Sum256([]byte("shelf-v1:" + r.PathValue("m") + tag))
	dir := filepath.Join(s.cfg.DataDir, "covers")
	name := filepath.Join(dir, fmt.Sprintf("%x.jpg", key))
	if r.Method == "GET" {
		image, e := os.Open(name)
		if os.IsNotExist(e) {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(404)
			return nil
		}
		if e != nil {
			return e
		}
		defer image.Close()
		w.Header().Set("Cache-Control", "private, max-age=3600")
		w.Header().Set("Content-Type", "image/jpeg")
		http.ServeContent(w, r, "thumbnail.jpg", info.ModTime(), image)
		return nil
	}
	if r.Header.Get("If-Match") != tag {
		return problem(412, "COVER_CHANGED", "封面来源已更新", true)
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, 512<<10+1))
	if e != nil {
		return e
	}
	cfg, kind, e := image.DecodeConfig(bytes.NewReader(b))
	if e != nil || kind != "jpeg" || len(b) > 512<<10 || cfg.Width > 512 || cfg.Height > 512 || cfg.Width < 1 || cfg.Height < 1 {
		return problem(400, "INVALID_COVER", "缩略图无效", false)
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	temp, e := os.CreateTemp(dir, "thumbnail-")
	if e != nil {
		return e
	}
	defer os.Remove(temp.Name())
	_, e = temp.Write(b)
	closeErr := temp.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	if e = os.Rename(temp.Name(), name); e != nil {
		return e
	}
	return send(w, M{"ok": true})
}
func (s *Server) coverRoutes() {
	s.route("GET /api/documents/{m}/thumbnail", s.thumbnail)
	s.route("PUT /api/documents/{m}/thumbnail", s.thumbnail)
	s.route("GET /api/documents/{m}/cover", func(w http.ResponseWriter, r *http.Request) error {
		f, format, e := s.coverFile(r.PathValue("m"))
		if e != nil {
			return e
		}
		defer f.Close()
		info, e := f.Stat()
		if e != nil {
			return e
		}
		if info.Size() > maxFileSize {
			return problem(413, "FILE_TOO_LARGE", "文件超过 200 MB 上限", false)
		}
		tag := coverTag(info)
		w.Header().Set("ETag", tag)
		w.Header().Set("Cache-Control", "private, max-age=3600")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Header.Get("If-None-Match") == tag {
			w.WriteHeader(http.StatusNotModified)
			return nil
		}
		if format != "epub" {
			w.Header().Set("Content-Type", bookContentType(format))
			http.ServeContent(w, r, "preview.pdf", info.ModTime(), f)
			return nil
		}
		b, kind, e := epubCover(f, info.Size())
		if e != nil {
			return problem(404, "COVER_UNAVAILABLE", "此书暂无可用封面", false)
		}
		w.Header().Set("Content-Type", kind)
		http.ServeContent(w, r, "cover", info.ModTime(), bytes.NewReader(b))
		return nil
	})
}
