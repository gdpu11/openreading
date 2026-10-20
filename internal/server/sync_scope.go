package server

import (
	"database/sql"
	"net/http"
)

// Missing scopes belong to devices paired before file selection was added.
func deviceDocument(d, m M) bool {
	if !deviceWorkspace(d, str(m, "workspaceId")) {
		return false
	}
	scope := obj(d, "syncScope")
	switch str(scope, "mode") {
	case "", "all":
		return true
	case "formats":
		for _, f := range arr(scope, "formats") {
			if f == m["format"] {
				return true
			}
		}
	case "manual":
		for _, id := range arr(scope, "memberIds") {
			if id == m["id"] {
				return true
			}
		}
	}
	return false
}

func (s *Server) validateSyncScope(q querier, b M) ([]any, M, error) {
	invalid := func(message string) ([]any, M, error) {
		return nil, nil, problem(400, "SYNC_SCOPE", message, false)
	}
	workspaces := arr(b, "workspaceIds")
	if len(workspaces) == 0 || len(workspaces) > 100 {
		return invalid("请选择需要同步的工作区")
	}
	allowed := map[string]bool{}
	for _, raw := range workspaces {
		ws, ok := raw.(string)
		if !ok || allowed[ws] {
			return invalid("工作区无效")
		}
		if _, e := one(q, "SELECT id FROM workspaces WHERE id=?", ws); e != nil {
			return invalid("工作区无效")
		}
		allowed[ws] = true
	}
	scope := M{"mode": "all"}
	if raw, exists := b["syncScope"]; exists {
		var ok bool
		scope, ok = raw.(map[string]any)
		if !ok {
			return invalid("同步范围无效")
		}
	}
	mode := str(scope, "mode")
	result := M{"mode": mode}
	switch mode {
	case "all":
	case "formats":
		formats := arr(scope, "formats")
		if len(formats) == 0 || len(formats) > 4 {
			return invalid("请至少选择一种文件类型")
		}
		for _, f := range formats {
			switch f {
			case "pdf", "epub", "txt", "markdown":
			default:
				return invalid("文件类型无效")
			}
		}
		result["formats"] = formats
	case "manual":
		members := arr(scope, "memberIds")
		if len(members) == 0 || len(members) > 10000 {
			return invalid("请选择需要同步的文件（最多 10000 个）")
		}
		for _, raw := range members {
			id, ok := raw.(string)
			if !ok {
				return invalid("文件无效")
			}
			m, e := s.member(q, id)
			if e != nil || !allowed[str(m, "workspaceId")] || str(m, "state") != "active" || str(m, "removedAt") != "" {
				return invalid("所选文件不在工作区内或已移除，请刷新后重试")
			}
		}
		result["memberIds"] = members
	default:
		return invalid("同步范围无效")
	}
	return workspaces, result, nil
}

func (s *Server) syncScopeRoutes() {
	// Desktop session only: phones must not discover files outside their grant.
	s.route("GET /api/pair/catalog", func(w http.ResponseWriter, r *http.Request) error {
		docs, e := all(s.db, `SELECT wd.id,wd.workspace_id,d.format,
 COALESCE((SELECT e.relative_path FROM source_entries e JOIN document_bindings b ON b.source_entry_id=e.id JOIN sources s ON s.id=e.source_id WHERE b.workspace_document_id=wd.id ORDER BY (e.state='active' AND b.state='active' AND s.state='active') DESC,e.relative_path LIMIT 1),'历史文档') AS title
 FROM workspace_documents wd JOIN documents d ON d.id=wd.document_id LEFT JOIN library_books lb ON lb.workspace_document_id=wd.id
 WHERE wd.state='active' AND COALESCE(lb.removed_at,'')='' ORDER BY title,wd.id`)
		if e != nil {
			return e
		}
		return send(w, docs)
	})
	s.route("PUT /api/devices/{d}/scope", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = s.transaction(func(tx *sql.Tx) error {
			if _, e := one(tx, "SELECT id FROM paired_devices WHERE id=? AND revoked_at IS NULL", r.PathValue("d")); e != nil {
				return e
			}
			workspaces, scope, e := s.validateSyncScope(tx, b)
			if e != nil {
				return e
			}
			if e = exec(tx, "UPDATE paired_devices SET workspace_ids_json=? WHERE id=?", js(workspaces), r.PathValue("d")); e != nil {
				return e
			}
			return exec(tx, "INSERT INTO device_sync_scopes VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET scope_json=excluded.scope_json", r.PathValue("d"), js(scope))
		})
		if e != nil {
			return e
		}
		return send(w, M{"ok": true})
	})
}
