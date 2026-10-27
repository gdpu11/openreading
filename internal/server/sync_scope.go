package server

import (
	"database/sql"
	"net/http"
	"path"
	"strings"
)

// Missing scopes belong to devices paired before file selection was added.
func deviceDocument(q querier, d, m M) (bool, error) {
	if !deviceWorkspace(d, str(m, "workspaceId")) {
		return false, nil
	}
	scope := obj(d, "syncScope")
	for _, member := range arr(scope, "excludedMemberIds") {
		if member == m["id"] {
			return false, nil
		}
	}
	switch str(scope, "mode") {
	case "", "all":
		return true, nil
	case "formats":
		for _, f := range arr(scope, "formats") {
			if f == m["format"] {
				return true, nil
			}
		}
	case "manual":
		for _, id := range arr(scope, "memberIds") {
			if id == m["id"] {
				return true, nil
			}
		}
		for _, workspace := range arr(scope, "workspaceIds") {
			if workspace == m["workspaceId"] {
				return true, nil
			}
		}
		if len(arr(scope, "folders")) > 0 {
			bindings, e := all(q, `SELECT e.source_id,e.relative_path FROM document_bindings b JOIN source_entries e ON e.id=b.source_entry_id JOIN sources s ON s.id=e.source_id WHERE b.workspace_document_id=? AND b.state='active' AND e.state='active' AND s.state='active'`, m["id"])
			if e != nil {
				return false, e
			}
			for _, raw := range arr(scope, "folders") {
				folder, _ := raw.(map[string]any)
				prefix := str(folder, "path")
				for _, binding := range bindings {
					if binding["sourceId"] == folder["sourceId"] && (prefix == "" || strings.HasPrefix(str(binding, "relativePath"), prefix+"/")) {
						return true, nil
					}
				}
			}
		}
	}
	return false, nil
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
		if len(formats) == 0 || len(formats) > 100 {
			return invalid("请至少选择一种文件类型")
		}
		for _, f := range formats {
			kind, ok := f.(string)
			if !ok || !supportedFormat(kind) {
				return invalid("文件类型无效")
			}
		}
		result["formats"] = formats
	case "manual":
		members := arr(scope, "memberIds")
		if len(members) > 10000 {
			return invalid("最多选择 10000 个文件")
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
		selectedWorkspaces := arr(scope, "workspaceIds")
		if len(selectedWorkspaces) > 100 {
			return invalid("工作区无效")
		}
		for _, raw := range selectedWorkspaces {
			ws, ok := raw.(string)
			if !ok || !allowed[ws] {
				return invalid("所选工作区不在授权范围内")
			}
		}
		result["workspaceIds"] = selectedWorkspaces
		folders := arr(scope, "folders")
		normalizedFolders := []M{}
		if len(folders) > 1000 {
			return invalid("最多选择 1000 个文件夹")
		}
		for _, raw := range folders {
			folder, ok := raw.(map[string]any)
			if !ok {
				return invalid("文件夹无效")
			}
			prefix, ok := folder["path"].(string)
			if !ok || (prefix != "" && (path.Clean(prefix) != prefix || path.IsAbs(prefix) || prefix == ".." || strings.HasPrefix(prefix, "../") || strings.Contains(prefix, "\\"))) {
				return invalid("文件夹路径无效")
			}
			source, e := one(q, "SELECT workspace_id FROM sources WHERE id=?", str(folder, "sourceId"))
			if e != nil || !allowed[str(source, "workspaceId")] {
				return invalid("所选文件夹不在工作区内")
			}
			normalizedFolders = append(normalizedFolders, M{"sourceId": str(folder, "sourceId"), "path": prefix, "workspaceId": str(source, "workspaceId")})
		}
		result["folders"] = normalizedFolders
		excluded := arr(scope, "excludedMemberIds")
		if len(excluded) > 10000 {
			return invalid("最多排除 10000 个文件")
		}
		for _, raw := range excluded {
			member, ok := raw.(string)
			if !ok {
				return invalid("文件无效")
			}
			m, e := s.member(q, member)
			if e != nil || !allowed[str(m, "workspaceId")] {
				return invalid("排除的文件不在工作区内")
			}
		}
		result["excludedMemberIds"] = excluded
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
		bindings, e := all(s.db, `SELECT b.workspace_document_id,e.source_id,e.relative_path,s.label AS source_label FROM document_bindings b JOIN source_entries e ON e.id=b.source_entry_id JOIN sources s ON s.id=e.source_id WHERE b.state='active' AND e.state='active' AND s.state='active' ORDER BY e.relative_path,e.source_id`)
		if e != nil {
			return e
		}
		byMember := map[string][]M{}
		for _, binding := range bindings {
			member := str(binding, "workspaceDocumentId")
			delete(binding, "workspaceDocumentId")
			byMember[member] = append(byMember[member], binding)
		}
		for _, doc := range docs {
			doc["bindings"] = byMember[str(doc, "id")]
		}
		return send(w, docs)
	})
	s.route("PUT /api/devices/{d}/scope", func(w http.ResponseWriter, r *http.Request) error {
		b, e := body(r)
		if e != nil {
			return e
		}
		e = s.transaction(func(tx *sql.Tx) error {
			device, e := one(tx, "SELECT d.id,COALESCE(s.scope_json,'{}') AS sync_scope_json FROM paired_devices d LEFT JOIN device_sync_scopes s ON s.device_id=d.id WHERE d.id=? AND revoked_at IS NULL", r.PathValue("d"))
			if e != nil {
				return e
			}
			if expected, exists := b["expectedRevision"]; exists && expected != str(obj(device, "syncScope"), "revision") {
				return problem(409, "SYNC_SCOPE_CHANGED", "同步范围已在其他窗口修改，请重新打开后重试", false)
			}
			workspaces, scope, e := s.validateSyncScope(tx, b)
			if e != nil {
				return e
			}
			// Pairing alone never enables downloads. Only a desktop save requests it.
			scope["autoSync"] = true
			scope["revision"] = id()
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
