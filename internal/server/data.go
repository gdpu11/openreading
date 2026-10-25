package server

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var backupTables = []string{"workspaces", "documents", "sources", "source_entries", "workspace_documents", "document_bindings", "versions", "artifacts", "manifests", "annotations", "resolutions", "threads", "messages", "message_versions", "drafts", "reading_states", "providers", "contexts", "ai_runs", "attempts", "run_events", "reading_events", "library_books", "note_learning", "book_preferences", "bookmarks", "recognized_pages", "mcp_documents"}

type backupManifest struct {
	SchemaVersion     int               `json:"schemaVersion"`
	CreatedAt         string            `json:"createdAt"`
	DataHash          string            `json:"dataHash"`
	Files             map[string]string `json:"files"`
	OfflineVersions   []string          `json:"offlineVersions"`
	UncachedVersions  []string          `json:"uncachedVersions"`
	OfflineDocuments  []string          `json:"offlineDocuments"`
	UncachedDocuments []string          `json:"uncachedDocuments"`
}

func documentCoverage(tables map[string][]M, files map[string]string) ([]string, []string) {
	cached := map[string]bool{}
	for _, v := range tables["versions"] {
		if files["blobs/"+str(v, "content_hash")] != "" {
			cached[str(v, "document_id")] = true
		}
	}
	offline, missing := []string{}, []string{}
	for _, wd := range tables["workspace_documents"] {
		if cached[str(wd, "document_id")] {
			offline = append(offline, str(wd, "id"))
		} else {
			missing = append(missing, str(wd, "id"))
		}
	}
	return offline, missing
}

type restorePlan struct {
	mu        sync.Mutex
	ID, Dir   string
	Tables    map[string][]M
	Manifest  backupManifest
	Committed bool
	Result    M
	Expires   time.Time
}

func rawRows(q querier, table string) ([]M, error) {
	return rawQuery(q, "SELECT * FROM "+table)
}

func rawQuery(q querier, query string, args ...any) ([]M, error) {
	rows, e := q.QueryContext(context.Background(), query, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	cols, e := rows.Columns()
	if e != nil {
		return nil, e
	}
	result := []M{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptr := make([]any, len(cols))
		for i := range vals {
			ptr[i] = &vals[i]
		}
		if e = rows.Scan(ptr...); e != nil {
			return nil, e
		}
		m := M{}
		for i, k := range cols {
			if b, ok := vals[i].([]byte); ok {
				vals[i] = string(b)
			}
			m[k] = vals[i]
		}
		result = append(result, m)
	}
	return result, rows.Err()
}
func (s *Server) protected(q querier) (map[string]bool, error) {
	hashes := map[string]bool{}
	versions, e := all(q, "SELECT DISTINCT content_hash FROM versions WHERE id IN (SELECT original_version_id FROM annotations UNION SELECT json_extract(j.value,'$.documentVersionId') FROM contexts c,json_each(c.sources_json) j UNION SELECT version_id FROM recognized_pages UNION SELECT version_id FROM bookmarks UNION SELECT version_id FROM contexts UNION SELECT target_version_id FROM resolutions UNION SELECT version_id FROM leases WHERE expires_at>? UNION SELECT v.id FROM versions v JOIN source_entries e ON e.document_id=v.document_id JOIN sources s ON s.id=e.source_id WHERE s.kind IN ('imported_collection','mcp'))", time.Now().Unix())
	if e != nil {
		return nil, e
	}
	for _, v := range versions {
		hashes[str(v, "contentHash")] = true
	}
	manifests, e := all(q, "SELECT resources_json FROM manifests WHERE id IN(SELECT manifest_id FROM annotations WHERE manifest_id IS NOT NULL UNION SELECT manifest_id FROM contexts WHERE manifest_id IS NOT NULL UNION SELECT json_extract(j.value,'$.resourceManifestId') FROM contexts c,json_each(c.sources_json) j UNION SELECT json_extract(selector_json,'$.anchor.resourceManifestId') FROM resolutions WHERE method='manual') OR version_id IN (SELECT version_id FROM bookmarks UNION SELECT version_id FROM leases WHERE expires_at>?)", time.Now().Unix())
	if e != nil {
		return nil, e
	}
	for _, m := range manifests {
		for _, raw := range arr(m, "resources") {
			r, _ := raw.(map[string]any)
			hashes[str(r, "blobHash")] = true
		}
	}
	return hashes, nil
}
func (s *Server) cacheCandidates() (M, error) {
	hashes, e := s.protected(s.db)
	if e != nil {
		return nil, e
	}
	entries, e := os.ReadDir(filepath.Join(s.cfg.DataDir, "blobs"))
	if e != nil {
		return nil, e
	}
	files := []string{}
	var bytes int64
	for _, f := range entries {
		if !f.IsDir() && !hashes[f.Name()] {
			info, e := f.Info()
			if e != nil {
				return nil, e
			}
			files = append(files, f.Name())
			bytes += info.Size()
		}
	}
	return M{"files": len(files), "bytes": bytes, "hashes": files}, nil
}
func (s *Server) backup() (M, error) {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	// Imported copies are application-owned primary data, including files never
	// opened by a reader. Capture them before taking the logical DB snapshot.
	imports, e := s.db.Begin()
	if e != nil {
		return nil, e
	}
	defer imports.Rollback()
	entries, e := all(imports, "SELECT e.*,s.root FROM source_entries e JOIN sources s ON s.id=e.source_id WHERE s.kind IN ('imported_collection','mcp') AND s.state='active' AND e.state='active'")
	if e != nil {
		return nil, e
	}
	for _, entry := range entries {
		hash, size, e := s.capture(str(entry, "root"), str(entry, "relativePath"))
		if e != nil {
			return nil, problem(409, "BACKUP_INCOMPLETE", "导入副本缺失或无法捕获，备份未成功", false)
		}
		if e = exec(imports, "INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?)", id(), entry["documentId"], hash, hash, size, now()); e != nil {
			return nil, e
		}
	}
	if e = imports.Commit(); e != nil {
		return nil, e
	}
	tx, e := s.db.Begin()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	tables := map[string][]M{}
	for _, table := range backupTables {
		data, e := rawRows(tx, table)
		if e != nil {
			return nil, e
		}
		if table == "providers" {
			for _, p := range data {
				p["credential_version"] = ""
			}
		}
		if table == "contexts" {
			for _, c := range data {
				var config M
				json.Unmarshal([]byte(str(c, "config_json")), &config)
				config["credentialVersion"] = ""
				c["config_json"] = js(config)
			}
		}
		tables[table] = data
	}
	protected, e := s.protected(tx)
	if e != nil {
		return nil, e
	}
	files := map[string]string{}
	offline, uncached := []string{}, []string{}
	include := func(hash string) error {
		if hash == "" {
			return nil
		}
		f, e := os.Open(filepath.Join(s.cfg.DataDir, "blobs", hash))
		if e != nil {
			if protected[hash] {
				return problem(409, "BACKUP_INCOMPLETE", "受保护快照或资源缺失，备份未成功；请先恢复缺失数据", false)
			}
			return nil
		}
		defer f.Close()
		h, e := io.ReadAll(io.LimitReader(f, maxFileSize+1))
		if e != nil {
			return e
		}
		if digest(h) != hash {
			return problem(409, "BACKUP_INCOMPLETE", "快照哈希校验失败，备份未成功", false)
		}
		files["blobs/"+hash] = hash
		return nil
	}
	for _, v := range tables["versions"] {
		hash := str(v, "content_hash")
		if e = include(hash); e != nil {
			return nil, e
		}
		if files["blobs/"+hash] != "" {
			offline = append(offline, str(v, "id"))
		} else {
			uncached = append(uncached, str(v, "id"))
		}
	}
	for _, m := range tables["manifests"] {
		var resources []M
		if e = json.Unmarshal([]byte(str(m, "resources_json")), &resources); e != nil {
			return nil, e
		}
		for _, resource := range resources {
			if e = include(str(resource, "blobHash")); e != nil {
				return nil, e
			}
		}
	}
	data := []byte(js(tables))
	offlineDocs, missingDocs := documentCoverage(tables, files)
	manifest := backupManifest{SchemaVersion: 1, CreatedAt: now(), DataHash: digest(data), Files: files, OfflineVersions: offline, UncachedVersions: uncached, OfflineDocuments: offlineDocs, UncachedDocuments: missingDocs}
	backupID := id()
	temp, e := os.CreateTemp(filepath.Join(s.cfg.DataDir, "backups"), "pending-")
	if e != nil {
		return nil, e
	}
	path := temp.Name()
	success := false
	defer func() {
		temp.Close()
		if !success {
			os.Remove(path)
		}
	}()
	z := zip.NewWriter(temp)
	add := func(name string, bytes []byte) error {
		entry, e := z.Create(name)
		if e != nil {
			return e
		}
		_, e = entry.Write(bytes)
		return e
	}
	if e = add("manifest.json", []byte(js(manifest))); e != nil {
		return nil, e
	}
	if e = add("data.json", data); e != nil {
		return nil, e
	}
	names := []string{}
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		entry, e := z.Create(name)
		if e != nil {
			return nil, e
		}
		f, e := os.Open(filepath.Join(s.cfg.DataDir, name))
		if e != nil {
			return nil, e
		}
		_, copyErr := io.Copy(entry, f)
		closeErr := f.Close()
		if copyErr != nil {
			return nil, copyErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
	}
	if e = z.Close(); e != nil {
		return nil, e
	}
	if e = temp.Sync(); e != nil {
		return nil, e
	}
	if e = temp.Close(); e != nil {
		return nil, e
	}
	dest := filepath.Join(s.cfg.DataDir, "backups", backupID+".zip")
	if e = os.Rename(path, dest); e != nil {
		return nil, e
	}
	success = true
	return M{"id": backupID, "schemaVersion": 1, "offlineVersions": len(offline), "uncachedVersions": len(uncached), "offlineDocuments": len(offlineDocs), "uncachedDocuments": len(missingDocs), "blobs": len(files)}, nil
}
func (s *Server) restorePreview(path string) (M, error) {
	z, e := zip.OpenReader(path)
	if e != nil {
		return nil, problem(400, "INVALID_BACKUP", "无法打开备份 ZIP", false)
	}
	defer z.Close()
	entries := map[string]*zip.File{}
	var size uint64
	for _, f := range z.File {
		n := f.Name
		if n != "manifest.json" && n != "data.json" && !(strings.HasPrefix(n, "blobs/") && len(strings.TrimPrefix(n, "blobs/")) == 64) {
			return nil, problem(400, "INVALID_BACKUP", "备份包含非法路径或额外内容", false)
		}
		if strings.Contains(n, "..") || strings.ContainsAny(n, "\\:") || f.Mode()&os.ModeSymlink != 0 || entries[n] != nil {
			return nil, problem(400, "INVALID_BACKUP", "备份路径不安全或重复", false)
		}
		size += f.UncompressedSize64
		if size > 2<<30 || len(entries) > 100000 || f.UncompressedSize64 > 256<<20 {
			return nil, problem(413, "INVALID_BACKUP", "备份展开大小超限", false)
		}
		entries[n] = f
	}
	read := func(name string, limit int64) ([]byte, error) {
		f := entries[name]
		if f == nil {
			return nil, problem(400, "INVALID_BACKUP", "备份清单或数据缺失", false)
		}
		r, e := f.Open()
		if e != nil {
			return nil, e
		}
		defer r.Close()
		bytes, e := io.ReadAll(io.LimitReader(r, limit+1))
		if int64(len(bytes)) > limit {
			return nil, problem(413, "INVALID_BACKUP", "备份元数据过大", false)
		}
		return bytes, e
	}
	mb, e := read("manifest.json", 16<<20)
	if e != nil {
		return nil, e
	}
	var manifest backupManifest
	if json.Unmarshal(mb, &manifest) != nil || manifest.SchemaVersion != 1 {
		return nil, problem(400, "UNSUPPORTED_SCHEMA", "备份版本不支持", false)
	}
	data, e := read("data.json", 128<<20)
	if e != nil {
		return nil, e
	}
	if digest(data) != manifest.DataHash {
		return nil, problem(400, "HASH_MISMATCH", "备份数据哈希校验失败", false)
	}
	tables := map[string][]M{}
	if json.Unmarshal(data, &tables) != nil {
		return nil, problem(400, "INVALID_BACKUP", "备份数据格式无效", false)
	}
	valid := map[string]bool{}
	for _, table := range backupTables {
		valid[table] = true
	}
	for table := range tables {
		if !valid[table] {
			return nil, problem(400, "INVALID_BACKUP", "备份含未知数据表", false)
		}
	}
	// Metadata in a backup is untrusted even when its manifest hash matches:
	// an attacker can recompute that hash. Blob references must be content
	// addresses, never arbitrary paths into or outside the server data folder.
	for _, version := range tables["versions"] {
		if !validBlobReference(str(version, "content_hash"), str(version, "blob_ref")) || num(version, "size") < 0 || int64(num(version, "size")) > maxFileSize {
			return nil, problem(400, "INVALID_BACKUP", "备份快照文件引用无效", false)
		}
	}
	if len(tables["workspaces"]) == 0 {
		return nil, problem(400, "INVALID_BACKUP", "备份没有工作区", false)
	}
	if len(entries) != len(manifest.Files)+2 {
		return nil, problem(400, "INVALID_BACKUP", "备份清单与条目数不符", false)
	}
	if free := availableSpace(s.cfg.DataDir); free > 0 && free < size+uint64(len(data))*3+(64<<20) {
		return nil, problem(507, "INSUFFICIENT_STORAGE", "空间不足以暂存并原子恢复，请先释放磁盘空间", true)
	}
	restoreID := id()
	dir := filepath.Join(s.cfg.DataDir, "staging", "restore-"+restoreID)
	if e = os.MkdirAll(filepath.Join(dir, "blobs"), 0700); e != nil {
		return nil, e
	}
	success := false
	defer func() {
		if !success {
			os.RemoveAll(dir)
		}
	}()
	for name, hash := range manifest.Files {
		if name != "blobs/"+hash || len(hash) != 64 || strings.ContainsAny(hash, "/\\.") {
			return nil, problem(400, "INVALID_BACKUP", "资源清单路径无效", false)
		}
		bytes, e := read(name, maxFileSize)
		if e != nil {
			return nil, e
		}
		if digest(bytes) != hash {
			return nil, problem(400, "HASH_MISMATCH", "快照哈希校验失败", false)
		}
		if e = os.WriteFile(filepath.Join(dir, name), bytes, 0600); e != nil {
			return nil, e
		}
	}
	plan := &restorePlan{ID: restoreID, Dir: dir, Tables: tables, Manifest: manifest, Expires: time.Now().Add(30 * time.Minute)}
	s.mu.Lock()
	s.restores[restoreID] = plan
	s.mu.Unlock()
	success = true
	offlineDocs, missingDocs := documentCoverage(tables, manifest.Files)
	return M{"id": restoreID, "schemaVersion": 1, "workspaces": len(tables["workspaces"]), "versions": len(manifest.OfflineVersions), "uncachedVersions": len(manifest.UncachedVersions), "offlineDocuments": len(offlineDocs), "uncachedDocuments": len(missingDocs), "blobs": len(manifest.Files), "bytes": size, "credentialsIncluded": false, "mode": "new-workspaces"}, nil
}

var idColumns = map[string]bool{"id": true, "workspace_id": true, "source_id": true, "document_id": true, "workspace_document_id": true, "source_entry_id": true, "version_id": true, "original_version_id": true, "target_version_id": true, "artifact_id": true, "manifest_id": true, "annotation_id": true, "thread_id": true, "message_id": true, "assistant_message_id": true, "snapshot_id": true, "provider_id": true, "run_id": true, "retry_of_run_id": true, "default_model_profile_id": true}
var jsonIDKeys = map[string]bool{"workspaceId": true, "workspaceDocumentId": true, "sourceEntryId": true, "documentId": true, "documentVersionId": true, "versionId": true, "extractionArtifactId": true, "artifactId": true, "resourceManifestId": true, "manifestId": true, "messageId": true, "threadId": true, "annotationId": true, "runId": true, "snapshotId": true, "providerId": true, "id": true}

func remapJSON(v any, mapping map[string]string, key string) any {
	switch x := v.(type) {
	case map[string]any:
		for k, value := range x {
			if k == "credentialVersion" {
				x[k] = ""
			} else {
				x[k] = remapJSON(value, mapping, k)
			}
		}
		return x
	case []any:
		for i, value := range x {
			x[i] = remapJSON(value, mapping, key)
		}
		return x
	case string:
		if jsonIDKeys[key] {
			if value, ok := mapping[x]; ok {
				return value
			}
		}
	}
	return v
}
func (s *Server) restoreCommit(restoreID string) (M, error) {
	s.mu.Lock()
	plan := s.restores[restoreID]
	s.mu.Unlock()
	if plan == nil || time.Now().After(plan.Expires) {
		return nil, problem(404, "RESTORE_EXPIRED", "恢复预览已过期，请重新选择备份", false)
	}
	plan.mu.Lock()
	defer plan.mu.Unlock()
	var result M
	e := s.transaction(func(tx *sql.Tx) error {
		if plan.Committed {
			result = plan.Result
			return nil
		}
		mapping := map[string]string{}
		for _, rows := range plan.Tables {
			for _, row := range rows {
				if x := str(row, "id"); x != "" {
					if _, ok := mapping[x]; !ok {
						mapping[x] = id()
					}
				}
			}
		}
		for name, hash := range plan.Manifest.Files {
			bytes, e := os.ReadFile(filepath.Join(plan.Dir, name))
			if e != nil || digest(bytes) != hash {
				return problem(400, "HASH_MISMATCH", "暂存快照校验失败，请重新预览", false)
			}
			dest := filepath.Join(s.cfg.DataDir, "blobs", hash)
			temp, e := os.CreateTemp(filepath.Join(s.cfg.DataDir, "staging"), "restore-publish-")
			if e != nil {
				return e
			}
			if _, e = temp.Write(bytes); e == nil {
				e = temp.Sync()
			}
			closeErr := temp.Close()
			if e == nil {
				e = closeErr
			}
			if e == nil {
				e = os.Rename(temp.Name(), dest)
			}
			if e != nil {
				os.Remove(temp.Name())
				return e
			}
		}
		if e := syncDirectory(filepath.Join(s.cfg.DataDir, "blobs")); e != nil {
			return e
		}
		workspaceIDs := []string{}
		retryLinks := []M{}
		for _, table := range backupTables {
			columns, e := all(tx, "PRAGMA table_info("+table+")")
			if e != nil {
				return e
			}
			allowed := map[string]bool{}
			for _, column := range columns {
				allowed[str(column, "name")] = true
			}
			for _, original := range plan.Tables[table] {
				row := M{}
				for key, value := range original {
					if !allowed[key] {
						return problem(400, "INVALID_BACKUP", "备份包含未知字段", false)
					}
					if idColumns[key] {
						if x, ok := value.(string); ok && x != "" {
							if mapped, ok := mapping[x]; ok {
								value = mapped
							} else {
								return problem(400, "INVALID_BACKUP", "备份外键指向不存在的记录", false)
							}
						}
					}
					if strings.HasSuffix(key, "_json") {
						var parsed any
						if v, ok := value.(string); ok && json.Unmarshal([]byte(v), &parsed) == nil {
							value = js(remapJSON(parsed, mapping, key))
						}
					}
					row[key] = value
				}
				switch table {
				case "workspaces":
					row["name"] = str(row, "name") + "（恢复）"
					row["default_model_profile_id"] = nil
					workspaceIDs = append(workspaceIDs, str(row, "id"))
				case "sources":
					row["root"] = filepath.Join(s.cfg.DataDir, "reconnect-required", str(row, "id"))
					row["state"] = "disconnected"
				case "source_entries":
					row["state"] = "missing"
					row["file_identity"] = ""
				case "document_bindings":
					row["state"] = "removed"
				case "providers":
					row["credential_version"] = ""
				case "contexts":
					var messages, sources, config any
					_ = json.Unmarshal([]byte(str(row, "messages_json")), &messages)
					_ = json.Unmarshal([]byte(str(row, "sources_json")), &sources)
					_ = json.Unmarshal([]byte(str(row, "config_json")), &config)
					row["content_hash"] = digest([]byte(js(M{"messages": messages, "sources": sources, "effectiveConfig": config})))
				case "ai_runs":
					if parent, ok := row["retry_of_run_id"].(string); ok && parent != "" {
						retryLinks = append(retryLinks, M{"id": row["id"], "parent": parent})
						row["retry_of_run_id"] = nil
					}
					if !terminal(str(row, "state")) {
						row["state"] = "interrupted"
						row["ended_at"] = now()
						row["error_code"] = "RESTORED_INTERRUPTED"
						row["error_message"] = "从备份恢复，未自动重发"
					}
				case "attempts":
					if !terminal(str(row, "state")) {
						row["state"] = "interrupted"
						row["ended_at"] = now()
					}
				case "drafts":
					old := str(original, "id")
					for before, after := range mapping {
						if strings.HasPrefix(old, before+":") {
							suffix := strings.TrimPrefix(old, before+":")
							if next, ok := mapping[suffix]; ok {
								suffix = next
							}
							row["id"] = after + ":" + suffix
							break
						}
					}
				}
				keys := []string{}
				values := []any{}
				placeholders := []string{}
				for key, value := range row {
					keys = append(keys, key)
					values = append(values, value)
					placeholders = append(placeholders, "?")
				}
				if e = exec(tx, "INSERT INTO "+table+"("+strings.Join(keys, ",")+") VALUES("+strings.Join(placeholders, ",")+")", values...); e != nil {
					return problem(400, "INVALID_BACKUP", "备份关系或字段校验失败，恢复未提交", false)
				}
			}
		}
		for _, link := range retryLinks {
			if e := exec(tx, "UPDATE ai_runs SET retry_of_run_id=? WHERE id=?", link["parent"], link["id"]); e != nil {
				return e
			}
		}
		result = M{"ok": true, "workspaceIds": workspaceIDs, "mode": "new-workspaces"}
		return nil
	})
	if e != nil {
		return nil, e
	}
	plan.Committed = true
	plan.Result = result
	return result, nil
}
func (s *Server) dataRoutes() {
	s.route("POST /api/exports", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		workspace, e := one(s.db, "SELECT * FROM workspaces WHERE id=?", b["workspaceId"])
		if e != nil {
			return e
		}
		threads, e := s.threadData(s.db, "JOIN workspace_documents wd ON wd.id=a.workspace_document_id WHERE wd.workspace_id=?", b["workspaceId"])
		if e != nil {
			return e
		}
		out := strings.Builder{}
		fmt.Fprintf(&out, "# %s 阅读笔记\n\n导出时间：%s\n\n", workspace["name"], now())
		for _, t := range threads {
			source, _ := one(s.db, "SELECT e.relative_path FROM source_entries e JOIN document_bindings b ON b.source_entry_id=e.id WHERE b.workspace_document_id=? LIMIT 1", t["workspaceDocumentId"])
			anchor := obj(t, "anchor")
			fmt.Fprintf(&out, "## %s\n\n版本：%s  \n位置：%s  \n学习状态：%s\n\n> %s\n\n", source["relativePath"], anchor["documentVersionId"], obj(anchor, "displayLocation")["label"], t["learningState"], strings.ReplaceAll(str(obj(anchor, "quote"), "visible"), "\n", "\n> "))
			for _, raw := range t["messages"].([]M) {
				m := raw
				role := "个人笔记"
				if str(m, "role") == "assistant" {
					role = "小阅"
				}
				fmt.Fprintf(&out, "### %s\n\n%s\n\n", role, m["body"])
			}
		}
		return send(w, M{"content": out.String(), "format": "markdown"})
	})
	s.route("POST /api/backups", func(w http.ResponseWriter, r *http.Request) error {
		v, e := s.backup()
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("GET /api/backups/{b}/download", func(w http.ResponseWriter, r *http.Request) error {
		backupID := r.PathValue("b")
		if (len(backupID) != 32 && !(len(backupID) == 37 && strings.HasPrefix(backupID, "auto-"))) || strings.ContainsAny(backupID, "./\\") {
			return problem(400, "INVALID_ID", "备份编号无效", false)
		}
		f, e := os.Open(filepath.Join(s.cfg.DataDir, "backups", backupID+".zip"))
		if e != nil {
			return problem(404, "NOT_FOUND", "备份不存在", false)
		}
		defer f.Close()
		info, e := f.Stat()
		if e != nil {
			return e
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", "attachment; filename=openreading-backup.zip")
		http.ServeContent(w, r, "backup.zip", info.ModTime(), f)
		return nil
	})
	s.route("POST /api/restores/preview", func(w http.ResponseWriter, r *http.Request) error {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<30)
		if e := r.ParseMultipartForm(8 << 20); e != nil {
			return problem(413, "INVALID_BACKUP", "备份上传失败或超过 1 GB", false)
		}
		defer r.MultipartForm.RemoveAll()
		file, _, e := r.FormFile("file")
		if e != nil {
			return problem(400, "INVALID_BACKUP", "请选择备份 ZIP", false)
		}
		defer file.Close()
		temp, e := os.CreateTemp(filepath.Join(s.cfg.DataDir, "staging"), "backup-upload-")
		if e != nil {
			return e
		}
		defer os.Remove(temp.Name())
		_, e = io.Copy(temp, file)
		closeErr := temp.Close()
		if e == nil {
			e = closeErr
		}
		if e != nil {
			return e
		}
		v, e := s.restorePreview(temp.Name())
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("POST /api/restores/{r}/commit", func(w http.ResponseWriter, r *http.Request) error {
		v, e := s.restoreCommit(r.PathValue("r"))
		if e != nil {
			return e
		}
		return send(w, v)
	})
	s.route("GET /api/cache/preview", func(w http.ResponseWriter, r *http.Request) error {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		v, e := s.cacheCandidates()
		if e != nil {
			return e
		}
		delete(v, "hashes")
		return send(w, v)
	})
	s.route("POST /api/cache/clear", func(w http.ResponseWriter, r *http.Request) error {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		v, e := s.cacheCandidates()
		if e != nil {
			return e
		}
		for _, hash := range v["hashes"].([]string) {
			if e = os.Remove(filepath.Join(s.cfg.DataDir, "blobs", hash)); e != nil {
				return e
			}
		}
		delete(v, "hashes")
		return send(w, v)
	})
	s.route("GET /api/usage", func(w http.ResponseWriter, r *http.Request) error {
		v, e := all(s.db, "SELECT state,usage_json,created_at FROM ai_runs ORDER BY created_at DESC LIMIT 200")
		if e != nil {
			return e
		}
		return send(w, M{"runs": v, "currency": nil, "priceEstimate": nil, "note": "实际 tokens 按供应商返回记录；空值为未知，未配置单价不估算费用"})
	})
	s.route("POST /api/sources/{s}/reconnect", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		root, e := canonical(str(b, "path"))
		if e != nil {
			return problem(404, "SOURCE_UNAVAILABLE", "重新连接目录不存在", false)
		}
		if within(s.cfg.DataDir, root) {
			return problem(403, "PATH_NOT_ALLOWED", "不能连接应用数据目录", false)
		}
		e = s.transaction(func(tx *sql.Tx) error {
			if e := exec(tx, "UPDATE sources SET root=?,state='active' WHERE id=?", root, r.PathValue("s")); e != nil {
				return e
			}
			return exec(tx, "UPDATE document_bindings SET state='active' WHERE source_entry_id IN(SELECT id FROM source_entries WHERE source_id=?)", r.PathValue("s"))
		})
		if e != nil {
			return e
		}
		job, e := s.startScan(r.PathValue("s"))
		if e != nil {
			return e
		}
		return send(w, job)
	})
}
