package server

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) capture(root, relative string) (string, int64, error) {
	for attempt := 0; attempt < 3; attempt++ {
		f, e := safeFile(root, relative)
		if e != nil {
			return "", 0, e
		}
		before, e := f.Stat()
		if e != nil {
			f.Close()
			return "", 0, e
		}
		if before.Size() > maxFileSize {
			f.Close()
			return "", 0, problem(413, "FILE_TOO_LARGE", "文件超过 200 MB 上限", false)
		}
		temp, e := os.CreateTemp(filepath.Join(s.cfg.DataDir, "staging"), "capture-")
		if e != nil {
			f.Close()
			return "", 0, e
		}
		h := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(temp, h), io.LimitReader(f, maxFileSize+1))
		after, statErr := f.Stat()
		_ = f.Close()
		syncErr := temp.Sync()
		closeErr := temp.Close()
		latest, openErr := safeFile(root, relative)
		stable := false
		if openErr == nil {
			last, err := latest.Stat()
			stable = err == nil && statErr == nil && os.SameFile(before, last) && before.Size() == after.Size() && before.ModTime() == after.ModTime() && before.Size() == last.Size() && before.ModTime() == last.ModTime()
			latest.Close()
		}
		if copyErr != nil || syncErr != nil || closeErr != nil {
			_ = os.Remove(temp.Name())
			if copyErr != nil {
				return "", 0, copyErr
			}
			if syncErr != nil {
				return "", 0, syncErr
			}
			return "", 0, closeErr
		}
		if n > maxFileSize {
			os.Remove(temp.Name())
			return "", 0, problem(413, "FILE_TOO_LARGE", "文件超过 200 MB 上限", false)
		}
		if !stable {
			_ = os.Remove(temp.Name())
			continue
		}
		if format(relative) == "epub" {
			if e = checkArchive(temp.Name()); e != nil {
				os.Remove(temp.Name())
				return "", 0, e
			}
		}
		hash := hex.EncodeToString(h.Sum(nil))
		dest := filepath.Join(s.cfg.DataDir, "blobs", hash)
		if _, e = os.Stat(dest); e == nil {
			e = os.Remove(temp.Name())
		} else {
			e = os.Rename(temp.Name(), dest)
		}
		if e != nil {
			return "", 0, e
		}
		if e = syncDirectory(filepath.Join(s.cfg.DataDir, "blobs")); e != nil {
			return "", 0, e
		}
		return hash, n, nil
	}
	return "", 0, problem(409, "VERSION_CHANGED", "源文件仍在更新，请稍后重新打开", true)
}
func (s *Server) versionRoutes() {
	s.route("POST /api/documents/{d}/prepare", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		member, e := s.member(s.db, str(b, "workspaceDocumentId"))
		if e != nil {
			return e
		}
		if str(member, "documentId") != r.PathValue("d") {
			return problem(403, "PATH_NOT_ALLOWED", "工作区文档不匹配", false)
		}
		entry, e := one(s.db, "SELECT e.*,s.root,s.state AS source_state FROM source_entries e JOIN sources s ON s.id=e.source_id JOIN document_bindings b ON b.source_entry_id=e.id WHERE b.workspace_document_id=? AND e.id=? AND e.document_id=? AND b.state='active' AND e.state='active' AND s.state='active'", member["id"], b["sourceEntryId"], member["documentId"])
		if e != nil {
			return problem(404, "SOURCE_UNAVAILABLE", "来源绑定不可用，可打开历史版本或重新连接", true)
		}
		var result M
		e = s.transaction(func(tx *sql.Tx) error {
			hash, size, e := s.capture(str(entry, "root"), str(entry, "relativePath"))
			if e != nil {
				return e
			}
			v, e := one(tx, "SELECT * FROM versions WHERE document_id=? AND content_hash=?", member["documentId"], hash)
			if isNotFound(e) {
				v = M{"id": id(), "documentId": member["documentId"], "contentHash": hash, "size": size, "createdAt": now()}
				e = exec(tx, "INSERT INTO versions VALUES(?,?,?,?,?,?)", v["id"], member["documentId"], hash, hash, size, v["createdAt"])
			}
			if e != nil {
				return e
			}
			lease := id()
			if e = exec(tx, "INSERT INTO leases VALUES(?,?,?)", lease, v["id"], time.Now().Add(10*time.Minute).Unix()); e != nil {
				return e
			}
			manifest, e := one(tx, "SELECT * FROM manifests WHERE version_id=? AND source_entry_id=? ORDER BY created_at DESC LIMIT 1", v["id"], entry["id"])
			if isNotFound(e) {
				manifest = M{"id": id(), "resources": []any{}}
				e = exec(tx, "INSERT INTO manifests VALUES(?,?,?,'[]',?)", manifest["id"], v["id"], entry["id"], now())
			}
			if e != nil {
				return e
			}
			if str(b, "purpose") != "conversion" {
				if e = exec(tx, "UPDATE workspace_documents SET last_opened=? WHERE id=?", now(), member["id"]); e != nil {
					return e
				}
			}
			state, _ := one(tx, "SELECT * FROM reading_states WHERE workspace_document_id=?", member["id"])
			result = M{"version": v, "leaseId": lease, "sourceEntryId": entry["id"], "resourceManifestId": manifest["id"], "readingState": state, "format": member["format"]}
			return nil
		})
		if e != nil {
			return e
		}
		return send(w, result)
	})
	s.route("GET /api/documents/{d}/versions", func(w http.ResponseWriter, r *http.Request) error {
		m, e := s.member(s.db, r.URL.Query().Get("workspaceDocumentId"))
		if e != nil || str(m, "documentId") != r.PathValue("d") {
			return problem(403, "PATH_NOT_ALLOWED", "工作区文档不匹配", false)
		}
		v, e := all(s.db, "SELECT id,document_id,content_hash,size,created_at FROM versions WHERE document_id=? ORDER BY created_at DESC", m["documentId"])
		if e != nil {
			return e
		}
		for _, version := range v {
			manifest, err := one(s.db, "SELECT m.id FROM manifests m JOIN document_bindings b ON b.source_entry_id=m.source_entry_id WHERE m.version_id=? AND b.workspace_document_id=? ORDER BY m.created_at DESC LIMIT 1", version["id"], m["id"])
			if err == nil {
				version["manifestId"] = manifest["id"]
			} else if !isNotFound(err) {
				return err
			}
		}
		return send(w, v)
	})
	s.route("POST /api/versions/{v}/lease", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		lease := id()
		e = s.transaction(func(tx *sql.Tx) error {
			if _, e := s.memberVersion(tx, str(b, "workspaceDocumentId"), r.PathValue("v")); e != nil {
				return e
			}
			return exec(tx, "INSERT INTO leases VALUES(?,?,?)", lease, r.PathValue("v"), time.Now().Add(10*time.Minute).Unix())
		})
		if e != nil {
			return e
		}
		return send(w, M{"id": lease})
	})
	s.route("GET /api/versions/{v}/content", func(w http.ResponseWriter, r *http.Request) error {
		v, e := s.memberVersion(s.db, r.URL.Query().Get("workspaceDocumentId"), r.PathValue("v"))
		if e != nil {
			return e
		}
		s.writeMu.Lock()
		f, e := os.Open(filepath.Join(s.cfg.DataDir, "blobs", str(v, "blobRef")))
		if e != nil {
			s.writeMu.Unlock()
			return problem(404, "SOURCE_UNAVAILABLE", "此快照已被清理，请重新连接来源", false)
		}
		defer f.Close()
		s.writeMu.Unlock()
		if e = exec(s.db, "INSERT INTO leases VALUES(?,?,?)", id(), v["id"], time.Now().Add(10*time.Minute).Unix()); e != nil {
			return e
		}
		switch str(v, "format") {
		case "pdf":
			w.Header().Set("Content-Type", "application/pdf")
		case "epub":
			w.Header().Set("Content-Type", "application/epub+zip")
		default:
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		}
		info, e := f.Stat()
		if e != nil {
			return e
		}
		http.ServeContent(w, r, "snapshot", info.ModTime(), f)
		return nil
	})
	s.route("POST /api/leases/{l}/renew", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = s.transaction(func(tx *sql.Tx) error {
			v, e := one(tx, "SELECT * FROM leases WHERE id=?", r.PathValue("l"))
			if e != nil {
				return e
			}
			if _, e = s.memberVersion(tx, str(b, "workspaceDocumentId"), str(v, "versionId")); e != nil {
				return e
			}
			return exec(tx, "UPDATE leases SET expires_at=? WHERE id=?", time.Now().Add(10*time.Minute).Unix(), r.PathValue("l"))
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("POST /api/artifacts", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		blocks := arr(b, "blocks")
		if len(blocks) == 0 || len(blocks) > 20000 || len(js(blocks)) > 4<<20 {
			return problem(400, "INVALID_ARTIFACT", "提取产物过大或为空", false)
		}
		seen := map[string]bool{}
		for _, v := range blocks {
			x, ok := v.(map[string]any)
			if !ok || str(x, "id") == "" || seen[str(x, "id")] {
				return problem(400, "INVALID_ARTIFACT", "文本块标识无效", false)
			}
			seen[str(x, "id")] = true
		}
		if str(b, "normalizationVersion") != "unicode-codepoint-preserve-v1" || str(b, "parserVersion") == "" {
			return problem(400, "INVALID_ARTIFACT", "解析或规范化版本无效", false)
		}
		var out M
		e = s.transaction(func(tx *sql.Tx) error {
			if _, e := s.memberVersion(tx, str(b, "workspaceDocumentId"), str(b, "versionId")); e != nil {
				return e
			}
			hash := digest([]byte(js(M{"blocks": blocks, "parser": b["parserVersion"], "normalization": b["normalizationVersion"], "sanitizer": "safe-v1"})))
			out, e = one(tx, "SELECT * FROM artifacts WHERE version_id=? AND artifact_hash=?", b["versionId"], hash)
			if e == nil {
				return nil
			}
			if !isNotFound(e) {
				return e
			}
			out = M{"id": id(), "artifactHash": hash}
			return exec(tx, "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?)", out["id"], b["versionId"], b["parserVersion"], b["normalizationVersion"], "safe-v1", hash, js(blocks), now())
		})
		if e != nil {
			return e
		}
		return send(w, out)
	})
	s.route("GET /api/artifacts/{a}", func(w http.ResponseWriter, r *http.Request) error {
		a, e := one(s.db, "SELECT * FROM artifacts WHERE id=?", r.PathValue("a"))
		if e != nil {
			return e
		}
		if _, e = s.memberVersion(s.db, r.URL.Query().Get("workspaceDocumentId"), str(a, "versionId")); e != nil {
			return e
		}
		return send(w, a)
	})
	s.route("POST /api/manifests/{m}/capture", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		var result M
		e = s.transaction(func(tx *sql.Tx) error {
			man, e := one(tx, "SELECT m.*,e.relative_path,s.root,s.state AS source_state FROM manifests m JOIN source_entries e ON e.id=m.source_entry_id JOIN sources s ON s.id=e.source_id JOIN document_bindings b ON b.source_entry_id=e.id WHERE m.id=? AND b.workspace_document_id=? AND b.state='active' AND s.state='active'", r.PathValue("m"), b["workspaceDocumentId"])
			if e != nil {
				return e
			}
			if _, e = s.memberVersion(tx, str(b, "workspaceDocumentId"), str(man, "versionId")); e != nil {
				return e
			}
			raw := str(b, "path")
			parsed, e := url.Parse(raw)
			if e != nil || parsed.IsAbs() || strings.HasPrefix(raw, "//") {
				return problem(403, "PATH_NOT_ALLOWED", "仅允许授权根内的相对图片", false)
			}
			rel := filepath.Clean(filepath.Join(filepath.Dir(str(man, "relativePath")), filepath.FromSlash(parsed.Path)))
			if !within(str(man, "root"), filepath.Join(str(man, "root"), rel)) {
				return problem(403, "PATH_NOT_ALLOWED", "资源越出授权根目录", false)
			}
			ext := strings.ToLower(filepath.Ext(rel))
			if ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".gif" && ext != ".webp" && ext != ".svg" {
				return problem(400, "UNSUPPORTED_FORMAT", "只捕获本地图片资源", false)
			}
			resources := arr(man, "resources")
			for _, v := range resources {
				x, _ := v.(map[string]any)
				if str(x, "path") == raw {
					result = M{"id": man["id"], "resources": resources}
					return nil
				}
			}
			hash, _, e := s.capture(str(man, "root"), rel)
			if e != nil {
				return e
			}
			resources = append(resources, M{"path": raw, "blobHash": hash, "mime": mime.TypeByExtension(ext)})
			result = M{"id": id(), "resources": resources}
			return exec(tx, "INSERT INTO manifests VALUES(?,?,?,?,?)", result["id"], man["versionId"], man["sourceEntryId"], js(resources), now())
		})
		if e != nil {
			return e
		}
		return send(w, result)
	})
	s.route("GET /api/manifests/{m}", func(w http.ResponseWriter, r *http.Request) error {
		m, e := one(s.db, "SELECT * FROM manifests WHERE id=?", r.PathValue("m"))
		if e != nil {
			return e
		}
		if _, e = s.memberVersion(s.db, r.URL.Query().Get("workspaceDocumentId"), str(m, "versionId")); e != nil {
			return e
		}
		if e = s.manifestMember(s.db, r.PathValue("m"), r.URL.Query().Get("workspaceDocumentId"), str(m, "versionId")); e != nil {
			return e
		}
		return send(w, m)
	})
	s.route("GET /api/manifests/{m}/resource", func(w http.ResponseWriter, r *http.Request) error {
		m, e := one(s.db, "SELECT * FROM manifests WHERE id=?", r.PathValue("m"))
		if e != nil {
			return e
		}
		if _, e = s.memberVersion(s.db, r.URL.Query().Get("workspaceDocumentId"), str(m, "versionId")); e != nil {
			return e
		}
		if e = s.manifestMember(s.db, r.PathValue("m"), r.URL.Query().Get("workspaceDocumentId"), str(m, "versionId")); e != nil {
			return e
		}
		for _, v := range arr(m, "resources") {
			x, _ := v.(map[string]any)
			if str(x, "path") == r.URL.Query().Get("path") {
				f, e := os.Open(filepath.Join(s.cfg.DataDir, "blobs", str(x, "blobHash")))
				if e != nil {
					return problem(404, "SOURCE_UNAVAILABLE", "资源快照缺失", false)
				}
				defer f.Close()
				w.Header().Set("Content-Type", str(x, "mime"))
				w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
				info, e := f.Stat()
				if e != nil {
					return e
				}
				http.ServeContent(w, r, "resource", info.ModTime(), f)
				return nil
			}
		}
		return problem(404, "SOURCE_UNAVAILABLE", "此历史资源未捕获", false)
	})
	s.route("GET /api/documents/{d}/change", func(w http.ResponseWriter, r *http.Request) error {
		member, e := s.member(s.db, r.URL.Query().Get("workspaceDocumentId"))
		if e != nil || str(member, "documentId") != r.PathValue("d") {
			return problem(403, "PATH_NOT_ALLOWED", "文档不匹配", false)
		}
		v, e := s.memberVersion(s.db, str(member, "id"), r.URL.Query().Get("versionId"))
		if e != nil {
			return e
		}
		entry, e := one(s.db, "SELECT e.*,s.root FROM source_entries e JOIN sources s ON s.id=e.source_id JOIN document_bindings b ON b.source_entry_id=e.id WHERE b.workspace_document_id=? AND e.id=? AND s.state='active' AND b.state='active'", member["id"], r.URL.Query().Get("sourceEntryId"))
		if e != nil {
			return send(w, M{"state": "unavailable"})
		}
		f, e := safeFile(str(entry, "root"), str(entry, "relativePath"))
		if e != nil {
			return send(w, M{"state": "unavailable"})
		}
		defer f.Close()
		h := sha256.New()
		if _, e = io.Copy(h, io.LimitReader(f, maxFileSize+1)); e != nil {
			return e
		}
		state := "unchanged"
		if hex.EncodeToString(h.Sum(nil)) != str(v, "contentHash") {
			state = "changed"
		}
		return send(w, M{"state": state})
	})
}
