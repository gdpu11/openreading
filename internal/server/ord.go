package server

import (
	"archive/zip"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// ORD is a portable, single membership snapshot. Only this allowlist can cross
// the boundary: no source paths, drafts, model configuration or device grants.
var ordTables = []string{"versions", "artifacts", "manifests", "annotations", "resolutions", "threads", "messages", "message_versions", "reading_states", "note_learning", "book_preferences", "bookmarks", "recognized_pages"}

const ordMaxBytes int64 = 1 << 30

type ordBook struct {
	Title      string         `json:"title"`
	Format     string         `json:"format"`
	DocumentID string         `json:"documentId"`
	MemberID   string         `json:"workspaceDocumentId"`
	VersionID  string         `json:"versionId"`
	ManifestID string         `json:"resourceManifestId,omitempty"`
	Tables     map[string][]M `json:"tables"`
}
type ordManifest struct {
	Type      string            `json:"type"`
	Version   int               `json:"version"`
	CreatedAt string            `json:"createdAt"`
	BookHash  string            `json:"bookHash"`
	Files     map[string]string `json:"files"`
}

func ordInvalid(message string) error { return problem(400, "INVALID_ORD", message, false) }
func ordHex(v string, n int) bool {
	b, e := hex.DecodeString(v)
	return e == nil && len(v) == n && len(b)*2 == n
}
func ordName(title, kind string) string {
	title = filepath.Base(strings.ReplaceAll(title, "\\", "/"))
	title = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '-'
		}
		return r
	}, title)
	title = strings.Trim(title, " .")
	if title == "" {
		title = "Open Reading"
	}
	for len(title) > 180 {
		_, n := utf8.DecodeLastRuneInString(title)
		title = title[:len(title)-n]
	}
	stem := strings.ToUpper(strings.Split(title, ".")[0])
	if stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || len(stem) == 4 && (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) && stem[3] >= '1' && stem[3] <= '9' {
		title = "book-" + title
	}
	ext := map[string]string{"markdown": ".md", "txt": ".txt", "pdf": ".pdf", "epub": ".epub", "mobi": ".mobi", "azw3": ".azw3", "fb2": ".fb2", "docx": ".docx", "html": ".html", "rtf": ".rtf", "cbz": ".cbz", "cbr": ".cbr"}[kind]
	if format(title) != kind {
		title += ext
	}
	return title
}
func (s *Server) exportORD(member, version, manifest string) (path, title string, err error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock() // Keep blobs alive against cache GC.
	tx, e := s.db.Begin()
	if e != nil {
		return "", "", e
	}
	defer tx.Rollback()
	m, e := s.memberVersion(tx, member, version)
	if e != nil {
		return "", "", e
	}
	if e = s.manifestMember(tx, manifest, member, version); e != nil {
		return "", "", e
	}
	active, e := one(tx, "SELECT count(*) AS n FROM ai_runs r JOIN messages m ON m.id=r.message_id JOIN threads t ON t.id=m.thread_id JOIN annotations a ON a.id=t.annotation_id WHERE a.workspace_document_id=? AND r.state IN ('queued','preparing','generating')", member)
	if e != nil {
		return "", "", e
	}
	if num(active, "n") > 0 {
		return "", "", problem(409, "RUN_ACTIVE", "本书问答仍在生成，请结束后再导出完整学习包", true)
	}
	entry, e := one(tx, "SELECT e.relative_path FROM source_entries e JOIN document_bindings b ON b.source_entry_id=e.id WHERE b.workspace_document_id=? ORDER BY (b.state='active') DESC,e.relative_path LIMIT 1", member)
	if e != nil {
		return "", "", e
	}
	book := ordBook{Title: ordName(str(entry, "relativePath"), str(m, "format")), Format: str(m, "format"), DocumentID: str(m, "documentId"), MemberID: member, VersionID: version, ManifestID: manifest, Tables: map[string][]M{}}
	queries := map[string]string{
		"note_learning":    "SELECT n.* FROM note_learning n JOIN threads t ON t.id=n.id JOIN annotations a ON a.id=t.annotation_id WHERE a.workspace_document_id=?",
		"book_preferences": "SELECT * FROM book_preferences WHERE id=?",
		"bookmarks":        "SELECT * FROM bookmarks WHERE workspace_document_id=?",
		"annotations":      "SELECT * FROM annotations WHERE workspace_document_id=?",
		"resolutions":      "SELECT * FROM resolutions WHERE annotation_id IN(SELECT id FROM annotations WHERE workspace_document_id=?)",
		"threads":          "SELECT * FROM threads WHERE annotation_id IN(SELECT id FROM annotations WHERE workspace_document_id=?)",
		"messages":         "SELECT * FROM messages WHERE thread_id IN(SELECT t.id FROM threads t JOIN annotations a ON a.id=t.annotation_id WHERE a.workspace_document_id=?)",
		// Previous edits and unsent drafts are private; only the saved revision travels.
		"message_versions": "SELECT mv.* FROM message_versions mv JOIN messages m ON m.id=mv.message_id JOIN threads t ON t.id=m.thread_id JOIN annotations a ON a.id=t.annotation_id WHERE a.workspace_document_id=? AND mv.version=m.version",
		"reading_states":   "SELECT * FROM reading_states WHERE workspace_document_id=?",
	}
	for table, query := range queries {
		book.Tables[table], e = rawQuery(tx, query, member)
		if e != nil {
			return "", "", e
		}
	}
	versions := map[string]bool{version: true}
	for _, b := range book.Tables["bookmarks"] {
		versions[str(b, "version_id")] = true
	}
	manifests := map[string]bool{}
	artifacts := map[string]bool{}
	if manifest != "" {
		manifests[manifest] = true
	}
	for _, a := range book.Tables["annotations"] {
		versions[str(a, "original_version_id")] = true
		artifacts[str(a, "artifact_id")] = true
		if v := str(a, "manifest_id"); v != "" {
			manifests[v] = true
		}
	}
	for _, r := range book.Tables["resolutions"] {
		versions[str(r, "target_version_id")] = true
		var selector M
		if json.Unmarshal([]byte(str(r, "selector_json")), &selector) != nil {
			return "", "", ordInvalid("标注定位数据损坏")
		}
		a := obj(selector, "anchor")
		if v := str(a, "extractionArtifactId"); v != "" {
			artifacts[v] = true
		}
		if v := str(a, "resourceManifestId"); v != "" {
			manifests[v] = true
		}
	}
	for _, r := range book.Tables["reading_states"] {
		if v := str(r, "version_id"); v != "" {
			versions[v] = true
		}
	}
	for _, name := range []string{"versions", "artifacts", "manifests"} {
		ids := versions
		if name == "artifacts" {
			ids = artifacts
		}
		if name == "manifests" {
			ids = manifests
		}
		book.Tables[name] = []M{}
		ordered := []string{}
		for v := range ids {
			ordered = append(ordered, v)
		}
		sort.Strings(ordered)
		for _, v := range ordered {
			rows, e := rawQuery(tx, "SELECT * FROM "+name+" WHERE id=?", v)
			if e != nil {
				return "", "", e
			}
			if len(rows) != 1 {
				return "", "", ordInvalid("书籍版本或标注资源缺失，无法完整导出")
			}
			book.Tables[name] = append(book.Tables[name], rows[0])
		}
	}
	book.Tables["recognized_pages"], e = rawQuery(tx, "SELECT rp.* FROM recognized_pages rp JOIN versions v ON v.id=rp.version_id WHERE v.document_id=(SELECT document_id FROM workspace_documents WHERE id=?)", member)
	if e != nil {
		return "", "", e
	}
	keptOCR := []M{}
	for _, page := range book.Tables["recognized_pages"] {
		if versions[str(page, "version_id")] {
			keptOCR = append(keptOCR, page)
		}
	}
	book.Tables["recognized_pages"] = keptOCR
	files := map[string]string{}
	for _, v := range book.Tables["versions"] {
		if str(v, "document_id") != book.DocumentID {
			return "", "", ordInvalid("书籍版本范围不一致")
		}
		hash := str(v, "content_hash")
		if !ordHex(hash, 64) {
			return "", "", ordInvalid("快照编号无效")
		}
		files["blobs/"+hash] = hash
	}
	for _, v := range book.Tables["manifests"] {
		if !versions[str(v, "version_id")] {
			return "", "", ordInvalid("资源版本范围不一致")
		}
		if e = s.manifestMember(tx, str(v, "id"), member, str(v, "version_id")); e != nil {
			return "", "", e
		}
		var resources []M
		if json.Unmarshal([]byte(str(v, "resources_json")), &resources) != nil {
			return "", "", ordInvalid("资源清单损坏")
		}
		for _, r := range resources {
			hash := str(r, "blobHash")
			if !ordHex(hash, 64) {
				return "", "", ordInvalid("图片资源编号无效")
			}
			files["blobs/"+hash] = hash
		}
	}
	records := 0
	for _, rows := range book.Tables {
		records += len(rows)
	}
	if records > 100000 || len(files) > 10000 {
		return "", "", problem(413, "ORD_TOO_LARGE", "本书笔记或资源数量超过 ORD 上限", false)
	}
	data, e := json.Marshal(book)
	if e != nil {
		return "", "", e
	}
	if len(data) > 32<<20 {
		return "", "", problem(413, "ORD_TOO_LARGE", "学习笔记元数据超过 32 MB", false)
	}
	temp, e := os.CreateTemp(filepath.Join(s.cfg.DataDir, "staging"), "export-*.ord")
	if e != nil {
		return "", "", e
	}
	path = temp.Name()
	success := false
	defer func() {
		temp.Close()
		if !success {
			os.Remove(path)
		}
	}()
	z := zip.NewWriter(temp)
	put := func(name string, data []byte) error {
		w, e := z.Create(name)
		if e == nil {
			_, e = w.Write(data)
		}
		return e
	}
	header := ordManifest{"openreading-book", 1, now(), digest(data), files}
	if e = put("manifest.json", []byte(js(header))); e != nil {
		return "", "", e
	}
	if e = put("book.json", data); e != nil {
		return "", "", e
	}
	var total int64 = int64(len(data))
	for name, hash := range files {
		f, e := os.Open(filepath.Join(s.cfg.DataDir, "blobs", hash))
		if e != nil {
			return "", "", problem(409, "ORD_INCOMPLETE", "原文快照或图片资源缺失，请恢复后再导出", false)
		}
		h := sha256.New()
		w, e := z.Create(name)
		if e != nil {
			f.Close()
			return "", "", e
		}
		n, e := io.Copy(io.MultiWriter(w, h), io.LimitReader(f, maxFileSize+1))
		f.Close()
		total += n
		if e != nil {
			return "", "", e
		}
		if n > maxFileSize || total > ordMaxBytes {
			return "", "", problem(413, "ORD_TOO_LARGE", "ORD 展开大小超过 1 GB 或单个快照超过 200 MB", false)
		}
		if hex.EncodeToString(h.Sum(nil)) != hash {
			return "", "", problem(409, "ORD_INCOMPLETE", "原文快照或图片校验失败，导出未完成", false)
		}
	}
	if e = z.Close(); e != nil {
		return "", "", e
	}
	if e = temp.Sync(); e != nil {
		return "", "", e
	}
	if e = temp.Close(); e != nil {
		return "", "", e
	}
	success = true
	return path, book.Title + ".ord", nil
}

type ordImport struct {
	book        ordBook
	manifest    ordManifest
	dir         string
	archiveHash string
}

func (s *Server) readORD(path string) (*ordImport, error) {
	z, e := zip.OpenReader(path)
	if e != nil {
		return nil, ordInvalid("无法打开 .ord 学习包")
	}
	defer z.Close()
	entries := map[string]*zip.File{}
	var total uint64
	for _, f := range z.File {
		if (f.Name != "manifest.json" && f.Name != "book.json" && !(strings.HasPrefix(f.Name, "blobs/") && ordHex(strings.TrimPrefix(f.Name, "blobs/"), 64))) || !f.Mode().IsRegular() || entries[f.Name] != nil {
			return nil, ordInvalid("学习包含不安全、重复或额外的文件")
		}
		if f.UncompressedSize64 > uint64(maxFileSize) || total > uint64(ordMaxBytes)-f.UncompressedSize64 || len(entries) >= 20000 {
			return nil, problem(413, "ORD_TOO_LARGE", "ORD 展开大小超过上限", false)
		}
		total += f.UncompressedSize64
		entries[f.Name] = f
	}
	read := func(name string, limit int64) ([]byte, error) {
		f := entries[name]
		if f == nil {
			return nil, ordInvalid("学习包缺少清单、笔记或原文")
		}
		r, e := f.Open()
		if e != nil {
			return nil, ordInvalid("学习包文件无法读取")
		}
		defer r.Close()
		b, e := io.ReadAll(io.LimitReader(r, limit+1))
		if e != nil || int64(len(b)) > limit {
			return nil, ordInvalid("学习包条目损坏或超限")
		}
		return b, nil
	}
	mb, e := read("manifest.json", 2<<20)
	if e != nil {
		return nil, e
	}
	p := &ordImport{}
	if json.Unmarshal(mb, &p.manifest) != nil || p.manifest.Type != "openreading-book" || p.manifest.Version != 1 {
		return nil, ordInvalid("不支持的 ORD 格式版本")
	}
	data, e := read("book.json", 32<<20)
	if e != nil {
		return nil, e
	}
	if digest(data) != p.manifest.BookHash {
		return nil, ordInvalid("学习笔记校验失败，文件可能已损坏")
	}
	if json.Unmarshal(data, &p.book) != nil {
		return nil, ordInvalid("书籍数据格式无效")
	}
	b := &p.book
	if !ordHex(b.DocumentID, 32) || !ordHex(b.MemberID, 32) || !ordHex(b.VersionID, 32) || !supportedFormat(b.Format) || len(b.Title) > 1024 {
		return nil, ordInvalid("书籍信息无效")
	}
	allowed := map[string]bool{}
	for _, t := range ordTables {
		allowed[t] = true
	}
	for t := range b.Tables {
		if !allowed[t] {
			return nil, ordInvalid("学习包含非书籍数据")
		}
	}
	count := 0
	for _, rows := range b.Tables {
		for _, row := range rows {
			count++
			if count > 100000 {
				return nil, problem(413, "ORD_TOO_LARGE", "学习包记录过多", false)
			}
			for _, key := range []string{"revision", "version"} {
				if value, ok := row[key]; ok {
					n, ok := value.(float64)
					if !ok || n < 1 || n > 1e9 || n != float64(int64(n)) {
						return nil, ordInvalid("学习包修订编号无效")
					}
				}
			}
		}
	}
	for _, m := range b.Tables["messages"] {
		if (str(m, "role") != "user" && str(m, "role") != "assistant") || (str(m, "recipient") != "note" && str(m, "recipient") != "assistant") {
			return nil, ordInvalid("学习笔记角色无效")
		}
	}
	for _, a := range b.Tables["artifacts"] {
		var blocks []any
		if json.Unmarshal([]byte(str(a, "blocks_json")), &blocks) != nil || len(blocks) == 0 || len(blocks) > 20000 || str(a, "normalization_version") != "unicode-codepoint-preserve-v1" {
			return nil, ordInvalid("原文提取数据无效")
		}
		h := digest([]byte(js(M{"blocks": blocks, "parser": a["parser_version"], "normalization": a["normalization_version"], "sanitizer": a["sanitizer_version"]})))
		if h != str(a, "artifact_hash") {
			return nil, ordInvalid("原文提取数据校验失败")
		}
	}
	if len(entries) != len(p.manifest.Files)+2 {
		return nil, ordInvalid("学习包文件与清单不一致")
	}
	needed := map[string]bool{}
	current := false
	for _, v := range b.Tables["versions"] {
		hash := str(v, "content_hash")
		if str(v, "document_id") != b.DocumentID || !ordHex(hash, 64) || str(v, "blob_ref") != hash || num(v, "size") < 0 || int64(num(v, "size")) > maxFileSize {
			return nil, ordInvalid("书籍快照信息无效")
		}
		needed["blobs/"+hash] = true
		if str(v, "id") == b.VersionID {
			current = true
		}
	}
	if !current {
		return nil, ordInvalid("学习包缺少当前原文版本")
	}
	for _, m := range b.Tables["manifests"] {
		var resources []M
		if json.Unmarshal([]byte(str(m, "resources_json")), &resources) != nil {
			return nil, ordInvalid("图片清单无效")
		}
		for _, r := range resources {
			h := str(r, "blobHash")
			path := str(r, "path")
			if !ordHex(h, 64) || path == "" || strings.Contains(path, "\\") || strings.HasPrefix(path, "/") {
				return nil, ordInvalid("图片资源信息无效")
			}
			needed["blobs/"+h] = true
		}
	}
	if len(needed) != len(p.manifest.Files) {
		return nil, ordInvalid("学习包含遗漏或无关的资源")
	}
	if free := availableSpace(s.cfg.DataDir); free > 0 && free < total*3+(64<<20) {
		return nil, problem(507, "INSUFFICIENT_STORAGE", "磁盘空间不足以导入学习包", true)
	}
	p.dir, e = os.MkdirTemp(filepath.Join(s.cfg.DataDir, "staging"), "ord-import-")
	if e != nil {
		return nil, e
	}
	success := false
	defer func() {
		if !success {
			os.RemoveAll(p.dir)
		}
	}()
	for name, hash := range p.manifest.Files {
		if name != "blobs/"+hash || !ordHex(hash, 64) || !needed[name] {
			return nil, ordInvalid("学习包资源路径无效")
		}
		f := entries[name]
		if f == nil {
			return nil, ordInvalid("学习包缺少原文或图片资源")
		}
		input, e := f.Open()
		if e != nil {
			return nil, ordInvalid("学习包资源无法读取")
		}
		output, e := os.OpenFile(filepath.Join(p.dir, hash), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			input.Close()
			return nil, e
		}
		h := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(output, h), io.LimitReader(input, maxFileSize+1))
		input.Close()
		closeErr := output.Close()
		if closeErr != nil {
			return nil, closeErr
		}
		if copyErr != nil || n > maxFileSize || hex.EncodeToString(h.Sum(nil)) != hash {
			return nil, ordInvalid("原文或图片校验失败，导入未完成")
		}

	}
	for _, v := range b.Tables["versions"] {
		st, e := os.Stat(filepath.Join(p.dir, str(v, "content_hash")))
		if e != nil || st.Size() != int64(num(v, "size")) {
			return nil, ordInvalid("原文大小与清单不一致")
		}
		{
			if e = checkBookArchive(filepath.Join(p.dir, str(v, "content_hash")), b.Format); e != nil {
				return nil, e
			}
		}
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	h := sha256.New()
	_, e = io.Copy(h, f)
	f.Close()
	if e != nil {
		return nil, e
	}
	p.archiveHash = hex.EncodeToString(h.Sum(nil))
	success = true
	return p, nil
}

func (s *Server) importORD(workspace, key, path string) (M, error) {
	if _, e := one(s.db, "SELECT id FROM workspaces WHERE id=?", workspace); e != nil {
		return nil, e
	}
	p, e := s.readORD(path)
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(p.dir)
	s.importMu.Lock()
	defer s.importMu.Unlock()
	root := ""
	success := false
	defer func() {
		if !success && root != "" {
			os.RemoveAll(root)
		}
	}()
	result, e := s.idem("ord-import:"+workspace, key, M{"hash": p.archiveHash}, func(tx *sql.Tx) (M, error) {
		b := p.book
		doc, member, source, entry := id(), id(), id(), id()
		mapping := map[string]string{b.DocumentID: doc, b.MemberID: member}
		for _, table := range ordTables {
			for _, row := range b.Tables[table] {
				if v := str(row, "id"); v != "" {
					if table == "book_preferences" {
						if v != b.MemberID {
							return nil, ordInvalid("阅读设置范围不一致")
						}
						continue
					}
					if table == "note_learning" {
						if mapping[v] == "" {
							return nil, ordInvalid("学习记录缺少对应笔记")
						}
						continue
					}
					if !ordHex(v, 32) || mapping[v] != "" {
						return nil, ordInvalid("学习包记录编号无效或重复")
					}
					mapping[v] = id()
				}
			}
		}
		for _, m := range b.Tables["manifests"] {
			if v := str(m, "source_entry_id"); v != "" {
				if !ordHex(v, 32) || mapping[v] != "" && mapping[v] != entry {
					return nil, ordInvalid("图片来源编号无效")
				}
				mapping[v] = entry
			}
		}
		root = filepath.Join(s.cfg.DataDir, "imports", "ord-"+source)
		if e = os.Mkdir(root, 0700); e != nil {
			return nil, e
		}
		title := ordName(b.Title, b.Format)
		currentHash := ""
		for _, v := range b.Tables["versions"] {
			if str(v, "id") == b.VersionID {
				currentHash = str(v, "content_hash")
			}
		}
		from, e := os.Open(filepath.Join(p.dir, currentHash))
		if e != nil {
			return nil, e
		}
		to, e := os.OpenFile(filepath.Join(root, title), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			from.Close()
			return nil, e
		}
		_, e = io.Copy(to, from)
		from.Close()
		if e == nil {
			e = to.Sync()
		}
		ce := to.Close()
		if e == nil {
			e = ce
		}
		if e != nil {
			return nil, e
		}
		if e = syncDirectory(root); e != nil {
			return nil, e
		}
		st, e := os.Stat(filepath.Join(root, title))
		if e != nil {
			return nil, e
		}
		for _, hash := range p.manifest.Files {
			tmp, e := os.OpenFile(filepath.Join(p.dir, hash), os.O_RDONLY, 0)
			if e != nil {
				return nil, e
			}
			out, e := os.CreateTemp(filepath.Join(s.cfg.DataDir, "staging"), "ord-blob-")
			if e != nil {
				tmp.Close()
				return nil, e
			}
			_, e = io.Copy(out, tmp)
			tmp.Close()
			if e == nil {
				e = out.Sync()
			}
			ce := out.Close()
			if e == nil {
				e = ce
			}
			if e == nil {
				e = os.Rename(out.Name(), filepath.Join(s.cfg.DataDir, "blobs", hash))
			}
			if e != nil {
				os.Remove(out.Name())
				return nil, e
			}
		}
		if e = syncDirectory(filepath.Join(s.cfg.DataDir, "blobs")); e != nil {
			return nil, e
		}
		for _, statement := range []struct {
			sql  string
			args []any
		}{
			{"INSERT INTO documents VALUES(?,?,?)", []any{doc, b.Format, now()}},
			{"INSERT INTO sources VALUES(?,?, 'imported_collection',?,?,'active','[]',?)", []any{source, workspace, root, "ORD · " + title, now()}},
			{"INSERT INTO source_entries VALUES(?,?,?,?,?,?,?,'active')", []any{entry, source, doc, title, fileIdentity(filepath.Join(root, title), st), st.Size(), st.ModTime().UnixNano()}},
			{"INSERT INTO workspace_documents(id,workspace_id,document_id) VALUES(?,?,?)", []any{member, workspace, doc}},
			{"INSERT INTO document_bindings VALUES(?,?,'active')", []any{member, entry}},
		} {
			if e = exec(tx, statement.sql, statement.args...); e != nil {
				return nil, e
			}
		}
		for _, table := range ordTables {
			cols, e := all(tx, "PRAGMA table_info("+table+")")
			if e != nil {
				return nil, e
			}
			keys := []string{}
			marks := []string{}
			for _, c := range cols {
				keys = append(keys, str(c, "name"))
				marks = append(marks, "?")
			}
			for _, original := range b.Tables[table] {
				if len(original) != len(keys) {
					return nil, ordInvalid("学习包字段缺失或不支持")
				}
				values := []any{}
				for _, k := range keys {
					v, ok := original[k]
					if !ok {
						return nil, ordInvalid("学习包字段不支持")
					}
					if idColumns[k] && v != nil {
						x, ok := v.(string)
						if !ok || mapping[x] == "" {
							return nil, ordInvalid("学习包引用了不存在的记录")
						}
						v = mapping[x]
					}
					if strings.HasSuffix(k, "_json") {
						var parsed any
						x, ok := v.(string)
						if !ok || json.Unmarshal([]byte(x), &parsed) != nil {
							return nil, ordInvalid("学习包标注数据格式无效")
						}
						v = js(remapJSON(parsed, mapping, k))
					}
					if table == "manifests" && k == "source_entry_id" {
						v = entry
					}
					values = append(values, v)
				}
				if e = exec(tx, "INSERT INTO "+table+"("+strings.Join(keys, ",")+") VALUES("+strings.Join(marks, ",")+")", values...); e != nil {
					return nil, ordInvalid("学习包数据关系错误，导入未提交")
				}
			}
		}
		annotations, e := all(tx, "SELECT * FROM annotations WHERE workspace_document_id=?", member)
		if e != nil {
			return nil, e
		}
		for _, a := range annotations {
			anchor := obj(a, "anchor")
			if e = s.validateAnchor(tx, member, str(a, "originalVersionId"), anchor); e != nil {
				return nil, e
			}
			if str(anchor, "extractionArtifactId") != str(a, "artifactId") || str(anchor, "resourceManifestId") != str(a, "manifestId") {
				return nil, ordInvalid("标注与原文引用不一致")
			}
		}
		for _, r := range b.Tables["resolutions"] {
			if str(r, "method") == "manual" {
				var sel M
				json.Unmarshal([]byte(str(r, "selector_json")), &sel)
				sel = remapJSON(sel, mapping, "").(map[string]any)
				if e = s.validateAnchor(tx, member, mapping[str(r, "target_version_id")], obj(sel, "anchor")); e != nil {
					return nil, e
				}
			}
		}
		for _, r := range b.Tables["annotations"] {
			if str(r, "workspace_document_id") != b.MemberID {
				return nil, ordInvalid("学习包标注范围不一致")
			}
		}
		if _, e = s.memberVersion(tx, member, mapping[b.VersionID]); e != nil {
			return nil, e
		}
		if b.ManifestID != "" && mapping[b.ManifestID] == "" {
			return nil, ordInvalid("当前资源清单不存在")
		}
		if e = s.manifestMember(tx, mapping[b.ManifestID], member, mapping[b.VersionID]); e != nil {
			return nil, e
		}
		for _, bookmark := range b.Tables["bookmarks"] {
			if str(bookmark, "workspace_document_id") != b.MemberID {
				return nil, ordInvalid("书签范围不一致")
			}
			if _, e := s.memberVersion(tx, member, mapping[str(bookmark, "version_id")]); e != nil {
				return nil, e
			}
		}
		// Make the chosen snapshot the initial file; historical anchors keep their IDs.
		return M{"workspaceDocumentId": member, "documentId": doc, "versionId": mapping[b.VersionID], "resourceManifestId": mapping[b.ManifestID], "title": title, "annotations": len(annotations), "messages": len(b.Tables["messages"]), "versions": len(b.Tables["versions"])}, nil
	})
	if e == nil {
		success = true
	}
	return result, e
}
func (s *Server) ordDownload(w http.ResponseWriter, r *http.Request) error {
	member := r.PathValue("m")
	if d := deviceFrom(r); d != nil {
		if _, e := s.syncMember(s.db, d, member); e != nil {
			return e
		}
	}
	path, title, e := s.exportORD(member, r.URL.Query().Get("versionId"), r.URL.Query().Get("manifestId"))
	if e != nil {
		return e
	}
	defer os.Remove(path)
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return e
	}
	w.Header().Set("Content-Type", "application/vnd.openreading.ord+zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": title}))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, title, st.ModTime(), f)
	return nil
}
func (s *Server) ordUpload(w http.ResponseWriter, r *http.Request) error {
	workspace := r.PathValue("w")
	if d := deviceFrom(r); d != nil && !deviceWorkspace(d, workspace) {
		return problem(403, "SYNC_SCOPE", "目标工作区不在设备授权范围内", false)
	}
	r.Body = http.MaxBytesReader(w, r.Body, ordMaxBytes+(8<<20))
	if e := r.ParseMultipartForm(8 << 20); e != nil {
		if r.MultipartForm != nil {
			r.MultipartForm.RemoveAll()
		}
		return problem(413, "ORD_TOO_LARGE", "ORD 上传失败或超过 1 GB", false)
	}
	defer r.MultipartForm.RemoveAll()
	file, _, e := r.FormFile("file")
	if e != nil {
		return ordInvalid("请选择 .ord 学习包")
	}
	defer file.Close()
	temp, e := os.CreateTemp(filepath.Join(s.cfg.DataDir, "staging"), "ord-upload-")
	if e != nil {
		return e
	}
	defer os.Remove(temp.Name())
	_, e = io.Copy(temp, io.LimitReader(file, ordMaxBytes+1))
	ce := temp.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	st, e := os.Stat(temp.Name())
	if e != nil {
		return e
	}
	if st.Size() > ordMaxBytes {
		return problem(413, "ORD_TOO_LARGE", "ORD 文件超过 1 GB", false)
	}
	result, e := s.importORD(workspace, r.FormValue("clientRequestId"), temp.Name())
	if e != nil {
		return e
	}
	return send(w, result)
}
func (s *Server) ordRoutes() {
	s.route("GET /api/documents/{m}/ord", s.ordDownload)
	s.route("POST /api/workspaces/{w}/ord", s.ordUpload)
	s.route("GET /api/sync/documents/{m}/ord", s.ordDownload)
	s.route("POST /api/sync/workspaces/{w}/ord", s.ordUpload)
}
