package server

import (
	"archive/zip"
	"context"
	"database/sql"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const maxFileSize int64 = 200 << 20

var ignored = map[string]bool{".git": true, "node_modules": true, "vendor": true, ".svn": true, ".hg": true, ".idea": true, ".DS_Store": true}

func format(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".markdown":
		return "markdown"
	case ".txt":
		return "txt"
	case ".pdf":
		return "pdf"
	case ".epub":
		return "epub"
	}
	return ""
}
func within(root, path string) bool {
	rel, e := filepath.Rel(root, path)
	return e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
func canonical(path string) (string, error) {
	p, e := filepath.Abs(path)
	if e != nil {
		return "", e
	}
	return filepath.EvalSymlinks(p)
}
func safeFile(root, relative string) (*os.File, error) {
	if relative == "" || filepath.IsAbs(relative) {
		return nil, problem(403, "PATH_NOT_ALLOWED", "文件路径不在授权范围", false)
	}
	r, e := os.OpenRoot(root)
	if e != nil {
		return nil, problem(404, "SOURCE_UNAVAILABLE", "源文件夹不可用，请重新连接", true)
	}
	defer r.Close()
	f, e := r.Open(relative)
	if e != nil {
		if strings.Contains(e.Error(), "outside") || strings.Contains(e.Error(), "escapes") {
			return nil, problem(403, "PATH_NOT_ALLOWED", "拒绝越出授权根目录", false)
		}
		return nil, problem(404, "SOURCE_UNAVAILABLE", "源文件不可用，历史快照仍可阅读", true)
	}
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, problem(403, "PATH_NOT_ALLOWED", "仅可读取授权范围内的普通文件", false)
	}
	return f, nil
}

type ScanJob struct {
	mu                    sync.Mutex
	ID, SourceID, State   string
	Discovered, Processed int
	Failures              []M
	cancel                context.CancelFunc
}

func (j *ScanJob) view() M {
	j.mu.Lock()
	defer j.mu.Unlock()
	return M{"id": j.ID, "sourceId": j.SourceID, "state": j.State, "discovered": j.Discovered, "processed": j.Processed, "failures": append([]M{}, j.Failures...)}
}
func (s *Server) startScan(sourceID string) (M, error) {
	src, e := one(s.db, "SELECT * FROM sources WHERE id=? AND state='active'", sourceID)
	if e != nil {
		return nil, e
	}
	s.mu.Lock()
	for _, j := range s.scans {
		if j.SourceID == sourceID {
			v := j.view()
			if v["state"] == "scanning" {
				s.mu.Unlock()
				return v, nil
			}
		}
	}
	ctx, cancel := context.WithCancel(s.ctx)
	j := &ScanJob{ID: id(), SourceID: sourceID, State: "scanning", Failures: []M{}, cancel: cancel}
	s.scans[j.ID] = j
	s.workers.Add(1)
	s.mu.Unlock()
	go func() { defer s.workers.Done(); s.scan(ctx, j, src) }()
	return j.view(), nil
}

type fileMeta struct {
	path, identity string
	size, mtime    int64
}

func (s *Server) scan(ctx context.Context, j *ScanJob, src M) {
	// MCP publishes its source, snapshot and membership in one transaction.
	// A folder scan must not republish metadata from a previous source root.
	if str(src, "kind") == "mcp" {
		j.mu.Lock()
		j.State = "completed"
		j.mu.Unlock()
		return
	}
	root := str(src, "root")
	files := []fileMeta{}
	ign := map[string]bool{}
	for k, v := range ignored {
		ign[k] = v
	}
	for _, v := range arr(src, "ignore") {
		if x, ok := v.(string); ok {
			ign[x] = true
		}
	}
	e := filepath.WalkDir(root, func(path string, d fs.DirEntry, e error) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if e != nil {
			j.mu.Lock()
			j.Failures = append(j.Failures, M{"file": filepath.Base(path), "reason": "无法读取元数据"})
			j.mu.Unlock()
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if path != root && (ign[d.Name()] || within(s.cfg.DataDir, path)) {
				return filepath.SkipDir
			}
			s.watchDirectory(str(src, "id"), path)
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 || format(path) == "" {
			return nil
		}
		info, e := d.Info()
		if e != nil || !info.Mode().IsRegular() {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		files = append(files, fileMeta{rel, fileIdentity(path, info), info.Size(), info.ModTime().UnixNano()})
		j.mu.Lock()
		j.Discovered = len(files)
		j.mu.Unlock()
		return nil
	})
	if e == nil {
		e = s.transaction(func(tx *sql.Tx) error {
			if _, e := one(tx, "SELECT id FROM sources WHERE id=? AND state='active'", src["id"]); e != nil {
				return e
			}
			if e := exec(tx, "UPDATE source_entries SET state='missing' WHERE source_id=?", src["id"]); e != nil {
				return e
			}
			for _, f := range files {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}
				entry, err := one(tx, "SELECT * FROM source_entries WHERE source_id=? AND relative_path=?", src["id"], f.path)
				if err != nil && !isNotFound(err) {
					return err
				}
				if err == nil {
					if err = exec(tx, "UPDATE source_entries SET file_identity=?,size=?,mtime=?,state='active' WHERE id=?", f.identity, f.size, f.mtime, entry["id"]); err != nil {
						return err
					}
				} else {
					docID := ""
					if f.identity != "" {
						existing, er := one(tx, "SELECT e.document_id,e.relative_path,s.root FROM source_entries e JOIN sources s ON s.id=e.source_id WHERE e.file_identity=? AND e.state='active' AND s.state='active' AND s.id<>? LIMIT 1", f.identity, src["id"])
						if er == nil {
							oldFile, oe := safeFile(str(existing, "root"), str(existing, "relativePath"))
							newFile, ne := safeFile(root, f.path)
							if oe == nil && ne == nil {
								oldInfo, oe := oldFile.Stat()
								newInfo, ne := newFile.Stat()
								if oe == nil && ne == nil && os.SameFile(oldInfo, newInfo) {
									docID = str(existing, "documentId")
								}
							}
							if oldFile != nil {
								oldFile.Close()
							}
							if newFile != nil {
								newFile.Close()
							}
						} else if !isNotFound(er) {
							return er
						}
					}
					if docID == "" {
						docID = id()
						if err = exec(tx, "INSERT INTO documents VALUES(?,?,?)", docID, format(f.path), now()); err != nil {
							return err
						}
					}
					entryID := id()
					if err = exec(tx, "INSERT INTO source_entries VALUES(?,?,?,?,?,?,?,?)", entryID, src["id"], docID, f.path, f.identity, f.size, f.mtime, "active"); err != nil {
						return err
					}
					entry = M{"id": entryID, "documentId": docID}
				}
				member, er := one(tx, "SELECT * FROM workspace_documents WHERE workspace_id=? AND document_id=?", src["workspaceId"], entry["documentId"])
				if isNotFound(er) {
					member = M{"id": id()}
					er = exec(tx, "INSERT INTO workspace_documents(id,workspace_id,document_id) VALUES(?,?,?)", member["id"], src["workspaceId"], entry["documentId"])
				}
				if er != nil {
					return er
				}
				if er = exec(tx, "INSERT INTO document_bindings VALUES(?,?,'active') ON CONFLICT(workspace_document_id,source_entry_id) DO UPDATE SET state='active'", member["id"], entry["id"]); er != nil {
					return er
				}
				if er = exec(tx, "UPDATE workspace_documents SET state='active' WHERE id=?", member["id"]); er != nil {
					return er
				}
				j.mu.Lock()
				j.Processed++
				j.mu.Unlock()
			}
			return nil
		})
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if ctx.Err() != nil {
		j.State = "canceled"
	} else if e != nil {
		j.State = "failed"
		j.Failures = append(j.Failures, M{"reason": "扫描失败，已保存数据保留"})
	} else {
		j.State = "completed"
	}
}
func (s *Server) sourceRoutes() {
	s.route("PATCH /api/sources/{s}", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		v, e := s.idem("patch-source:"+r.PathValue("s"), str(b, "clientRequestId"), b, func(tx *sql.Tx) (M, error) {
			old, e := one(tx, "SELECT * FROM sources WHERE id=?", r.PathValue("s"))
			if e != nil {
				return nil, e
			}
			label := str(old, "label")
			if _, ok := b["label"]; ok {
				label = strings.TrimSpace(str(b, "label"))
				if label == "" || len([]rune(label)) > 80 {
					return nil, problem(400, "INVALID_NAME", "来源名称为空或过长", false)
				}
			}
			ignore := old["ignore"]
			if v, ok := b["ignore"]; ok {
				ignore = v
				if len(arr(b, "ignore")) > 100 {
					return nil, problem(400, "INVALID_REQUEST", "忽略规则过多", false)
				}
			}
			if e = exec(tx, "UPDATE sources SET label=?,ignore_json=? WHERE id=?", label, js(ignore), r.PathValue("s")); e != nil {
				return nil, e
			}
			return M{"ok": true}, nil
		})
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("POST /api/local-picker/sessions", func(w http.ResponseWriter, r *http.Request) error {
		token := id()
		s.mu.Lock()
		s.pickers[token] = time.Now().Add(10 * time.Minute)
		s.mu.Unlock()
		home, _ := os.UserHomeDir()
		return send(w, M{"token": token, "initialPath": home})
	})
	s.route("GET /api/local-picker/entries", func(w http.ResponseWriter, r *http.Request) error {
		s.mu.Lock()
		expires, ok := s.pickers[r.URL.Query().Get("token")]
		s.mu.Unlock()
		if !ok || time.Now().After(expires) {
			return problem(403, "PICKER_EXPIRED", "文件夹选择已过期，请重新打开", false)
		}
		p, e := canonical(r.URL.Query().Get("path"))
		if e != nil {
			return problem(404, "SOURCE_UNAVAILABLE", "文件夹不存在", false)
		}
		items, e := os.ReadDir(p)
		if e != nil {
			return problem(403, "PATH_NOT_ALLOWED", "无法打开此文件夹", false)
		}
		dirs := []M{}
		for _, d := range items {
			if d.IsDir() && !strings.HasPrefix(d.Name(), ".") {
				dirs = append(dirs, M{"name": d.Name(), "path": filepath.Join(p, d.Name())})
			}
		}
		return send(w, M{"path": p, "parent": filepath.Dir(p), "entries": dirs})
	})
	s.route("GET /api/workspaces/{w}/sources", func(w http.ResponseWriter, r *http.Request) error {
		v, e := all(s.db, "SELECT id,workspace_id,kind,label,state,ignore_json,created_at FROM sources WHERE workspace_id=? ORDER BY created_at", r.PathValue("w"))
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("POST /api/workspaces/{w}/sources", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		if strings.TrimSpace(str(b, "path")) == "" {
			return problem(400, "PATH_NOT_ALLOWED", "请明确指定要连接的文件夹", false)
		}
		root, e := canonical(str(b, "path"))
		if e != nil {
			return problem(404, "SOURCE_UNAVAILABLE", "文件夹不存在或无法读取", false)
		}
		info, e := os.Stat(root)
		if e != nil || !info.IsDir() || within(s.cfg.DataDir, root) {
			return problem(403, "PATH_NOT_ALLOWED", "请选择资料文件夹，不能连接应用数据目录", false)
		}
		sourceID := id()
		e = s.transaction(func(tx *sql.Tx) error {
			existing, e := all(tx, "SELECT root FROM sources WHERE workspace_id=? AND state='active'", r.PathValue("w"))
			if e != nil {
				return e
			}
			for _, v := range existing {
				if within(root, str(v, "root")) || within(str(v, "root"), root) {
					return problem(409, "SOURCE_OVERLAP", "此文件夹与已有来源重复或重叠，请使用已有来源", false)
				}
			}
			label := str(b, "label")
			if label == "" {
				label = filepath.Base(root)
			}
			old, err := one(tx, "SELECT id FROM sources WHERE workspace_id=? AND root=?", r.PathValue("w"), root)
			if err == nil {
				sourceID = str(old, "id")
				if e = exec(tx, "UPDATE sources SET state='active',label=?,ignore_json=? WHERE id=?", label, js(arr(b, "ignore")), sourceID); e != nil {
					return e
				}
				return exec(tx, "UPDATE document_bindings SET state='active' WHERE source_entry_id IN(SELECT id FROM source_entries WHERE source_id=?)", sourceID)
			} else if !isNotFound(err) {
				return err
			}
			return exec(tx, "INSERT INTO sources(id,workspace_id,kind,root,label,ignore_json,created_at) VALUES(?,?,'local_folder',?,?,?,?)", sourceID, r.PathValue("w"), root, label, js(arr(b, "ignore")), now())
		})
		if e != nil {
			return e
		}
		job, e := s.startScan(sourceID)
		if e != nil {
			return e
		}
		return send(w, M{"id": sourceID, "scan": job})
	})
	s.route("POST /api/sources/{s}/scan", func(w http.ResponseWriter, r *http.Request) error {
		j, e := s.startScan(r.PathValue("s"))
		if e != nil {
			return e
		}
		return send(w, j)
	})
	s.route("GET /api/scans/{j}", func(w http.ResponseWriter, r *http.Request) error {
		s.mu.Lock()
		j := s.scans[r.PathValue("j")]
		s.mu.Unlock()
		if j == nil {
			return problem(404, "NOT_FOUND", "扫描任务不存在", false)
		}
		return send(w, j.view())
	})
	s.route("POST /api/scans/{j}/cancel", func(w http.ResponseWriter, r *http.Request) error {
		s.mu.Lock()
		j := s.scans[r.PathValue("j")]
		s.mu.Unlock()
		if j != nil {
			j.cancel()
		}
		return send(w, M{"ok": true})
	})
	s.route("DELETE /api/sources/{s}", func(w http.ResponseWriter, r *http.Request) error {
		e := s.transaction(func(tx *sql.Tx) error {
			if e := exec(tx, "UPDATE sources SET state='removed' WHERE id=?", r.PathValue("s")); e != nil {
				return e
			}
			if e := exec(tx, "UPDATE document_bindings SET state='removed' WHERE source_entry_id IN(SELECT id FROM source_entries WHERE source_id=?)", r.PathValue("s")); e != nil {
				return e
			}
			return exec(tx, "UPDATE workspace_documents SET state='archived' WHERE NOT EXISTS(SELECT 1 FROM document_bindings b JOIN source_entries e ON e.id=b.source_entry_id JOIN sources s ON s.id=e.source_id WHERE b.workspace_document_id=workspace_documents.id AND b.state='active' AND s.state='active')")
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true, "originalFilesModified": false})
	})
	s.route("POST /api/documents/{d}/rebind", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = s.transaction(func(tx *sql.Tx) error {
			member, e := s.member(tx, str(b, "workspaceDocumentId"))
			if e != nil || str(member, "documentId") != r.PathValue("d") {
				return problem(403, "PATH_NOT_ALLOWED", "文档身份不匹配", false)
			}
			entry, e := one(tx, "SELECT e.*,d.format FROM source_entries e JOIN sources s ON s.id=e.source_id JOIN documents d ON d.id=e.document_id WHERE e.id=? AND s.workspace_id=? AND e.state='active' AND s.state='active'", b["sourceEntryId"], member["workspaceId"])
			if e != nil {
				return e
			}
			if str(entry, "format") != str(member, "format") {
				return problem(400, "UNSUPPORTED_FORMAT", "重新绑定的文件必须是同一种格式", false)
			}
			if str(entry, "documentId") != r.PathValue("d") {
				used, e := one(tx, "SELECT count(*) AS n FROM annotations a JOIN workspace_documents wd ON wd.id=a.workspace_document_id WHERE wd.document_id=?", entry["documentId"])
				if e != nil {
					return e
				}
				if num(used, "n") > 0 {
					return problem(409, "REVISION_CONFLICT", "目标文件已有学习记录，请保留两份身份", false)
				}
				if e = exec(tx, "DELETE FROM document_bindings WHERE source_entry_id=?", entry["id"]); e != nil {
					return e
				}
				if e = exec(tx, "UPDATE source_entries SET document_id=? WHERE id=?", r.PathValue("d"), entry["id"]); e != nil {
					return e
				}
			}
			if e = exec(tx, "INSERT OR REPLACE INTO document_bindings VALUES(?,?,'active')", member["id"], entry["id"]); e != nil {
				return e
			}
			if e = exec(tx, "DELETE FROM workspace_documents WHERE id<>? AND NOT EXISTS(SELECT 1 FROM document_bindings b WHERE b.workspace_document_id=workspace_documents.id) AND NOT EXISTS(SELECT 1 FROM annotations a WHERE a.workspace_document_id=workspace_documents.id)", member["id"]); e != nil {
				return e
			}
			return exec(tx, "UPDATE workspace_documents SET state='active' WHERE id=?", member["id"])
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
	s.route("POST /api/workspaces/{w}/imports", s.importFiles)
}
func checkArchive(path string) error {
	z, e := zip.OpenReader(path)
	if e != nil {
		return problem(400, "INVALID_ARCHIVE", "EPUB 压缩包损坏", false)
	}
	defer z.Close()
	if len(z.File) > 5000 {
		return problem(400, "INVALID_ARCHIVE", "压缩包条目过多", false)
	}
	var total uint64
	names := map[string]bool{}
	for _, f := range z.File {
		n := strings.ReplaceAll(f.Name, "\\", "/")
		parts := strings.Split(n, "/")
		if strings.HasPrefix(n, "/") || strings.Contains(n, ":") || len(parts) > 20 || f.Mode()&os.ModeSymlink != 0 {
			return problem(400, "INVALID_ARCHIVE", "压缩包路径不安全", false)
		}
		for _, p := range parts {
			if p == ".." {
				return problem(400, "INVALID_ARCHIVE", "压缩包路径越界", false)
			}
		}
		if names[n] {
			return problem(400, "INVALID_ARCHIVE", "压缩包路径重复", false)
		}
		names[n] = true
		total += f.UncompressedSize64
		if total > 512<<20 || f.UncompressedSize64 > 64<<20 || (f.UncompressedSize64 > 1<<20 && f.UncompressedSize64/(f.CompressedSize64+1) > 200) {
			return problem(400, "INVALID_ARCHIVE", "压缩包展开大小或压缩比超限", false)
		}
	}
	if !names["META-INF/container.xml"] {
		return problem(400, "INVALID_ARCHIVE", "缺少 EPUB 容器信息", false)
	}
	return nil
}
func (s *Server) importFiles(w http.ResponseWriter, r *http.Request) error {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	r.Body = http.MaxBytesReader(w, r.Body, 500<<20)
	if e := r.ParseMultipartForm(8 << 20); e != nil {
		return problem(413, "IMPORT_TOO_LARGE", "导入过大，单批总大小最多 500 MB", false)
	}
	defer r.MultipartForm.RemoveAll()
	files := r.MultipartForm.File["files"]
	if len(files) == 0 || len(files) > 50 {
		return problem(400, "IMPORT_LIMIT", "每次请选择 1 至 50 份文件", false)
	}
	sourceID := id()
	root := filepath.Join(s.cfg.DataDir, "imports", sourceID)
	if e := os.MkdirAll(root, 0700); e != nil {
		return e
	}
	e := s.transaction(func(tx *sql.Tx) error {
		return exec(tx, "INSERT INTO sources(id,workspace_id,kind,root,label,created_at) VALUES(?,?,'imported_collection',?,'导入文件',?)", sourceID, r.PathValue("w"), root, now())
	})
	if e != nil {
		return e
	}
	results := []M{}
	for i, f := range files {
		res := M{"name": f.Filename}
		if format(f.Filename) == "" || f.Size > maxFileSize {
			res["error"] = "不支持此格式或单文件超过 200 MB"
			results = append(results, res)
			continue
		}
		src, err := f.Open()
		if err != nil {
			res["error"] = "无法读取"
			results = append(results, res)
			continue
		}
		name := fmt.Sprintf("%02d_%s", i+1, filepath.Base(f.Filename))
		dest := filepath.Join(root, name)
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err == nil {
			_, err = io.Copy(out, io.LimitReader(src, maxFileSize+1))
			if err == nil {
				err = out.Sync()
			}
			_ = out.Close()
		}
		_ = src.Close()
		if err == nil && format(name) == "epub" {
			err = checkArchive(dest)
		}
		if err != nil {
			_ = os.Remove(dest)
			res["error"] = "文件不安全、损坏或无法保存"
		} else {
			res["imported"] = true
		}
		results = append(results, res)
	}
	j, e := s.startScan(sourceID)
	if e != nil {
		return e
	}
	for {
		state := str(j, "state")
		if state != "scanning" {
			break
		}
		select {
		case <-s.ctx.Done():
			return problem(503, "IMPORT_INTERRUPTED", "导入已中断，完成的副本仍保留", true)
		case <-time.After(20 * time.Millisecond):
		}
		s.mu.Lock()
		job := s.scans[str(j, "id")]
		s.mu.Unlock()
		if job == nil {
			break
		}
		j = job.view()
	}
	return send(w, M{"id": sourceID, "files": results, "scan": j})
}
