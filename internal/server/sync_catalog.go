package server

import (
	"database/sql"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Catalog browsing grants metadata within paired workspaces, never file access.
// File access continues to require deviceDocument; selection is an explicit write.
func (s *Server) syncCatalogRoutes() {
	s.route("GET /api/sync/catalog", func(w http.ResponseWriter, r *http.Request) error {
		d := deviceFrom(r)
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if utf8.RuneCountInString(q) > 100 {
			return problem(400, "CATALOG_QUERY", "搜索词最多 100 个字", false)
		}
		offset := 0
		if raw := r.URL.Query().Get("offset"); raw != "" {
			v, e := strconv.Atoi(raw)
			if e != nil || v < 0 || v > 1000000 {
				return problem(400, "CATALOG_QUERY", "无效的分页位置", false)
			}
			offset = v
		}
		workspace, format := r.URL.Query().Get("workspace"), r.URL.Query().Get("format")
		if format != "" && !supportedFormat(format) {
			return problem(400, "CATALOG_QUERY", "文件类型无效", false)
		}
		workspaces := []M{}
		items := []M{}
		total := 0
		e := s.transaction(func(tx *sql.Tx) error {
			fresh, e := one(tx, "SELECT d.*,COALESCE(s.scope_json,'{}') AS sync_scope_json FROM paired_devices d LEFT JOIN device_sync_scopes s ON s.device_id=d.id WHERE d.id=? AND revoked_at IS NULL AND expires_at>?", d["id"], time.Now().Unix())
			if e != nil {
				return problem(401, "DEVICE_REQUIRED", "设备授权已失效，请在电脑端重新扫码", false)
			}
			d = fresh
			if workspace != "" && !deviceWorkspace(d, workspace) {
				return problem(403, "SYNC_SCOPE", "此工作区未获电脑授权", false)
			}
			// The catalog never prepares snapshots or reads book contents or notes.
			for _, raw := range arr(d, "workspaceIds") {
				ws, e := one(tx, "SELECT id,name FROM workspaces WHERE id=?", raw)
				if isNotFound(e) {
					continue
				}
				if e != nil {
					return e
				}
				workspaces = append(workspaces, ws)
				if workspace != "" && workspace != str(ws, "id") {
					continue
				}
				docs, e := all(tx, `SELECT wd.id,wd.workspace_id,d.format,
 COALESCE((SELECT e.relative_path FROM source_entries e JOIN document_bindings b ON b.source_entry_id=e.id JOIN sources s ON s.id=e.source_id WHERE b.workspace_document_id=wd.id ORDER BY (e.state='active' AND b.state='active' AND s.state='active') DESC,e.relative_path LIMIT 1),'历史文档') AS title
 FROM workspace_documents wd JOIN documents d ON d.id=wd.document_id LEFT JOIN library_books lb ON lb.workspace_document_id=wd.id
 WHERE wd.workspace_id=? AND wd.state='active' AND COALESCE(lb.removed_at,'')='' ORDER BY title,wd.id`, raw)
				if e != nil {
					return e
				}
				for _, m := range docs {
					title := path.Base(str(m, "title"))
					if (q != "" && !strings.Contains(strings.ToLower(title), strings.ToLower(q))) || (format != "" && str(m, "format") != format) {
						continue
					}
					total++
					if total <= offset || len(items) >= 30 {
						continue
					}
					selected, e := deviceDocument(tx, d, m)
					if e != nil {
						return e
					}
					items = append(items, M{"id": m["id"], "workspaceId": ws["id"], "workspaceName": ws["name"], "title": title, "format": m["format"], "selected": selected})
				}
			}
			return nil
		})
		if e != nil {
			return e
		}
		return send(w, M{"items": items, "workspaces": workspaces, "total": total, "offset": offset, "hasMore": offset+len(items) < total, "revision": str(obj(d, "syncScope"), "revision")})
	})
	s.route("POST /api/sync/catalog/select", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		members := arr(b, "memberIds")
		if len(members) == 0 || len(members) > 500 {
			return problem(400, "SYNC_SELECTION", "每次请选择 1 到 500 本书", false)
		}
		expected, ok := b["expectedRevision"].(string)
		if !ok {
			return problem(400, "SYNC_SELECTION", "请先刷新电脑书库", false)
		}
		d := deviceFrom(r)
		var saved M
		e = s.transaction(func(tx *sql.Tx) error {
			fresh, e := one(tx, "SELECT d.*,COALESCE(s.scope_json,'{}') AS sync_scope_json FROM paired_devices d LEFT JOIN device_sync_scopes s ON s.device_id=d.id WHERE d.id=? AND revoked_at IS NULL AND expires_at>?", d["id"], time.Now().Unix())
			if e != nil {
				return problem(401, "DEVICE_REQUIRED", "设备授权已失效，请在电脑端重新扫码", false)
			}
			scope := obj(fresh, "syncScope")
			if expected != str(scope, "revision") {
				return problem(409, "SYNC_SCOPE_CHANGED", "电脑同步清单已更新，已保留勾选，请刷新后再次同步", false)
			}
			chosen := map[string]bool{}
			for _, raw := range members {
				member, ok := raw.(string)
				if !ok || member == "" {
					return problem(400, "SYNC_SELECTION", "所选书籍无效", false)
				}
				m, e := s.member(tx, member)
				if e != nil || !deviceWorkspace(fresh, str(m, "workspaceId")) || str(m, "state") != "active" || str(m, "removedAt") != "" {
					return problem(403, "SYNC_SCOPE", "书籍未获授权或已移除，请刷新电脑书库", false)
				}
				chosen[member] = true
			}
			if str(scope, "mode") == "" {
				scope["mode"] = "all"
			}
			included := arr(scope, "memberIds")
			present := map[string]bool{}
			for _, raw := range included {
				if id, ok := raw.(string); ok {
					present[id] = true
				}
			}
			for _, raw := range members {
				member := raw.(string)
				if !present[member] {
					included = append(included, member)
					present[member] = true
				}
			}
			if len(included) > 10000 {
				return problem(400, "SYNC_SELECTION", "同步书目已达上限，请在电脑端整理清单", false)
			}
			excluded := []any{}
			for _, raw := range arr(scope, "excludedMemberIds") {
				if member, ok := raw.(string); ok && !chosen[member] {
					excluded = append(excluded, raw)
				}
			}
			scope["memberIds"] = included
			scope["excludedMemberIds"] = excluded
			scope["autoSync"] = true
			scope["revision"] = id()
			if e = exec(tx, "INSERT INTO device_sync_scopes VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET scope_json=excluded.scope_json", fresh["id"], js(scope)); e != nil {
				return e
			}
			saved = scope
			return nil
		})
		if e != nil {
			return e
		}
		s.queueSync(str(d, "id"), saved)
		return send(w, M{"ok": true, "revision": saved["revision"]})
	})
}
